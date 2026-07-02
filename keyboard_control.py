from pymavlink import mavutil
import time
import sys
import tty
import termios

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

def forward():
    set_rc(1, 1650)
    print("Forward")

def backward():
    set_rc(1, 1350)
    print("Backward")

def turn_left():
    set_rc(2, 1350)
    print("Left")

def turn_right():
    set_rc(2, 1650)
    print("Right")

def stop_movement():
    set_rc(1, 1500)
    set_rc(2, 1500)
    print("Stop movement")

def ascend():
    set_rc(3, 1650)
    print("Ascending")

def descend():
    set_rc(3, 1350)
    print("Descending")

def hold_depth():
    set_rc(3, 1500)
    print("Holding depth")

def light_on():
    set_rc(4, 1900)
    print("Light ON")

def light_off():
    set_rc(4, 1500)
    print("Light OFF")

def get_key():
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        key = sys.stdin.read(1)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
    return key

def handle_key(key):
    if key == 'w':
        forward()
    elif key == 's':
        backward()
    elif key == 'd':
        turn_right()
    elif key == 'a':
        turn_left()
    elif key == ' ':
        stop_movement()
    elif key == 'q':
        ascend()
    elif key == 'e':
        descend()
    elif key == 'h':
        hold_depth()
    elif key == 'l':
        light_on()
    elif key == 'k':
        light_off()
    elif key == 'x':
        all_stop()
        light_off()
        disarm()
        sys.exit(0)


try:
    master.set_mode('MANUAL')
    arm()
    print("Ready! WASD to move, Q/E depth, L/K light, X to quit")
    while True:
        key = get_key()
        handle_key(key)
finally:
    all_stop()
    light_off()
    disarm()
