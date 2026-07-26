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
    PING_PROFILE  fetch the full acoustic profile as well as the distance
                  (default 1; set 0 to fall back to distance-only reads)
    PING_RANGE_M  pin the scan window to 0..N metres instead of letting the
                  device auto-range (unset = auto). Auto-ranging retunes the
                  window every ping (observed swinging 1.3 m -> 6.4 m), which
                  makes the UI's echogram rescale constantly; pin it for a
                  stable picture once you know the depth you're working in.
    PING_INTERVAL_MS  device ping interval in ms (unset = device default). Stock
                  behaviour measured ~3 pings/s; try 60-100 for a smoother
                  echogram. Too low and profile reads start missing.

Accuracy model — two layers:
  1. Device: speed of sound is set for the actual water, so the echo time -> metres
     conversion is right (fresh vs salt alone is a ~1.3% range error).
  2. Filter: `distance_m` is the MEDIAN of recent samples whose confidence passes
     PING_MIN_CONF. In-air / cup / tube garbage (0% conf spikes to ~90 m) never
     passes the gate, so the UI shows "no lock" instead of a confident-looking lie.
     The unfiltered reading is still published as `raw_m` for debugging.

`quality` in latest: "good" (median over a full window), "weak" (few accepted
samples — trust with caution), "none" (nothing passes the gate — no target lock).

Acoustic profile: the device returns ~200 amplitude samples (0-255, nearest
first) spanning scan_start..scan_start+scan_length, which is what BlueRobotics'
Ping Viewer draws its echogram from. `get_profile()` is a strict superset of
`get_distance()` for the same single round-trip, so we ask for it by default and
publish `profile` alongside the scalars. The window it covers moves when the
device is auto-ranging, so `scan_start_m`/`scan_length_m` are published with
every sample — a consumer cannot assume a fixed range per bin.

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
PING_PROFILE = os.environ.get("PING_PROFILE", "1") not in ("0", "false", "False", "")
# Unset => leave the device auto-ranging (its default).
_range_env = os.environ.get("PING_RANGE_M", "").strip()
PING_RANGE_M = float(_range_env) if _range_env else None
# Unset => leave the device's own ping interval alone. Measured stock behaviour is
# only ~3 pings/s, which makes the UI echogram visibly chunky; lowering this
# raises the row rate. Do not go below the round-trip time for a 226-byte profile
# reply (~20 ms at 115200) or reads start missing.
_interval_env = os.environ.get("PING_INTERVAL_MS", "").strip()
PING_INTERVAL_MS = int(_interval_env) if _interval_env else None

# Filter window: at ~10 Hz polling this is ~1.5 s of history — long enough for a
# stable median, short enough that a genuinely moving target still tracks.
_WINDOW_SAMPLES = 15
_SAMPLE_MAX_AGE_S = 2.0   # stale samples age out even if polling hiccups
_GOOD_MIN_ACCEPTED = 5    # accepted samples needed to call the lock "good"

# How many consecutive failed reads before we tear the link down and reconnect.
# One miss is normal (~3% loss); a run of them means the Ping lost power or the
# cable was unseated, which a reconnect (and mux re-fix) can recover from.
_MAX_CONSECUTIVE_MISSES = 20
# The device request itself blocks until the Ping answers (~160 ms measured for a
# 226-byte profile reply), so this sleep is pure added latency on top of a call
# that is already self-throttling. Keep it small — the device's ping interval,
# not this number, is what governs the real sample rate.
_READ_PERIOD_S = 0.02
_RECONNECT_BACKOFF_S = 2.0

# Consecutive get_profile() failures before we give up on profiles and fall back
# to distance-only reads for the rest of the session. The profile payload is
# ~226 bytes against ~26 for a bare distance, so if this link degrades it is the
# profile that starts failing first — better to keep the distance working.
_MAX_PROFILE_FAILURES = 10


def _empty_reading(ok=False, ts=0.0):
    """The no-data shape of `latest`. Every key the UI reads exists here, so a
    consumer never has to guard for a missing field before the first echo."""
    return {"distance_m": None, "raw_m": None, "confidence": None,
            "quality": "none", "ok": ok, "ts": ts,
            "profile": None, "scan_start_m": None, "scan_length_m": None,
            "gain": None, "ping_number": None}


def _silence_brping_chatter():
    """Stop brping printing "Opening <port> at <baud> bps" on every attempt.

    That one library print is what floods the journal while the sonar is
    disconnected: the reconnect loop calls connect_serial every few seconds and
    the line is unconditional, so no amount of de-duplication in our own logging
    can reach it. Our messages already name the port and baud.

    Assigning `print` into the library module's namespace shadows the builtin
    for THAT MODULE ONLY. The obvious alternative — wrapping the call in
    contextlib.redirect_stdout — swaps sys.stdout process-wide, and because this
    reader runs on its own thread it swallowed whatever the main thread happened
    to be printing at that instant. That is not hypothetical: it ate the
    server's "listening on ws://…" line, which the `drone` launcher greps for to
    decide startup succeeded, so a perfectly healthy server reported a timeout.
    """
    try:
        import brping.device
        brping.device.print = lambda *a, **k: None
    except Exception:  # noqa: BLE001
        pass  # library layout changed — the only cost is a chattier log


_silence_brping_chatter()


def _close_iodev(ping):
    """Close a Ping1D's serial fd. Idempotent and never raises."""
    iodev = getattr(ping, "iodev", None)
    if iodev is None:
        return
    try:
        iodev.close()
    except OSError:
        pass


class SonarReader:
    """Owns the Ping serial link on a daemon thread. Read `.latest` from anywhere."""

    def __init__(self, port=PING_PORT, baud=PING_BAUD, fix_mux=PING_FIX_MUX):
        self.port = port
        self.baud = baud
        self.fix_mux = fix_mux
        # distance_m is the FILTERED distance (None until an echo passes the
        # confidence gate); raw_m/confidence are the latest unfiltered sample;
        # quality is the lock state; ok tracks the serial link itself.
        # `latest` is always REPLACED wholesale, never mutated in place, so a
        # reader gets a self-consistent snapshot without taking a lock.
        self.latest = _empty_reading()
        self._ping = None
        self._stop = threading.Event()
        self._thread = None
        self._window = deque(maxlen=_WINDOW_SAMPLES)  # (distance_m, conf, ts)
        self._want_profile = PING_PROFILE
        self._profile_failures = 0
        # Repeat-suppression state for _log. The reader retries forever, so an
        # unplugged sonar used to write the same two lines to the journal every
        # few seconds all night — which buries anything that actually changed.
        self._last_log = None
        self._repeats = 0

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

    def _log(self, message):
        """Print `message`, collapsing consecutive duplicates into a count.

        The reconnect loop repeats every few seconds indefinitely, so without
        this a sonar that is simply unplugged floods the journal and makes the
        one line that matters — the state *change* — impossible to spot.
        """
        if message == self._last_log:
            self._repeats += 1
            return
        if self._repeats:
            print(f"Sonar: (previous message repeated {self._repeats}x)")
        self._last_log = message
        self._repeats = 0
        print(message)

    def _appears_unpowered(self):
        """True if the Ping's TX line is floating, i.e. the Ping has no power.

        A powered Ping idles its TX high, so forcing an internal pull-down on
        GPIO5 (header pin 29) and still reading `hi` means it is driving the
        line. Reading `lo` means nothing is connected or powered — usually the
        red/black leads have unseated from pins 4/6, which share those pins with
        the battery feed and pop out easily when the other leads are moved.

        Returns None when it can't be measured, so callers can stay quiet rather
        than assert a fault they never observed.
        """
        if not self.fix_mux:
            return None  # we don't own the mux, so don't disturb it
        try:
            subprocess.run(["pinctrl", "set", "5", "ip", "pd"], check=True,
                           capture_output=True, timeout=5)
            out = subprocess.run(["pinctrl", "get", "5"], check=True,
                                 capture_output=True, text=True, timeout=5).stdout
        except (OSError, subprocess.SubprocessError):
            return None
        finally:
            # Always restore the uart mux AND the pull. TXD2/RXD2 are alt2 on
            # this Pi — any other alt silently disconnects the UART from the
            # header. Restoring `pu` matters too: leaving the pull-down from the
            # probe in place would sit against an idle-high RX line.
            subprocess.run(["pinctrl", "set", "5", "a2", "pu"], check=False,
                           capture_output=True, timeout=5)
        return "| hi" not in out

    def _connect(self):
        """Open the Ping and initialize with retries. Returns True on success."""
        self._apply_mux()
        try:
            ping = Ping1D()
            ping.connect_serial(self.port, self.baud)
        except Exception as exc:  # noqa: BLE001
            hint = ""
            if "lock" in str(exc).lower() or "busy" in str(exc).lower():
                # Only one process can hold the port; the usual cause is a
                # standalone ping_live.py/start_sonar.sh run alongside the server.
                hint = (" — another process is holding the port "
                        "(standalone ping_live.py / start_sonar.sh?)")
            self._log(f"Sonar: could not open {self.port}: {exc}{hint}")
            return False
        # ~3% loss + no internal retry in initialize() => retry a handful of times.
        for _ in range(5):
            if self._stop.is_set():
                break
            if ping.initialize():
                self._ping = ping
                self._log(f"Sonar connected on {self.port} @ {self.baud}")
                self._configure(ping)
                return True
            time.sleep(0.3)
        else:
            # Close before probing: the power check drives GPIO5, which would
            # corrupt this port's stream if it were still open.
            _close_iodev(ping)
            if self._appears_unpowered():
                self._log(
                    f"Sonar: {self.port} did not initialize — the Ping appears "
                    "UNPOWERED (pin 29 floating; a powered Ping idles TX high). "
                    "Check the red lead in pin 4 and black in pin 6."
                )
            else:
                self._log(f"Sonar: {self.port} did not initialize "
                          "(check power/wiring/mux)")
        # Close the port on every failure path — each retry cycle opens a fresh
        # fd, and leaking one every backoff would exhaust the fd limit within
        # an hour of the sonar being unplugged. Idempotent, so the early close
        # taken before the power probe above is safe to repeat here.
        _close_iodev(ping)
        return False

    def _configure(self, ping):
        """Push accuracy settings to the device. Best-effort only: brping's
        set_speed_of_sound(verify=True) reads back an internal attribute that is
        not always populated on this decode path and raises AttributeError instead
        of returning False on that race, so it's called with verify=False and
        confirmed separately via get_speed_of_sound. Nothing here may ever raise —
        accuracy tuning must not be able to take down the whole reader thread."""
        sos_mm_s = int(PING_SOS_M_S * 1000)  # protocol wants mm/s
        acknowledged = False
        try:
            for _ in range(3):
                if ping.set_speed_of_sound(sos_mm_s, verify=False):
                    acknowledged = True
                    break
                time.sleep(0.2)
        except Exception as exc:  # noqa: BLE001
            self._log(f"Sonar: could not set speed of sound ({exc}) — continuing "
                      "with the device's current setting")
            return
        if not acknowledged:
            self._log(f"Sonar: speed-of-sound request not acknowledged "
                      f"(wanted {PING_SOS_M_S:g} m/s) — ranges may be off")
            return

        # The write is done and the device acked it. The confirmation below is
        # strictly a nice-to-have and is guarded SEPARATELY, because brping's
        # get_speed_of_sound() reads back self._speed_of_sound — an attribute the
        # library only populates on some decode paths, so it raises AttributeError
        # often enough to matter. Folding it into the try above made a healthy,
        # applied setting report "could not set speed of sound", which is exactly
        # backwards and sent us looking for a fault that wasn't there.
        try:
            # get_speed_of_sound() returns a DICT ({"speed_of_sound": mm/s}),
            # not the bare int — comparing it to sos_mm_s always failed, so this
            # used to log "device may not have applied it" even on success.
            readback = ping.get_speed_of_sound()
            applied = readback.get("speed_of_sound") if isinstance(readback, dict) else readback
            if applied == sos_mm_s:
                self._log(f"Sonar: speed of sound set to {PING_SOS_M_S:g} m/s")
            else:
                self._log(f"Sonar: speed-of-sound readback {applied} != {sos_mm_s} "
                          "mm/s — device may not have applied it")
        except Exception as exc:  # noqa: BLE001
            self._log(f"Sonar: speed of sound set to {PING_SOS_M_S:g} m/s "
                      f"(device acked it; readback unavailable: {exc})")

        # Pin the scan window if asked. set_range only takes effect in manual
        # mode — auto-ranging overrides both range and gain — so mode must go
        # first. Separately guarded from the speed-of-sound block above so a
        # failure in one still lets the other apply.
        if PING_RANGE_M is not None:
            try:
                ping.set_mode_auto(0, verify=False)
                ping.set_range(0, int(PING_RANGE_M * 1000), verify=False)
                print(f"Sonar: scan range pinned to 0–{PING_RANGE_M:g} m (manual mode)")
            except Exception as exc:  # noqa: BLE001
                print(f"Sonar: could not pin scan range ({exc}) — leaving the "
                      "device on auto-range")

        if PING_INTERVAL_MS is not None:
            try:
                ping.set_ping_interval(PING_INTERVAL_MS, verify=False)
                print(f"Sonar: ping interval set to {PING_INTERVAL_MS} ms")
            except Exception as exc:  # noqa: BLE001
                print(f"Sonar: could not set ping interval ({exc}) — keeping "
                      "the device default")

    def _mark_down(self):
        self._ping = None
        self._window.clear()
        self.latest = _empty_reading(ts=time.time())

    def _read(self):
        """One device exchange. Returns the brping dict, or None on a miss.

        get_profile() carries everything get_distance() does plus the amplitude
        array, for the same single round-trip, so it is the default. If profiles
        keep failing on a degraded link we permanently drop back to the smaller
        distance-only request rather than losing the reading altogether.
        """
        if not self._want_profile:
            return self._ping.get_distance()

        data = self._ping.get_profile()
        if data is not None:
            self._profile_failures = 0
            return data

        self._profile_failures += 1
        if self._profile_failures >= _MAX_PROFILE_FAILURES:
            self._want_profile = False
            print(f"Sonar: {_MAX_PROFILE_FAILURES} consecutive profile requests "
                  "failed — falling back to distance-only reads")
        return None

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
                    data = self._read()
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

                    # profile_data is `bytes` and scan_* are mm — convert both
                    # here so nothing downstream has to know the wire format
                    # (bytes is not JSON-serializable). Absent on a
                    # distance-only read, hence the .get()s.
                    profile = data.get("profile_data")
                    scan_start = data.get("scan_start")
                    scan_length = data.get("scan_length")

                    self.latest = {
                        "distance_m": filtered,
                        "raw_m": raw_m,
                        "confidence": conf,
                        "quality": quality,
                        "ok": True,
                        "ts": now,
                        "profile": list(profile) if profile else None,
                        "scan_start_m": (round(scan_start / 1000.0, 3)
                                         if scan_start is not None else None),
                        "scan_length_m": (round(scan_length / 1000.0, 3)
                                          if scan_length is not None else None),
                        "gain": data.get("gain_setting"),
                        "ping_number": data.get("ping_number"),
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
