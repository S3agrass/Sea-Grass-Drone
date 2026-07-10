"""
Seagrass drone server — runs on the Raspberry Pi 5.

Bridges the React GCS to the Pixhawk over MAVLink. Mirrors the channel
mapping in keyboard_control.py so the UI and the CLI tool behave identically:

    W/S -> ch1 propulsion    A/D -> ch2 steering
    Q/E -> ch3 buoyancy      L/K -> ch4 light

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
import os
import subprocess
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

NEUTRAL_PWM = 1500
FORWARD_PWM = 1650
BACKWARD_PWM = 1350
LIGHT_ON_PWM = 1900

# ---------------- MAVLink layer ----------------
master = None
pixhawk_ok = False
armed = False
mode = "MANUAL"

# ---------------- camera subprocess ----------------
_CAMERA_SCRIPT = os.path.join(os.path.dirname(__file__), "camera_stream.py")
camera_proc: subprocess.Popen | None = None


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
    if not master:
        return
    # ArduSub's manual-control mixer uses a fixed RC scheme: ch1=Pitch,
    # ch2=Roll, ch3=Throttle/vertical, ch4=Yaw, ch5=Forward, ch6=Lateral.
    # This 2-motor SimpleROV-3 frame only has authority over ch3/ch5/ch6
    # (mirrors keyboard_control.py's all_stop).
    rc = [65535] * 8
    rc[2] = NEUTRAL_PWM  # channel 3 - throttle/vertical
    rc[4] = NEUTRAL_PWM  # channel 5 - forward
    rc[5] = NEUTRAL_PWM  # channel 6 - lateral
    master.mav.rc_channels_override_send(
        master.target_system, master.target_component, *rc
    )


def do_arm():
    global armed
    if not master:
        return
    master.arducopter_arm()
    master.motors_armed_wait()
    armed = True


def do_disarm():
    global armed
    if not master:
        return
    all_stop()
    master.arducopter_disarm()
    master.motors_disarmed_wait()
    armed = False


def do_set_mode(new_mode):
    global mode
    if not master:
        return
    try:
        master.set_mode(new_mode)
        mode = new_mode
    except Exception as exc:  # noqa: BLE001
        print(f"set_mode failed: {exc}")


# ---------------- key state -> RC channels ----------------
pressed = set()


def update_channels():
    # Forward maps to ch5 and lateral to ch6 per ArduSub's fixed
    # manual-control scheme — not ch1/ch2 (Pitch/Roll), which this frame
    # has no authority over (mirrors keyboard_control.py's update_motion).
    fwd, back = "w" in pressed, "s" in pressed
    if fwd and not back:
        set_rc(5, FORWARD_PWM)
    elif back and not fwd:
        set_rc(5, BACKWARD_PWM)
    else:
        set_rc(5, NEUTRAL_PWM)

    right, left = "d" in pressed, "a" in pressed
    if right and not left:
        set_rc(6, FORWARD_PWM)
    elif left and not right:
        set_rc(6, BACKWARD_PWM)
    else:
        set_rc(6, NEUTRAL_PWM)

    rise, dive = "q" in pressed, "e" in pressed
    if rise and not dive:
        set_rc(3, FORWARD_PWM)
    elif dive and not rise:
        set_rc(3, BACKWARD_PWM)
    else:
        set_rc(3, NEUTRAL_PWM)


def handle_key(key, is_pressed):
    key = key.lower()
    if key in ("w", "a", "s", "d", "q", "e"):
        if is_pressed:
            pressed.add(key)
        else:
            pressed.discard(key)
        update_channels()
    elif key == "l" and is_pressed:
        set_rc(4, LIGHT_ON_PWM)
    elif key == "k" and is_pressed:
        set_rc(4, NEUTRAL_PWM)


# ---------------- telemetry ----------------
def read_telemetry():
    """Drain pending MAVLink messages, return latest values (or None)."""
    if not master:
        return {}
    out = {}
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
    return out


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
            }
        )

    async def telemetry_loop():
        while True:
            data = read_telemetry()
            if data:
                await send({"type": "telemetry", **data})
            await state()
            # watchdog — force neutral if the client went silent mid-motion
            if helm_holder is ws and pressed and time.time() - last_seen > WATCHDOG_S:
                pressed.clear()
                all_stop()
                print("Watchdog: all stop")
            await asyncio.sleep(0.5)

    tele_task = asyncio.create_task(telemetry_loop())
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
            elif mtype == "arm":
                await asyncio.to_thread(do_arm)
                await state()
            elif mtype == "disarm":
                pressed.clear()
                await asyncio.to_thread(do_disarm)
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
                    await asyncio.to_thread(do_disarm)
                stop_camera()
                await state()
                print("KILL SWITCH: all stop + disarm, shutting server down")
                os._exit(0)
            elif mtype == "camera_on":
                await asyncio.to_thread(start_camera)
                await state()
            elif mtype == "camera_off":
                await asyncio.to_thread(stop_camera)
                await state()
    finally:
        tele_task.cancel()
        if helm_holder is ws:
            helm_holder = None
            pressed.clear()
            all_stop()
        print(f"Client disconnected: {ws.remote_address}")


async def main():
    connect_pixhawk()
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
        if master and armed:
            do_disarm()
