#!/usr/bin/env python3
"""Mock of server/drone_server.py for LOCAL testing (no Pixhawk, no camera).

Speaks the same WebSocket JSON protocol as the real server so the GCS UI can be
driven end-to-end. Recording/photo commands are relayed to the mock camera's HTTP
endpoints (sim/mock_camera.py) so the media gallery reflects real files.

  client→server: hello, ping, camera_on/off, record_start/stop, photo,
                 set_autorecord, arm, disarm, key, axis, mode, stop, soft_stop
  server→client: hello_ok, state, telemetry, media_saved, notice
"""
import asyncio
import json
import os
import time
import urllib.request

import websockets

PORT = int(os.environ.get("MOCK_DRONE_PORT", "8765"))
TOKEN = os.environ.get("SEAGRASS_TOKEN", "")
CAMERA_HTTP = os.environ.get("CAMERA_HTTP", "http://127.0.0.1:8000")

state = {
    "armed": False,
    "mode": "MANUAL",
    "pixhawk": True,
    "camera": False,
    "detect": False,
    "recording": False,
    "autorecord": False,
}
rec_started_at = 0.0


def cam_post(path):
    req = urllib.request.Request(f"{CAMERA_HTTP}{path}", method="POST")
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    try:
        with urllib.request.urlopen(req, timeout=4) as resp:
            return json.loads(resp.read().decode()) if resp.length != 0 else {}
    except Exception as exc:  # noqa: BLE001
        print(f"cam_post {path} failed: {exc}")
        return None


def state_msg():
    global rec_started_at
    return {
        "type": "state",
        **state,
        "rec_elapsed_s": int(time.time() - rec_started_at) if state["recording"] else 0,
    }


def start_rec():
    global rec_started_at
    if state["recording"]:
        return
    cam_post("/record/start")
    state["recording"] = True
    rec_started_at = time.time()


def stop_rec():
    if not state["recording"]:
        return
    cam_post("/record/stop")
    state["recording"] = False


async def handler(ws):
    authed = not TOKEN
    print("client connected")

    async def send(o):
        await ws.send(json.dumps(o))

    async def pusher():
        # Periodic state + telemetry, like the real server.
        hdg = 42.0
        while True:
            await send(state_msg())
            hdg = (hdg + 3) % 360
            await send({"type": "telemetry", "heading": hdg, "groundspeed": 1.6,
                        "battery": 82, "lat": 43.65, "lon": -79.38, "depth": 0.4})
            await asyncio.sleep(0.5)

    push_task = None
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            t = msg.get("type")

            if t == "hello":
                if TOKEN and msg.get("token") != TOKEN:
                    await send({"type": "error", "message": "Invalid access token"})
                    await ws.close(code=4401, reason="unauthorized")
                    return
                authed = True
                await send({"type": "hello_ok"})
                await send(state_msg())
                push_task = asyncio.create_task(pusher())
                continue
            if not authed:
                continue
            if t == "ping":
                continue

            if t == "camera_on":
                state["camera"] = True
            elif t == "camera_off":
                stop_rec()
                state["camera"] = False
            elif t == "record_start":
                state["camera"] = True
                start_rec()
            elif t == "record_stop":
                stop_rec()
            elif t == "photo":
                state["camera"] = True
                r = cam_post("/photo")
                if r and r.get("name"):
                    await send({"type": "media_saved", "kind": "photo", "name": r["name"]})
                else:
                    await send({"type": "notice", "level": "warn", "message": "Photo failed"})
            elif t == "set_autorecord":
                state["autorecord"] = bool(msg.get("on"))
                if state["autorecord"] and state["armed"]:
                    start_rec()
                elif not state["autorecord"] and state["recording"]:
                    stop_rec()
            elif t == "arm":
                state["armed"] = True
                if state["autorecord"]:
                    start_rec()
            elif t == "disarm":
                state["armed"] = False
                if state["recording"]:
                    stop_rec()
            elif t in ("key", "axis", "mode", "soft_stop"):
                pass  # accepted, no-op for the sim
            elif t == "stop":
                stop_rec()
                state["armed"] = False
            await send(state_msg())
    finally:
        if push_task:
            push_task.cancel()
        print("client disconnected")


async def main():
    print(f"mock drone on ws://localhost:{PORT}  (token={'set' if TOKEN else 'none'})")
    async with websockets.serve(handler, "0.0.0.0", PORT):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
