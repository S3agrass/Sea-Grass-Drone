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
            if helm_holder is ws and pressed and time.time() - last_seen > WATCHDOG_S:
                pressed.clear()
                all_stop()
                print("Watchdog: all stop")
            await asyncio.sleep(0.5)

    async def detections_loop():
        # Relay detector output at ~5fps (faster than the 0.5s telemetry loop so
        # overlay boxes track smoothly). Silent while the detector is off.
        while True:
            if detector_running():
                await send({"type": "detections", **latest_detections})
            await asyncio.sleep(0.2)

    tele_task = asyncio.create_task(telemetry_loop())
    detect_task = asyncio.create_task(detections_loop())
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
                do_arm()
                await state()
            elif mtype == "disarm":
                pressed.clear()
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
        if helm_holder is ws:
            helm_holder = None
            pressed.clear()
            all_stop()
        print(f"Client disconnected: {ws.remote_address}")


async def main():
    connect_pixhawk()
    # Announce ourselves as a GCS at 1 Hz on a dedicated daemon thread, for the
    # whole server lifetime (not gated on a client being connected), so the
    # heartbeat is never delayed by the asyncio loop and ArduSub never trips its
    # heartbeat failsafe.
    start_heartbeat_thread()
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
