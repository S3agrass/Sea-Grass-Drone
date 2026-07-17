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
import subprocess
import threading
import time

import websockets
from pymavlink import mavutil

# ---------------- configuration ----------------
SERIAL_PORT = os.environ.get("PIXHAWK_PORT", "/dev/ttyACM0")
BAUD = int(os.environ.get("PIXHAWK_BAUD", "115200"))
WS_HOST = "0.0.0.0"
WS_PORT = int(os.environ.get("SEAGRASS_PORT", "8765"))
TOKEN = os.environ.get("SEAGRASS_TOKEN", "")  # empty = auth disabled (LAN only!)
if not TOKEN:
    raise SystemExit("SEAGRASS_TOKEN must be set — export it before running this script.")
WATCHDOG_S = 1.5

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

# -- Ramp-up = seconds a held/full input takes to build from stopped to full
#    power (bigger = gentler spin-up); Decay = seconds to fall back to stopped
#    after release (bigger = longer coast, smaller = crisper stop). The two
#    RAMP_UP knobs below are THE dial for how gradual the spin-up feels: they're
#    "seconds from thrust onset to top speed" and do NOT change top speed
#    (that's MAX_PWM_OFFSET). The ramp is EASED, not linear (see RAMP_EASE_RATIO
#    and _ramp): rate grows with how fast you're already going, so the spin-up
#    starts gentle and accelerates. Rate keys off current speed, not off how far
#    away the target is, so a small stick nudge is still reached quickly -- it's
#    just a short trip -- while a full-stick pull takes the whole ramp_up_s. ---
SURGE_RAMP_UP_S  = float(os.environ.get("SEAGRASS_SURGE_RAMP", "5.0"))  # forward: seconds to full. Bigger = gentler/chiller.
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

# Editable behaviour map: angle (degrees, 0=forward, 90=hard right, 180=reverse,
# 270=hard left) -> (left_motor, right_motor), each in [-1.0, 1.0].
#   sign     = direction (+ shows "CW" in the readout, - shows "CCW")
#   magnitude= speed (1.0 = full = +/-MAX_PWM_OFFSET, 0.5 = half, 0.0 = stopped)
# Edit any entry to change that direction; add more keys (e.g. 30, 60) for finer
# control — interpolation and the live readout pick them up automatically.
ANGLE_TABLE = {
    0:   ( -1.0,  -1.0),   # forward
    45:  ( -1.0,  0.0),   # forward-right: left drives, right stops
    90:  ( -1.0, 1.0),   # hard right: pivot in place
    135: ( 0.0, 1.0),
    180: (1.0, 1.0),   # reverse
    225: (1.0,  0.0),
    270: (1.0,  -1.0),   # hard left: pivot in place
    315: ( 0.0,  -1.0),
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

# ---------------- camera subprocess ----------------
# The repo-root camera_stream.py (Picamera2 -> MJPEG on :8000) is the camera
# path that actually runs on this Pi. server/camera_stream.py is the WebRTC/
# GStreamer stack, which needs GStreamer + MediaMTX installed; point this there
# once that toolchain is in place.
_CAMERA_SCRIPT = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "camera_stream.py")
)
camera_proc: subprocess.Popen | None = None

# Shared frame slot: camera_stream.py's detection tap writes the latest JPEG
# here, and detector.py reads it. Passing DETECT_FRAME to the camera turns the
# tap on whenever the camera runs; the detector only consumes it when detection
# is enabled, so the two lifecycles stay decoupled.
DETECT_FRAME_PATH = os.environ.get("DETECT_FRAME", "/tmp/seagrass-detect-frame.jpg")


def camera_running() -> bool:
    return camera_proc is not None and camera_proc.poll() is None


def start_camera():
    global camera_proc
    if camera_running():
        return
    try:
        camera_proc = subprocess.Popen(
            ["python3", _CAMERA_SCRIPT],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={**os.environ, "DETECT_FRAME": DETECT_FRAME_PATH},
        )
        print(f"Camera stream started (pid {camera_proc.pid})")
    except Exception as exc:  # noqa: BLE001
        print(f"Failed to start camera: {exc}")


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


# ---------------- detector subprocess ----------------
# The object detector runs as a separate OS process (like the camera) so its
# CPU-bound inference never blocks the asyncio control loop that drives MAVLink
# and the safety watchdog. Unlike the camera we need its stdout, so it is an
# asyncio subprocess whose JSON lines are read into `latest_detections`.
_DETECTOR_SCRIPT = os.path.join(os.path.dirname(__file__), "vision", "detector.py")
detector_proc: "asyncio.subprocess.Process | None" = None
latest_detections = {"boxes": [], "ts": 0}


def detector_running() -> bool:
    return detector_proc is not None and detector_proc.returncode is None


async def start_detector():
    global detector_proc
    if detector_running():
        return
    try:
        detector_proc = await asyncio.create_subprocess_exec(
            "python3", _DETECTOR_SCRIPT,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env={**os.environ, "DETECT_FRAME": DETECT_FRAME_PATH},
        )
        print(f"Detector started (pid {detector_proc.pid})")
        asyncio.create_task(_read_detections(detector_proc))
    except Exception as exc:  # noqa: BLE001
        print(f"Failed to start detector: {exc}")


async def _read_detections(proc):
    """Consume the detector's stdout JSON lines into latest_detections."""
    global latest_detections
    while proc.returncode is None:
        line = await proc.stdout.readline()
        if not line:
            break
        try:
            latest_detections = json.loads(line)
        except json.JSONDecodeError:
            continue


async def stop_detector():
    global detector_proc, latest_detections
    latest_detections = {"boxes": [], "ts": 0}
    if not detector_running():
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
            except OSError:
                pass  # link dropped; read_telemetry surfaces it on next read
        time.sleep(HEARTBEAT_S)


def start_heartbeat_thread():
    threading.Thread(target=_heartbeat_loop, daemon=True).start()


def connect_pixhawk():
    global master, pixhawk_ok
    try:
        print(f"Connecting to Pixhawk on {SERIAL_PORT} @ {BAUD}…")
        master = mavutil.mavlink_connection(SERIAL_PORT, baud=BAUD)
        master.wait_heartbeat(timeout=10)
        pixhawk_ok = True
        print("Pixhawk heartbeat OK")
    except Exception as exc:  # noqa: BLE001
        pixhawk_ok = False
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
    # Zero every input source and the ramped PWM state first, so the control_loop
    # doesn't immediately ramp back up from the pre-stop speed on its next tick.
    reset_motion_state()
    if not master:
        return
    # ArduSub's manual-control mixer uses a fixed RC scheme: ch1=Pitch,
    # ch2=Roll, ch3=Throttle/vertical, ch4=Yaw, ch5=Forward, ch6=Lateral.
    # This 2-motor SimpleROV-3 frame has authority over ch3 (vertical), ch4
    # (steering/yaw) and ch5 (forward) — not ch6 (lateral), which has no
    # thruster. Neutral those three and leave the light channel alone (mirrors
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
    """Turn stick components into a compass-style angle + magnitude for ANGLE_TABLE.

    x = steer (right +), y = surge (forward +). atan2(x, y) puts 0deg at pure
    forward and 90deg at pure right (matching the table's convention), wrapped to
    [0, 360). magnitude is the stick's distance from center, clamped to 1.0. At
    dead center (0, 0) magnitude is 0, so the motors come out stopped."""
    angle = math.degrees(math.atan2(x, y)) % 360.0
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


def _ramp(current, target, dt, ramp_up_s, decay_s, max_offset):
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
        band = max(1.0, max_offset - CREEP_FLOOR)
        v = min(1.0, (abs(cur_off) - CREEP_FLOOR) / band)
        rate = band * (_EASE_A + _EASE_B * v) / ramp_up_s
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
                      dt, surge_up, surge_dec, surge_max)
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
        msg = master.recv_match(blocking=False)
        if msg is None:
            break
        t = msg.get_type()
        if t == "VFR_HUD":
            out["heading"] = msg.heading
            out["groundspeed"] = round(msg.groundspeed * 1.94384, 2)  # m/s -> kn
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
    global helm_holder
    authed = not TOKEN
    last_seen = time.time()
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
            }
        )

    async def telemetry_loop():
        while True:
            data, notices = read_telemetry()
            if data:
                await send({"type": "telemetry", **data})
            for level, message in notices:
                await send({"type": "notice", "level": level, "message": message})
            await state()
            # watchdog — force neutral if the client went silent mid-motion
            # (a held key OR a deflected analog stick both count as motion)
            if helm_holder is ws and motion_active() and time.time() - last_seen > WATCHDOG_S:
                all_stop()  # also clears keys + axes via reset_motion_state
                print("Watchdog: all stop")
            await asyncio.sleep(0.5)

    async def detections_loop():
        # Relay detector output at ~5fps (faster than the 0.5s telemetry loop so
        # overlay boxes track smoothly). Silent while the detector is off.
        while True:
            if detector_running():
                await send({"type": "detections", **latest_detections})
            await asyncio.sleep(0.2)

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
                await state()
                print("KILL SWITCH: all stop + disarm, shutting server down")
                os._exit(0)
            elif mtype == "camera_on":
                await asyncio.to_thread(start_camera)
                await state()
            elif mtype == "camera_off":
                await stop_detector()
                await asyncio.to_thread(stop_camera)
                await state()
            elif mtype == "detect_on":
                await start_detector()
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
        tele_task.cancel()
        detect_task.cancel()
        motors_task.cancel()
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


async def main():
    connect_pixhawk()
    # Announce ourselves as a GCS at 1 Hz on a dedicated daemon thread, for the
    # whole server lifetime (not gated on a client being connected), so the
    # heartbeat is never delayed by the asyncio loop and ArduSub never trips its
    # heartbeat failsafe.
    start_heartbeat_thread()
    # Stream RC overrides continuously (see control_loop) so ArduSub's separate
    # manual-control failsafe is fed just as steadily as the heartbeat feeds the
    # GCS failsafe.
    asyncio.create_task(control_loop())
    async with websockets.serve(client_handler, WS_HOST, WS_PORT):
        print(f"Seagrass drone server listening on ws://{WS_HOST}:{WS_PORT}")
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
