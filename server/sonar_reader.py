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

The sonar is optional: if it never connects, `latest["ok"]` stays False and the
rest of the server runs normally — same non-fatal contract as the Pixhawk link.
"""

import os
import subprocess
import threading
import time

from brping import Ping1D

PING_PORT = os.environ.get("PING_PORT", "/dev/ttyAMA2")
PING_BAUD = int(os.environ.get("PING_BAUD", "115200"))
PING_FIX_MUX = os.environ.get("PING_FIX_MUX", "1") not in ("0", "false", "False", "")

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
        # distance_m/confidence are None until the first good read; ok flips the UI
        # from "—" to a live value and back if the link drops.
        self.latest = {"distance_m": None, "confidence": None, "ok": False, "ts": 0.0}
        self._ping = None
        self._stop = threading.Event()
        self._thread = None

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
                return False
            if ping.initialize():
                self._ping = ping
                print(f"Sonar connected on {self.port} @ {self.baud}")
                return True
            time.sleep(0.3)
        print(f"Sonar: {self.port} did not initialize (check power/wiring/mux)")
        return False

    def _mark_down(self):
        self._ping = None
        self.latest = {"distance_m": None, "confidence": None, "ok": False,
                       "ts": time.time()}

    def _run(self):
        misses = 0
        while not self._stop.is_set():
            if self._ping is None:
                if not self._connect():
                    # Back off before retrying so a missing sonar doesn't spin the CPU.
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
                self.latest = {
                    "distance_m": round(data["distance"] / 1000.0, 3),  # mm -> m
                    "confidence": int(data["confidence"]),
                    "ok": True,
                    "ts": time.time(),
                }

            self._stop.wait(_READ_PERIOD_S)

        if self._ping is not None and getattr(self._ping, "iodev", None):
            try:
                self._ping.iodev.close()
            except OSError:
                pass
