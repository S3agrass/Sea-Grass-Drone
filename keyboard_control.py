import os
import sys
import threading
import time

from pymavlink import mavutil

try:
    from pynput import keyboard
    HAS_PYNPUT = True
except ImportError:
    HAS_PYNPUT = False
    keyboard = None

try:
    import pygame
    import pygame._sdl2.controller as sdl_controller
    HAS_PYGAME = True
except ImportError:
    HAS_PYGAME = False

# Same PIXHAWK_PORT/PIXHAWK_BAUD env override pattern as server/drone_server.py,
# so this file works unedited on the Mac (/dev/cu.usbmodemXXXX) and the Pi
# (/dev/ttyACM0).
PIXHAWK_PORT = os.environ.get("PIXHAWK_PORT", "/dev/ttyACM0")
PIXHAWK_BAUD = int(os.environ.get("PIXHAWK_BAUD", "115200"))

try:
    print(f"Connecting to Pixhawk on {PIXHAWK_PORT} @ {PIXHAWK_BAUD}...")
    if PIXHAWK_PORT.startswith(("udp", "tcp")):
        master = mavutil.mavlink_connection(PIXHAWK_PORT)
    else:
        master = mavutil.mavlink_connection(PIXHAWK_PORT, baud=PIXHAWK_BAUD)
    if master.wait_heartbeat(timeout=10) is None:
        print(f"No heartbeat from Pixhawk on {PIXHAWK_PORT} after 10s — is it powered and plugged in?")
        sys.exit(1)
except OSError as exc:
    print(f"Could not open {PIXHAWK_PORT}: {exc}")
    print("Set PIXHAWK_PORT to the correct serial device "
          "(e.g. /dev/ttyACM0 on the Pi, /dev/cu.usbmodemXXXX on Mac) and try again.")
    sys.exit(1)

print("Connected!")

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
            # thread and let the main loop notice and clean up.
            break
        time.sleep(1)

heartbeat_thread = threading.Thread(target=send_heartbeat_loop, daemon=True)
heartbeat_thread.start()

def arm():
    """Attempt to arm, retrying once on timeout. Returns True iff confirmed armed."""
    for attempt in (1, 2):
        master.arducopter_arm()
        print(f"Arm command sent (attempt {attempt}/2), waiting for confirmation...")
        end_time = time.time() + 10
        while time.time() < end_time:
            msg = master.recv_match(type=['STATUSTEXT', 'HEARTBEAT'], blocking=False)
            if msg:
                if msg.get_type() == 'STATUSTEXT':
                    print(f"  STATUSTEXT: {msg.text}")
                elif msg.get_type() == 'HEARTBEAT':
                    armed = bool(msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
                    if armed:
                        print("Armed!")
                        return True
            time.sleep(0.1)
        print(f"Arm attempt {attempt}/2 timed out after 10s — check STATUSTEXT messages above for the reason")
    print("ARM FAILED after 2 attempts — refusing to continue as if armed. "
          "Check the safety switch, battery, and EKF status and try again.")
    return False

def disarm():
    master.arducopter_disarm()
    end_time = time.time() + 5
    while time.time() < end_time:
        msg = master.recv_match(type='HEARTBEAT', blocking=False)
        if msg and not bool(msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED):
            print("Disarmed!")
            return
        time.sleep(0.1)
    print("Disarm not confirmed within 5s (vehicle may already be disarmed, or connection was lost)")

def set_rc(channel, pwm):
    rc = [65535] * 8
    rc[channel - 1] = pwm
    master.mav.rc_channels_override_send(
        master.target_system,
        master.target_component,
        *rc
    )
    print(f"  -> Sent: Channel {channel} = {pwm}")

def all_stop():
    # ArduSub's manual-control mixer uses a fixed RC scheme:
    # ch1=Pitch, ch2=Roll, ch3=Throttle/vertical, ch4=Yaw, ch5=Forward, ch6=Lateral.
    # Our SimpleROV-3 (2-motor) frame has no lateral thruster, so steering
    # rides on Yaw (ch4) — ch3 (vertical), ch4 (steering), and ch5 (forward)
    # are the channels that must be neutraled here. Light (LIGHT_CHANNEL) is
    # deliberately left alone so an all-stop doesn't also kill the light.
    rc = [65535] * 8
    rc[2] = 1500  # channel 3 - throttle/vertical
    rc[STEER_CHANNEL - 1] = 1500
    rc[4] = 1500  # channel 5 - forward
    master.mav.rc_channels_override_send(
        master.target_system,
        master.target_component,
        *rc
    )
    reset_motion_state()  # so the next tick doesn't resume ramping from the pre-stop speed
    print("All stop")

# Keyboard and gamepad each get their own held-input set so that releasing
# one source's stick/key can't clobber the other source still holding it.
# update_motion/update_depth read the union of both, which is what actually
# integrates the PS4 controller into the existing keyboard control paths.
pressed_keys = set()
gamepad_keys = set()

def held(k):
    return k in pressed_keys or k in gamepad_keys

NEUTRAL_PWM = 1500
MAX_PWM_OFFSET = 150    # safe limit — PWM never goes past NEUTRAL_PWM +/- this

# Feel tuning — ramp-up and decay are independent knobs per axis, all in
# seconds. Just change the number:
#   *_RAMP_UP_S = how long a held key/stick takes to go from stopped to
#                 full power (bigger = gentler acceleration).
#   *_DECAY_S   = how long it takes to fall back to stopped after you let
#                 go (bigger = longer coast, smaller = crisper stop).
# SURGE = forward/back (W/S), STEER = left/right turn (A/D),
# DEPTH = ascend/descend (Q/E).
SURGE_RAMP_UP_S = 1.5
SURGE_DECAY_S = 0.1
STEER_RAMP_UP_S = 0.35
STEER_DECAY_S = 0.25
DEPTH_RAMP_UP_S = 1.0
DEPTH_DECAY_S = 0.4

# During a turn, shed up to this fraction of forward power (scaled by how
# hard the turn is) so the yaw differential dominates — the drone carves
# through the turn instead of plowing straight ahead with a slight drift.
TURN_ASSIST = 0.45

TICK_SECONDS = 0.02     # 50 Hz control loop — smooth ramps, low input latency

# This 2-motor SimpleROV-3 frame has no lateral thruster, so left/right
# steering has to ride on Yaw (ch4) — sending it on Lateral (ch6) is a
# channel this frame has zero authority over, hence "stick moves, nothing
# happens." Light rides on its own spare channel so it can't fight with
# steering the way it did sharing ch4. Adjust LIGHT_CHANNEL below if your
# light relay isn't wired to ch7 (check QGroundControl's SERVOx_FUNCTION
# parameters).
STEER_CHANNEL = 4
LIGHT_CHANNEL = 7

# Current commanded PWM per axis. Ramped a little every tick instead of
# snapping straight to full/neutral, so holding a direction longer builds
# up speed toward MAX_PWM_OFFSET rather than going 0-to-100 instantly.
surge_pwm = NEUTRAL_PWM   # ch5 - forward/back
steer_pwm = NEUTRAL_PWM   # STEER_CHANNEL - left/right
depth_pwm = NEUTRAL_PWM   # ch3 - ascend/descend

# Analog stick input in [-1, 1] per axis, written by poll_gamepad. Keyboard
# keys contribute full-scale +/-1; the two sources are summed and clamped so
# either one can drive, and opposing inputs cancel.
gamepad_axes = {'surge': 0.0, 'steer': 0.0, 'depth': 0.0}

_last_sent_frame = None

def reset_motion_state():
    global surge_pwm, steer_pwm, depth_pwm, speed_locked, locked_targets
    surge_pwm = steer_pwm = depth_pwm = NEUTRAL_PWM
    # A speed lock must never survive a stop — otherwise the vehicle would sit
    # locked at neutral, ignoring the sticks, with no visible reason why.
    speed_locked = False
    locked_targets = None

def _axis_value(pos_key, neg_key, analog):
    digital = (1.0 if held(pos_key) else 0.0) - (1.0 if held(neg_key) else 0.0)
    return max(-1.0, min(1.0, digital + analog))

def _ramp(current, target, dt, ramp_up_s, decay_s):
    # Ramp-up rate applies while pushing further from neutral in the same
    # direction; anything heading back toward (or through) neutral uses the
    # decay rate so letting go can feel immediate, not floaty.
    cur_off = current - NEUTRAL_PWM
    tgt_off = target - NEUTRAL_PWM
    moving_away = abs(tgt_off) > abs(cur_off) and cur_off * tgt_off >= 0
    secs = ramp_up_s if moving_away else decay_s
    max_step = (MAX_PWM_OFFSET / secs) * dt
    if current < target:
        return min(current + max_step, target)
    if current > target:
        return max(current - max_step, target)
    return current

def update_flight(dt):
    global surge_pwm, steer_pwm, depth_pwm, _last_sent_frame, locked_targets
    surge_in = _axis_value('w', 's', gamepad_axes['surge'])
    steer_in = _axis_value('d', 'a', gamepad_axes['steer'])
    depth_in = _axis_value('q', 'e', gamepad_axes['depth'])

    # Turn assist: the harder the turn, the more forward power is shed, so
    # the yaw differential between the two motors stays pronounced instead
    # of both motors saturating forward.
    surge_in *= 1.0 - TURN_ASSIST * abs(steer_in)

    targets = (NEUTRAL_PWM + surge_in * MAX_PWM_OFFSET,
               NEUTRAL_PWM + steer_in * MAX_PWM_OFFSET,
               NEUTRAL_PWM + depth_in * MAX_PWM_OFFSET)
    # R1 speed lock: latch the targets on the first tick after locking, then
    # hold them — stick/key motion input is computed and discarded until
    # unlock, while frames keep flowing below so the RC-override failsafe
    # still sees a live pilot.
    if speed_locked:
        if locked_targets is None:
            locked_targets = targets
        targets = locked_targets
    else:
        locked_targets = None

    surge_pwm = _ramp(surge_pwm, targets[0],
                      dt, SURGE_RAMP_UP_S, SURGE_DECAY_S)
    steer_pwm = _ramp(steer_pwm, targets[1],
                      dt, STEER_RAMP_UP_S, STEER_DECAY_S)
    depth_pwm = _ramp(depth_pwm, targets[2],
                      dt, DEPTH_RAMP_UP_S, DEPTH_DECAY_S)

    # One combined override per tick instead of three separate messages —
    # less serial traffic and the axes always arrive as a consistent frame.
    # Sent every tick even when unchanged so ArduSub's RC-override timeout
    # failsafe keeps seeing a live pilot.
    rc = [65535] * 8
    rc[2] = round(depth_pwm)
    rc[STEER_CHANNEL - 1] = round(steer_pwm)
    rc[4] = round(surge_pwm)
    master.mav.rc_channels_override_send(
        master.target_system,
        master.target_component,
        *rc
    )
    frame = (rc[4], rc[STEER_CHANNEL - 1], rc[2])
    if frame != _last_sent_frame:
        print(f"  -> surge={frame[0]} steer={frame[1]} depth={frame[2]}")
        _last_sent_frame = frame

# Arrow keys drive the same forward/steer channels as WASD: Up/Down = both
# motors together (CW/CCW = forward/back), Left/Right = differential turn
# (one motor slows while the other holds speed). ArduSub's mixer for this
# 2-motor frame does that differential split on its own from the ch5
# (forward) + STEER_CHANNEL (yaw) commands — same as W/A/S/D below.
# Guard on hasattr(keyboard, 'Key') too, not just HAS_PYNPUT: over headless SSH
# (no display) the pynput import succeeds but its backend can't initialize, so
# keyboard.Key never gets attached and referencing keyboard.Key.* here would
# crash at import. If it's missing we fall back to an empty map and gamepad-only
# control (the pygame path works independently).
ARROW_KEY_MAP = {
    keyboard.Key.up: 'w',
    keyboard.Key.down: 's',
    keyboard.Key.left: 'a',
    keyboard.Key.right: 'd',
} if HAS_PYNPUT and hasattr(keyboard, 'Key') else {}

def on_press(key):
    k = ARROW_KEY_MAP.get(key)
    if k is None:
        try:
            k = key.char
        except AttributeError:
            k = None

    if k:
        pressed_keys.add(k)
        # w/s/a/d/q/e just update held state — the main loop's periodic
        # tick is what ramps the PWM toward the target every cycle.
        if k == 'l':
            set_rc(LIGHT_CHANNEL, 1900)
            print("Light ON")
        elif k == 'k':
            set_rc(LIGHT_CHANNEL, 1500)
            print("Light OFF")
        elif k == 'x':
            return False

def on_release(key):
    k = ARROW_KEY_MAP.get(key)
    if k is None:
        try:
            k = key.char
        except AttributeError:
            k = None

    if k:
        pressed_keys.discard(k)

# --- PS4 gamepad support -----------------------------------------------
# Same left-stick/right-stick/L1/R1/Options mapping as the web app's
# GamepadControl.jsx: left stick + D-pad = move/steer (w/a/s/d), right
# stick Y = rise/dive (q/e), L1 = light toggle, R1 = speed lock,
# Options = all-stop.
#
# This uses pygame's SDL GameController API (named buttons: leftshoulder,
# start, dpad_up, ...) instead of raw joystick button indices. Raw indices
# are assigned per-device by however the OS/driver enumerates the HID
# report and are not portable — that's what caused L1 to fire the "all
# stop" action: this controller's raw index 9 is L1, not Options, and
# index 4 isn't Options either. SDL's controller database maps by
# physical button name instead, so this works regardless of raw ordering
# as long as SDL recognizes the pad (run with --gamepad-debug to confirm
# what SDL sees).
# Fraction of stick travel near center that reads as zero, killing rest drift.
# Not a gate — _stick_curve rescales the remaining travel so output starts from
# 0 right at the deadzone edge, so this costs no resolution. Keep it just above
# the pad's real drift (run --gamepad-debug with the sticks centred to read it).
GAMEPAD_DEADZONE = 0.05
# Gas-pedal response: two linear zones meeting at a knee, instead of one expo
# curve. The creep zone (deadzone edge -> CREEP_ZONE_END of the remaining
# travel) climbs gently to CREEP_ZONE_OUTPUT of full authority; past the knee
# the power zone climbs ~5x steeper to exactly 1.0 at full lock. Easing around
# the top of the stick moves output slowly; pushing past the knee gives clearly
# more power per millimetre — a distinction a single expo curve can't make.
# Keep these in step with src/lib/stickCurve.js and terminal_control.py.
#
# Retune CREEP_ZONE_OUTPUT first: it sets how fast "slow" is. Raise it if the
# whole creep zone feels inert, lower it if inching is already too quick.
# CREEP_ZONE_END trades fine-control travel against power-zone travel.
CREEP_ZONE_END = 0.55     # fraction of post-deadzone travel in the creep zone
CREEP_ZONE_OUTPUT = 0.2   # authority at the knee (1.0 = full)
AXIS_MAX = 32767  # SDL controller axes are raw ints in [-32768, 32767]

gamepad_edge = {'l1': False, 'r1': False, 'options': False}
gamepad_light_on = False

# R1 speed lock: freeze the current motion targets and ignore stick/key input
# for surge/steer/depth until R1 is pressed again. speed_locked is the toggle;
# locked_targets is captured lazily by update_flight on the first tick after
# locking (that's where the targets are computed), and cleared on unlock.
# All-stop always wins: all_stop() drops the lock along with the motion state.
speed_locked = False
locked_targets = None

def _stick_curve(raw):
    """Deadzone-rescaled two-zone "gas pedal" response. Rescaling means the
    output ramps from 0 at the deadzone edge instead of jumping to it; the two
    zones are continuous at the knee and reach exactly 1.0 at full deflection.
    Same shape as src/lib/stickCurve.js — keep them in step."""
    mag = abs(raw)
    if mag < GAMEPAD_DEADZONE:
        return 0.0
    mag = min(1.0, (mag - GAMEPAD_DEADZONE) / (1.0 - GAMEPAD_DEADZONE))
    if mag <= CREEP_ZONE_END:
        mag = CREEP_ZONE_OUTPUT * (mag / CREEP_ZONE_END)
    else:
        mag = CREEP_ZONE_OUTPUT + ((1.0 - CREEP_ZONE_OUTPUT)
                                   * (mag - CREEP_ZONE_END) / (1.0 - CREEP_ZONE_END))
    return mag if raw >= 0 else -mag

def set_gamepad_key(key, want_held):
    was_held = key in gamepad_keys
    if want_held == was_held:
        return False
    if want_held:
        gamepad_keys.add(key)
    else:
        gamepad_keys.discard(key)
    return True

def poll_gamepad(gamepad, debug=False):
    """Poll one frame of gamepad input.

    Returns the gamepad object to keep using (unchanged on success), or None
    if the controller has disconnected — the caller should drop it and fall
    back to keyboard-only (if available).
    """
    global gamepad_light_on, speed_locked
    try:
        pygame.event.pump()

        left_x = gamepad.get_axis(pygame.CONTROLLER_AXIS_LEFTX) / AXIS_MAX
        left_y = gamepad.get_axis(pygame.CONTROLLER_AXIS_LEFTY) / AXIS_MAX
        right_y = gamepad.get_axis(pygame.CONTROLLER_AXIS_RIGHTY) / AXIS_MAX

        # Sticks are fully analog: half deflection = half authority, with an
        # expo curve for fine control near center. Stick up is negative raw,
        # so surge/depth flip sign. The main loop's periodic tick is what
        # actually ramps the PWM toward these targets every cycle.
        gamepad_axes['surge'] = -_stick_curve(left_y)
        gamepad_axes['steer'] = _stick_curve(left_x)
        gamepad_axes['depth'] = -_stick_curve(right_y)

        # D-pad stays digital: full authority in the pressed direction.
        set_gamepad_key('w', bool(gamepad.get_button(pygame.CONTROLLER_BUTTON_DPAD_UP)))
        set_gamepad_key('s', bool(gamepad.get_button(pygame.CONTROLLER_BUTTON_DPAD_DOWN)))
        set_gamepad_key('a', bool(gamepad.get_button(pygame.CONTROLLER_BUTTON_DPAD_LEFT)))
        set_gamepad_key('d', bool(gamepad.get_button(pygame.CONTROLLER_BUTTON_DPAD_RIGHT)))

        l1_down = bool(gamepad.get_button(pygame.CONTROLLER_BUTTON_LEFTSHOULDER))
        if l1_down and not gamepad_edge['l1']:
            gamepad_light_on = not gamepad_light_on
            set_rc(LIGHT_CHANNEL, 1900 if gamepad_light_on else 1500)
            print("Light ON" if gamepad_light_on else "Light OFF")
        gamepad_edge['l1'] = l1_down

        # R1 toggles the speed lock (edge-detected like L1). update_flight does
        # the actual latching/holding; all_stop() below always clears the lock.
        r1_down = bool(gamepad.get_button(pygame.CONTROLLER_BUTTON_RIGHTSHOULDER))
        if r1_down and not gamepad_edge['r1']:
            speed_locked = not speed_locked
        gamepad_edge['r1'] = r1_down

        options_down = bool(gamepad.get_button(pygame.CONTROLLER_BUTTON_START))
        if options_down and not gamepad_edge['options']:
            # All-stop only — zero the sticks and keep the program (and the
            # arm state) running, rather than quitting. Use 'x' on the
            # keyboard or Ctrl+C to actually end the session.
            print("Gamepad OPTIONS — all stop")
            all_stop()
            gamepad_keys.clear()
            pressed_keys.clear()
        gamepad_edge['options'] = options_down

        if debug:
            axes = (f"surge:{gamepad_axes['surge']:+.2f} steer:{gamepad_axes['steer']:+.2f} "
                    f"depth:{gamepad_axes['depth']:+.2f}")
            held_dpad = [k for k in ('w', 'a', 's', 'd') if k in gamepad_keys]
            print(f"  [gamepad] {axes} dpad{held_dpad} l1={l1_down} r1={r1_down} "
                  f"lock={speed_locked} options={options_down}")
    except pygame.error as exc:
        fallback = "falling back to keyboard-only control" if HAS_PYNPUT else "no input source left — press Ctrl+C to quit"
        print(f"Controller lost ({exc}) — {fallback}")
        gamepad_keys.clear()
        gamepad_axes['surge'] = gamepad_axes['steer'] = gamepad_axes['depth'] = 0.0
        gamepad_edge['l1'] = False
        gamepad_edge['r1'] = False
        gamepad_edge['options'] = False
        all_stop()  # immediate hard stop, not a graceful ramp-down — control input is gone; also drops any speed lock
        return None

    return gamepad

def init_gamepad():
    if not HAS_PYGAME:
        print("pygame not installed — gamepad control disabled (pip install pygame to enable)")
        return None

    pygame.init()
    sdl_controller.init()
    if sdl_controller.get_count() == 0:
        print("No gamepad detected — keyboard-only control")
        return None

    gamepad = sdl_controller.Controller(0)
    gamepad.init()
    print(f"Gamepad connected: {gamepad.name}")
    return gamepad

if __name__ == "__main__":
    gamepad_debug = "--gamepad-debug" in sys.argv

    listener = None
    gamepad = None
    try:
        master.set_mode('MANUAL')
        if not arm():
            sys.exit(1)
        print("Ready! Arrow keys (or WASD) to move, Q/E depth, L/K light, X to quit")

        gamepad = init_gamepad()
        if gamepad:
            print("PS4 controller ready! Left stick/D-pad move, right stick Y depth, "
                  "L1 light, R1 speed lock, Options all-stop")

        if HAS_PYNPUT:
            try:
                listener = keyboard.Listener(on_press=on_press, on_release=on_release)
                listener.start()
            except Exception as e:
                print(f"Keyboard input unavailable ({e}) — gamepad-only control")
        else:
            print("pynput not available — keyboard control disabled, gamepad-only")

        if not gamepad and not listener:
            print("No input source available (no gamepad, no keyboard) — nothing to do. Exiting.")
            sys.exit(1)

        last_tick = time.time()
        while listener.running if listener else True:
            if gamepad:
                gamepad = poll_gamepad(gamepad, debug=gamepad_debug)

            now = time.time()
            dt = now - last_tick
            last_tick = now
            update_flight(dt)

            time.sleep(TICK_SECONDS)

    except KeyboardInterrupt:
        print("\nInterrupted — shutting down")
    except OSError as exc:
        print(f"Lost connection to Pixhawk: {exc}")
    finally:
        if listener:
            listener.stop()
        try:
            all_stop()
            set_rc(LIGHT_CHANNEL, 1500)
            disarm()
        except OSError as exc:
            print(f"Could not send stop/disarm commands — connection already lost: {exc}")