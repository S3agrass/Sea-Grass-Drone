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
RAMP_SECONDS = 0.6      # time to reach MAX_PWM_OFFSET from a standstill while held

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

def reset_motion_state():
    global surge_pwm, steer_pwm, depth_pwm
    surge_pwm = steer_pwm = depth_pwm = NEUTRAL_PWM

def _ramp(current, target, dt):
    max_step = (MAX_PWM_OFFSET / RAMP_SECONDS) * dt
    if current < target:
        return min(current + max_step, target)
    if current > target:
        return max(current - max_step, target)
    return current

def update_motion(dt):
    global surge_pwm, steer_pwm
    forward = held('w')
    backward = held('s')
    left = held('a')
    right = held('d')

    surge_target = NEUTRAL_PWM
    if forward and not backward:
        surge_target = NEUTRAL_PWM + MAX_PWM_OFFSET
    elif backward and not forward:
        surge_target = NEUTRAL_PWM - MAX_PWM_OFFSET
    surge_pwm = _ramp(surge_pwm, surge_target, dt)
    set_rc(5, round(surge_pwm))

    steer_target = NEUTRAL_PWM
    if right and not left:
        steer_target = NEUTRAL_PWM + MAX_PWM_OFFSET
    elif left and not right:
        steer_target = NEUTRAL_PWM - MAX_PWM_OFFSET
    steer_pwm = _ramp(steer_pwm, steer_target, dt)
    set_rc(STEER_CHANNEL, round(steer_pwm))

def update_depth(dt):
    global depth_pwm
    ascend = held('q')
    descend = held('e')

    depth_target = NEUTRAL_PWM
    if ascend and not descend:
        depth_target = NEUTRAL_PWM + MAX_PWM_OFFSET
    elif descend and not ascend:
        depth_target = NEUTRAL_PWM - MAX_PWM_OFFSET
    depth_pwm = _ramp(depth_pwm, depth_target, dt)
    set_rc(3, round(depth_pwm))

def on_press(key):
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
    try:
        k = key.char
    except AttributeError:
        k = None

    if k:
        pressed_keys.discard(k)

# --- PS4 gamepad support -----------------------------------------------
# Same left-stick/right-stick/L1/Options mapping as the web app's
# GamepadControl.jsx: left stick + D-pad = move/steer (w/a/s/d), right
# stick Y = rise/dive (q/e), L1 = light toggle, Options = all-stop.
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
GAMEPAD_DEADZONE = 0.35
AXIS_MAX = 32767  # SDL controller axes are raw ints in [-32768, 32767]

gamepad_edge = {'l1': False, 'options': False}
gamepad_light_on = False

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
    global gamepad_light_on
    try:
        pygame.event.pump()

        left_x = gamepad.get_axis(pygame.CONTROLLER_AXIS_LEFTX) / AXIS_MAX
        left_y = gamepad.get_axis(pygame.CONTROLLER_AXIS_LEFTY) / AXIS_MAX
        right_y = gamepad.get_axis(pygame.CONTROLLER_AXIS_RIGHTY) / AXIS_MAX

        want_forward = left_y < -GAMEPAD_DEADZONE or gamepad.get_button(pygame.CONTROLLER_BUTTON_DPAD_UP)
        want_back = left_y > GAMEPAD_DEADZONE or gamepad.get_button(pygame.CONTROLLER_BUTTON_DPAD_DOWN)
        want_left = left_x < -GAMEPAD_DEADZONE or gamepad.get_button(pygame.CONTROLLER_BUTTON_DPAD_LEFT)
        want_right = left_x > GAMEPAD_DEADZONE or gamepad.get_button(pygame.CONTROLLER_BUTTON_DPAD_RIGHT)
        want_ascend = right_y < -GAMEPAD_DEADZONE
        want_descend = right_y > GAMEPAD_DEADZONE

        # Just update held state here — the main loop's periodic tick is
        # what actually ramps the PWM toward the target every cycle.
        set_gamepad_key('w', want_forward)
        set_gamepad_key('s', want_back)
        set_gamepad_key('a', want_left)
        set_gamepad_key('d', want_right)
        set_gamepad_key('q', want_ascend)
        set_gamepad_key('e', want_descend)

        l1_down = bool(gamepad.get_button(pygame.CONTROLLER_BUTTON_LEFTSHOULDER))
        if l1_down and not gamepad_edge['l1']:
            gamepad_light_on = not gamepad_light_on
            set_rc(LIGHT_CHANNEL, 1900 if gamepad_light_on else 1500)
            print("Light ON" if gamepad_light_on else "Light OFF")
        gamepad_edge['l1'] = l1_down

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
            axes = f"LX:{left_x:.2f} LY:{left_y:.2f} RY:{right_y:.2f}"
            held = [k for k in ('w', 'a', 's', 'd', 'q', 'e') if k in gamepad_keys]
            print(f"  [gamepad] {axes} held{held} l1={l1_down} options={options_down}")
    except pygame.error as exc:
        fallback = "falling back to keyboard-only control" if HAS_PYNPUT else "no input source left — press Ctrl+C to quit"
        print(f"Controller lost ({exc}) — {fallback}")
        gamepad_keys.clear()
        gamepad_edge['l1'] = False
        gamepad_edge['options'] = False
        all_stop()  # immediate hard stop, not a graceful ramp-down — control input is gone
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
        print("Ready! WASD to move, Q/E depth, L/K light, X to quit")

        gamepad = init_gamepad()
        if gamepad:
            print("PS4 controller ready! Left stick/D-pad move, right stick Y depth, L1 light, Options all-stop")

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
            update_motion(dt)
            update_depth(dt)

            time.sleep(0.05)

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