"""
Ping2 sonar reader — a background thread that keeps the latest distance reading
available for drone_server.py to broadcast to the UI.

Runs entirely off the asyncio event loop: pyserial reads block, so they must not
happen on the loop that drives MAVLink and the safety watchdog. This mirrors the
heartbeat-thread pattern in drone_server.py and the read loop in sonar_logger.py.

Wiring / gotchas live in sonar/README.md. The short version this class encodes:
  * The Ping is on uart2 -> /dev/ttyAMA2 (pins 7/29) at 115200 baud.
  * GPIO4/5 must be muxed to a2 (TXD2/RXD2), NOT a4 — a4 is RI0/DTR0 and silently
    disconnects the UART from the header. We set a2 ourselves on start (PING_FIX_MUX).
  * initialize() over this link fails ~20-25% of the time from ~3% packet loss with
    no internal retry, so every connect retries a few times.

Env vars:
    PING_PORT     Ping2 serial device   (default /dev/ttyAMA2)
    PING_BAUD     Ping2 baud rate       (default 115200)
    PING_FIX_MUX  set GPIO4/5 to a2 on start (default 1; set 0 to skip)
    PING_SOS_M_S  speed of sound in m/s (default 1481 = freshwater ~20°C;
                  use 1500 for saltwater — a wrong medium reads ~1.3% off)
    PING_MIN_CONF minimum confidence % a sample needs to count as a real echo
                  (default 50; below it the sample is noise and is not trusted)

Accuracy model — two layers:
  1. Device: speed of sound is set for the actual water, so the echo time -> metres
     conversion is right (fresh vs salt alone is a ~1.3% range error).
  2. Filter: `distance_m` is the MEDIAN of recent samples whose confidence passes
     PING_MIN_CONF. In-air / cup / tube garbage (0% conf spikes to ~90 m) never
     passes the gate, so the UI shows "no lock" instead of a confident-looking lie.
     The unfiltered reading is still published as `raw_m` for debugging.

`quality` in latest: "good" (median over a full window), "weak" (few accepted
samples — trust with caution), "none" (nothing passes the gate — no target lock).

The sonar is optional: if it never connects, `latest["ok"]` stays False and the
rest of the server runs normally — same non-fatal contract as the Pixhawk link.
"""

import os
import statistics
import subprocess
import threading
import time
from collections import deque

from brping import Ping1D

PING_PORT = os.environ.get("PING_PORT", "/dev/ttyAMA2")
PING_BAUD = int(os.environ.get("PING_BAUD", "115200"))
PING_FIX_MUX = os.environ.get("PING_FIX_MUX", "1") not in ("0", "false", "False", "")
PING_SOS_M_S = float(os.environ.get("PING_SOS_M_S", "1481"))
PING_MIN_CONF = int(os.environ.get("PING_MIN_CONF", "50"))

# Filter window: at ~10 Hz polling this is ~1.5 s of history — long enough for a
# stable median, short enough that a genuinely moving target still tracks.
_WINDOW_SAMPLES = 15
_SAMPLE_MAX_AGE_S = 2.0   # stale samples age out even if polling hiccups
_GOOD_MIN_ACCEPTED = 5    # accepted samples needed to call the lock "good"

# How many consecutive failed reads before we tear the link down and reconnect.
# One miss is normal (~3% loss); a run of them means the Ping lost power or the
# cable was unseated, which a reconnect (and mux re-fix) can recover from.
_MAX_CONSECUTIVE_MISSES = 20
_READ_PERIOD_S = 0.1        # ~10 Hz polling; the UI samples this at its own rate
_RECONNECT_BACKOFF_S = 2.0


class SonarReader:
    """Owns the Ping serial link on a daemon thread. Read `.latest` from anywhere."""

    def __init__(self, port=PING_PORT, baud=PING_BAUD, fix_mux=PING_FIX_MUX):
        self.port = port
        self.baud = baud
        self.fix_mux = fix_mux
        # distance_m is the FILTERED distance (None until an echo passes the
        # confidence gate); raw_m/confidence are the latest unfiltered sample;
        # quality is the lock state; ok tracks the serial link itself.
        self.latest = {"distance_m": None, "raw_m": None, "confidence": None,
                       "quality": "none", "ok": False, "ts": 0.0}
        self._ping = None
        self._stop = threading.Event()
        self._thread = None
        self._window = deque(maxlen=_WINDOW_SAMPLES)  # (distance_m, conf, ts)

    # ---------------- lifecycle ----------------
    def start(self):
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    # ---------------- internals ----------------
    def _apply_mux(self):
        """Force GPIO4/5 to a2 (TXD2/RXD2). Best-effort: pinctrl may be absent off
        a Pi, in which case we just skip it and let the connect attempt speak."""
        if not self.fix_mux:
            return
        try:
            subprocess.run(["pinctrl", "set", "4", "a2"], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(["pinctrl", "set", "5", "a2"], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (FileNotFoundError, OSError) as exc:
            print(f"Sonar: could not set uart2 mux ({exc}) — continuing anyway")

    def _connect(self):
        """Open the Ping and initialize with retries. Returns True on success."""
        self._apply_mux()
        try:
            ping = Ping1D()
            ping.connect_serial(self.port, self.baud)
        except Exception as exc:  # noqa: BLE001
            print(f"Sonar: could not open {self.port}: {exc}")
            return False
        # ~3% loss + no internal retry in initialize() => retry a handful of times.
        for _ in range(5):
            if self._stop.is_set():
                break
            if ping.initialize():
                self._ping = ping
                print(f"Sonar connected on {self.port} @ {self.baud}")
                self._configure(ping)
                return True
            time.sleep(0.3)
        else:
            print(f"Sonar: {self.port} did not initialize (check power/wiring/mux)")
        # Close the port on every failure path — each retry cycle opens a fresh
        # fd, and leaking one every backoff would exhaust the fd limit within
        # an hour of the sonar being unplugged.
        if getattr(ping, "iodev", None):
            try:
                ping.iodev.close()
            except OSError:
                pass
        return False

    def _configure(self, ping):
        """Push accuracy settings to the device. Best-effort only: brping's
        set_speed_of_sound(verify=True) reads back an internal attribute that is
        not always populated on this decode path and raises AttributeError instead
        of returning False on that race, so it's called with verify=False and
        confirmed separately via get_speed_of_sound. Nothing here may ever raise —
        accuracy tuning must not be able to take down the whole reader thread."""
        sos_mm_s = int(PING_SOS_M_S * 1000)  # protocol wants mm/s
        try:
            for _ in range(3):
                if ping.set_speed_of_sound(sos_mm_s, verify=False):
                    break
                time.sleep(0.2)
            else:
                print(f"Sonar: speed-of-sound request not acknowledged "
                      f"(wanted {PING_SOS_M_S:g} m/s) — ranges may be off")
                return
            readback = ping.get_speed_of_sound()
            if readback == sos_mm_s:
                print(f"Sonar: speed of sound set to {PING_SOS_M_S:g} m/s")
            else:
                print(f"Sonar: speed-of-sound readback {readback} != {sos_mm_s} "
                      "mm/s — device may not have applied it")
        except Exception as exc:  # noqa: BLE001
            print(f"Sonar: could not set speed of sound ({exc}) — continuing "
                  "with the device's current setting")

    def _mark_down(self):
        self._ping = None
        self._window.clear()
        self.latest = {"distance_m": None, "raw_m": None, "confidence": None,
                       "quality": "none", "ok": False, "ts": time.time()}

    def _run(self):
        misses = 0
        while not self._stop.is_set():
            # Top-level safety net: this library has already thrown one
            # surprising internal AttributeError (see _configure) instead of
            # returning False as documented. Nothing raised anywhere in this
            # loop may be allowed to end the thread — that's what silently
            # freezes the UI on "Sonar OFF" with no further retries. Any
            # unexpected exception is treated exactly like a read error: tear
            # the link down and let the normal reconnect path take over.
            try:
                if self._ping is None:
                    if not self._connect():
                        # Back off so a missing sonar doesn't spin the CPU.
                        self._stop.wait(_RECONNECT_BACKOFF_S)
                        continue
                    misses = 0

                try:
                    data = self._ping.get_distance()
                except Exception as exc:  # noqa: BLE001
                    print(f"Sonar: read error ({exc}) — reconnecting")
                    self._mark_down()
                    continue

                if data is None:
                    misses += 1
                    if misses >= _MAX_CONSECUTIVE_MISSES:
                        print("Sonar: too many missed reads — reconnecting")
                        self._mark_down()
                        misses = 0
                else:
                    misses = 0
                    now = time.time()
                    raw_m = round(data["distance"] / 1000.0, 3)  # mm -> m
                    conf = int(data["confidence"])
                    self._window.append((raw_m, conf, now))

                    # Median of the samples that pass the confidence gate and
                    # aren't stale. A 0%-confidence 90 m spike (air / cup /
                    # tube reverb) contributes nothing, so the displayed
                    # distance can never be noise.
                    accepted = [d for (d, c, t) in self._window
                                if c >= PING_MIN_CONF and now - t <= _SAMPLE_MAX_AGE_S]
                    if len(accepted) >= _GOOD_MIN_ACCEPTED:
                        quality, filtered = "good", round(statistics.median(accepted), 3)
                    elif accepted:
                        quality, filtered = "weak", round(statistics.median(accepted), 3)
                    else:
                        quality, filtered = "none", None

                    self.latest = {
                        "distance_m": filtered,
                        "raw_m": raw_m,
                        "confidence": conf,
                        "quality": quality,
                        "ok": True,
                        "ts": now,
                    }

                self._stop.wait(_READ_PERIOD_S)
            except Exception as exc:  # noqa: BLE001
                print(f"Sonar: unexpected error in reader loop ({exc}) — reconnecting")
                self._mark_down()
                self._stop.wait(_RECONNECT_BACKOFF_S)

        if self._ping is not None and getattr(self._ping, "iodev", None):
            try:
                self._ping.iodev.close()
            except OSError:
                pass
