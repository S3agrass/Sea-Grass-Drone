"""Measure what the GPS actually does, from open sky to no sky.

Answers two questions the console cannot currently answer at all, because
nothing in this repo reads GPS_RAW_INT:

  1. HOW FAST does a usable fix arrive? Not "a fix" — a fix you can navigate on.
     A receiver can report a 2D position in 20 seconds that is 40 m out, and
     that is not the number the operator waiting at the ramp cares about. So
     time-to-first-fix is recorded at every tier separately: any fix, 3D, and
     each grade in server/gps_quality.py.

  2. HOW ACCURATE is it, really? Every receiver reports its own accuracy and
     every receiver is optimistic about it. The static-scatter scenario parks
     the vehicle and measures the dispersion directly, then divides that by what
     the receiver claimed. That ratio is the point of this whole script: it is
     what says whether the accuracy circle the map is about to draw is honest.

WHY THIS REFUSES TO RUN ALONGSIDE THE SERVER

The Pixhawk link is single-owner. `scripts/drone` and drone-server.service both
free it by force (`lsof -t $PIXHAWK_PORT | xargs kill -9`) because they are the
thing that should own it. This script is the opposite: it is a diagnostic, it
has no claim on the vehicle, and silently killing the server out from under an
operator would be a genuinely bad way to start a measurement session. So it
detects the conflict and stops, printing what to run.

MAVLINK 2 IS NOT OPTIONAL HERE

h_acc/v_acc/hdg_acc are MAVLink2 extension fields. Under pymavlink's default 1.0
dialect they do not exist as attributes at all, so every accuracy figure would
quietly become a HDOP estimate and the claimed-vs-measured ratio would be
comparing the receiver against a constant. MAVLINK20 is therefore forced below,
before pymavlink is imported, and the dialect actually in use is printed into
the report header so a reader can tell which kind of number they are holding.

    python3 scripts/gps_survey.py --list          # the scenarios and durations
    python3 scripts/gps_survey.py                 # the full guided survey
    python3 scripts/gps_survey.py --only static-scatter
    python3 scripts/gps_survey.py --continuous --duration 3600 --label dock
"""
import argparse
import csv
import json
import math
import os
import select
import statistics
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone

# Must be set BEFORE pymavlink is imported — the dialect module is chosen at
# import time, and the 1.0 one has no h_acc field to read. See the docstring.
os.environ.setdefault("MAVLINK20", "1")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "server"))
sys.path.insert(0, os.path.join(REPO_ROOT, "sonar"))

import gps_quality as gq  # noqa: E402
from pymavlink import mavutil  # noqa: E402

try:
    from ping_preflight import port_owner, describe_pid
except ImportError:  # pragma: no cover - only if the sonar module moves
    def port_owner(_port):
        return []

    def describe_pid(pid):
        return f"pid {pid}"

# Same env vars the server reads, so the survey measures the deployed wiring
# rather than a second configuration that can drift from it.
PORT = os.environ.get("PIXHAWK_PORT", "/dev/ttyACM0")
BAUD = int(os.environ.get("PIXHAWK_BAUD", "115200"))
SERVICE = "drone-server"

HEARTBEAT_S = 1.0
OUT_DIR = os.path.join(REPO_ROOT, "diagnostics", "gps")

# 5 Hz on GPS_RAW_INT is for this script only, where the link is otherwise idle.
# The server asks for 2 Hz — it shares a 115200 USB CDC link with RC overrides,
# attitude and everything else, and its telemetry loop only sends every 0.5 s.
STREAMS = [
    ("GPS_RAW_INT", mavutil.mavlink.MAVLINK_MSG_ID_GPS_RAW_INT, 5),
    ("GLOBAL_POSITION_INT", mavutil.mavlink.MAVLINK_MSG_ID_GLOBAL_POSITION_INT, 5),
    ("GPS2_RAW", mavutil.mavlink.MAVLINK_MSG_ID_GPS2_RAW, 1),
    ("EKF_STATUS_REPORT", mavutil.mavlink.MAVLINK_MSG_ID_EKF_STATUS_REPORT, 1),
    ("SYS_STATUS", mavutil.mavlink.MAVLINK_MSG_ID_SYS_STATUS, 1),
    ("VFR_HUD", mavutil.mavlink.MAVLINK_MSG_ID_VFR_HUD, 2),
    ("ATTITUDE", mavutil.mavlink.MAVLINK_MSG_ID_ATTITUDE, 2),
]

# Printed raw into the report header. Deliberately NOT decoded here: ARMING_CHECK
# is a bitmask whose meaning moves between firmware versions, and a hand-written
# table in this file would eventually describe a different vehicle than the one
# on the bench. The captured "PreArm:" STATUSTEXT lines are the authority on why
# an arm was refused.
PARAMS = ["ARMING_CHECK", "AHRS_GPS_MINSATS", "EK3_GPS_CHECK", "GPS_TYPE",
          "GPS_TYPE2", "SERIAL3_PROTOCOL", "SERIAL3_BAUD"]

SCENARIOS = [
    {
        "key": "cold-open",
        "title": "open sky, cold start",
        "prompt": ("Stand in the open with a clear horizon. The autopilot must have\n"
                   "been powered OFF for at least 4 hours (or pull the battery), so the\n"
                   "receiver has no valid ephemeris cached.\n"
                   "Power it on now, wait for the USB to enumerate, then press Enter."),
        "hold_s": 300,
        "measures": "Worst-case time to first fix — what you actually wait through at the ramp.",
    },
    {
        "key": "warm-open",
        "title": "open sky, warm start",
        "prompt": ("Same spot. Power the autopilot off for about 20 minutes, then back\n"
                   "on, then press Enter. This is the realistic between-dives case."),
        "hold_s": 180,
        "measures": "Time to first fix with a stale but present almanac.",
    },
    {
        "key": "hot-open",
        "title": "open sky, hot start",
        "prompt": ("Same spot. Power-cycle the autopilot and press Enter immediately\n"
                   "(less than 2 minutes off). Ephemeris should still be valid."),
        "hold_s": 120,
        "measures": "Best case. Should be seconds, not minutes.",
    },
    {
        "key": "static-scatter",
        "title": "stationary, open sky",
        "prompt": ("THE ACCURACY TEST. Put the antenna in its REAL mounted position on\n"
                   "the hull — not in your hand, not on a tripod, because multipath off\n"
                   "the hull is part of what we are measuring. Do not move the vehicle\n"
                   "for the next 10 minutes. Press Enter when it is settled."),
        "hold_s": 600,
        "scatter": True,
        "measures": "Measured dispersion (CEP50/CEP95) against the receiver's own claim.",
    },
    {
        "key": "partial-canopy",
        "title": "half the sky blocked",
        "prompt": ("Move under tree canopy, or hard against a building edge, so roughly\n"
                   "half the sky is obstructed. Keep it still. Press Enter."),
        "hold_s": 240,
        "scatter": True,
        "measures": "Whether degradation is reported honestly, and how much accuracy is lost.",
    },
    {
        "key": "window",
        "title": "indoors beside a window",
        "prompt": ("Go indoors and stand within a metre of a window. Press Enter.\n"
                   "This is the classic trap: enough signal to claim a fix, not enough\n"
                   "to earn one."),
        "hold_s": 180,
        "measures": "Whether a marginal fix is graded down or oversold.",
    },
    {
        "key": "indoors",
        "title": "fully indoors",
        "prompt": ("Go well inside, away from any window. Press Enter.\n"
                   "This scenario MUST fail. A good grade here invalidates the survey."),
        "hold_s": 180,
        "measures": "The honesty check. Everything else depends on this one failing.",
    },
    {
        "key": "reacquire",
        "title": "recovery after a blockage",
        "prompt": ("Back out to open sky. Wait until the live line below reads `good`,\n"
                   "then fully shield the antenna (wrap it in foil, or invert a metal\n"
                   "bowl over it) for about 60 seconds, then uncover it.\n"
                   "Press Enter once you are outside and ready to start."),
        "hold_s": 240,
        "measures": "Re-acquisition time — the mid-mission case, when a fix is lost under a bridge.",
    },
    {
        "key": "launch-site",
        "title": "the actual water entry point",
        "prompt": ("At the real launch site, vehicle in its launch position.\n"
                   "Press Enter."),
        "hold_s": 300,
        "scatter": True,
        "optional": True,
        "measures": "The only numbers that are operationally binding. Run with --only launch-site.",
    },
]

CSV_FIELDS = [
    "ts_unix", "ts_iso", "scenario", "phase", "t_scenario_s",
    "fix_type", "fix_name", "sats", "hdop", "vdop",
    "h_acc_m", "v_acc_m", "vel_acc_ms", "hdg_acc_deg", "acc_m", "acc_source", "grade",
    "lat", "lon", "alt_msl_m", "cog_deg", "gps_speed_ms",
    "gpos_lat", "gpos_lon", "gpos_rel_alt_m",
    "ekf_flags", "ekf_pos_horiz_acc", "ekf_pos_horiz_var", "ekf_compass_var",
    "ekf_vel_var", "sys_gps_present", "sys_gps_enabled", "sys_gps_health",
    "vfr_heading", "vfr_groundspeed_ms", "yaw_deg",
    "gps2_fix_type", "gps2_sats", "note",
]


# ---------------------------------------------------------------- guards


def _systemd_state(unit):
    """"active" / "inactive" / None when systemd isn't there to ask."""
    try:
        out = subprocess.run(["systemctl", "is-active", unit],
                             capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() or None


def preflight(force=False):
    """Refuse to fight for the serial port. Returns True if it is safe to open.

    Note what this does NOT do: it never kills the holder. `scripts/drone` does,
    and should — it is the thing that owns the vehicle. A diagnostic that stole
    the link would take the console down mid-dive to answer a question nobody
    urgently needed answered.
    """
    problems = []

    if _systemd_state(SERVICE) == "active":
        problems.append(
            f"{SERVICE}.service is running and holds {PORT}.\n"
            f"    Stop it, run the survey, then start it again:\n"
            f"        sudo systemctl stop {SERVICE}\n"
            f"        python3 scripts/gps_survey.py\n"
            f"        sudo systemctl start {SERVICE}"
        )

    owners = port_owner(PORT)
    if owners:
        who = ", ".join(describe_pid(p) for p in owners)
        problems.append(
            f"{PORT} is already open by another process ({who}).\n"
            f"    Only one process can talk to the Pixhawk. Close that one first."
        )

    if PORT.startswith("/dev/") and not os.path.exists(PORT):
        problems.append(
            f"{PORT} does not exist.\n"
            f"    The Pixhawk is a USB CDC device, so an absent node means it is\n"
            f"    unplugged, unpowered, or still rebooting — not misconfigured.\n"
            f"    Check the cable, then: ls /dev/serial/by-id/"
        )

    for p in problems:
        print(f"  !! {p}")
    if problems and not force:
        return False
    if problems:
        print("\n  --force given; continuing anyway.\n")
    return True


# ---------------------------------------------------------------- the link


def connect():
    """Open the link and start the GCS heartbeat. Mirrors connect_pixhawk()."""
    print(f"Connecting to Pixhawk on {PORT} @ {BAUD}…")
    master = mavutil.mavlink_connection(PORT, baud=BAUD)
    if master.wait_heartbeat(timeout=15) is None:
        raise SystemExit(
            "  !! No heartbeat in 15 s. The port opened but nothing is talking on it.\n"
            "     On a Holybro Pixhawk6C the MAVLink endpoint is the -if00 node;\n"
            "     -if02 is the console and will sit silent exactly like this."
        )
    print(f"Heartbeat OK — system {master.target_system}, component {master.target_component}")

    def beat():
        # ArduSub trips its GCS failsafe without this. It does not change the
        # GPS, but it does change the vehicle's behaviour and its STATUSTEXT
        # output, and a survey should not be measuring a vehicle in failsafe.
        while True:
            try:
                master.mav.heartbeat_send(
                    mavutil.mavlink.MAV_TYPE_GCS,
                    mavutil.mavlink.MAV_AUTOPILOT_INVALID, 0, 0, 0)
            except OSError:
                return
            time.sleep(HEARTBEAT_S)

    threading.Thread(target=beat, daemon=True).start()
    return master


def request_streams(master):
    """Ask for the message rates we need. Returns a note for the report header."""
    for _name, msgid, hz in STREAMS:
        master.mav.command_long_send(
            master.target_system, master.target_component,
            mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL, 0,
            msgid, int(1e6 / hz), 0, 0, 0, 0, 0)

    accepted = rejected = 0
    deadline = time.time() + 3.0
    while time.time() < deadline:
        msg = master.recv_match(type="COMMAND_ACK", blocking=True, timeout=0.3)
        if msg is None:
            continue
        if msg.command == mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL:
            if msg.result == mavutil.mavlink.MAV_RESULT_ACCEPTED:
                accepted += 1
            else:
                rejected += 1

    if rejected or accepted == 0:
        # Older firmware, or a build without SET_MESSAGE_INTERVAL. The legacy
        # stream request is coarser (one rate for everything) but it is the
        # difference between a survey and an empty CSV.
        master.mav.request_data_stream_send(
            master.target_system, master.target_component,
            mavutil.mavlink.MAV_DATA_STREAM_ALL, 5, 1)
        return (f"SET_MESSAGE_INTERVAL: {accepted} accepted, {rejected} rejected "
                f"— fell back to REQUEST_DATA_STREAM at 5 Hz")
    return f"SET_MESSAGE_INTERVAL: all {accepted} stream requests accepted"


def fetch_params(master, names, timeout=5.0):
    """Read a few autopilot params. Missing ones are reported as missing."""
    for name in names:
        master.mav.param_request_read_send(
            master.target_system, master.target_component, name.encode(), -1)
    found = {}
    deadline = time.time() + timeout
    while time.time() < deadline and len(found) < len(names):
        msg = master.recv_match(type="PARAM_VALUE", blocking=True, timeout=0.3)
        if msg is None:
            continue
        pid = msg.param_id.strip("\x00") if isinstance(msg.param_id, str) else \
            msg.param_id.decode(errors="replace").strip("\x00")
        if pid in names:
            found[pid] = msg.param_value
    return {n: found.get(n) for n in names}


# ---------------------------------------------------------------- sampling


class Survey:
    """Drains the link, grades every GPS_RAW_INT, and writes a row per fix.

    GPS_RAW_INT is what defines "a fix was received" — everything else is
    stamped onto the row from the last value seen, which is why `latest` exists.
    """

    def __init__(self, master, writer, events_fh):
        self.master = master
        self.writer = writer
        self.events_fh = events_fh
        self.latest = {}
        self.rows = []
        self.events = []
        self.scenario = "-"
        self.phase = ""
        self.t0 = time.time()
        # Which MAVLink2 extension fields have EVER arrived non-zero. Decides
        # whether the accuracy column is a measurement or an inference.
        self.seen_ext = set()
        self.saw_gps2 = False

    # -- message handling ------------------------------------------------

    def _handle(self, msg):
        t = msg.get_type()
        if t == "GPS_RAW_INT":
            return self._gps_row(msg)
        if t == "GPS2_RAW":
            self.saw_gps2 = True
            self.latest["gps2_fix_type"] = msg.fix_type
            self.latest["gps2_sats"] = msg.satellites_visible
        elif t == "GLOBAL_POSITION_INT":
            self.latest["gpos_lat"] = msg.lat / 1e7
            self.latest["gpos_lon"] = msg.lon / 1e7
            self.latest["gpos_rel_alt_m"] = msg.relative_alt / 1000.0
        elif t == "EKF_STATUS_REPORT":
            self.latest["ekf_flags"] = msg.flags
            self.latest["ekf_pos_horiz_acc"] = getattr(msg, "pos_horiz_accuracy", None)
            self.latest["ekf_pos_horiz_var"] = msg.pos_horiz_variance
            self.latest["ekf_compass_var"] = msg.compass_variance
            self.latest["ekf_vel_var"] = msg.velocity_variance
        elif t == "SYS_STATUS":
            bit = mavutil.mavlink.MAV_SYS_STATUS_SENSOR_GPS
            self.latest["sys_gps_present"] = int(bool(msg.onboard_control_sensors_present & bit))
            self.latest["sys_gps_enabled"] = int(bool(msg.onboard_control_sensors_enabled & bit))
            self.latest["sys_gps_health"] = int(bool(msg.onboard_control_sensors_health & bit))
        elif t == "VFR_HUD":
            self.latest["vfr_heading"] = msg.heading
            self.latest["vfr_groundspeed_ms"] = round(msg.groundspeed, 3)
        elif t == "ATTITUDE":
            self.latest["yaw_deg"] = round(math.degrees(msg.yaw) % 360, 1)
        elif t == "STATUSTEXT":
            self._event(msg)
        return None

    def _event(self, msg):
        text = msg.text.strip() if isinstance(msg.text, str) else \
            msg.text.decode(errors="replace").strip()
        rec = {"ts": time.time(), "t_scenario_s": round(time.time() - self.t0, 2),
               "scenario": self.scenario, "severity": msg.severity, "text": text}
        self.events.append(rec)
        self.events_fh.write(json.dumps(rec) + "\n")
        self.events_fh.flush()

    def _gps_row(self, msg):
        now = time.time()
        # getattr, not msg.h_acc: on a MAVLink1 link these attributes do not
        # exist and a direct access raises rather than returning nothing.
        # UINT32_MAX is the "unknown" sentinel for all four, and a receiver that
        # is still searching sends it on every message. Left raw it lands in the
        # CSV as a 4,294 km accuracy claim.
        def ext(name):
            value = getattr(msg, name, 0) or 0
            return 0 if value == gq.ACC_UNKNOWN_MM else value

        h_acc, v_acc = ext("h_acc"), ext("v_acc")
        vel_acc, hdg_acc = ext("vel_acc"), ext("hdg_acc")
        for name, value in (("h_acc", h_acc), ("v_acc", v_acc),
                            ("vel_acc", vel_acc), ("hdg_acc", hdg_acc)):
            if value:
                self.seen_ext.add(name)

        hdop = gq.decode_hdop(msg.eph)
        vdop = gq.decode_hdop(msg.epv)
        acc_m, acc_src = gq.decode_accuracy(h_acc, msg.eph)
        grade = gq.grade_fix(msg.fix_type, msg.satellites_visible, hdop, acc_m)

        row = dict.fromkeys(CSV_FIELDS)
        row.update(self.latest)
        row.update({
            "ts_unix": round(now, 3),
            "ts_iso": datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="seconds"),
            "scenario": self.scenario,
            "phase": self.phase,
            "t_scenario_s": round(now - self.t0, 2),
            "fix_type": msg.fix_type,
            "fix_name": gq.fix_name(msg.fix_type),
            "sats": msg.satellites_visible,
            "hdop": round(hdop, 2) if hdop is not None else None,
            "vdop": round(vdop, 2) if vdop is not None else None,
            "h_acc_m": round(h_acc / 1000.0, 3) if h_acc else None,
            "v_acc_m": round(v_acc / 1000.0, 3) if v_acc else None,
            "vel_acc_ms": round(vel_acc / 1000.0, 3) if vel_acc else None,
            "hdg_acc_deg": round(hdg_acc / 1e5, 2) if hdg_acc else None,
            "acc_m": round(acc_m, 3) if acc_m is not None else None,
            "acc_source": acc_src,
            "grade": grade,
            # Null Island suppression, same rule as the server: 0/0 is what
            # ArduPilot publishes before it has anything, and it is a real
            # coordinate in the Gulf of Guinea.
            "lat": msg.lat / 1e7 if (msg.lat or msg.lon) else None,
            "lon": msg.lon / 1e7 if (msg.lat or msg.lon) else None,
            "alt_msl_m": round(msg.alt / 1000.0, 2),
            "cog_deg": round(msg.cog / 100.0, 2) if msg.fix_type >= 2 and msg.cog != 65535 else None,
            "gps_speed_ms": round(msg.vel / 100.0, 2) if msg.vel != 65535 else None,
        })
        self.writer.writerow(row)
        self.rows.append(row)
        return row

    # -- loops -----------------------------------------------------------

    def flush(self, seconds=0.5):
        """Drain and DISCARD. Used after an input() prompt, where the serial
        buffer has been filling with stale pre-scenario samples the whole time
        the operator was walking somewhere."""
        deadline = time.time() + seconds
        while time.time() < deadline:
            if self.master.recv_match(blocking=True, timeout=0.1) is None:
                continue

    def run(self, seconds, scenario, tracker=None, live=True, on_tick=None):
        """Record for `seconds`. Returns the rows produced in that window."""
        self.scenario = scenario
        self.t0 = time.time()
        start = len(self.rows)
        deadline = self.t0 + seconds
        last_draw = 0.0
        while time.time() < deadline:
            msg = self.master.recv_match(blocking=True, timeout=0.2)
            if msg is not None:
                try:
                    row = self._handle(msg)
                except Exception as exc:  # noqa: BLE001
                    print(f"\n  (skipped a {msg.get_type()}: {exc})")
                    row = None
                if row and tracker is not None:
                    tracker.feed(row["t_scenario_s"], row["fix_type"], row["grade"])
            if on_tick is not None:
                on_tick(self)
            if live and time.time() - last_draw > 0.5:
                last_draw = time.time()
                self._draw(deadline - time.time())
        if live:
            sys.stdout.write("\r" + " " * 78 + "\r")
            sys.stdout.flush()
        return self.rows[start:]

    def _draw(self, remaining):
        r = self.rows[-1] if self.rows else None
        if r is None:
            line = "  waiting for GPS_RAW_INT…"
        else:
            acc = f"±{r['acc_m']:.1f} m" if r["acc_m"] is not None else "±? m"
            hdop = f"{r['hdop']:.2f}" if r["hdop"] is not None else "—"
            line = (f"  {r['fix_name']:<9} {str(r['sats'] or 0):>2} sats  "
                    f"hdop {hdop:>5}  {acc:>9}  {r['grade']:<6}")
        sys.stdout.write(f"\r{line}  [{int(max(0, remaining)):>4}s]".ljust(78))
        sys.stdout.flush()


# ---------------------------------------------------------------- summaries


def fmt_ttff(seconds):
    if seconds is None:
        return "—"
    return f"{int(seconds) // 60:02d}:{int(seconds) % 60:02d}"


def _stats(values):
    vals = [v for v in values if v is not None]
    if not vals:
        return None
    return min(vals), statistics.median(vals), max(vals)


def summarise(scenario, rows, tracker, events):
    """The per-scenario block, as a list of lines. Same text to stdout and file."""
    title = f"{scenario['key']} — {scenario['title']}"
    span = rows[-1]["t_scenario_s"] if rows else 0
    lines = [f"{title:<52} {span:.0f} s, {len(rows)} samples"]

    if not rows:
        lines.append("  NO GPS_RAW_INT RECEIVED. The receiver is not streaming — check")
        lines.append("  the GPS is wired to the SERIAL3/GPS1 port and GPS_TYPE is not 0.")
        return lines

    lines.append(f"  TTFF   any fix {fmt_ttff(tracker.get('any'))}    "
                 f"3D {fmt_ttff(tracker.get('3d'))}    "
                 f"fair {fmt_ttff(tracker.get('fair'))}    "
                 f"good {fmt_ttff(tracker.get('good'))}    "
                 f"survey {fmt_ttff(tracker.get('survey'))}")

    counts = {g: 0 for g in gq.GRADES}
    for r in rows:
        counts[r["grade"]] = counts.get(r["grade"], 0) + 1
    pct = "  ".join(f"{g} {100.0 * counts[g] / len(rows):.0f}%" for g in gq.GRADES)
    lines.append(f"  grade  {pct}")

    sats = _stats([r["sats"] for r in rows])
    hdop = _stats([r["hdop"] for r in rows])
    if sats:
        lines.append(f"  sats   min {sats[0]:.0f}  median {sats[1]:.0f}  max {sats[2]:.0f}"
                     + (f"        hdop  min {hdop[0]:.2f}  median {hdop[1]:.2f}  "
                        f"max {hdop[2]:.2f}" if hdop else "        hdop  not reported"))

    accs = [r["acc_m"] for r in rows if r["acc_m"] is not None]
    if accs:
        srcs = {r["acc_source"] for r in rows if r["acc_source"]}
        src = "reported" if srcs == {"reported"} else "/".join(sorted(srcs))
        lines.append(f"  acc    claimed mean ±{sum(accs) / len(accs):.1f} m ({src})"
                     f"   worst ±{max(accs):.1f} m")
    else:
        lines.append("  acc    not reported and no HDOP to estimate from")

    mine = [e for e in events if e["scenario"] == scenario["key"]]
    prearm = [e for e in mine if "PreArm" in e["text"] or "EKF" in e["text"]]
    if prearm:
        seen = {}
        for e in prearm:
            seen.setdefault(e["text"], e["t_scenario_s"])
        for text, first in list(seen.items())[:4]:
            n = sum(1 for e in prearm if e["text"] == text)
            lines.append(f"  status {n} x \"{text}\"  (first at t+{first:.0f} s)")

    if scenario.get("scatter"):
        lines.extend(_scatter_lines(rows))
    return lines


def _scatter_lines(rows):
    samples = [{"t": r["t_scenario_s"], "lat": r["lat"], "lon": r["lon"],
                "acc_m": r["acc_m"]}
               for r in rows if r["lat"] is not None]
    if len(samples) < 30:
        return ["  scatter  too few positioned samples to measure dispersion"]

    s = gq.scatter_summary(samples)
    lines = [
        f"  mean position  {s['mean_lat']:.7f}, {s['mean_lon']:.7f}",
        f"  measured       CEP50 {s['cep50']:.2f} m   CEP95 {s['cep95']:.2f} m   "
        f"max {s['max']:.2f} m   2DRMS {s['two_drms']:.2f} m",
    ]
    if s["claimed_mean"] is not None:
        lines.append(f"  claimed        mean accuracy ±{s['claimed_mean']:.2f} m")
    if s["ratio"] is not None:
        verdict = ("healthy" if 1.7 <= s["ratio"] <= 2.5
                   else "RECEIVER IS OPTIMISTIC" if s["ratio"] > 2.5 else "conservative")
        lines.append(f"  ratio          CEP95 / claimed = {s['ratio']:.2f}   "
                     f"({verdict}; healthy is 1.7-2.5)")
    if s["drift_m"] is not None:
        lines.append(f"  drift          first minute to last minute: {s['drift_m']:.2f} m")
    return lines


def gate_report(results):
    """Check the survey against the criteria for trusting this in the UI.

    These are the questions Phase 2 is gated on, so they are evaluated here
    rather than left for someone to eyeball out of a CSV at the dock.
    """
    lines = ["", "GATE CHECKS", "-" * 68]
    by_key = {r["scenario"]["key"]: r for r in results}

    def ttff(key, tier):
        r = by_key.get(key)
        return r["tracker"].get(tier) if r else None

    def verdict(label, ok, detail):
        mark = "PASS" if ok else ("FAIL" if ok is False else "n/a ")
        lines.append(f"  [{mark}] {label}  — {detail}")

    t3d, tgood = ttff("cold-open", "3d"), ttff("cold-open", "good")
    if "cold-open" in by_key:
        verdict("cold start reaches 3D within 60 s",
                t3d is not None and t3d <= 60, f"3D at {fmt_ttff(t3d)}")
        verdict("cold start reaches good within 120 s",
                tgood is not None and tgood <= 120, f"good at {fmt_ttff(tgood)}")

    thot = ttff("hot-open", "good")
    if "hot-open" in by_key:
        verdict("hot start reaches good within 15 s",
                thot is not None and thot <= 15, f"good at {fmt_ttff(thot)}")

    r = by_key.get("static-scatter")
    if r:
        s = r.get("scatter")
        if s and s.get("cep50") is not None:
            verdict("stationary CEP50 within 2.5 m", s["cep50"] <= 2.5,
                    f"CEP50 {s['cep50']:.2f} m")
            verdict("stationary CEP95 within 5 m", s["cep95"] <= 5.0,
                    f"CEP95 {s['cep95']:.2f} m")
        if s and s.get("ratio") is not None:
            verdict("receiver's claimed accuracy is not optimistic", s["ratio"] <= 2.5,
                    f"ratio {s['ratio']:.2f} — if this fails, scale the map's "
                    f"accuracy circle by it")

    r = by_key.get("indoors")
    if r:
        best = max((gq.grade_rank(row["grade"]) for row in r["rows"]), default=0)
        lines.append("")
        verdict("HARD GATE: indoors never grades good or survey",
                best < gq.grade_rank("good"),
                f"best grade indoors was `{gq.GRADES[max(best, 0)]}`")
        if best >= gq.grade_rank("good"):
            lines.append("         The receiver reports a good fix where it cannot have one.")
            lines.append("         Every gating feature in the console depends on it not")
            lines.append("         doing that. Do not build the UI integration on this.")
    return lines


# ---------------------------------------------------------------- modes


def run_scenarios(survey, scenarios):
    results = []
    for i, scenario in enumerate(scenarios, 1):
        print("\n" + "=" * 70)
        print(f"[{i}/{len(scenarios)}]  {scenario['key']} — {scenario['title']}")
        print(f"          {scenario['measures']}")
        print("-" * 70)
        for line in scenario["prompt"].split("\n"):
            print(f"  {line}")
        print(f"\n  Then it records for {scenario['hold_s']} s. Ctrl-C skips this scenario.")
        try:
            input("  > ")
        except (EOFError, KeyboardInterrupt):
            print("\n  skipped.")
            continue

        # The operator has been walking around for minutes; everything queued on
        # the serial port describes where they used to be.
        survey.flush(1.0)
        tracker = gq.TTFFTracker()
        try:
            rows = survey.run(scenario["hold_s"], scenario["key"], tracker)
        except KeyboardInterrupt:
            print("\n  cut short.")
            rows = [r for r in survey.rows if r["scenario"] == scenario["key"]]

        result = {"scenario": scenario, "rows": rows, "tracker": tracker}
        if scenario.get("scatter"):
            samples = [{"t": r["t_scenario_s"], "lat": r["lat"], "lon": r["lon"],
                        "acc_m": r["acc_m"]} for r in rows if r["lat"] is not None]
            if len(samples) >= 30:
                result["scatter"] = gq.scatter_summary(samples)
        results.append(result)

        print()
        for line in summarise(scenario, rows, tracker, survey.events):
            print(line)
    return results


def run_continuous(survey, duration, label):
    print(f"\nRecording continuously for {duration} s as `{label}`.")
    print("Press Enter at any point to mark the log; Ctrl-C to stop early.\n")
    tracker = gq.TTFFTracker()
    marks = {"n": 0}

    def on_tick(s):
        # Non-blocking stdin so an annotation never stalls the sample loop.
        try:
            ready, _, _ = select.select([sys.stdin], [], [], 0)
        except (OSError, ValueError):
            return
        if ready:
            sys.stdin.readline()
            marks["n"] += 1
            s.phase = f"mark{marks['n']}"
            print(f"\n  marked #{marks['n']} at t+{time.time() - s.t0:.0f} s\n")

    try:
        rows = survey.run(duration, label, tracker, on_tick=on_tick)
    except KeyboardInterrupt:
        print("\n  stopped.")
        rows = [r for r in survey.rows if r["scenario"] == label]

    scenario = {"key": label, "title": "continuous log", "scatter": True,
                "measures": "continuous"}
    result = {"scenario": scenario, "rows": rows, "tracker": tracker}
    samples = [{"t": r["t_scenario_s"], "lat": r["lat"], "lon": r["lon"],
                "acc_m": r["acc_m"]} for r in rows if r["lat"] is not None]
    if len(samples) >= 30:
        result["scatter"] = gq.scatter_summary(samples)
    print()
    for line in summarise(scenario, rows, tracker, survey.events):
        print(line)
    return [result]


# ---------------------------------------------------------------- main


def write_report(path, header, results, survey):
    with open(path, "w") as fh:
        fh.write("# GPS survey\n\n")
        for line in header:
            fh.write(f"- {line}\n")
        fh.write("\n## Scenarios\n\n")
        for r in results:
            fh.write("```\n")
            for line in summarise(r["scenario"], r["rows"], r["tracker"], survey.events):
                fh.write(line + "\n")
            fh.write("```\n\n")
        fh.write("## Gate checks\n\n```\n")
        for line in gate_report(results):
            fh.write(line + "\n")
        fh.write("```\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--list", action="store_true", help="print the scenarios and exit")
    ap.add_argument("--only", help="comma-separated scenario keys to run")
    ap.add_argument("--skip", help="comma-separated scenario keys to skip")
    ap.add_argument("--continuous", action="store_true",
                    help="one long unattended log instead of guided scenarios")
    ap.add_argument("--duration", type=int, default=1800, help="--continuous length, seconds")
    ap.add_argument("--label", default="continuous", help="--continuous scenario label")
    ap.add_argument("--out", default=OUT_DIR, help="where to write the csv/md/jsonl")
    ap.add_argument("--force", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args()

    if args.list:
        print(f"\n{'key':<16} {'hold':>6}  what it measures")
        print("-" * 70)
        for s in SCENARIOS:
            tag = " (--only)" if s.get("optional") else ""
            print(f"{s['key']:<16} {s['hold_s']:>5}s  {s['measures']}{tag}")
        total = sum(s["hold_s"] for s in SCENARIOS if not s.get("optional"))
        print(f"\nDefault run: {total // 60} minutes of recording, plus the time you\n"
              f"spend walking between scenarios and power-cycling.\n")
        return 0

    scenarios = [s for s in SCENARIOS if not s.get("optional")]
    if args.only:
        keys = [k.strip() for k in args.only.split(",")]
        unknown = [k for k in keys if k not in {s["key"] for s in SCENARIOS}]
        if unknown:
            raise SystemExit(f"Unknown scenario(s): {', '.join(unknown)}. Try --list.")
        scenarios = [s for s in SCENARIOS if s["key"] in keys]
    if args.skip:
        skip = {k.strip() for k in args.skip.split(",")}
        scenarios = [s for s in scenarios if s["key"] not in skip]

    print("\nGPS survey\n" + "=" * 70)
    if not preflight(force=args.force):
        return 1

    master = connect()
    stream_note = request_streams(master)
    print(f"  {stream_note}")
    params = fetch_params(master, PARAMS)

    os.makedirs(args.out, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base = os.path.join(args.out, f"gps_survey_{stamp}")
    csv_path, md_path, ev_path = base + ".csv", base + ".md", base + ".events.jsonl"

    with open(csv_path, "w", newline="") as csv_fh, open(ev_path, "w") as ev_fh:
        writer = csv.DictWriter(csv_fh, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        survey = Survey(master, writer, ev_fh)

        # Capability probe. This decides whether every accuracy number below is
        # a measurement the receiver made or an inference we made from HDOP,
        # which is a different claim and must not be read as the same one.
        print("\n  Probing what this link actually reports (5 s)…")
        survey.run(5.0, "probe", live=False)
        dialect = "2.0" if master.mavlink20() else "1.0"
        ext = ", ".join(sorted(survey.seen_ext)) if survey.seen_ext else "none"
        if survey.seen_ext:
            acc_note = f"accuracy is RECEIVER-REPORTED (fields present: {ext})"
        else:
            acc_note = (f"accuracy is ESTIMATED from HDOP x {gq.UERE_M} m — the receiver "
                        f"reports no h_acc, so the claimed-vs-measured ratio is "
                        f"meaningless and every ± figure below is an inference")
        print(f"  MAVLink dialect {dialect}; {acc_note}")
        if not survey.rows:
            print("  !! No GPS_RAW_INT arrived in 5 s. The survey will record nothing.")
        # GPS_TYPE2 0 means there is no second receiver — its absence is normal,
        # not a fault, and should not be reported as one.
        if params.get("GPS_TYPE2") in (0, 0.0):
            print("  GPS_TYPE2 is 0 — no second receiver, so gps2_* columns stay blank.")

        header = [
            f"Recorded {datetime.now().isoformat(timespec='seconds')}",
            f"Port {PORT} @ {BAUD}",
            f"MAVLink dialect {dialect}",
            f"Accuracy source: {acc_note}",
            f"MAVLink2 extension fields seen: {ext}",
            stream_note,
            "Params: " + ", ".join(
                f"{k}={'—' if v is None else (int(v) if float(v).is_integer() else v)}"
                for k, v in params.items()),
        ]

        try:
            if args.continuous:
                results = run_continuous(survey, args.duration, args.label)
            else:
                results = run_scenarios(survey, scenarios)
        except KeyboardInterrupt:
            print("\nInterrupted.")
            results = []

        print("\n" + "=" * 70)
        for line in gate_report(results):
            print(line)

        write_report(md_path, header, results, survey)

    print(f"\nWrote:\n  {csv_path}\n  {md_path}\n  {ev_path}")
    if _systemd_state(SERVICE) == "inactive":
        print(f"\nRemember to bring the server back up:\n  sudo systemctl start {SERVICE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
