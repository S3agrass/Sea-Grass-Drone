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
FORWARD_PWM = 1650
BACKWARD_PWM = 1350
LIGHT_ON_PWM = 1900

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


# ---------------- key state -> RC channels ----------------
pressed = set()


def channel_frame():
    """Build one combined RC_CHANNELS_OVERRIDE frame from the current key state.

    Forward -> ch5, steering -> ch4 (Yaw), vertical -> ch3 per ArduSub's fixed
    manual-control scheme. Steering rides on Yaw, not Lateral (ch6): this
    2-motor frame has no lateral thruster, so ch6 has zero authority and ch4's
    differential is what actually turns the vehicle (mirrors
    keyboard_control.py's update_flight). ch1/ch2 (Pitch/Roll), the light
    channel (ch7) and every unused channel are left at 65535 ("ignore this
    channel") so a separate light override (set_rc(LIGHT_CHANNEL, ...)) is never
    clobbered — the same combined-frame approach keyboard_control.py uses.
    """
    rc = [65535] * 8

    fwd, back = "w" in pressed, "s" in pressed
    rc[4] = FORWARD_PWM if fwd and not back else BACKWARD_PWM if back and not fwd else NEUTRAL_PWM

    right, left = "d" in pressed, "a" in pressed
    rc[STEER_CHANNEL - 1] = FORWARD_PWM if right and not left else BACKWARD_PWM if left and not right else NEUTRAL_PWM

    rise, dive = "q" in pressed, "e" in pressed
    rc[2] = FORWARD_PWM if rise and not dive else BACKWARD_PWM if dive and not rise else NEUTRAL_PWM

    return rc


def send_control_frame():
    """Push the current channel frame to the Pixhawk as a single RC override."""
    if not master:
        return
    rc = channel_frame()
    master.mav.rc_channels_override_send(
        master.target_system, master.target_component, *rc
    )


def handle_key(key, is_pressed):
    key = key.lower()
    if key in ("w", "a", "s", "d", "q", "e"):
        if is_pressed:
            pressed.add(key)
        else:
            pressed.discard(key)
        # Update held state and send immediately for zero-latency response; the
        # control_loop keeps re-sending this frame at CONTROL_HZ regardless.
        send_control_frame()
    elif key == "l" and is_pressed:
        set_rc(LIGHT_CHANNEL, LIGHT_ON_PWM)
    elif key == "k" and is_pressed:
        set_rc(LIGHT_CHANNEL, NEUTRAL_PWM)


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
    while True:
        send_control_frame()
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
