import time
from pymavlink import mavutil

CONNECTION = '/dev/ttyACM0'
BAUD = 115200

def connect():
    print(f"Connecting to {CONNECTION} @ {BAUD}...")
    master = mavutil.mavlink_connection(CONNECTION, baud=BAUD)
    master.wait_heartbeat()
    print(f"Heartbeat received (system {master.target_system}, component {master.target_component})")
    return master

def send_heartbeat(master):
    master.mav.heartbeat_send(
        mavutil.mavlink.MAV_TYPE_GCS,
        mavutil.mavlink.MAV_AUTOPILOT_INVALID,
        0, 0, 0
    )

def main():
    master = connect()
    last_heartbeat = time.time()

    while True:
        if time.time() - last_heartbeat > 1:
            send_heartbeat(master)
            last_heartbeat = time.time()

        msg = master.recv_match(blocking=False)
        if msg is None:
            time.sleep(0.01)
            continue

        msg_type = msg.get_type()

        if msg_type == 'ATTITUDE':
            print(f"ATTITUDE  roll={msg.roll:.3f} pitch={msg.pitch:.3f} yaw={msg.yaw:.3f}")
        elif msg_type == 'GLOBAL_POSITION_INT':
            print(f"GPOS_INT  lat={msg.lat/1e7:.6f} lon={msg.lon/1e7:.6f} relalt={msg.relative_alt/1000:.2f}m")
        elif msg_type == 'AHRS2':
            print(f"AHRS2     roll={msg.roll:.3f} pitch={msg.pitch:.3f} yaw={msg.yaw:.3f} alt={msg.altitude:.2f}")
        elif msg_type == 'VFR_HUD':
            print(f"VFR_HUD   heading={msg.heading} alt={msg.alt:.2f} climb={msg.climb:.2f}")

if __name__ == '__main__':
    main()
EOF
