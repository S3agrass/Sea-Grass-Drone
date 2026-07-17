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

Feel tuning: the knobs below shape the stick response. Override live
without editing the file, e.g.
    SEAGRASS_DEADZONE=0.08 SEAGRASS_CREEP_OUT=0.25 python3 terminal_control.py
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
# Gas-pedal response: two linear zones meeting at a knee, instead of one expo
# curve. The creep zone (deadzone edge -> CREEP_ZONE_END of the remaining
# travel) climbs gently to CREEP_ZONE_OUTPUT of full authority; past the knee
# the power zone climbs ~5x steeper to exactly 1.0 at full lock. Retune
# CREEP_ZONE_OUTPUT first — it sets how fast "slow" is. Keep these in step
# with keyboard_control.py and src/lib/stickCurve.js.
GAMEPAD_DEADZONE = float(os.environ.get("SEAGRASS_DEADZONE", "0.05"))
CREEP_ZONE_END = float(os.environ.get("SEAGRASS_CREEP_END", "0.55"))
CREEP_ZONE_OUTPUT = float(os.environ.get("SEAGRASS_CREEP_OUT", "0.2"))
SEND_INTERVAL = 0.05   # 20 Hz analog updates
REPEAT_INTERVAL = 0.2  # re-send even when unchanged — well under the 1.5s watchdog
AXIS_EPSILON = 0.01    # only push a fresh frame when an axis moved this much
# PS4 OPTIONS button -> latched soft-stop. The pygame button index for a DS4
# varies by driver, so this is a best guess; every button press prints its index
# below, so if OPTIONS doesn't stop, read the index off that line and set
# SEAGRASS_OPTIONS_BUTTON to it.
OPTIONS_BUTTON = int(os.environ.get("SEAGRASS_OPTIONS_BUTTON", "9"))


def stick_curve(raw):
    """Deadzone-rescaled two-zone "gas pedal" response. Rescaling means the
    output ramps from 0 at the deadzone edge instead of jumping to it; the two
    zones are continuous at the knee and reach exactly 1.0 at full deflection.
    Same shape as keyboard_control.py and src/lib/stickCurve.js."""
    mag = abs(raw)
    if mag < GAMEPAD_DEADZONE:
        return 0.0
    mag = min(1.0, (mag - GAMEPAD_DEADZONE) / (1.0 - GAMEPAD_DEADZONE))
    if mag <= CREEP_ZONE_END:
        mag = CREEP_ZONE_OUTPUT * (mag / CREEP_ZONE_END)
    else:
        mag = CREEP_ZONE_OUTPUT + ((1.0 - CREEP_ZONE_OUTPUT)
                                   * (mag - CREEP_ZONE_END) / (1.0 - CREEP_ZONE_END))
    return mag if raw >= 0 else -mag


def _dir(v):
    """Motor sign -> rotation label for the readout. Convention only: if a motor
    is physically wired mirrored it's just a label (flip SEAGRASS_STEER_REVERSED /
    SEAGRASS_SURGE_REVERSED on the server)."""
    if v > 0.02:
        return "CW "
    if v < -0.02:
        return "CCW"
    return "-- "


def fmt_motors(m):
    """Format a server 'motors' message as a two-line live readout."""
    left, right = m["left"], m["right"]
    return (f"-> {m['angle']:5.1f}deg  mag {m['mag']:.2f}\n"
            f"   L: {abs(left) * 100:3.0f}% {_dir(left)}   "
            f"R: {abs(right) * 100:3.0f}% {_dir(right)}")


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

        async def send_axes(axes):
            await ws.send(json.dumps({"type": "axis", **axes}))

        async def sender():
            last_sent = {"surge": 0.0, "steer": 0.0, "depth": 0.0}
            last_ping = asyncio.get_event_loop().time()
            last_repeat = 0.0
            prev_buttons = [0] * js.get_numbuttons()
            while True:
                pygame.event.pump()
                now = asyncio.get_event_loop().time()

                # Button edges: OPTIONS toggles the latched soft-stop; every press
                # also prints its index so the pilot can find the right OPTIONS one.
                for i in range(js.get_numbuttons()):
                    down = js.get_button(i)
                    if down and not prev_buttons[i]:
                        print(f"[button {i} pressed]")
                        if i == OPTIONS_BUTTON:
                            await ws.send(json.dumps({"type": "soft_stop"}))
                    prev_buttons[i] = down

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
                    last_sent = axes
                    last_repeat = now

                if now - last_ping > 4.5:
                    await ws.send(json.dumps({"type": "ping"}))
                    last_ping = now

                await asyncio.sleep(SEND_INTERVAL)

        async def reader():
            # Drain server messages and print the live per-motor readout. Draining
            # also stops the receive buffer growing unbounded while we drive.
            last_print = None
            async for raw in ws:
                try:
                    m = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if m.get("type") == "soft_stop":
                    print(">>> STOPPED (OPTIONS to resume)" if m.get("latched")
                          else ">>> DRIVING")
                    continue
                if m.get("type") != "motors":
                    continue
                key = (m["angle"], m["left"], m["right"])
                if key == last_print:
                    continue  # print only on change, so a held/centered stick stays quiet
                last_print = key
                print(fmt_motors(m))

        try:
            await asyncio.gather(sender(), reader())
        except KeyboardInterrupt:
            print("\nStopping...")
        finally:
            await send_axes({"surge": 0.0, "steer": 0.0, "depth": 0.0})
            await ws.send(json.dumps({"type": "disarm"}))
            print("Disarmed. Exiting.")


if __name__ == "__main__":
    asyncio.run(main())
