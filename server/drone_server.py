"""
Seagrass drone server — runs on the Raspberry Pi 5.

Bridges the React GCS to the Pixhawk over MAVLink. Mirrors the channel
mapping in keyboard_control.py so the UI and the CLI tool behave identically.
Steering rides on Yaw (ch4), not Lateral (ch6): this 2-motor frame has no
lateral thruster, so ch6 has no authority — ch4's differential is what turns
the vehicle. Light is on ch7 so it never fights steering.

    W/S -> ch5 forward         A/D -> ch4 steering (yaw)
    Q/E -> ch3 vertical        L/K -> ch7 light

Security:
  - Set SEAGRASS_TOKEN in the environment; every client must send it in a
    {"type": "hello", "token": "..."} message before any command is accepted.
  - For remote use, put this behind a Cloudflare Tunnel (wss://) instead of
    exposing port 8765 to the internet.

Safety:
  - Watchdog: if a client stops sending anything for WATCHDOG_S seconds while
    motion keys are held, all channels are forced to neutral.
  - On client disconnect: all-stop.
  - "stop" (gamepad OPTIONS / keyboard SPACE / UI ALL STOP) is a hard kill:
    all-stop + disarm + camera off + the server process exits. Restarting
    the server is required before the vehicle can move again.
  - Only one client may hold the helm at a time (first come, first served).

Run:
    pip install pymavlink websockets
    SEAGRASS_TOKEN=your-secret python3 drone_server.py
"""

import asyncio
import json
import math
import os
import signal
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

import websockets
from pymavlink import mavutil

from sonar_reader import SonarReader

# pid_controller.py lives at the repo root (one level up from server/), so make
# it importable without installing the package.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pid_controller import PIDController, wrap_deg  # noqa: E402

# ---------------- configuration ----------------
SERIAL_PORT = os.environ.get("PIXHAWK_PORT", "/dev/ttyACM0")
BAUD = int(os.environ.get("PIXHAWK_BAUD", "115200"))
WS_HOST = "0.0.0.0"
WS_PORT = int(os.environ.get("SEAGRASS_PORT", "8765"))
# Optional TLS, for driving the vehicle from a page loaded over HTTPS (e.g. a
# deployed frontend) — browsers refuse a ws:// connection from an https:// page
# (mixed content), so remote control needs a real wss://.
#
# Deliberately terminated HERE rather than behind `tailscale serve`: that proxy
# fronts plain HTTP reverse-proxying, and its WebSocket path has open upstream
# reliability reports (connections dropping every 10-40s) — unacceptable for a
# live control link. `tailscale cert` issues a real Let's Encrypt certificate
# for the device's tailnet name for free; this server terminates TLS with it
# directly, so the WS connection is a standard, well-tested TLS+WebSocket
# server with nothing flaky in between. The cert does not auto-renew — see
# scripts/renew-tls-cert.sh and its systemd timer.
WS_TLS_CERT = os.environ.get("WS_TLS_CERT", "")
WS_TLS_KEY = os.environ.get("WS_TLS_KEY", "")
TOKEN = os.environ.get("SEAGRASS_TOKEN", "")  # empty = auth disabled (LAN only!)
if not TOKEN:
    raise SystemExit("SEAGRASS_TOKEN must be set — export it before running this script.")
WATCHDOG_S = 1.5
# Separate, much longer watchdog for AUTONOMOUS motion (heading hold).
#
# WATCHDOG_S above works for manual control because it only applies while a key
# or stick is held, and a client doing that is streaming input messages several
# times a second — so last_seen is always fresh. Heading hold is motion with NO
# operator input, where the only thing refreshing last_seen is DroneLink's
# keepalive ping every 5s (src/lib/droneLink.js, _keepAlive). Reusing 1.5s there
# meant the watchdog fired within 1.5s of every engage, so the hold released
# almost immediately, every time.
#
# 12s tolerates a lost ping and some jitter. It does NOT delay the response to a
# client actually going away: a closed socket disengages the hold immediately in
# client_handler's finally block. This only covers the case where the TCP
# connection is still up but the client has stopped talking.
HOLD_WATCHDOG_S = 12.0

# Stream the RC override frame to the Pixhawk at this rate, every tick even
# when nothing changed, so ArduSub's manual-control (pilot-input) failsafe
# always sees a live pilot. keyboard_control.py streams at 50 Hz for exactly
# this reason; sending only on key change (what this server did before) left
# multi-second gaps with no RC override whenever no motion key was held —
# right after arming most of all — which is when "Lost manual control" fired.
CONTROL_HZ = 50
CONTROL_PERIOD_S = 1.0 / CONTROL_HZ

NEUTRAL_PWM = 1500
LIGHT_ON_PWM = 1900

# ============================================================================
#  FEEL TUNING — edit these while testing. Bigger/smaller effects noted inline.
#  Ported from keyboard_control.py, then rebalanced so forward and turning both
#  read as a smooth analog "push more = faster" spectrum (turning no longer
#  snaps in ~4x quicker than forward and no longer guts forward mid-turn).
#  Each knob also reads an env var, so you can override live without editing:
#    SEAGRASS_MAX_OFFSET=300 SEAGRASS_STEER_OFFSET=180 python3 server/drone_server.py
#  Restart the server after editing for changes to take effect.
# ============================================================================

# -- Top speed (peak PWM offset from NEUTRAL_PWM; vehicle hard limit is +/-400,
#    i.e. RC*_MIN 1100 / RC*_MAX 1900) ---------------------------------------
MAX_PWM_OFFSET   = int(os.environ.get("SEAGRASS_MAX_OFFSET",   "250"))  # forward/back + depth. Bigger = faster.
STEER_MAX_OFFSET = int(os.environ.get("SEAGRASS_STEER_OFFSET", "150"))  # turn only. Bigger = sharper/spinnier turn.

# -- Ramp-up = seconds a held/full input takes to build to full power (bigger =
#    gentler spin-up); Decay = seconds to fall back to stopped after release
#    (bigger = longer coast, smaller = crisper stop). The two RAMP_UP knobs below
#    are THE dial for how gradual the spin-up feels, and do NOT change top speed
#    (that's MAX_PWM_OFFSET). The ramp is EASED, not linear (see RAMP_EASE_RATIO
#    and _ramp): rate grows with how fast you're already going, so the spin-up
#    starts gentle and accelerates. Rate keys off current speed, not off how far
#    away the target is, so a small stick nudge is still reached quickly -- it's
#    just a short trip -- while a full-stick pull takes the whole ramp_up_s.
#
#    NOTE on surge: SPRINT_FRACTION below puts a knee in the surge ramp, so
#    SURGE_RAMP_UP_S is "seconds from the knee to top speed", not from a
#    standstill. Total time to top = SURGE_SPRINT_UP_S + SURGE_RAMP_UP_S. Steer
#    and depth have no knee, so for them it stays "seconds to full". ---------
SURGE_RAMP_UP_S  = float(os.environ.get("SEAGRASS_SURGE_RAMP", "5"))  # forward: seconds from knee to full. Bigger = gentler/chiller.
SURGE_DECAY_S    = 0.1
# Steer is a differential with far less inertia than surge and no lurch to
# prevent, and 5s to full yaw is unsteerable while inching, so it ramps quicker.
# It still gets the same ease-in curve and creep floor -- only the duration differs.
STEER_RAMP_UP_S  = float(os.environ.get("SEAGRASS_STEER_RAMP", "2.5"))  # turn: seconds to full. Bigger = smoother, less snappy.
STEER_DECAY_S    = 0.25
# Depth fights buoyancy, so a full 5s risks sluggish depth capture.
DEPTH_RAMP_UP_S  = float(os.environ.get("SEAGRASS_DEPTH_RAMP", "2.0"))
DEPTH_DECAY_S    = 0.4

# -- Spin-up shape -----------------------------------------------------------
# RAMP_EASE_RATIO (r): how much faster the ramp climbs at full speed than at the
# moment thrust starts. 1.0 = perfectly linear (the old behaviour, exact
# rollback); 4.0 = tops out climbing 4x quicker than it starts, which reads as
# "eases away gently, then builds". Drop toward 2 if fine trim feels mushy.
#
# Rate f(v) = a + b*v over v = progress across the useful band, with
# b = a(r-1) so f(1)/f(0) = r, and total time
#   T = integral(0..1) dv/(a + b*v) = ln(r) / (a(r-1))   =>   a = ln(r)/(T(r-1)).
# _EASE_A/_EASE_B factor out T so the 50Hz control loop never calls log().
RAMP_EASE_RATIO = float(os.environ.get("SEAGRASS_RAMP_EASE", "4.0"))
_EASE_A = (math.log(RAMP_EASE_RATIO) / (RAMP_EASE_RATIO - 1.0)
           if abs(RAMP_EASE_RATIO - 1.0) > 1e-9 else 1.0)   # r->1 limit is 1/T
_EASE_B = _EASE_A * (RAMP_EASE_RATIO - 1.0)
# Seconds to cross the sub-CREEP_FLOOR dead band, where the props aren't biting
# and nothing is felt. Easing through it would just be a delay before anything
# happens, so we cross it fast and start the ease-in at the point thrust begins.
RAMP_ENGAGE_S = float(os.environ.get("SEAGRASS_RAMP_ENGAGE", "0.3"))

# -- Two-stage surge ramp ("sprint, then earn the rest") ---------------------
# Splits the surge spin-up at a knee: a full-stick hold sprints to
# SURGE_SPRINT_FRACTION of top speed in SURGE_SPRINT_UP_S, then grinds out the
# remainder over SURGE_RAMP_UP_S. Top speed is untouched (still MAX_PWM_OFFSET) --
# this only reshapes the trip there, so most of the usable speed arrives promptly
# while the last stretch has to be earned by holding the stick.
#
# The fraction is of TOP SPEED, so 0.6 means the knee sits at 0.6*MAX_PWM_OFFSET
# and reads "full stick gets you 3/5 of top speed quickly, the last 2/5 takes
# SURGE_RAMP_UP_S". Clamped up to CREEP_FLOOR: a knee under the floor is a knee
# inside the dead band, which the engage branch has already crossed. Set to 1.0
# to remove the knee (single-stage; SPRINT_UP_S then has no effect and
# SURGE_RAMP_UP_S goes back to meaning "seconds to full").
# Surge only, by deliberate omission: steer's 2.5s ramp is already tuned to stay
# steerable while inching, and depth fights buoyancy, so neither wants a knee.
SURGE_SPRINT_FRACTION = float(os.environ.get("SEAGRASS_SPRINT_FRACTION", "0.6"))
SURGE_SPRINT_FRACTION = max(0.0, min(1.0, SURGE_SPRINT_FRACTION))
# Seconds for that first stage. Eased on the same curve as the second, so the
# sprint still starts gently off the creep floor rather than lurching.
SURGE_SPRINT_UP_S = float(os.environ.get("SEAGRASS_SPRINT_RAMP", "1.2"))

# -- Creep floor -------------------------------------------------------------
# CREEP_FLOOR: the smallest PWM offset that actually spins a thruster. Below
# ArduSub's MOT_SPIN_MIN a motor buzzes without turning, so a small stick nudge
# would command "motion" that never arrives; this lifts a stalled command up to
# the point it bites, letting you inch. Applied in the MOTOR domain
# (_apply_creep_floor) because MOT_SPIN_MIN is a per-motor deadband -- flooring
# each channel separately would rotate the commanded heading.
#
# CALIBRATE, don't guess: set SEAGRASS_CREEP_FLOOR=0, put the vehicle in water,
# ease the stick up until the props bite, and read left_pwm/right_pwm off the
# live motors readout. If MOT_SPIN_MIN is already non-zero in QGroundControl,
# ArduSub is doing this for you -- stacking a second floor turns the smallest
# nudge into a lurch, so leave this at 0.
CREEP_FLOOR = float(os.environ.get("SEAGRASS_CREEP_FLOOR", "0"))
# Above min(surge cap, steer cap) the scaling bound in _apply_creep_floor no
# longer holds (a floored command could exceed an axis's own maximum).
CREEP_FLOOR = max(0.0, min(CREEP_FLOOR, float(min(MAX_PWM_OFFSET, STEER_MAX_OFFSET))))

# -- Direction ---------------------------------------------------------------
# SURGE_REVERSED: flip forward/back polarity on ch5 in software. Set when a
# "forward" command spins the thrusters the wrong way (this frame drove both
# motors backward on forward). The canonical fix is on the Pixhawk
# (MOT_1/2_DIRECTION or RC5_REVERSED) so every control path agrees; this is the
# quick server-only override. Toggle with SEAGRASS_SURGE_REVERSED=0 to undo.
SURGE_REVERSED = os.environ.get("SEAGRASS_SURGE_REVERSED", "1") not in ("0", "false", "False", "")
SURGE_SIGN = -1.0 if SURGE_REVERSED else 1.0
# STEER_REVERSED: same idea for yaw (ch4). Turning is a two-motor differential
# (ArduSub speeds one thruster up and slows the other) — if left/right come out
# swapped, the differential is applied the wrong way; flip it here. Undo with
# SEAGRASS_STEER_REVERSED=0.
STEER_REVERSED = os.environ.get("SEAGRASS_STEER_REVERSED", "1") not in ("0", "false", "False", "")
STEER_SIGN = -1.0 if STEER_REVERSED else 1.0

# -- Drive mode --------------------------------------------------------------
# VECTOR_DRIVE: pure differential (tank/arcade) mixing where the stick's exact
# direction maps geometrically to the two motors — equal gain on both axes, no
# expo / turn-assist / arc-cap. Stick right = spin in place (motors opposite,
# equal speed); stick at 45deg = one motor only; stick forward = both together;
# everything between is a smooth spectrum. ArduSub already mixes ch5+ch4 as
# left=ch5+ch4 / right=ch5-ch4, so sending surge on ch5 and steer on ch4 at the
# SAME scale reproduces that mapping. Enable with SEAGRASS_VECTOR_DRIVE=1.
# When off, the game-feel path below (expo, turn-assist, ARC_TURN) is used.
VECTOR_DRIVE = os.environ.get("SEAGRASS_VECTOR_DRIVE", "0") not in ("0", "false", "False", "")
# Shared top-speed for both axes in vector mode (equal gain is what makes the
# 45deg = one-motor geometry hold). Defaults to the forward top-speed knob.
VECTOR_MAX_OFFSET = int(os.environ.get("SEAGRASS_VECTOR_OFFSET", str(MAX_PWM_OFFSET)))

# ANGLE_TABLE_DRIVE: the most explicit mode. Instead of any fixed mix, you define
# exactly what each motor does at each joystick angle in ANGLE_TABLE below, and the
# code interpolates smoothly between entries and scales by how far the stick is
# pushed. It still goes out on ch5/ch4 (we invert ArduSub's mixer:
# ch5=forward=(L+R)/2, ch4=yaw=(L-R)/2), so ArduSub's motor safety/thrust-curve and
# our watchdog/all-stop all keep working. Takes precedence over VECTOR_DRIVE when
# both are set. Enable with SEAGRASS_ANGLE_TABLE_DRIVE=1.
ANGLE_TABLE_DRIVE = os.environ.get("SEAGRASS_ANGLE_TABLE_DRIVE", "0") not in ("0", "false", "False", "")

# Editable behaviour map: angle (degrees, unit-circle convention — 0=right,
# 90=forward, 180=left, 270=reverse) -> (left_motor, right_motor), each in
# [-1.0, 1.0].
#   sign     = direction (+ shows "CW" in the readout, - shows "CCW")
#   magnitude= speed (1.0 = full = +/-MAX_PWM_OFFSET, 0.5 = half, 0.0 = stopped)
# Edit any entry to change that direction; add more keys (e.g. 30, 60) for finer
# control — interpolation and the live readout pick them up automatically.
ANGLE_TABLE = {
    0:   ( -1.0, 1.0),   # hard right: pivot in place
    45:  ( -1.0, 0.0),   # forward-right: left drives, right stops
    90:  ( -1.0, -1.0),   # forward
    135: ( 0.0, -1.0),
    180: (1.0,  -1.0),   # hard left: pivot in place
    225: (1.0,  0.0),
    270: (1.0, 1.0),   # reverse
    315: ( 0.0,  1.0),
}

# ARC_TURN ("turn follows throttle"): while the vehicle is translating, cap the
# yaw so it never exceeds the surge — the inside motor keeps driving in the surge
# direction instead of stalling at the differential balance point. Result is a
# smooth arc (one side slower than the other) instead of a one-motor pivot, so
# forward/back diagonals actually travel. Full yaw is still allowed when
# essentially stopped, so you can still spin in place. Disable: SEAGRASS_ARC_TURN=0.
ARC_TURN = os.environ.get("SEAGRASS_ARC_TURN", "1") not in ("0", "false", "False", "")
# PWM the inside motor is kept above neutral by while arcing, so it stays past
# ArduSub's MOT_SPIN_MIN deadband; also the surge level below which we count as
# "stopped" and allow a full in-place pivot. Bigger = both motors drive harder
# during a reverse/forward arc, but a tighter turn needs more throttle.
ARC_SPIN_MARGIN = int(os.environ.get("SEAGRASS_ARC_MARGIN", "80"))
# ARC_PIVOT_FADE: surge offset over which full-authority pivoting fades out as
# the arc cap fades in. Without it the cap is a cliff -- at surge_off exactly
# ARC_SPIN_MARGIN yaw has 100% authority and one PWM later it has ~0%. Digital
# keys jump clean over that band (surge_off is only ever 0, 187.5 or 250), but an
# analog stick parks in it, and 30-50% throttle is exactly where you inch. Bigger
# = pivot authority bleeds off more gradually.
ARC_PIVOT_FADE = int(os.environ.get("SEAGRASS_ARC_PIVOT_FADE", str(2 * ARC_SPIN_MARGIN)))

# -- Turn behaviour ----------------------------------------------------------
# TURN_ASSIST: fraction of forward power shed mid-turn (scaled by how hard the
# turn is) so the yaw differential stays pronounced instead of both motors
# saturating forward. 0 = none (forward untouched), 0.45 = the old, aggressive
# value that made forward vanish in turns.
TURN_ASSIST = float(os.environ.get("SEAGRASS_TURN_ASSIST", "0.25"))
# STEER_EXPO: steering response curve. 0 = linear (turn rate tracks stick 1:1).
# Higher = more progressive — near center the stick gives a gentle heading trim
# and the turn sharpens toward full lock. Blends linear and cubic, so full lock
# still reaches 100% turn authority.
#
# Defaults to 0 because every analog client (terminal_control.py, and now the
# browser) already applies its own expo in stick_curve before sending. Composing
# the two squashes fine steering to nothing: a 30% steer stick becomes 0.136
# client-side, then 0.043 here -- 6.4 PWM, which does nothing. One expo, applied
# client-side, keeps steering's curve identical to surge's and browser matched to
# terminal. (This knob was always a no-op for digital keys: _expo(±1, k) = ±1.)
# Raise to ~0.3 only if analog steering feels twitchy.
STEER_EXPO = float(os.environ.get("SEAGRASS_STEER_EXPO", "0.0"))
# ============================================================================

# This 2-motor SimpleROV-3 frame has no lateral thruster, so left/right
# steering rides on Yaw (ch4) — sending it on Lateral (ch6) is a channel the
# frame has zero authority over, which is why the stick moved but nothing did.
# Light rides on its own spare channel (ch7) so it can't fight steering the way
# it did when it shared ch4. Both mirror keyboard_control.py, which is the
# known-good mapping that drives correctly on this hardware. Adjust LIGHT_CHANNEL
# if the light relay isn't wired to ch7 (check QGroundControl SERVOx_FUNCTION).
STEER_CHANNEL = 4
LIGHT_CHANNEL = 7

# ---------------- MAVLink layer ----------------
master = None
pixhawk_ok = False
armed = False
mode = "MANUAL"

# Number of connected websocket clients. The mission recorder uses this to decide
# whether it must drain MAVLink itself (no client) to keep `armed` fresh, or leave
# that to the per-client telemetry loop (avoids two concurrent readers).
client_count = 0

# Ping2 sonar reader — runs on its own daemon thread (see sonar_reader.py) so its
# blocking serial reads never touch this asyncio loop. Started in main(), non-fatal
# if the sonar is absent; the telemetry loop broadcasts sonar.latest to the UI.
sonar = SonarReader()

# Altitude-hold PID demo. It runs on the live barometric altitude and its output
# is DISPLAY-ONLY — nothing actuates on it (there is no vertical control authority
# wired). Gains mirror test_pid_synthetic.py. The setpoint is captured from the
# first valid altitude reading ("hold this height"); change pid_setpoint to target
# a fixed altitude or a UI-driven value instead.
alt_pid = PIDController(
    kp=0.3, ki=0.05, kd=0.1,
    output_limits=(-1.0, 1.0),
    integral_limits=(-2.0, 2.0),
)
pid_setpoint = None  # None until the first altitude sample captures it
pid_readout = {
    "setpoint": None, "measurement": None, "error": None,
    "integral": None, "output": None, "ok": False,
}


def reset_alt_pid():
    """Drop PID state so a fresh setpoint is captured on the next altitude sample."""
    global pid_setpoint
    alt_pid.reset()
    pid_setpoint = None
    pid_readout.update(setpoint=None, measurement=None, error=None,
                       integral=None, output=None, ok=False)


def step_alt_pid(altitude):
    """Feed one altitude sample to the PID and refresh pid_readout. altitude is
    the barometric altitude in meters; returns nothing (state lives in globals)."""
    global pid_setpoint
    if pid_setpoint is None:
        pid_setpoint = altitude  # hold whatever height we first saw
        alt_pid.setpoint = pid_setpoint
    output = alt_pid.update(altitude, current_time=time.time())
    pid_readout.update(
        setpoint=round(pid_setpoint, 2),
        measurement=round(altitude, 2),
        error=round(pid_setpoint - altitude, 3),
        integral=round(alt_pid._integral, 3),
        output=round(output, 3),
        ok=True,
    )


# ---------------- heading hold ----------------
# The first closed loop this frame can actually fly. Two forward-facing thrusters
# mean differential thrust steers and nothing controls depth (the buoyancy engine
# that will drive the dive profile is not installed yet), so holding a compass
# bearing is the autonomy that keeps survey transects straight.
#
# Gains are in DEGREES of error and are deliberately gentle. They WILL need
# tuning in water. Do not reach for the altitude demo's kp=0.3 above: at that
# gain a 10 degree error saturates the output immediately, which is bang-bang
# steering that overshoots and weaves (see test_pid_synthetic.py).
HEADING_KP = float(os.environ.get("SEAGRASS_HEADING_KP", "0.03"))
HEADING_KI = float(os.environ.get("SEAGRASS_HEADING_KI", "0.005"))
HEADING_KD = float(os.environ.get("SEAGRASS_HEADING_KD", "0.02"))
# Stick deflection past which the operator counts as steering. Manual input
# always wins.
HEADING_MANUAL_DEADZONE = float(os.environ.get("SEAGRASS_HEADING_DEADZONE", "0.08"))
# Yaw older than this is not trusted. Telemetry runs at ~2 Hz, so a gap this long
# means the link stalled — steering on a stale bearing is worse than not steering.
HEADING_STALE_S = 2.0

heading_pid = PIDController(
    kp=HEADING_KP, ki=HEADING_KI, kd=HEADING_KD,
    output_limits=(-1.0, 1.0),
    integral_limits=(-2.0, 2.0),
    angular=True,  # headings wrap at 0/360 — see pid_controller.wrap_deg
)
heading_hold_engaged = False
heading_hold_suspended = False  # operator is steering; the hold yields
heading_setpoint = None         # degrees, captured on engage
heading_output = 0.0            # steer command in [-1, 1], consumed by channel_frame
heading_last_yaw = None
heading_last_yaw_at = 0.0
heading_readout = {
    "engaged": False, "suspended": False, "setpoint": None,
    "heading": None, "error": None, "output": 0.0, "ok": False,
}


def _refresh_heading_readout():
    heading_readout.update(
        engaged=heading_hold_engaged,
        suspended=heading_hold_suspended,
        setpoint=None if heading_setpoint is None else round(heading_setpoint, 1),
        heading=None if heading_last_yaw is None else round(heading_last_yaw, 1),
        error=None if (heading_setpoint is None or heading_last_yaw is None)
        else round(wrap_deg(heading_setpoint - heading_last_yaw), 1),
        output=round(heading_output, 3),
        ok=heading_hold_engaged and not heading_hold_suspended,
    )


def engage_heading_hold():
    """Capture the current heading and start holding it. Returns (ok, message).

    Refuses unless armed, not soft-stopped, and holding a FRESH yaw sample —
    engaging on a stale or absent compass would confidently steer toward a
    bearing that means nothing, which is the worst failure this loop can have.
    """
    global heading_hold_engaged, heading_hold_suspended, heading_setpoint, heading_output
    if not armed:
        return False, "not armed"
    if motion_latched:
        return False, "soft stop is latched"
    if heading_last_yaw is None or time.time() - heading_last_yaw_at > HEADING_STALE_S:
        return False, "no fresh heading — check the compass"
    heading_pid.reset()
    heading_setpoint = heading_last_yaw
    heading_pid.setpoint = heading_setpoint
    heading_output = 0.0
    heading_hold_engaged = True
    heading_hold_suspended = False
    _refresh_heading_readout()
    print(f"Heading hold: engaged on {heading_setpoint:.1f} deg")
    return True, f"holding {heading_setpoint:.0f} deg"


def disengage_heading_hold(reason=""):
    """Stop holding. Safe to call unconditionally — every cancel path lands here,
    including all_stop(), so a path added later cannot forget to release it."""
    global heading_hold_engaged, heading_hold_suspended, heading_setpoint, heading_output
    if not heading_hold_engaged:
        return
    heading_hold_engaged = False
    heading_hold_suspended = False
    heading_setpoint = None
    # Zeroing the output stops channel_frame injecting; the existing ramp then
    # decays steering to neutral rather than dropping it in one step.
    heading_output = 0.0
    heading_pid.reset()
    _refresh_heading_readout()
    print(f"Heading hold: disengaged{' — ' + reason if reason else ''}")


def step_heading_hold(yaw):
    """Feed one yaw sample (degrees, 0-360) to the heading PID.

    Also the freshness clock for engage_heading_hold(), so it must be called on
    every telemetry pass whether or not the hold is running.
    """
    global heading_last_yaw, heading_last_yaw_at, heading_output, heading_hold_suspended
    global heading_setpoint
    heading_last_yaw = yaw
    heading_last_yaw_at = time.time()

    if not heading_hold_engaged:
        _refresh_heading_readout()
        return

    # Re-check the gates every sample, not just at engage: arming, soft stop and
    # the MAVLink link can all change underneath a running hold.
    if not armed:
        disengage_heading_hold("disarmed")
        return
    if motion_latched:
        disengage_heading_hold("soft stop latched")
        return
    if not pixhawk_ok:
        disengage_heading_hold("Pixhawk link lost")
        return

    # Operator steering always wins. Suspending rather than summing means manual
    # and autonomous commands can never add into a bigger turn than either one
    # asked for.
    if abs(_axis_value("d", "a", axis_targets["steer"])) > HEADING_MANUAL_DEADZONE:
        if not heading_hold_suspended:
            print("Heading hold: suspended — manual steering")
        heading_hold_suspended = True
        heading_output = 0.0
        heading_pid.reset()
        _refresh_heading_readout()
        return

    if heading_hold_suspended:
        # Stick back at centre: adopt whatever bearing the pilot steered onto,
        # so "turn, then let go" sets the new course.
        heading_hold_suspended = False
        heading_setpoint = yaw
        heading_pid.setpoint = yaw
        heading_pid.reset()
        print(f"Heading hold: resumed on {yaw:.1f} deg")

    heading_output = heading_pid.update(yaw, current_time=time.time())
    _refresh_heading_readout()


# ---------------- sonar brake ----------------
# Forward thrust is shed as the Ping2 sees something closing ahead, and cut
# entirely inside SONAR_BRAKE_STOP_M. This is a BRAKE, not obstacle avoidance:
# the Ping2 is one fixed forward beam with no scan and no array, so it can say
# "something is N metres ahead" and nothing whatsoever about which way is clear.
# Steering around an obstacle needs a left/right range comparison this hardware
# cannot make, so the vehicle stops rather than guessing a direction — a guessed
# dodge would also fight heading hold, which has no notion of "obstacle cleared"
# and would simply steer back onto the original bearing and re-approach.
#
# Applied to the surge axis in channel_frame() rather than to the PWM, so it
# rides the same ramp/creep-floor/all-stop paths as any other surge input and
# holds under every drive mode (angle-table, vector, arc).
SONAR_BRAKE = os.environ.get("SEAGRASS_SONAR_BRAKE", "1") not in ("0", "false", "False", "")
# Inside this range forward thrust is zero. Wider than the Ping's 0.5 m dead
# zone (see PING_MIN_RANGE_M in src/lib/sonarGeometry.js) so the vehicle stops
# while the obstacle is still resolvable rather than as it vanishes into it.
SONAR_BRAKE_STOP_M = float(os.environ.get("SEAGRASS_SONAR_STOP_M", "0.6"))
# Braking starts here and ramps linearly to a full stop at STOP_M.
SONAR_BRAKE_SLOW_M = float(os.environ.get("SEAGRASS_SONAR_SLOW_M", "2.0"))
# Confidence floor for a reading to be allowed to brake. sonar_reader already
# gates distance_m at PING_MIN_CONF; this is a second, independently tunable
# floor so braking can be made stricter than the display without making the
# display lie.
SONAR_BRAKE_MIN_CONF = int(os.environ.get("SEAGRASS_SONAR_MIN_CONF", "50"))
# A reading older than this cannot brake. The reader already blanks `latest` when
# the link drops (_mark_down), so this is defence in depth for the window between
# the last good read and that teardown — it keeps the control loop's safety from
# depending on the reader's internal bookkeeping.
SONAR_BRAKE_STALE_S = 2.0

sonar_brake = 0.0  # fraction of forward thrust to shed: 0 = none, 1 = full stop
brake_readout = {"brake": 0.0, "braking": False}


def step_sonar_brake():
    """Recompute `sonar_brake` from the latest sonar reading.

    Uses the FILTERED distance_m (median of confidence-gated samples), not the
    raw echo: braking on a single spike would lurch the vehicle every time a
    fish or a bubble crossed the beam. The cost is a few samples of lag before a
    suddenly-appearing obstacle registers.

    Releasing on a stale/absent reading — rather than latching the brake on —
    is deliberate. A dead sensor that permanently locked out forward thrust
    would strand the vehicle with no way to drive out of a current, which is a
    worse failure than one the operator can see on the camera and drive around.
    This is an assist under a human, not a guarantee.

    A "good" lock is required, not merely a non-null distance. This is not
    belt-and-braces: distance_m is the MEDIAN OF A 2-SECOND WINDOW while
    confidence is THIS sample's, so the two describe different moments. Gating
    on confidence alone let a single reverb sample that happened to clear the
    threshold both admit itself to the window (producing a distance) and pass
    the confidence check in the same instant — the brake then engaged on a
    phantom and released on the next sample. Observed in a test tank: 2%
    confidence displayed, brake flickering at 32%, against an obstacle 1.5 m
    away in a box 0.46 m long. "good" means _GOOD_MIN_ACCEPTED samples agreed
    inside the window, which a fluke cannot fake.
    """
    global sonar_brake
    reading = sonar.latest
    dist = reading.get("distance_m")
    conf = reading.get("confidence")
    quality = reading.get("quality")
    ts = reading.get("ts") or 0.0

    if (not SONAR_BRAKE or dist is None or conf is None
            or quality != "good"
            or conf < SONAR_BRAKE_MIN_CONF
            or time.time() - ts > SONAR_BRAKE_STALE_S):
        sonar_brake = 0.0
    elif dist <= SONAR_BRAKE_STOP_M:
        sonar_brake = 1.0
    elif dist >= SONAR_BRAKE_SLOW_M:
        sonar_brake = 0.0
    else:
        span = SONAR_BRAKE_SLOW_M - SONAR_BRAKE_STOP_M
        sonar_brake = (SONAR_BRAKE_SLOW_M - dist) / span if span > 0 else 1.0

    brake_readout.update(brake=round(sonar_brake, 3), braking=sonar_brake > 0.0)


# ---------------- camera subprocess ----------------
# server/camera_stream.py: GStreamer -> MediaMTX, streamed to browsers over
# WebRTC/WHEP. Needed for the deployed (non-Tailscale) site — the repo-root
# camera_stream.py's MJPEG-over-HTTP (multipart/x-mixed-replace, no
# Content-Length, body ends only on connection close) has no valid framing
# under HTTP/2 and gets a hard 501 from any HTTP/2-terminating proxy
# (Cloudflare Tunnel included), independent of any DNS/cert configuration.
# Recording is not carried over to this path yet — see media_server.py's
# module docstring for why and what's missing.
_CAMERA_SCRIPT = os.path.join(os.path.dirname(__file__), "camera_stream.py")
camera_proc: subprocess.Popen | None = None

# media_server.py: photo capture, media listing/serving. Independent of the
# camera process (unlike the legacy MJPEG script, which bundled both) so the
# Media page keeps working whether or not the camera pipeline is currently
# running, and needs its own start/stop tied to the server's own lifetime.
_MEDIA_SCRIPT = os.path.join(os.path.dirname(__file__), "media_server.py")
media_proc: subprocess.Popen | None = None
MEDIA_LOG_PATH = "/tmp/seagrass-media-server.log"


def media_server_running() -> bool:
    return media_proc is not None and media_proc.poll() is None


def start_media_server():
    global media_proc
    if media_server_running():
        return
    try:
        log = open(MEDIA_LOG_PATH, "w")
        media_proc = subprocess.Popen(
            ["python3", _MEDIA_SCRIPT],
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        log.close()
        print(f"Media server started (pid {media_proc.pid})")
    except Exception as exc:  # noqa: BLE001
        print(f"Failed to start media server: {exc}")


def stop_media_server():
    global media_proc
    if not media_server_running():
        media_proc = None
        return
    media_proc.terminate()
    try:
        media_proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        media_proc.kill()
        media_proc.wait()
    media_proc = None
    print("Media server stopped")

# Shared frame slot: camera_stream.py's detection tap writes the latest JPEG
# here, and detector.py reads it. Passing DETECT_FRAME to the camera turns the
# tap on whenever the camera runs; the detector only consumes it when detection
# is enabled, so the two lifecycles stay decoupled.
DETECT_FRAME_PATH = os.environ.get("DETECT_FRAME", "/tmp/seagrass-detect-frame.jpg")


def camera_running() -> bool:
    return camera_proc is not None and camera_proc.poll() is None


# camera_stream.py's own errors used to go to DEVNULL — a real crash (camera
# busy, hardware fault, missing dependency) was indistinguishable from a clean
# exit, so "turns off right after turning on" had no diagnosable cause short of
# running the script by hand. It now logs here instead, truncated on every
# start (this is a live debug tail, not history — nothing here is needed past
# the next start_camera() call).
CAMERA_LOG_PATH = "/tmp/seagrass-camera.log"

# How long to wait before checking whether the process is still alive. Long
# enough for a hardware/import failure to have already killed it (these fail
# in well under a second), short enough that a normal start isn't perceptibly
# delayed — start_camera() already runs off the event loop via to_thread.
_CAMERA_STARTUP_GRACE_S = 1.0


def start_camera():
    global camera_proc
    if camera_running():
        return
    try:
        log = open(CAMERA_LOG_PATH, "w")
        camera_proc = subprocess.Popen(
            ["python3", _CAMERA_SCRIPT],
            stdout=log,
            stderr=subprocess.STDOUT,
            env={**os.environ, "DETECT_FRAME": DETECT_FRAME_PATH},
        )
        log.close()  # the child inherited its own fd; ours is no longer needed
        print(f"Camera stream started (pid {camera_proc.pid})")
    except Exception as exc:  # noqa: BLE001
        print(f"Failed to start camera: {exc}")
        return

    time.sleep(_CAMERA_STARTUP_GRACE_S)
    if camera_proc.poll() is not None:
        tail = _tail_camera_log()
        print(f"Camera exited immediately (code {camera_proc.returncode}) — "
              f"{tail or f'see {CAMERA_LOG_PATH}'}")


def _tail_camera_log(n_lines: int = 6) -> str:
    try:
        with open(CAMERA_LOG_PATH) as fh:
            lines = fh.readlines()[-n_lines:]
        return "".join(lines).strip().replace("\n", " | ")
    except OSError:
        return ""


def stop_camera():
    global camera_proc
    if not camera_running():
        camera_proc = None
        return
    camera_proc.terminate()
    try:
        camera_proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        camera_proc.kill()
        camera_proc.wait()
    camera_proc = None
    print("Camera stream stopped")


# ---------------- recording (SD-card capture) ----------------
# CAMERA_HTTP now reaches media_server.py, not the camera subprocess — see that
# module's docstring for why recording (/record/start, /record/stop) currently
# 501s there: the GStreamer/MediaMTX camera path has no second on-Pi encoder to
# draw an mp4 from, unlike the legacy Picamera2 script's dual-encoder setup.
# record_start()/record_stop() below still degrade gracefully (ok=False just
# means `recording` never flips true), so this is a capability gap, not a bug.
CAMERA_HTTP = os.environ.get("CAMERA_HTTP", "http://127.0.0.1:8000")

# Where media_server.py writes photos (and would write recordings, if that were
# implemented) — must match its own MEDIA_DIR. We write a metadata sidecar next
# to each capture, and media_uploader.py drains this directory to Supabase.
MEDIA_DIR = os.environ.get("MEDIA_DIR", os.path.expanduser("~/seagrass-media"))

# Auto-record: when enabled, arming (or entering an autonomous run) starts a
# recording and disarming stops it — so a mission with no operator connected is
# still captured. Persisted to a small state file so it survives disconnects and
# restarts; the operator toggles it from the UI (set_autorecord) or via env.
AUTORECORD_STATE = os.environ.get(
    "AUTORECORD_STATE", "/tmp/seagrass-autorecord"
)

recording = False
rec_started_at = 0.0
# Filename of the recording in progress, captured from /record/start's response.
rec_file = None


def _load_autorecord() -> bool:
    try:
        with open(AUTORECORD_STATE) as fh:
            return fh.read().strip() == "1"
    except OSError:
        return os.environ.get("AUTO_RECORD", "0") == "1"


autorecord_enabled = _load_autorecord()


def _persist_autorecord(on: bool):
    try:
        with open(AUTORECORD_STATE, "w") as fh:
            fh.write("1" if on else "0")
    except OSError as exc:
        print(f"Could not persist auto-record flag: {exc}")


def _camera_post(path: str):
    """POST to the camera's local control endpoint. Runs off the event loop via
    asyncio.to_thread — urllib is blocking.

    Returns (ok, body): ok is True on a 2xx response, body is the decoded JSON
    (or {} if it wasn't JSON). record_start needs the body — it carries the
    filename the recorder just opened, which is the only place that name is
    reported: Recorder.stop() clears current_file before returning."""
    req = urllib.request.Request(f"{CAMERA_HTTP}{path}", method="POST")
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    try:
        with urllib.request.urlopen(req, timeout=4) as resp:
            ok = 200 <= resp.status < 300
            try:
                body = json.loads(resp.read().decode("utf-8"))
            except (ValueError, OSError):
                body = {}
            return ok, body if isinstance(body, dict) else {}
    except (urllib.error.URLError, OSError) as exc:
        print(f"Camera control POST {path} failed: {exc}")
        return False, {}


def _camera_photo():
    """POST /photo to the camera and return the saved filename (or None)."""
    req = urllib.request.Request(f"{CAMERA_HTTP}/photo", method="POST")
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    try:
        with urllib.request.urlopen(req, timeout=4) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("name")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print(f"Camera photo failed: {exc}")
        return None


# ---------------- media sidecars (the upload queue) ----------------
# Every finished capture gets a "<name>.json" sidecar written next to it in
# MEDIA_DIR. media_uploader.py treats those sidecars as its work queue: a media
# file with no sidecar is not uploaded.
#
# That rule is deliberate and does two jobs at once. It keeps an in-progress
# recording (whose mp4 is still being written by ffmpeg) out of the queue with no
# cross-process locking, and it means the queue survives power loss — which is
# the normal case here, since the vehicle has no network link until it surfaces
# and may sit with hours of pending uploads.
#
# The sidecar also carries the context only THIS process knows: what the detector
# was seeing, and how deep / which way / where the vehicle was at that instant.
# That is the difference between "here is a photo" and "here is what the drone
# thought was worth photographing, 4.2 m down, bearing 137".

# Latest value seen for each telemetry field. read_telemetry() returns only the
# fields whose MAVLink messages arrived on that pass, so a snapshot taken at
# capture time needs this accumulator rather than one pass's output.
latest_telemetry: "dict" = {}


def _detection_context():
    """The highest-confidence current detection, or empty when nothing is up.

    Detections older than a couple of seconds are ignored: a stale box would
    label a photo with something that has already left the frame."""
    boxes = latest_detections.get("boxes") or []
    ts = latest_detections.get("ts") or 0
    if not boxes or (ts and time.time() - ts > 2.0):
        return {"label": None, "confidence": None}
    top = max(boxes, key=lambda b: b.get("conf") or 0)
    return {"label": top.get("cls"), "confidence": top.get("conf")}


def _write_media_sidecar(name: str, trigger: str = "manual"):
    """Enqueue a capture for upload by recording what was happening when it was
    taken. Best-effort: a failure here must never take down a capture or a
    mission, so it logs and moves on."""
    if not name:
        return
    payload = {
        "name": name,
        "type": "video" if name.lower().endswith(".mp4") else "photo",
        "captured_at": time.time(),
        "trigger": trigger,
        "uploaded": False,
        "context": {
            **_detection_context(),
            "depth_m": latest_telemetry.get("depth"),
            "heading_deg": latest_telemetry.get("heading"),
            "lat": latest_telemetry.get("lat"),
            "lon": latest_telemetry.get("lon"),
            "armed": armed,
        },
    }
    path = os.path.join(MEDIA_DIR, f"{name}.json")
    try:
        os.makedirs(MEDIA_DIR, exist_ok=True)
        # Write-then-rename: the uploader polls this directory, and a half-written
        # sidecar would be read as corrupt and the capture dropped from the queue.
        tmp = f"{path}.tmp"
        with open(tmp, "w") as fh:
            json.dump(payload, fh)
        os.replace(tmp, path)
    except OSError as exc:
        print(f"Could not write media sidecar for {name}: {exc}")


async def record_start():
    """Start an SD-card recording. Ensures the camera process is up first — the
    recorder lives inside it — so auto-record works even if the camera was off."""
    global recording, rec_started_at, rec_file
    if recording:
        return
    await asyncio.to_thread(start_camera)
    ok, body = await asyncio.to_thread(_camera_post, "/record/start")
    if ok:
        recording = True
        rec_started_at = time.time()
        # Remembered so record_stop can enqueue the finished mp4 — the stop
        # response no longer names it.
        rec_file = body.get("current_file")
        print(f"Recording started ({rec_file or 'unknown file'})")


async def record_stop():
    global recording, rec_file
    if not recording:
        return
    await asyncio.to_thread(_camera_post, "/record/stop")
    recording = False
    # Only now is the mp4 finalised by ffmpeg, so only now is it safe to queue.
    if rec_file:
        _write_media_sidecar(rec_file, trigger="auto" if autorecord_enabled else "manual")
        rec_file = None
    print("Recording stopped")


# ---------------- detector subprocess ----------------
# The object detector runs as a separate OS process (like the camera) so its
# CPU-bound inference never blocks the asyncio control loop that drives MAVLink
# and the safety watchdog. Unlike the camera we need its stdout, so it is an
# asyncio subprocess whose JSON lines are read into `latest_detections`.
_DETECTOR_SCRIPT = os.path.join(os.path.dirname(__file__), "vision", "detector.py")
detector_proc: "asyncio.subprocess.Process | None" = None
latest_detections = {"boxes": [], "ts": 0}
# Explicit liveness, because asyncio.Process.returncode is NOT one: it stays
# None until the child is reaped, so a detector that exited instantly (the
# normal case when the model file is missing) still read as running, `state`
# kept reporting detect=true, and the UI toggle latched on for a corpse.
detector_alive = False
# Last few stderr lines, so a failure can be reported with the detector's own
# words instead of a generic "it didn't start".
detector_last_error: "list[str]" = []
# How long to wait before deciding a spawn failed. A config or missing-model
# exit happens in well under this; a healthy detector is still loading its
# model. Deliberately NOT proc.wait() — that would block the message handler
# for as long as the detector runs, i.e. forever on success.
_DETECTOR_STARTUP_GRACE_S = 0.4


def detector_running() -> bool:
    return detector_proc is not None and detector_alive


async def _drain_detector_stderr(proc):
    """Relay the detector's stderr into the server log.

    This used to be DEVNULL, which threw away the only thing that ever
    explained a silent failure: detector.py prints an actionable line for a
    missing model, missing labels or a bad env value and then exits, and all of
    it went straight to the bit bucket. The operator saw an AI button that did
    nothing at all.
    """
    while True:
        line = await proc.stderr.readline()
        if not line:
            return
        text = line.decode(errors="replace").rstrip()
        if not text:
            continue
        print(text if text.startswith("Detector:") else f"Detector: {text}")
        detector_last_error.append(text)
        del detector_last_error[:-5]


async def start_detector() -> "tuple[bool, str]":
    """Spawn the detector. Returns (ok, detail) — detail is empty when ok."""
    global detector_proc, detector_alive
    if detector_running():
        return True, ""
    detector_last_error.clear()
    try:
        detector_proc = await asyncio.create_subprocess_exec(
            "python3", _DETECTOR_SCRIPT,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "DETECT_FRAME": DETECT_FRAME_PATH},
        )
    except Exception as exc:  # noqa: BLE001 — python3 missing, script gone, etc.
        detector_alive = False
        print(f"Failed to start detector: {exc}")
        return False, str(exc)

    detector_alive = True
    print(f"Detector started (pid {detector_proc.pid})")
    asyncio.create_task(_drain_detector_stderr(detector_proc))
    asyncio.create_task(_read_detections(detector_proc))

    # Give it long enough to fall over on a bad config, then check. Catching it
    # here is what lets the failure reach the operator at the moment they press
    # the button, rather than as an AI toggle that lights up and does nothing.
    await asyncio.sleep(_DETECTOR_STARTUP_GRACE_S)
    if detector_proc is not None and detector_proc.returncode is not None:
        detail = detector_last_error[-1] if detector_last_error else \
            f"detector exited with code {detector_proc.returncode}"
        return False, detail
    return True, ""


# ---------------- autonomous capture ----------------
# The point of the whole media pipeline: on a dive with no operator watching, the
# vehicle photographs what its detector finds so there is something to review
# afterwards. The capture lands on the SD card, gets a sidecar naming what
# triggered it, and uploads itself once the vehicle surfaces.
#
# OFF by default. This makes an autonomous vehicle take an action nobody asked
# for, so enabling it should be a deliberate act, and a misconfigured threshold
# should not be able to fill the SD card on its first sea trial.
#
#   DETECT_AUTOCAPTURE           1 to enable.                     default: 0
#   DETECT_AUTOCAPTURE_MIN_CONF  Confidence a box must clear.     default: 0.6
#   DETECT_AUTOCAPTURE_COOLDOWN_S  Minimum gap between captures.  default: 15
AUTOCAPTURE = os.environ.get("DETECT_AUTOCAPTURE", "0") == "1"
AUTOCAPTURE_MIN_CONF = float(os.environ.get("DETECT_AUTOCAPTURE_MIN_CONF", "0.6"))
AUTOCAPTURE_COOLDOWN_S = float(os.environ.get("DETECT_AUTOCAPTURE_COOLDOWN_S", "15"))

_last_autocapture = 0.0


async def maybe_autocapture():
    """Photograph the current frame if the detector is confident enough.

    The cooldown is load-bearing, not politeness: the detector emits several
    frames a second, and a fish that stays in view would otherwise become
    hundreds of near-identical JPEGs — a full card and an upload backlog that
    outlasts the mission."""
    global _last_autocapture
    if not AUTOCAPTURE:
        return
    now = time.time()
    if now - _last_autocapture < AUTOCAPTURE_COOLDOWN_S:
        return
    boxes = latest_detections.get("boxes") or []
    if not any((b.get("conf") or 0) >= AUTOCAPTURE_MIN_CONF for b in boxes):
        return
    # Claim the cooldown before awaiting, so a slow camera POST cannot let a
    # second detection line slip through and fire a duplicate capture.
    _last_autocapture = now
    name = await asyncio.to_thread(_camera_photo)
    if name:
        _write_media_sidecar(name, trigger="auto")
        top = _detection_context()
        print(f"Auto-captured {name} ({top['label']} {top['confidence']})")


async def _read_detections(proc):
    """Consume the detector's stdout JSON lines into latest_detections."""
    global latest_detections, detector_alive
    try:
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            try:
                latest_detections = json.loads(line)
            except json.JSONDecodeError:
                continue
            await maybe_autocapture()
    finally:
        # EOF means the child is finishing, whatever the reason. Reap it so the
        # exit code is real, then mark it dead and drop the last detections —
        # leaving them up would keep boxes on screen for a detector that no
        # longer exists.
        code = await proc.wait()
        if proc is detector_proc:
            detector_alive = False
            latest_detections = {"boxes": [], "ts": 0}
            # Positive codes only: a negative one is the signal from our own
            # terminate() in stop_detector, and reporting a clean shutdown as an
            # error trains people to ignore the line that matters.
            if code > 0:
                print(f"Detector exited with code {code}")


async def stop_detector():
    global detector_proc, latest_detections, detector_alive
    latest_detections = {"boxes": [], "ts": 0}
    detector_alive = False
    if detector_proc is None or detector_proc.returncode is not None:
        detector_proc = None
        return
    detector_proc.terminate()
    try:
        await asyncio.wait_for(detector_proc.wait(), timeout=5)
    except asyncio.TimeoutError:
        detector_proc.kill()
        await detector_proc.wait()
    detector_proc = None
    print("Detector stopped")


HEARTBEAT_S = 1.0  # 1 Hz — well under ArduSub's GCS failsafe timeout (~5s)
# How long to wait between attempts to rebuild a dropped Pixhawk link. A USB
# re-enumeration takes a few seconds (and a bootloader pass ~5s), so retrying
# faster than this just fills the log without reconnecting any sooner.
PIXHAWK_RETRY_S = 3.0


def _heartbeat_loop():
    """Announce ourselves to ArduSub as a GCS at 1 Hz, forever.

    Runs on its own daemon thread (mirrors sonar_logger.py / keyboard_control.py)
    so the heartbeat can NEVER be delayed by anything on the asyncio event loop —
    websocket handling, telemetry reads, camera/detector control. Without a
    steady GCS heartbeat ArduSub trips its GCS/manual-control failsafe within
    seconds of arming ("MYGCS: 255, heartbeat lost" / "Lost manual control") and
    the vehicle stops responding to input.

    The only other place we send on this link is the event-loop thread (RC
    overrides / arm). Each mavlink send is a single write() of a complete frame,
    so the two threads can't interleave a message mid-frame — the same
    main-thread-sends + heartbeat-thread pattern keyboard_control.py already uses.
    """
    while True:
        if master:
            try:
                master.mav.heartbeat_send(
                    mavutil.mavlink.MAV_TYPE_GCS,
                    mavutil.mavlink.MAV_AUTOPILOT_INVALID,
                    0, 0, 0,
                )
            except OSError as exc:
                # serial.SerialException is an OSError. Flag the drop here rather
                # than waiting for the next read: with no client connected this
                # 1 Hz send is often the first thing to notice the link is gone.
                mark_link_lost(exc)
        time.sleep(HEARTBEAT_S)


def start_heartbeat_thread():
    threading.Thread(target=_heartbeat_loop, daemon=True).start()


def _close_master():
    """Drop the current MAVLink handle. Safe to call on an already-dead link."""
    global master, pixhawk_ok
    old, master = master, None
    pixhawk_ok = False
    if old is not None:
        try:
            old.close()
        except Exception:  # noqa: BLE001
            pass  # the link is already gone — closing is best-effort


def mark_link_lost(exc):
    """Flag the Pixhawk link as down so the supervisor rebuilds it.

    Called from wherever a read/write actually fails. Deliberately idempotent:
    several loops touch the link and they will all trip on the same dropout.
    """
    if master is None and not pixhawk_ok:
        return  # already torn down; don't spam the log
    print(f"Pixhawk link lost: {exc}")
    _close_master()


def connect_pixhawk():
    """(Re)build the MAVLink link. Blocking — call it off the event loop.

    Sets pixhawk_ok, which is what the UI's Pixhawk indicator reflects.
    """
    global master, pixhawk_ok
    _close_master()
    try:
        # A USB CDC node that hasn't re-enumerated yet fails slowly and noisily;
        # checking first keeps the retry loop cheap and the log readable.
        if SERIAL_PORT.startswith("/dev/") and not os.path.exists(SERIAL_PORT):
            raise FileNotFoundError(f"{SERIAL_PORT} not present")
        print(f"Connecting to Pixhawk on {SERIAL_PORT} @ {BAUD}…")
        link = mavutil.mavlink_connection(SERIAL_PORT, baud=BAUD)
        link.wait_heartbeat(timeout=10)
        master = link
        pixhawk_ok = True
        print("Pixhawk heartbeat OK")
    except Exception as exc:  # noqa: BLE001
        _close_master()
        print(f"Pixhawk not available: {exc}")


def set_rc(channel, pwm):
    if not master:
        return
    rc = [65535] * 8
    rc[channel - 1] = pwm
    master.mav.rc_channels_override_send(
        master.target_system, master.target_component, *rc
    )


def all_stop():
    # Release any autonomous hold FIRST. Every stop path in the server funnels
    # through here, so releasing it in this one place means a path added later
    # cannot forget to — and an "all stop" that left the vehicle still steering
    # itself would be a lie.
    disengage_heading_hold("all stop")
    # Zero every input source and the ramped PWM state first, so the control_loop
    # doesn't immediately ramp back up from the pre-stop speed on its next tick.
    reset_motion_state()
    if not master:
        return
    # ArduSub's manual-control mixer uses a fixed RC scheme: ch1=Pitch,
    # ch2=Roll, ch3=Throttle/vertical, ch4=Yaw, ch5=Forward, ch6=Lateral.
    # FRAME_CONFIG=4 (SimpleROV-3) declares a vertical thruster, but this vehicle
    # is built with only the TWO horizontal motors — so in practice ch4
    # (steering/yaw) and ch5 (forward) are the only channels with real authority.
    # ch3 is neutralled anyway: it costs nothing and stays correct if the
    # buoyancy/vertical hardware is fitted later. ch6 (lateral) has no thruster
    # in any configuration. Leave the light channel alone (mirrors
    # keyboard_control.py's all_stop).
    rc = [65535] * 8
    rc[2] = NEUTRAL_PWM               # channel 3 - throttle/vertical
    rc[STEER_CHANNEL - 1] = NEUTRAL_PWM  # channel 4 - steering/yaw
    rc[4] = NEUTRAL_PWM               # channel 5 - forward
    master.mav.rc_channels_override_send(
        master.target_system, master.target_component, *rc
    )


def do_arm():
    """Fire the arm command at the Pixhawk (non-blocking).

    Deliberately does NOT call motors_armed_wait(). If a PreArm check rejects
    the arm, that call blocks forever in this worker thread AND competes with
    read_telemetry() for messages on the same MAVLink link, so the rejection
    reason gets eaten and the arm hangs silently — the exact failure this
    replaces. Instead we send the command and let the single main-thread reader
    (read_telemetry) pick up the HEARTBEAT that flips `armed`, plus the
    COMMAND_ACK and any "PreArm:" STATUSTEXT, so a rejection is always logged
    and pushed to the UI.
    """
    if not master:
        print("ARM requested but no Pixhawk link — ignoring")
        return
    print("ARM: sending arm command to Pixhawk")
    master.arducopter_arm()


def do_disarm():
    """Fire the disarm command at the Pixhawk (non-blocking, see do_arm)."""
    if not master:
        print("DISARM requested but no Pixhawk link — ignoring")
        return
    all_stop()
    print("DISARM: sending disarm command to Pixhawk")
    master.arducopter_disarm()


def do_set_mode(new_mode):
    global mode
    if not master:
        return
    try:
        master.set_mode(new_mode)
        mode = new_mode
    except Exception as exc:  # noqa: BLE001
        print(f"set_mode failed: {exc}")


# ---------------- key + analog state -> RC channels ----------------
# Digital keys (web KeyboardControl.jsx / GamepadControl.jsx) contribute
# full-scale +/-1 per axis; analog axis targets (terminal_control.py's shaped
# PS4 sticks) contribute proportionally. The two are summed and clamped so
# either source can drive and opposing inputs cancel — same union approach as
# keyboard_control.py.
pressed = set()
axis_targets = {"surge": 0.0, "steer": 0.0, "depth": 0.0}

# Current commanded PWM per axis, ramped a little each tick toward the target
# instead of snapping, so pushing a stick further (or holding a key longer)
# builds speed toward MAX_PWM_OFFSET rather than going 0-to-100 instantly.
surge_pwm = NEUTRAL_PWM   # ch5 - forward/back
steer_pwm = NEUTRAL_PWM   # STEER_CHANNEL - left/right yaw
depth_pwm = NEUTRAL_PWM   # ch3 - ascend/descend

# Latest per-motor command, recomputed every control tick from the channels we
# actually send (mode-agnostic) and pushed to the client for the live readout.
motor_readout = {"angle": 0.0, "mag": 0.0, "left": 0.0, "right": 0.0,
                 "left_pwm": 0, "right_pwm": 0}

# Latched soft-stop: while True, all motion input is ignored and every axis holds
# neutral until the pilot toggles it off (OPTIONS). Unlike the "stop" kill switch
# this keeps the server running and the vehicle armed — a recoverable full-stop.
motion_latched = False


def motion_active():
    """True while any input source is asking for motion — used by the watchdog
    so it also trips on a silent client that left the analog sticks deflected,
    not only one that left a digital key held."""
    return bool(pressed) or any(abs(v) > 1e-3 for v in axis_targets.values())


def reset_motion_state():
    """Zero every input source and the ramped PWM state, so an all-stop is a
    real stop — the next tick can't resume ramping from the pre-stop speed."""
    global surge_pwm, steer_pwm, depth_pwm
    pressed.clear()
    axis_targets["surge"] = axis_targets["steer"] = axis_targets["depth"] = 0.0
    surge_pwm = steer_pwm = depth_pwm = NEUTRAL_PWM


def _axis_value(pos_key, neg_key, analog):
    """Union of a digital key contribution (+/-1) with the analog axis, clamped
    to [-1, 1]."""
    digital = (1.0 if pos_key in pressed else 0.0) - (1.0 if neg_key in pressed else 0.0)
    return max(-1.0, min(1.0, digital + analog))


def _expo(x, k):
    """Progressive response curve: blend linear and cubic by k in [0, 1],
    keeping sign. k=0 is straight linear; k=1 is fully cubic, which bows the
    middle down so small inputs stay gentle while +/-1 still maps to +/-1. Used
    to make steering trim finely near center and carve harder toward full lock."""
    return (1.0 - k) * x + k * x ** 3


def _stick_to_angle_mag(x, y):
    """Turn stick components into a unit-circle angle + magnitude for ANGLE_TABLE.

    x = steer (right +), y = surge (forward +). atan2(y, x) puts 0deg at pure
    right, 90deg at pure forward ("up"), 180deg at pure left, and 270deg at
    pure reverse ("down") -- standard unit-circle convention, wrapped to
    [0, 360). magnitude is the stick's distance from center, clamped to 1.0. At
    dead center (0, 0) magnitude is 0, so the motors come out stopped."""
    angle = math.degrees(math.atan2(y, x)) % 360.0
    magnitude = min(1.0, math.hypot(x, y))
    return angle, magnitude


def _lookup_motors(angle, magnitude):
    """Interpolate ANGLE_TABLE at `angle` and scale by `magnitude` -> (left, right).

    Finds the two table entries that bracket `angle` (wrapping past the last key
    back to the first at 360deg) and linearly blends each motor between them, so
    the closer the stick is to one entry the closer the output is to that entry's
    setting — a smooth spectrum, not stepped. Both motors are then scaled by
    magnitude (how far the stick is pushed) and clamped to [-1, 1]."""
    keys = sorted(ANGLE_TABLE)
    # Find the bracketing pair (lo, hi); hi wraps to the first key + 360.
    lo = keys[-1]
    hi = keys[0] + 360.0
    for i in range(len(keys)):
        if keys[i] <= angle:
            lo = keys[i]
            hi = keys[i + 1] if i + 1 < len(keys) else keys[0] + 360.0
    span = hi - lo
    frac = 0.0 if span == 0 else (angle - lo) / span
    l_lo, r_lo = ANGLE_TABLE[lo]
    l_hi, r_hi = ANGLE_TABLE[hi % 360 if hi >= 360 else hi]
    left = (l_lo + frac * (l_hi - l_lo)) * magnitude
    right = (r_lo + frac * (r_hi - r_lo)) * magnitude
    return max(-1.0, min(1.0, left)), max(-1.0, min(1.0, right))


def _apply_creep_floor(surge_off, steer_off):
    """Lift a stalled command up to the minimum offset that actually spins a
    motor, preserving the commanded direction exactly.

    Works in the motor domain -- ArduSub mixes left = ch5 + ch4 and
    right = ch5 - ch4 -- because MOT_SPIN_MIN is a per-motor deadband, not a
    per-channel one. Scaling both motors by the same factor scales surge_off and
    steer_off by that factor too, so atan2(steer, surge) is unchanged and only
    the magnitude rises: a commanded 18deg nudge still comes out at 18deg.
    (Flooring each channel independently would rotate that same nudge to 45deg.)

    No-op once any motor is already past the floor, so a fine yaw trim at full
    forward -- where both motors are long past MOT_SPIN_MIN and need no help --
    stays a fine trim instead of being slammed to a minimum turn rate.
    """
    if CREEP_FLOOR <= 0:
        return surge_off, steer_off
    left = surge_off + steer_off
    right = surge_off - steer_off
    mag = max(abs(left), abs(right))
    if 0.0 < mag < CREEP_FLOOR:
        k = CREEP_FLOOR / mag
        left *= k
        right *= k
    return (left + right) / 2.0, (left - right) / 2.0


def _ramp(current, target, dt, ramp_up_s, decay_s, max_offset,
          sprint_fraction=1.0, sprint_up_s=None):
    """Ease `current` PWM toward `target` in one of three regimes, chosen by
    where `current` already is -- never by how far `target` is.

      * heading back toward/through neutral -> constant, fast decay rate, so
        releasing the stick and reversing direction both stay crisp;
      * below CREEP_FLOOR -> the props aren't biting and nothing is felt yet, so
        cross the dead band at a fixed fast rate and start making thrust promptly;
      * above CREEP_FLOOR -> ease in: the rate grows linearly with speed,
        reaching RAMP_EASE_RATIO x the onset rate at full and taking ramp_up_s to
        cross the whole band.

    Keying the rate off current speed rather than off the distance to the target
    is what lets one curve serve both goals: a small nudge is a short trip and is
    reached in a fraction of a second, while a full-stick pull still takes the
    whole ramp_up_s. `max_offset` is this axis's peak PWM offset, so ramp_up_s
    stays "seconds to reach full" even though steer and surge have different caps.

    `sprint_fraction` < 1.0 splits that last regime at a knee sitting at that
    fraction of `max_offset`: the band from the creep floor up to the knee is
    crossed in `sprint_up_s`, the rest in `ramp_up_s`. Each stage re-runs the same
    ease over its own sub-band, so the curve restarts gently at the knee instead
    of stepping. Top speed is unchanged either way -- only the pacing differs.
    Defaults to 1.0 (no knee).
    """
    cur_off = current - NEUTRAL_PWM
    tgt_off = target - NEUTRAL_PWM
    moving_away = abs(tgt_off) > abs(cur_off) and cur_off * tgt_off >= 0
    if not moving_away:
        # Gated behind moving_away on purpose: easing the decay too would make
        # v -> 0 near neutral, and the last stretch of stopping would crawl.
        rate = max_offset / decay_s
    elif abs(cur_off) < CREEP_FLOOR:
        # Explicit branch, not a formula: below the floor the ease's progress
        # term goes negative and the rate collapses toward zero, so a formula
        # would never engage from a standstill.
        rate = max(CREEP_FLOOR, 1.0) / RAMP_ENGAGE_S
    else:
        lo, hi, span_s = CREEP_FLOOR, float(max_offset), ramp_up_s
        knee = max(CREEP_FLOOR, sprint_fraction * max_offset)
        if sprint_fraction < 1.0 and knee < max_offset:
            if abs(cur_off) < knee:
                hi, span_s = knee, (sprint_up_s if sprint_up_s else ramp_up_s)
            else:
                lo = knee
        band = max(1.0, hi - lo)
        v = min(1.0, (abs(cur_off) - lo) / band)
        rate = band * (_EASE_A + _EASE_B * v) / span_s
    max_step = rate * dt
    if current < target:
        return min(current + max_step, target)
    if current > target:
        return max(current - max_step, target)
    return current


def channel_frame(dt):
    """Build one combined RC_CHANNELS_OVERRIDE frame, ramped by `dt` seconds.

    Combines digital keys + analog axis targets, applies turn-assist, and ramps
    each axis toward NEUTRAL_PWM + input*MAX_PWM_OFFSET. Forward -> ch5,
    steering -> ch4 (Yaw), vertical -> ch3 per ArduSub's fixed manual-control
    scheme. Steering rides on Yaw, not Lateral (ch6): this 2-motor frame has no
    lateral thruster, so ch6 has zero authority and ch4's differential is what
    actually turns the vehicle (mirrors keyboard_control.py's update_flight).
    ch1/ch2 (Pitch/Roll), the light channel (ch7) and every unused channel are
    left at 65535 ("ignore this channel") so a separate light override
    (set_rc(LIGHT_CHANNEL, ...)) is never clobbered.
    """
    global surge_pwm, steer_pwm, depth_pwm

    surge_in = _axis_value("w", "s", axis_targets["surge"])
    steer_in = _axis_value("d", "a", axis_targets["steer"])
    depth_in = _axis_value("q", "e", axis_targets["depth"])

    # Sonar brake: shed forward thrust as something closes ahead. Applied to the
    # axis input, before expo/turn-assist/ramp, so it damps the *request* and
    # every downstream path (all three drive modes, the creep floor, the ramp)
    # treats the braked value as if the pilot had eased off the stick.
    # Deliberately one-directional — reverse is how you back away from whatever
    # triggered it, so it is never restricted.
    step_sonar_brake()
    if sonar_brake > 0.0 and surge_in > 0.0:
        surge_in *= 1.0 - sonar_brake

    # Heading hold steers only while the operator isn't. Injecting here as an
    # ordinary steer input — rather than writing ch4 directly — is what makes the
    # autonomous command inherit every existing safety path unchanged: the ramp,
    # expo, turn-assist, creep floor, soft stop, watchdog and all_stop all apply
    # exactly as they do to a human on the stick.
    if heading_hold_engaged and not heading_hold_suspended:
        steer_in = max(-1.0, min(1.0, heading_output))

    # Stick as the pilot actually moved it, kept for the readout: the default
    # branch below mutates steer_in/surge_in with expo and turn-assist, which
    # would make the reported angle/mag describe the mix rather than the stick.
    raw_steer_in, raw_surge_in = steer_in, surge_in

    if ANGLE_TABLE_DRIVE:
        # Explicit per-motor control: the stick's angle+magnitude looks up
        # (left, right) motor commands from ANGLE_TABLE (interpolated), then we
        # invert ArduSub's mixer to the two channels it drives — ch5 forward =
        # (L+R)/2, ch4 yaw = (L-R)/2 — so ArduSub still runs its motor library
        # (safety, thrust curve) and every existing all-stop/watchdog path applies.
        # Both axes ramp at the same rate so the heading is preserved during ramp.
        angle, mag = _stick_to_angle_mag(steer_in, surge_in)
        left, right = _lookup_motors(angle, mag)
        fwd = (left + right) / 2.0
        yaw = (left - right) / 2.0
        surge_off = SURGE_SIGN * fwd * MAX_PWM_OFFSET
        steer_off = STEER_SIGN * yaw * MAX_PWM_OFFSET
        surge_max = steer_max = MAX_PWM_OFFSET
        surge_up, surge_dec = SURGE_RAMP_UP_S, SURGE_DECAY_S
        steer_up, steer_dec = SURGE_RAMP_UP_S, SURGE_DECAY_S
    elif VECTOR_DRIVE:
        # Pure differential: equal gain, no expo/turn-assist/arc-cap, so the
        # stick's exact direction maps geometrically to the two motors (ArduSub
        # mixes left=ch5+ch4 / right=ch5-ch4). Both axes ramp at the same rate so
        # the commanded heading is preserved during the ramp, not skewed.
        surge_off = SURGE_SIGN * surge_in * VECTOR_MAX_OFFSET
        steer_off = STEER_SIGN * steer_in * VECTOR_MAX_OFFSET
        surge_max = steer_max = VECTOR_MAX_OFFSET
        surge_up, surge_dec = SURGE_RAMP_UP_S, SURGE_DECAY_S
        steer_up, steer_dec = SURGE_RAMP_UP_S, SURGE_DECAY_S
    else:
        # Progressive steering: gentle heading trim near center, sharper carve
        # toward full stick. Applied before turn-assist so the forward-power shed
        # also grows progressively with how hard you're actually turning.
        steer_in = _expo(steer_in, STEER_EXPO)

        # The harder the turn, the more forward power is shed so the yaw
        # differential stays pronounced instead of both motors saturating forward.
        surge_in *= 1.0 - TURN_ASSIST * abs(steer_in)

        surge_off = SURGE_SIGN * surge_in * MAX_PWM_OFFSET
        steer_off = STEER_SIGN * steer_in * STEER_MAX_OFFSET

        # Turn-follows-throttle: while translating, limit yaw to the surge
        # available (minus the margin that keeps the inside motor spinning) so a
        # diagonal curves instead of stalling one motor at the differential
        # balance point. Near stopped, leave yaw untouched so a pivot still works.
        #
        # The two allowances are blended with max() rather than switched between,
        # so authority slides continuously from "full pivot" to "arc-capped"
        # instead of falling off a cliff the moment surge passes ARC_SPIN_MARGIN.
        # Both endpoints are unchanged: at surge_off 0 pivot_allow is the full
        # STEER_MAX_OFFSET, and once surge_off clears ARC_PIVOT_FADE arc_allow
        # takes over exactly as before.
        if ARC_TURN:
            pivot_allow = STEER_MAX_OFFSET * max(0.0, 1.0 - abs(surge_off) / max(1.0, ARC_PIVOT_FADE))
            arc_allow = max(0.0, abs(surge_off) - ARC_SPIN_MARGIN)
            lim = max(pivot_allow, arc_allow)
            steer_off = max(-lim, min(lim, steer_off))

        surge_max, steer_max = MAX_PWM_OFFSET, STEER_MAX_OFFSET
        surge_up, surge_dec = SURGE_RAMP_UP_S, SURGE_DECAY_S
        steer_up, steer_dec = STEER_RAMP_UP_S, STEER_DECAY_S

    # Lift a stalled command past the thrusters' minimum spin PWM so the smallest
    # nudge inches instead of buzzing. After the arc cap, so the cap stays a hard
    # limit the floor can never violate; outside the mode branch, so all three
    # drive modes share it. Depth is its own thruster on ch3, so it takes a plain
    # per-channel floor rather than the two-motor mix.
    surge_off, steer_off = _apply_creep_floor(surge_off, steer_off)
    depth_off = depth_in * MAX_PWM_OFFSET
    if CREEP_FLOOR > 0 and 0.0 < abs(depth_off) < CREEP_FLOOR:
        depth_off = math.copysign(CREEP_FLOOR, depth_off)

    surge_pwm = _ramp(surge_pwm, NEUTRAL_PWM + surge_off,
                      dt, surge_up, surge_dec, surge_max,
                      SURGE_SPRINT_FRACTION, SURGE_SPRINT_UP_S)
    steer_pwm = _ramp(steer_pwm, NEUTRAL_PWM + steer_off,
                      dt, steer_up, steer_dec, steer_max)
    depth_pwm = _ramp(depth_pwm, NEUTRAL_PWM + depth_off,
                      dt, DEPTH_RAMP_UP_S, DEPTH_DECAY_S, MAX_PWM_OFFSET)

    # Live readout: recover the per-motor command from the channels we're actually
    # sending (invert ArduSub's mixer), so it reflects the real output in every
    # mode — angle-table, vector, or arc — including the ramp and sign flips.
    # Normalised by the combined cap because a motor sees surge + yaw stacked:
    # that sum spans +/-400, which is also the vehicle's hard limit (RC*_MIN 1100
    # / RC*_MAX 1900). Dividing by MAX_PWM_OFFSET alone reported a hard arc as
    # 100/40 when the truth was 4:1. left_pwm/right_pwm are the raw offsets --
    # those are what you read to calibrate CREEP_FLOOR.
    fwd_off = surge_pwm - NEUTRAL_PWM
    yaw_off = steer_pwm - NEUTRAL_PWM
    motor_scale = float(MAX_PWM_OFFSET + STEER_MAX_OFFSET)
    left_pwm = fwd_off + yaw_off
    right_pwm = fwd_off - yaw_off
    angle, mag = _stick_to_angle_mag(raw_steer_in, raw_surge_in)
    motor_readout["angle"] = round(angle, 1)
    motor_readout["mag"] = round(mag, 3)
    motor_readout["left"] = round(max(-1.0, min(1.0, left_pwm / motor_scale)), 3)
    motor_readout["right"] = round(max(-1.0, min(1.0, right_pwm / motor_scale)), 3)
    motor_readout["left_pwm"] = round(left_pwm)
    motor_readout["right_pwm"] = round(right_pwm)

    rc = [65535] * 8
    rc[4] = round(surge_pwm)
    rc[STEER_CHANNEL - 1] = round(steer_pwm)
    rc[2] = round(depth_pwm)
    return rc


def send_control_frame(dt):
    """Push the current ramped channel frame to the Pixhawk as one RC override."""
    if not master:
        return
    rc = channel_frame(dt)
    master.mav.rc_channels_override_send(
        master.target_system, master.target_component, *rc
    )


def toggle_soft_stop():
    """Flip the latched soft-stop (OPTIONS). Latching neutrals every motor via
    all_stop() and freezes input until toggled off; the server stays up and armed."""
    global motion_latched
    motion_latched = not motion_latched
    if motion_latched:
        all_stop()  # neutral ch3/ch4/ch5 + reset ramp/inputs immediately
        print("SOFT STOP: latched — motors neutral, input frozen (OPTIONS to resume)")
    else:
        print("SOFT STOP: released — driving resumed")


def handle_key(key, is_pressed):
    if motion_latched:
        return  # frozen until soft-stop released; a held key can't re-command motion
    key = key.lower()
    if key in ("w", "a", "s", "d", "q", "e"):
        # Just update held state — control_loop ramps the PWM toward the target
        # every tick at CONTROL_HZ, so there's no fixed-frame snap to send here.
        if is_pressed:
            pressed.add(key)
        else:
            pressed.discard(key)
    elif key == "l" and is_pressed:
        set_rc(LIGHT_CHANNEL, LIGHT_ON_PWM)
    elif key == "k" and is_pressed:
        set_rc(LIGHT_CHANNEL, NEUTRAL_PWM)


def handle_axis(msg):
    """Analog stick update from terminal_control.py: floats in [-1, 1] per axis,
    already deadzone+expo shaped client-side. Stored as targets the control_loop
    ramps toward."""
    if motion_latched:
        return  # frozen until soft-stop released; a deflected stick can't re-command motion
    for name in ("surge", "steer", "depth"):
        if name in msg:
            try:
                axis_targets[name] = max(-1.0, min(1.0, float(msg[name])))
            except (TypeError, ValueError):
                pass


# ---------------- telemetry ----------------
def _mav_result_name(result):
    try:
        return mavutil.mavlink.enums["MAV_RESULT"][result].name
    except (KeyError, AttributeError):
        return f"result {result}"


def read_telemetry():
    """Drain pending MAVLink messages.

    Returns (data, notices): `data` is the latest telemetry values, `notices`
    is a list of (level, text) operator alerts — arm rejections and PreArm
    warnings — that the caller pushes to the UI. This is the ONLY place we
    recv() from the link, so keeping COMMAND_ACK/STATUSTEXT handling here (not
    in a worker thread) is what stops the arm-rejection reason from being lost.
    """
    if not master:
        return {}, []
    out = {}
    notices = []
    while True:
        try:
            msg = master.recv_match(blocking=False)
        except Exception as exc:  # noqa: BLE001
            # The Pixhawk is a USB CDC device: a knocked cable, a brown-out on the
            # shared 5V rail, or the autopilot rebooting makes /dev/ttyACM0 vanish
            # and pyserial raises right here. This used to propagate out and kill
            # mission_recorder_loop outright while pixhawk_ok stayed True forever,
            # so the UI kept showing a healthy Pixhawk on a dead link. Flag it
            # instead and let pixhawk_supervisor_loop rebuild the connection.
            mark_link_lost(exc)
            return out, notices
        if msg is None:
            break
        t = msg.get_type()
        if t == "VFR_HUD":
            out["heading"] = msg.heading
            out["groundspeed"] = round(msg.groundspeed * 1.94384, 2)  # m/s -> kn
            # Altitude + climb come from the Pixhawk's onboard barometer, so they
            # are real even with no external sensors attached (baro alt is MSL-ish
            # and drifts, but tracks vertical motion). Meters and m/s.
            out["altitude"] = round(msg.alt, 2)
            out["climb"] = round(msg.climb, 2)
        elif t == "ATTITUDE":
            # EKF-fused vehicle attitude. MAVLink sends radians; the UI wants
            # degrees. Roll/pitch are signed (±180 / ±90); yaw is normalized to
            # 0–360 so it reads like a compass bearing.
            out["roll"] = round(math.degrees(msg.roll), 1)
            out["pitch"] = round(math.degrees(msg.pitch), 1)
            out["yaw"] = round(math.degrees(msg.yaw) % 360, 1)
        elif t == "GLOBAL_POSITION_INT":
            out["lat"] = msg.lat / 1e7
            out["lon"] = msg.lon / 1e7
            out["depth"] = max(0.0, -msg.relative_alt / 1000.0)
        elif t == "SYS_STATUS":
            if msg.battery_remaining >= 0:
                out["battery"] = msg.battery_remaining
        elif t == "HEARTBEAT":
            global armed
            armed = bool(
                msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED
            )
        elif t == "COMMAND_ACK":
            # The Pixhawk's verdict on our arm/disarm command. A non-ACCEPTED
            # result is why the vehicle "won't arm" — log it and surface it.
            if msg.command == mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM:
                if msg.result != mavutil.mavlink.MAV_RESULT_ACCEPTED:
                    note = f"Pixhawk rejected arm/disarm: {_mav_result_name(msg.result)}"
                    print(f"ARM: {note}")
                    notices.append(("error", note))
                else:
                    print("ARM: Pixhawk accepted arm/disarm command")
        elif t == "STATUSTEXT":
            # PreArm failure reasons ("PreArm: ...") and other warnings arrive
            # here. These explain a silent arm refusal (e.g. GPS/EKF checks that
            # make no sense for a tethered, no-GPS ROV — relax ARMING_CHECK on
            # the Pixhawk if so). Forward WARNING-or-worse so the field operator
            # sees them.
            if msg.severity <= mavutil.mavlink.MAV_SEVERITY_WARNING:
                text = msg.text.strip()
                print(f"PIXHAWK: {text}")
                level = "error" if "arm" in text.lower() else "warn"
                notices.append((level, text))
    return out, notices


# ---------------- WebSocket server ----------------
helm_holder = None  # only one client controls the drone at a time


async def client_handler(ws):
    global helm_holder, client_count
    authed = not TOKEN
    last_seen = time.time()
    client_count += 1
    print(f"Client connected: {ws.remote_address}")

    async def send(obj):
        try:
            await ws.send(json.dumps(obj))
        except websockets.ConnectionClosed:
            pass

    async def state():
        await send(
            {
                "type": "state",
                "armed": armed,
                "mode": mode,
                "pixhawk": pixhawk_ok,
                "camera": camera_running(),
                "detect": detector_running(),
                "recording": recording,
                "rec_elapsed_s": int(time.time() - rec_started_at) if recording else 0,
                "autorecord": autorecord_enabled,
            }
        )

    async def telemetry_loop():
        while True:
            data, notices = read_telemetry()
            if data:
                # Accumulate, don't replace: `data` holds only the fields whose
                # MAVLink messages happened to arrive on this pass, and a media
                # sidecar written between passes still needs the last known
                # depth/heading/position.
                latest_telemetry.update(data)
                await send({"type": "telemetry", **data})
            if "altitude" in data:
                step_alt_pid(data["altitude"])
            # Must run on every pass, engaged or not: it is also the freshness
            # clock that engage_heading_hold() checks before trusting the compass.
            if "yaw" in data:
                step_heading_hold(data["yaw"])
            await send({"type": "pid", **pid_readout})
            await send({"type": "heading_hold", **heading_readout})
            # Gauge-level sonar: scalars only. The ~200-sample amplitude array
            # goes out on its own faster loop below, so it is stripped here
            # rather than paying ~800 bytes twice at two different rates.
            # brake_readout rides along so the operator can see *why* forward
            # thrust went away — an unexplained refusal to drive reads as a
            # broken vehicle, not as an assist doing its job.
            await send({"type": "sonar",
                        **{k: v for k, v in sonar.latest.items() if k != "profile"},
                        **brake_readout})
            for level, message in notices:
                await send({"type": "notice", "level": level, "message": message})
            await state()
            # watchdog — force neutral if the client went silent mid-motion
            # (a held key OR a deflected analog stick both count as motion)
            if helm_holder is ws and motion_active() and time.time() - last_seen > WATCHDOG_S:
                all_stop()  # also releases heading hold + clears keys/axes
                print("Watchdog: all stop")
            # A running hold keeps the vehicle steering with no stick deflection,
            # so motion_active() is false and the watchdog above never fires. This
            # is the equivalent guard for autonomous motion: a silent operator
            # must not leave the vehicle holding a bearing indefinitely. It needs
            # its own, longer timeout — see HOLD_WATCHDOG_S.
            elif (helm_holder is ws and heading_hold_engaged
                  and time.time() - last_seen > HOLD_WATCHDOG_S):
                all_stop()
                print("Watchdog: all stop (heading hold, client silent)")
            await asyncio.sleep(0.5)

    async def detections_loop():
        # Relay detector output at ~5fps (faster than the 0.5s telemetry loop so
        # overlay boxes track smoothly). Silent while the detector is off.
        while True:
            if detector_running():
                await send({"type": "detections", **latest_detections})
            await asyncio.sleep(0.2)

    async def sonar_profile_loop():
        # Feed the UI's echogram at the reader's own ~10 Hz sample rate. The
        # 0.5 s telemetry loop is far too coarse for a scrolling waterfall — at
        # 2 Hz you lose 4 of every 5 pings and the display stutters.
        #
        # Keyed on ping_number so a row is emitted once per ACOUSTIC ping: this
        # loop and the reader thread are unsynchronised, so polling faster than
        # the device pings would otherwise duplicate rows and stretch the time
        # axis. A skipped ping (link loss) just leaves a gap, which is honest.
        #
        # The body is wrapped because this is a create_task() coroutine whose
        # result nobody awaits: an unhandled exception here does not crash the
        # server, it silently retires THIS task and the echogram freezes on its
        # last frame for the rest of the session, while every other panel keeps
        # updating. Reconnecting builds a fresh task and it works again, which
        # makes the fault look like a network problem rather than a dead loop.
        # Observed in the field exactly that way. send() only swallows
        # ConnectionClosed, so anything else — a value the encoder can't take,
        # say — escapes. One bad ping should cost one frame, not the session.
        #
        # LIVENESS. Keying on ping_number alone let the device starve the panel:
        # if that counter stops advancing while the link still answers, the
        # reader keeps filling its window with fresh replies — so the lock stays
        # "good" and the 2 Hz gauge keeps updating — while this loop, seeing an
        # unchanged key, sends nothing at all. The UI then blanks a few seconds
        # in and still reads LOCK, which points every suspicion at the wrong
        # subsystem. So a stale key is forced out after MAX_SILENCE_S: one row
        # per acoustic ping when the counter behaves, and never total silence
        # when it does not. A repeated row is honest here — it is what the
        # device is telling us.
        MAX_SILENCE_S = 0.5
        last_ping = None
        last_sent_at = 0.0
        stall_warned = False
        while True:
            try:
                snap = sonar.latest  # replaced wholesale by the reader — safe to alias
                ping_no = snap.get("ping_number")
                now = time.time()
                fresh = ping_no is None or ping_no != last_ping
                if snap.get("ok") and (fresh or now - last_sent_at > MAX_SILENCE_S):
                    if not fresh and not stall_warned:
                        # Said once, not per tick. Names the subsystem, because
                        # the symptom (blank readout, LOCK still lit) otherwise
                        # implicates the link or the browser rather than the
                        # device's own counter.
                        stall_warned = True
                        print(f"Sonar: ping_number stuck at {ping_no} while reads "
                              "still succeed — sending on a timer instead")
                    elif fresh:
                        stall_warned = False
                    last_ping = ping_no
                    last_sent_at = now
                    await send({
                        "type": "sonar_profile",
                        "ping": ping_no,
                        "ts": snap.get("ts"),
                        "distance_m": snap.get("distance_m"),
                        "raw_m": snap.get("raw_m"),
                        "confidence": snap.get("confidence"),
                        "quality": snap.get("quality"),
                        "scan_start_m": snap.get("scan_start_m"),
                        "scan_length_m": snap.get("scan_length_m"),
                        "gain": snap.get("gain"),
                        "profile": snap.get("profile"),
                    })
            except Exception as exc:  # noqa: BLE001 — never let one ping end the stream
                print(f"Sonar profile loop: {exc!r} — skipping this ping")
            await asyncio.sleep(0.05)

    async def motors_loop():
        # Push the live per-motor readout (angle/mag/left/right) to the helm holder
        # at ~10 Hz so terminal_control.py can print what each motor is doing as the
        # stick moves. Only to the helm holder — it reflects the active command.
        while True:
            if helm_holder is ws:
                await send({"type": "motors", **motor_readout})
            await asyncio.sleep(0.1)

    tele_task = asyncio.create_task(telemetry_loop())
    detect_task = asyncio.create_task(detections_loop())
    motors_task = asyncio.create_task(motors_loop())
    sonar_task = asyncio.create_task(sonar_profile_loop())
    try:
        async for raw in ws:
            last_seen = time.time()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            mtype = msg.get("type")

            if mtype == "hello":
                if TOKEN and msg.get("token") != TOKEN:
                    await send({"type": "error", "message": "Invalid access token"})
                    await ws.close(code=4401, reason="unauthorized")
                    return
                authed = True
                await send({"type": "hello_ok"})
                await state()
                continue

            if not authed:
                await send({"type": "error", "message": "Send hello with token first"})
                continue

            if mtype == "ping":
                continue

            # commands below take the helm
            if helm_holder is None:
                helm_holder = ws
            if helm_holder is not ws:
                await send({"type": "error", "message": "Another operator has the helm"})
                continue

            if mtype == "key":
                handle_key(msg.get("key", ""), bool(msg.get("pressed")))
            elif mtype == "axis":
                handle_axis(msg)
            elif mtype == "soft_stop":
                # Latched full-stop (gamepad OPTIONS): neutral all motors and hold,
                # or resume. Recoverable — unlike "stop", it does NOT disarm/shutdown.
                toggle_soft_stop()
                await send({"type": "soft_stop", "latched": motion_latched})
            elif mtype == "heading_hold_on":
                ok, detail = engage_heading_hold()
                if not ok:
                    await send({"type": "notice", "level": "warn",
                                "message": f"Heading hold refused: {detail}"})
                await send({"type": "heading_hold", **heading_readout})
            elif mtype == "heading_hold_off":
                disengage_heading_hold("operator")
                await send({"type": "heading_hold", **heading_readout})
            elif mtype == "arm":
                do_arm()
                await state()
            elif mtype == "disarm":
                reset_motion_state()
                do_disarm()
                await state()
            elif mtype == "mode":
                await asyncio.to_thread(do_set_mode, msg.get("mode", "MANUAL"))
                await state()
            elif mtype == "stop":
                # Hard kill: every "all stop" control (gamepad OPTIONS, keyboard
                # SPACE, the UI button) lands here. This isn't a pause — it
                # disarms, kills the camera, and takes the whole server down so
                # nothing can move again until someone deliberately restarts it.
                pressed.clear()
                all_stop()
                if armed:
                    do_disarm()
                await stop_detector()
                stop_camera()
                stop_media_server()
                await state()
                print("KILL SWITCH: all stop + disarm, shutting server down")
                os._exit(0)
            elif mtype == "camera_on":
                await asyncio.to_thread(start_camera)
                await state()
            elif mtype == "camera_off":
                # Finalise any recording before the camera process dies, so the
                # mp4 is flushed cleanly rather than truncated.
                await record_stop()
                await stop_detector()
                await asyncio.to_thread(stop_camera)
                await state()
            elif mtype == "record_start":
                await record_start()
                await state()
            elif mtype == "record_stop":
                await record_stop()
                await state()
            elif mtype == "photo":
                await asyncio.to_thread(start_camera)
                name = await asyncio.to_thread(_camera_photo)
                if name:
                    _write_media_sidecar(name, trigger="manual")
                    await send({"type": "media_saved", "kind": "photo", "name": name})
                else:
                    await send({"type": "notice", "level": "warn",
                                "message": "Photo failed — no camera frame yet"})
            elif mtype == "set_autorecord":
                global autorecord_enabled
                autorecord_enabled = bool(msg.get("on"))
                _persist_autorecord(autorecord_enabled)
                # Apply immediately: if turning on while already armed, start now;
                # if turning off mid-recording, stop.
                if autorecord_enabled and armed and not recording:
                    await record_start()
                elif not autorecord_enabled and recording:
                    await record_stop()
                await state()
            elif mtype == "detect_on":
                ok, detail = await start_detector()
                if not ok:
                    # Say why, in the detector's own words. Without this the
                    # button lights up, nothing happens, and the reason (almost
                    # always a missing model file) is invisible from the UI.
                    await send({"type": "notice", "level": "error",
                                "message": f"Detector failed to start — {detail}"})
                await state()
            elif mtype == "detect_off":
                await stop_detector()
                await state()
            else:
                # Never drop a command silently — an unknown/misspelled type
                # here (not a typo'd "arm") would otherwise vanish without a
                # trace, which is exactly the kind of silent failure that makes
                # field debugging impossible.
                print(f"WARNING: ignoring unknown message type {mtype!r}")
                await send(
                    {"type": "error", "message": f"Unknown command: {mtype}"}
                )
    finally:
        client_count -= 1
        tele_task.cancel()
        detect_task.cancel()
        motors_task.cancel()
        sonar_task.cancel()
        if client_count == 0:
            # Last operator left — drop PID state so the next session re-captures
            # its hold altitude fresh rather than resuming a stale setpoint.
            reset_alt_pid()
        # Autonomy never outlives its operator: release the hold on ANY client
        # leaving, not just the helm holder, and regardless of client_count.
        disengage_heading_hold("operator disconnected")
        if helm_holder is ws:
            helm_holder = None
            pressed.clear()
            all_stop()
        print(f"Client disconnected: {ws.remote_address}")


async def control_loop():
    """Stream the current RC override frame at CONTROL_HZ for the whole server
    lifetime, independent of any client — the RC-override analogue of the 1 Hz
    GCS heartbeat thread.

    The heartbeat feeds ArduSub's GCS failsafe; this feeds its *separate*
    manual-control / pilot-input failsafe, which only RC_CHANNELS_OVERRIDE (or
    MANUAL_CONTROL) resets. Without this steady stream ArduSub trips "Lost
    manual control" within a second or two of arming whenever no motion key
    happens to be held — exactly what a well-behaved client with idle sticks
    produces. Sent every tick even when unchanged (like keyboard_control.py),
    and unconditionally rather than gated on `armed`, so there's no gap at the
    instant of arming while the HEARTBEAT-driven `armed` flag catches up.
    """
    last_tick = time.time()
    while True:
        now = time.time()
        dt = now - last_tick
        last_tick = now
        send_control_frame(dt)
        await asyncio.sleep(CONTROL_PERIOD_S)


async def mission_recorder_loop():
    """Drive auto-record for the whole server lifetime, including unattended
    autonomous runs with no operator connected — the underwater/no-signal case
    the operator needs captured.

    When a client is connected its telemetry loop already drains MAVLink (and so
    keeps `armed` fresh); when none is, we read it here ourselves so arm/disarm
    transitions are still seen. The client_count guard means there is never a
    second concurrent reader stealing the other's messages.
    """
    prev_armed = armed
    while True:
        if client_count == 0 and master is not None:
            # No client is draining the link — keep arm state current ourselves.
            read_telemetry()
        if autorecord_enabled:
            if armed and not prev_armed:
                await record_start()
            elif not armed and prev_armed and recording:
                await record_stop()
        prev_armed = armed
        await asyncio.sleep(0.5)


async def pixhawk_supervisor_loop():
    """Rebuild the MAVLink link after a dropout, for the whole server lifetime.

    Without this a single USB re-enumeration (cable knock, 5V brown-out, or the
    autopilot rebooting through its bootloader) left the server holding a dead
    handle until someone restarted it by hand.

    connect_pixhawk() blocks for up to 10s in wait_heartbeat, so it runs in a
    worker thread — blocking the event loop here would stall the websocket and
    RC-override loops, which is exactly what you don't want mid-dive.
    """
    loop = asyncio.get_running_loop()
    while True:
        if not pixhawk_ok:
            await loop.run_in_executor(None, connect_pixhawk)
            if not pixhawk_ok:
                await asyncio.sleep(PIXHAWK_RETRY_S)
        await asyncio.sleep(1.0)


def _build_ws_ssl_context():
    """Build the TLS context for the control WebSocket, or None to serve plain
    ws:// (LAN-only setups, or when a cert simply isn't configured yet).

    A missing/unreadable cert at the configured path fails loudly rather than
    silently falling back to plain ws://: that fallback would look identical to
    "TLS isn't configured" while actually meaning "TLS was expected and broke",
    and a remote operator would only discover it as an unexplained connection
    failure from their browser with no clue why."""
    if not WS_TLS_CERT and not WS_TLS_KEY:
        return None
    if not WS_TLS_CERT or not WS_TLS_KEY:
        raise SystemExit(
            "WS_TLS_CERT and WS_TLS_KEY must both be set (or both unset) — "
            "got only one."
        )
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(WS_TLS_CERT, WS_TLS_KEY)
    return ctx


async def main():
    connect_pixhawk()
    # Announce ourselves as a GCS at 1 Hz on a dedicated daemon thread, for the
    # whole server lifetime (not gated on a client being connected), so the
    # heartbeat is never delayed by the asyncio loop and ArduSub never trips its
    # heartbeat failsafe.
    start_heartbeat_thread()
    # Begin reading the Ping2 sonar on its own daemon thread (non-fatal if absent).
    # It sets the uart2 mux and retries the connect itself, so nothing else needs
    # to be launched for the sonar to appear in the UI.
    sonar.start()
    # Stream RC overrides continuously (see control_loop) so ArduSub's separate
    # manual-control failsafe is fed just as steadily as the heartbeat feeds the
    # GCS failsafe.
    asyncio.create_task(control_loop())
    # Auto-record missions (arm→record, disarm→stop), running with or without an
    # operator connected. See mission_recorder_loop.
    asyncio.create_task(mission_recorder_loop())
    # Reconnect the Pixhawk automatically if its USB link drops.
    asyncio.create_task(pixhawk_supervisor_loop())
    # Camera up with the server, not on operator demand. It used to start only
    # when a browser opened the Control page and stop when that page closed,
    # which the detector cannot live with: the JPEG frame tap lives inside
    # camera_stream.py, so nothing was being detected at any moment nobody
    # happened to be watching the feed — the exact moments an autonomous vehicle
    # most needs to be looking. Also means the stream is already up when an
    # operator connects instead of taking a few seconds to appear.
    #
    # Tried gating this on pixhawk_ok too (only run with a vehicle to film), but
    # constantly-on turned out to be the wanted behavior — simpler, and the
    # camera being up doesn't depend on guessing whether the Pixhawk will still
    # be plugged in a moment from now.
    #
    # The cost is real and deliberate: the camera now draws power and CPU for
    # the whole session. start_camera() blocks on Popen, hence the thread.
    await asyncio.to_thread(start_camera)
    start_media_server()
    print(f"Auto-record: {'ON' if autorecord_enabled else 'off'}")
    print(f"Auto-capture: {'ON' if AUTOCAPTURE else 'off'}"
          + (f" (conf >= {AUTOCAPTURE_MIN_CONF}, every {AUTOCAPTURE_COOLDOWN_S:.0f}s)"
             if AUTOCAPTURE else ""))
    ssl_ctx = _build_ws_ssl_context()
    scheme = "wss" if ssl_ctx else "ws"
    async with websockets.serve(client_handler, WS_HOST, WS_PORT, ssl=ssl_ctx):
        print(f"Seagrass drone server listening on {scheme}://{WS_HOST}:{WS_PORT}")
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    finally:
        all_stop()
        stop_camera()
        # The event loop is closed here, so signal the detector child directly
        # by pid rather than awaiting the async stop_detector().
        if detector_proc is not None:
            try:
                os.kill(detector_proc.pid, signal.SIGTERM)
            except (ProcessLookupError, OSError):
                pass
        if master and armed:
            do_disarm()
