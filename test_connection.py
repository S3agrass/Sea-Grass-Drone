from pymavlink import mavutil

master = mavutil.mavlink_connection('tcp:127.0.0.1:5760')
master.wait_heartbeat()
print("Connected! Heartbeat received.")