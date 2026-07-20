"""
Seagrass sonar logger — runs on the Raspberry Pi 5 ("seagrass-pi").

Reads distance from a Blue Robotics Ping2 echosounder over USB-serial and
appends one row per reading to sonar_log.csv, tagged with the vehicle's
current heading (VFR_HUD) and depth (GLOBAL_POSITION_INT) from the Pixhawk.
The log is raw material for later analysis and obstacle-avoidance logic.

Read-only / safe to run at any time: this script never sends RC overrides
and never arms or disarms — it only listens to the Pixhawk. It can run
alongside drone_server.py or keyboard_control.py without touching them.

Run:
    pip install brping pymavlink
    python3 sonar_logger.py

Env vars:
    PING_PORT     Ping2 serial device   (default /dev/ttyUSB0)
    PING_BAUD     Ping2 baud rate       (default 115200)
    PIXHAWK_PORT  Pixhawk serial device (default /dev/ttyACM0)
    PIXHAWK_BAUD  Pixhawk baud rate     (default 115200)

The Pixhawk is optional: without it, rows still log with heading/depth empty.
"""

import csv
import os
import sys
import threading
import time

from brping import Ping1D  # Ping2 speaks the Ping1D protocol/driver
from pymavlink import mavutil

# ---------------- configuration ----------------
PING_PORT = os.environ.get("PING_PORT", "/dev/ttyUSB0")
PING_BAUD = int(os.environ.get("PING_BAUD", "115200"))
SERIAL_PORT = os.environ.get("PIXHAWK_PORT", "/dev/ttyACM0")
BAUD = int(os.environ.get("PIXHAWK_BAUD", "115200"))

LOG_INTERVAL_S = 0.5
LOG_FILE = "sonar_log.csv"
CSV_FIELDS = ["timestamp", "distance_m", "confidence", "heading_deg", "depth_m"]


# ---------------- Ping2 sonar ----------------
def connect_ping():
    """Connect to the Ping2. Fatal (clean exit) on failure — the sonar is
    the whole point of this script, so there is nothing to log without it."""
    try:
        print(f"Connecting to Ping2 sonar on {PING_PORT} @ {PING_BAUD}…")
        ping = Ping1D()
        ping.connect_serial(PING_PORT, PING_BAUD)
        if not ping.initialize():
            print(f"Ping2 on {PING_PORT} did not respond to initialize() — "
                  "check wiring/power and that PING_PORT is the sonar, not the Pixhawk.")
            sys.exit(1)
        print("Ping2 initialized")
        return ping
    except Exception as exc:  # noqa: BLE001
        print(f"Could not open Ping2 on {PING_PORT}: {exc}")
        print("Set PING_PORT to the sonar's serial device "
              "(e.g. /dev/ttyUSB0 on the Pi) and try again.")
        sys.exit(1)


# ---------------- Pixhawk (read-only) ----------------
def connect_pixhawk():
    """Connect to the Pixhawk for heading/depth telemetry only. Non-fatal:
    returns None on failure and rows log with heading/depth empty."""
    try:
        print(f"Connecting to Pixhawk on {SERIAL_PORT} @ {BAUD}…")
        master = mavutil.mavlink_connection(SERIAL_PORT, baud=BAUD)
        if master.wait_heartbeat(timeout=10) is None:
            print(f"No heartbeat from Pixhawk on {SERIAL_PORT} after 10s — "
                  "logging without heading/depth.")
            master.close()
            return None
        print("Pixhawk heartbeat OK")
        return master
    except Exception as exc:  # noqa: BLE001
        print(f"Pixhawk not available: {exc} — logging without heading/depth.")
        return None


def start_heartbeat_thread(master):
    # We open our own MAVLink connection, so we must announce ourselves as a
    # GCS once per second or the link can hang (same fix as keyboard_control.py).
    def send_heartbeat_loop():
        while True:
            try:
                master.mav.heartbeat_send(
                    mavutil.mavlink.MAV_TYPE_GCS,
                    mavutil.mavlink.MAV_AUTOPILOT_INVALID,
                    0, 0, 0
                )
            except OSError:
                # Serial link is gone; stop spamming errors from this daemon
                # thread and let the main loop notice on its next read.
                break
            time.sleep(1)

    threading.Thread(target=send_heartbeat_loop, daemon=True).start()


def drain_telemetry(master, latest):
    """Drain pending MAVLink messages, updating latest heading/depth in place."""
    while True:
        msg = master.recv_match(blocking=False)
        if msg is None:
            break
        t = msg.get_type()
        if t == "VFR_HUD":
            latest["heading_deg"] = float(msg.heading)
        elif t == "GLOBAL_POSITION_INT":
            latest["depth_m"] = max(0.0, -msg.relative_alt / 1000.0)


# ---------------- main loop ----------------
def main():
    ping = connect_ping()
    master = connect_pixhawk()
    if master:
        start_heartbeat_thread(master)

    latest = {"heading_deg": None, "depth_m": None}

    write_header = not os.path.exists(LOG_FILE)
    log_file = open(LOG_FILE, "a", newline="")
    writer = csv.writer(log_file)
    if write_header:
        writer.writerow(CSV_FIELDS)
        log_file.flush()

    print(f"Logging to {LOG_FILE} every {LOG_INTERVAL_S}s — Ctrl+C to stop")
    try:
        while True:
            if master:
                drain_telemetry(master, latest)

            data = ping.get_distance()
            if data is None:
                print("Ping2 read failed (no reply) — skipping this row")
            else:
                row = [
                    time.time(),
                    data["distance"] / 1000.0,  # Ping2 reports mm
                    data["confidence"],
                    latest["heading_deg"],
                    latest["depth_m"],
                ]
                writer.writerow(row)
                log_file.flush()
                print(f"dist={row[1]:.3f}m conf={row[2]}% "
                      f"heading={row[3]} depth={row[4]}")

            time.sleep(LOG_INTERVAL_S)
    except KeyboardInterrupt:
        pass
    finally:
        log_file.close()
        if hasattr(ping, "iodev") and ping.iodev:
            ping.iodev.close()
        if master:
            master.close()
        print("Stopped.")


if __name__ == "__main__":
    main()
