from pymavlink import mavutil
import time
from pynput import keyboard

master = mavutil.mavlink_connection('/dev/ttyACM0', baud=115200)
master.wait_heartbeat()
print("Connected!")

def arm():
    master.arducopter_arm()
    master.motors_armed_wait()
    print("Armed!")

def disarm():
    master.arducopter_disarm()
    master.motors_disarmed_wait()
    print("Disarmed!")

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
    rc = [1500, 1500, 1500, 1500, 65535, 65535, 65535, 65535]
    master.mav.rc_channels_override_send(
        master.target_system,
        master.target_component,
        *rc
    )
    print("All stop")

pressed_keys = set()

FORWARD_PWM = 1650
BACKWARD_PWM = 1350
NEUTRAL_PWM = 1500
ASCEND_PWM = 1650
DESCEND_PWM = 1350

def update_motion():
    forward = 'w' in pressed_keys
    backward = 's' in pressed_keys
    left = 'a' in pressed_keys
    right = 'd' in pressed_keys

    if forward and not backward:
        set_rc(1, FORWARD_PWM)
    elif backward and not forward:
        set_rc(1, BACKWARD_PWM)
    else:
        set_rc(1, NEUTRAL_PWM)

    if right and not left:
        set_rc(2, FORWARD_PWM)
    elif left and not right:
        set_rc(2, BACKWARD_PWM)
    else:
        set_rc(2, NEUTRAL_PWM)

def update_depth():
    ascend = 'q' in pressed_keys
    descend = 'e' in pressed_keys

    if ascend and not descend:
        set_rc(3, ASCEND_PWM)
    elif descend and not ascend:
        set_rc(3, DESCEND_PWM)
    else:
        set_rc(3, NEUTRAL_PWM)

def on_press(key):
    try:
        k = key.char
    except AttributeError:
        k = None

    if k:
        pressed_keys.add(k)
        if k in ('w', 's', 'a', 'd'):
            update_motion()
        elif k in ('q', 'e'):
            update_depth()
        elif k == 'l':
            set_rc(4, 1900)
            print("Light ON")
        elif k == 'k':
            set_rc(4, 1500)
            print("Light OFF")
        elif k == 'x':
            return False

def on_release(key):
    try:
        k = key.char
    except AttributeError:
        k = None

    if k in pressed_keys:
        pressed_keys.discard(k)
        if k in ('w', 's', 'a', 'd'):
            update_motion()
        elif k in ('q', 'e'):
            update_depth()

try:
    master.set_mode('MANUAL')
    arm()
    print("Ready! WASD to move, Q/E depth, L/K light, X to quit")

    with keyboard.Listener(on_press=on_press, on_release=on_release) as listener:
        listener.join()

finally:
    all_stop()
    set_rc(4, 1500)
    disarm()
