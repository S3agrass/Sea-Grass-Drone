import { useEffect, useRef, useState } from "react";
import { useDrone } from "../context/DroneContext";
import { stickCurve } from "../lib/stickCurve";

/* Left stick → propulsion/steering, right stick Y → buoyancy, sent as analog
   axis targets (link.sendAxis) that the server shapes and ramps — NOT as the
   w/a/s/d keypresses this panel used to emit. That older path thresholded the
   stick at 0.35 and threw the rest away, so the drone had exactly two speeds:
   stopped, and everything. Proportional targets are what let you nudge the
   stick to inch toward something.

   If this controller reports a non-standard Gamepad mapping (see the
   diagnostic readout below), press each physical control once, read the
   real index off the live readout, and update AXIS/BUTTON below — nothing
   else needs to change. Feel lives elsewhere: stick shaping in
   ../lib/stickCurve, ramp and top speed in server/drone_server.py's tuning
   block. */
const SEND_MS = 50; // 20Hz analog updates, mirroring terminal_control.py
// Re-send an unchanged frame at least this often. The server watchdog forces an
// all-stop after 1.5s of silence mid-motion (server/drone_server.py WATCHDOG_S),
// so a held stick must keep the frames coming. 150ms gives ~10 chances to land
// under that deadline, with margin for a tunnelled connection.
const REPEAT_MS = 150;
const AXIS_EPSILON = 0.01; // only push a fresh frame when an axis moved this much
const DISPLAY_THRESHOLD = 0.15; // cosmetic only: when a direction pip lights up
const AXIS = { LEFT_X: 0, LEFT_Y: 1, RIGHT_X: 2, RIGHT_Y: 3 };
const BUTTON = { L1: 4, OPTIONS: 9 };

// Held keys and analog axes are unioned server-side (_axis_value), so a key left
// stuck down would pin an axis at full regardless of the stick. We drive analog
// only and purge these once on enable.
const MOTION_KEYS = ["w", "a", "s", "d", "q", "e"];

const KEY_HINTS = {
  q: "Rise",
  w: "Fwd",
  e: "Dive",
  a: "Left",
  s: "Back",
  d: "Right",
};

export default function GamepadControl() {
  const { link, linkStatus, armed, demoMode, activeInput, claimInput, releaseInput } =
    useDrone();
  const [enabled, setEnabled] = useState(false);
  const [gamepadIndex, setGamepadIndex] = useState(null);
  const [padInfo, setPadInfo] = useState(null);
  const [pressed, setPressed] = useState(new Set());
  const [lightOn, setLightOn] = useState(false);
  const [debugText, setDebugText] = useState("");
  const [motors, setMotors] = useState(null);

  const pressedRef = useRef(pressed);
  pressedRef.current = pressed;
  const lightOnRef = useRef(lightOn);
  lightOnRef.current = lightOn;
  const edgeRef = useRef({ l1: false, options: false });
  const rafRef = useRef(null);
  const lastSendTsRef = useRef(0);
  const lastDebugTsRef = useRef(0);
  // Last axes we shaped and sent, kept in a ref so the 20Hz send path never
  // touches React state.
  const lastAxesRef = useRef({ surge: 0, steer: 0, depth: 0 });
  const lastFrameTsRef = useRef(0);

  const canDrive =
    enabled &&
    (linkStatus === "connected" || demoMode) &&
    (activeInput === null || activeInput === "gamepad") &&
    gamepadIndex !== null;

  useEffect(() => () => releaseInput("gamepad"), [releaseInput]);

  // Live per-motor readout. The server has always broadcast this at 10Hz to
  // whoever holds the helm; nothing consumed it. Subscribed here rather than in
  // DroneContext on purpose — 10Hz setState in the provider would re-render
  // every consumer, camera and map included. It's also the calibration tool for
  // the server's CREEP_FLOOR: ease the stick up until the props bite and read
  // left_pwm/right_pwm.
  useEffect(() => {
    if (!enabled) {
      setMotors(null);
      return;
    }
    return link.subscribe((e) => {
      if (e.type === "message" && e.data?.type === "motors") setMotors(e.data);
    });
  }, [enabled, link]);

  // Track connect/disconnect, including a controller already paired before mount.
  useEffect(() => {
    function onConnect(e) {
      setGamepadIndex(e.gamepad.index);
      setPadInfo({ id: e.gamepad.id, mapping: e.gamepad.mapping });
    }
    function onDisconnect(e) {
      setGamepadIndex((cur) => (cur === e.gamepad.index ? null : cur));
      setPadInfo((cur) => (cur && cur.id === e.gamepad.id ? null : cur));
    }
    const existing = navigator.getGamepads().find(Boolean);
    if (existing) {
      setGamepadIndex(existing.index);
      setPadInfo({ id: existing.id, mapping: existing.mapping });
    }
    window.addEventListener("gamepadconnected", onConnect);
    window.addEventListener("gamepaddisconnected", onDisconnect);
    return () => {
      window.removeEventListener("gamepadconnected", onConnect);
      window.removeEventListener("gamepaddisconnected", onDisconnect);
    };
  }, []);

  useEffect(() => {
    if (!canDrive) return;

    // Any key still held server-side gets unioned with our analog axes
    // (drone_server.py _axis_value) and would pin that axis at full regardless
    // of the stick. handle_key does a plain discard, so this is idempotent.
    for (const k of MOTION_KEYS) link.sendKey(k, false);

    function sendZero() {
      link.sendAxis({ surge: 0, steer: 0, depth: 0 });
      lastAxesRef.current = { surge: 0, steer: 0, depth: 0 };
      setPressed(new Set());
    }

    function tick() {
      const pad = navigator.getGamepads()[gamepadIndex];
      if (!pad) {
        // Controller yanked mid-drive: stop commanding motion now rather than
        // waiting out the server's 1.5s watchdog.
        const l = lastAxesRef.current;
        if (l.surge || l.steer || l.depth) sendZero();
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const now = performance.now();
      if (now - lastSendTsRef.current >= SEND_MS) {
        lastSendTsRef.current = now;
        // Stick up reads negative, so surge and depth flip sign. Mirrors
        // terminal_control.py and the digital mapping this replaces: left stick
        // Y = w/s surge, left stick X = d/a steer, right stick Y = q/e depth.
        const axes = {
          surge: -stickCurve(pad.axes[AXIS.LEFT_Y] ?? 0),
          steer: stickCurve(pad.axes[AXIS.LEFT_X] ?? 0),
          depth: -stickCurve(pad.axes[AXIS.RIGHT_Y] ?? 0),
        };
        const last = lastAxesRef.current;
        const moved = ["surge", "steer", "depth"].some(
          (k) => Math.abs(axes[k] - last[k]) > AXIS_EPSILON
        );
        const centered = !axes.surge && !axes.steer && !axes.depth;
        // Repeat unchanged frames so a held stick keeps feeding the watchdog, but
        // stay silent while centered: motion_active() is already false there so
        // the watchdog won't trip, and ArduSub's failsafe is fed by the server's
        // own control_loop independently of us.
        const stale = now - lastFrameTsRef.current >= REPEAT_MS;
        if (moved || (stale && !centered)) {
          link.sendAxis(axes);
          lastAxesRef.current = axes;
          lastFrameTsRef.current = now;
        }
      }

      const l1Down = Boolean(pad.buttons[BUTTON.L1]?.pressed);
      if (l1Down && !edgeRef.current.l1) {
        const turningOn = !lightOnRef.current;
        setLightOn(turningOn);
        const k = turningOn ? "l" : "k";
        link.sendKey(k, true);
        setTimeout(() => link.sendKey(k, false), 120);
      }
      edgeRef.current.l1 = l1Down;

      const optionsDown = Boolean(pad.buttons[BUTTON.OPTIONS]?.pressed);
      if (optionsDown && !edgeRef.current.options) {
        link.allStop();
        sendZero();
      }
      edgeRef.current.options = optionsDown;

      // Display only, and deliberately throttled to 10Hz: the direction pips are
      // derived here rather than in the 20Hz send path so steering the drone
      // doesn't re-render the panel on every frame.
      if (now - lastDebugTsRef.current > 100) {
        lastDebugTsRef.current = now;
        const { surge, steer, depth } = lastAxesRef.current;
        const lit = new Set();
        if (surge > DISPLAY_THRESHOLD) lit.add("w");
        if (surge < -DISPLAY_THRESHOLD) lit.add("s");
        if (steer > DISPLAY_THRESHOLD) lit.add("d");
        if (steer < -DISPLAY_THRESHOLD) lit.add("a");
        if (depth > DISPLAY_THRESHOLD) lit.add("q");
        if (depth < -DISPLAY_THRESHOLD) lit.add("e");
        const cur = pressedRef.current;
        if (lit.size !== cur.size || [...lit].some((k) => !cur.has(k))) {
          setPressed(lit);
        }
        const axesStr = pad.axes.map((a, i) => `${i}:${a.toFixed(2)}`).join(" ");
        const btnsStr = pad.buttons
          .map((b, i) => (b.pressed ? i : null))
          .filter((i) => i !== null)
          .join(",");
        setDebugText(
          `surge ${surge.toFixed(2)} steer ${steer.toFixed(2)} depth ${depth.toFixed(2)}\n` +
            `axes[${axesStr}] pressed btns[${btnsStr}]`
        );
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);

    function onBlur() {
      sendZero();
    }
    function onVisibility() {
      if (document.hidden) sendZero();
    }
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      sendZero();
    };
  }, [canDrive, gamepadIndex, link]);

  return (
    <div className="kbd-panel">
      <div className="panel-head">
        <span className="eyebrow">Helm · gamepad</span>
        <button
          className={`toggle ${enabled ? "on" : ""}`}
          onClick={() => {
            const next = !enabled;
            setEnabled(next);
            if (next) claimInput("gamepad");
            else releaseInput("gamepad");
          }}
          aria-pressed={enabled}
        >
          <span className="toggle-knob" />
          {enabled ? "Active" : "Off"}
        </button>
      </div>

      {enabled && activeInput === "keyboard" && (
        <div className="kbd-warning">
          Keyboard has the helm — disable it to steer with the gamepad.
        </div>
      )}
      {enabled && gamepadIndex === null && (
        <div className="kbd-warning">
          No gamepad detected — connect a controller and press any button.
        </div>
      )}
      {enabled && linkStatus !== "connected" && !demoMode && (
        <div className="kbd-warning">Connect to the drone to take the helm.</div>
      )}
      {enabled && canDrive && !armed && !demoMode && (
        <div className="kbd-warning">Thrusters are disarmed — arm to move.</div>
      )}
      {padInfo && padInfo.mapping !== "standard" && (
        <div className="kbd-warning">
          Non-standard mapping reported — verify indices below before flying.
        </div>
      )}

      <div className="conn-host mono kbd-diag">
        {padInfo ? padInfo.id : "No gamepad detected"}
      </div>
      <div className="conn-rows">
        <div className="conn-row">
          <span>Mapping</span>
          <span className="mono">{padInfo?.mapping || "(non-standard / empty)"}</span>
        </div>
        {motors && (
          <>
            <div className="conn-row">
              <span>Stick</span>
              <span className="mono">
                {motors.angle?.toFixed(1)}° · mag {motors.mag?.toFixed(2)}
              </span>
            </div>
            <div className="conn-row">
              <span>Motor L</span>
              <span className="mono">
                {Math.round(Math.abs(motors.left) * 100)}% ({motors.left_pwm} PWM)
              </span>
            </div>
            <div className="conn-row">
              <span>Motor R</span>
              <span className="mono">
                {Math.round(Math.abs(motors.right) * 100)}% ({motors.right_pwm} PWM)
              </span>
            </div>
          </>
        )}
      </div>
      {debugText && <div className="conn-host mono kbd-diag">{debugText}</div>}

      <div className={`kbd-grid ${canDrive ? "" : "disabled"}`}>
        {Object.keys(KEY_HINTS).map((key) => (
          <div key={key} className={`kbd-key ${pressed.has(key) ? "down" : ""}`}>
            <span className="kbd-key-label mono">{key.toUpperCase()}</span>
            <span className="kbd-key-hint">{KEY_HINTS[key]}</span>
          </div>
        ))}
      </div>

      <div className="kbd-row">
        <div className={`kbd-key wide ${lightOn ? "down" : ""}`}>
          <span className="kbd-key-label mono">L1</span>
          <span className="kbd-key-hint">Light toggle</span>
        </div>
        <div className="kbd-key wide">
          <span className="kbd-key-label mono">OPT</span>
          <span className="kbd-key-hint">All stop</span>
        </div>
      </div>

      <button
        className="btn btn-danger estop"
        onClick={() => {
          link.allStop();
          setPressed(new Set());
        }}
        disabled={linkStatus !== "connected"}
      >
        ⏻ ALL STOP <span className="mono estop-hint">OPTIONS</span>
      </button>
    </div>
  );
}
