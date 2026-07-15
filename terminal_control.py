#!/usr/bin/env python3
"""
Terminal-only motor test — reads the PS4 controller plugged into THIS machine
(your Mac) via pygame, and speaks the same WebSocket protocol the browser
frontend uses to talk to drone_server.py on the Pi. No npm run dev needed.

Setup (once):
    pip3 install pygame websockets

Run:
    SEAGRASS_TOKEN=<token from ~/.seagrass-env on the Pi> python3 terminal_control.py

Optional: pass a different URL as the first arg, e.g.
    python3 terminal_control.py ws://100.64.0.1:8765

Controls: left stick = move/steer (analog — push more, go faster),
right stick Y = rise/dive, Ctrl-C to quit (auto-disarms).

Feel tuning: the two knobs below shape the stick response. Override live
without editing the file, e.g.
    SEAGRASS_DEADZONE=0.08 SEAGRASS_EXPO=0.7 python3 terminal_control.py
(Top speed is the server's SEAGRASS_MAX_OFFSET knob, not set here.)
"""
import asyncio
import json
import os
import sys

import pygame
import websockets

WS_URL = sys.argv[1] if len(sys.argv) > 1 else "ws://seagrass-pi.local:8765"
TOKEN = os.environ.get("SEAGRASS_TOKEN")
if not TOKEN:
    print("Set SEAGRASS_TOKEN env var first (same value as ~/.seagrass-env on the Pi).")
    print("Example: SEAGRASS_TOKEN=abc123 python3 terminal_control.py")
    sys.exit(1)

# Deadzone: fraction of stick travel near center that reads as zero (kills
# drift). Kept small so most of the travel is usable and progressive.
# Expo: 0 = linear, 1 = fully cubic — higher gives finer control near center
# while full deflection still reaches 100%. This is the "push more = faster"
# curve.
GAMEPAD_DEADZONE = float(os.environ.get("SEAGRASS_DEADZONE", "0.12"))
GAMEPAD_EXPO = float(os.environ.get("SEAGRASS_EXPO", "0.6"))
SEND_INTERVAL = 0.05   # 20 Hz analog updates
REPEAT_INTERVAL = 0.2  # re-send even when unchanged — well under the 1.5s watchdog
AXIS_EPSILON = 0.01    # only push a fresh frame when an axis moved this much


def stick_curve(raw):
    """Deadzone-rescaled expo response: small deflections give fine, gentle
    control, full deflection still reaches 100%. Rescaling means output starts
    from 0 right at the deadzone edge instead of jumping."""
    mag = abs(raw)
    if mag < GAMEPAD_DEADZONE:
        return 0.0
    mag = min(1.0, (mag - GAMEPAD_DEADZONE) / (1.0 - GAMEPAD_DEADZONE))
    mag = (1.0 - GAMEPAD_EXPO) * mag + GAMEPAD_EXPO * mag ** 3
    return mag if raw >= 0 else -mag


async def main():
    pygame.init()
    pygame.joystick.init()
    if pygame.joystick.get_count() == 0:
        print("No controller detected. Plug in the PS4 controller and try again.")
        return
    js = pygame.joystick.Joystick(0)
    js.init()
    print(f"Controller detected: {js.get_name()}")
    print(f"Connecting to {WS_URL} ...")

    async with websockets.connect(WS_URL) as ws:
        await ws.send(json.dumps({"type": "hello", "token": TOKEN}))
        # Server may interleave telemetry/state broadcasts around auth —
        # keep reading until we see hello_ok or an explicit error.
        while True:
            resp = json.loads(await ws.recv())
            if resp.get("type") == "hello_ok":
                print("Authenticated OK.")
                break
            if resp.get("type") == "error":
                print("Auth failed:", resp.get("message"))
                return
            # anything else (telemetry, state) — ignore and keep waiting
            print("(ignoring pre-auth message:", resp.get("type"), ")")

        await ws.send(json.dumps({"type": "arm"}))
        print("Arm sent. Left stick = move/steer, right stick Y = depth. "
              "Push more to go faster. Ctrl-C to quit and disarm.\n")

        last_sent = {"surge": 0.0, "steer": 0.0, "depth": 0.0}
        last_ping = asyncio.get_event_loop().time()
        last_repeat = 0.0

        async def send_axes(axes):
            await ws.send(json.dumps({"type": "axis", **axes}))

        try:
            while True:
                pygame.event.pump()
                now = asyncio.get_event_loop().time()

                # Stick up is negative raw, so surge/depth flip sign.
                surge = -stick_curve(js.get_axis(1))  # left stick Y  -> forward/back
                steer = stick_curve(js.get_axis(0))   # left stick X  -> yaw/steer
                depth = -stick_curve(js.get_axis(3))  # right stick Y -> rise/dive
                axes = {"surge": round(surge, 3), "steer": round(steer, 3),
                        "depth": round(depth, 3)}

                moved = any(abs(axes[k] - last_sent[k]) > AXIS_EPSILON for k in axes)
                # Re-send unchanged frames on REPEAT_INTERVAL so the server's
                # watchdog never sees a gap while a stick is held deflected.
                if moved or (now - last_repeat) > REPEAT_INTERVAL:
                    await send_axes(axes)
                    if moved:
                        print(f"  -> surge={axes['surge']:+.2f} steer={axes['steer']:+.2f} "
                              f"depth={axes['depth']:+.2f}")
                    last_sent = axes
                    last_repeat = now

                if now - last_ping > 4.5:
                    await ws.send(json.dumps({"type": "ping"}))
                    last_ping = now

                await asyncio.sleep(SEND_INTERVAL)
        except KeyboardInterrupt:
            print("\nStopping...")
        finally:
            await send_axes({"surge": 0.0, "steer": 0.0, "depth": 0.0})
            await ws.send(json.dumps({"type": "disarm"}))
            print("Disarmed. Exiting.")


if __name__ == "__main__":
    asyncio.run(main())
