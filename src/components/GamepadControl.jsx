import { useEffect, useRef, useState } from "react";
import { useDrone } from "../context/DroneContext";

/* Left stick → propulsion/steering, right stick Y → buoyancy, mirrors
   the same ch1/ch2/ch3 mapping keyboard control drives via link.sendKey.
   If this controller reports a non-standard Gamepad mapping (see the
   diagnostic readout below), press each physical control once, read the
   real index off the live readout, and update AXIS/BUTTON below — nothing
   else needs to change. */
const DEADZONE = 0.35;
// Re-assert held controls at least this often. The server watchdog forces an
// all-stop after 1.5s of silence mid-motion (server/drone_server.py WATCHDOG_S),
// so we must keep sending while a stick is held even when nothing changed.
const KEEPALIVE_MS = 120;
const AXIS = { LEFT_X: 0, LEFT_Y: 1, RIGHT_X: 2, RIGHT_Y: 3 };
const BUTTON = { L1: 4, OPTIONS: 9 };

const AXIS_KEYS = [
  { axis: AXIS.LEFT_Y, negKey: "w", posKey: "s" }, // fwd/back
  { axis: AXIS.LEFT_X, negKey: "a", posKey: "d" }, // left/right
  { axis: AXIS.RIGHT_Y, negKey: "q", posKey: "e" }, // rise/dive
];

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

  const pressedRef = useRef(pressed);
  pressedRef.current = pressed;
  const lightOnRef = useRef(lightOn);
  lightOnRef.current = lightOn;
  const edgeRef = useRef({ l1: false, options: false });
  const rafRef = useRef(null);
  const lastSendTsRef = useRef(0);
  const lastDebugTsRef = useRef(0);

  const canDrive =
    enabled &&
    (linkStatus === "connected" || demoMode) &&
    (activeInput === null || activeInput === "gamepad") &&
    gamepadIndex !== null;

  useEffect(() => () => releaseInput("gamepad"), [releaseInput]);

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

    function releaseAll() {
      for (const k of pressedRef.current) link.sendKey(k, false);
      setPressed(new Set());
    }

    function tick() {
      const pad = navigator.getGamepads()[gamepadIndex];
      if (!pad) {
        if (pressedRef.current.size > 0) releaseAll();
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const now = performance.now();
      // Re-send held keys on a fixed cadence, not just on change, so the server
      // watchdog keeps seeing input while a stick is held steady. handle_key on
      // the server is idempotent, so re-asserting a held key is a safe keepalive.
      const keepAlive = now - lastSendTsRef.current >= KEEPALIVE_MS;
      const next = new Set(pressedRef.current);
      let changed = false;
      let sent = false;
      for (const { axis, negKey, posKey } of AXIS_KEYS) {
        const v = pad.axes[axis] ?? 0;
        const wantNeg = v < -DEADZONE;
        const wantPos = v > DEADZONE;
        if (wantNeg !== next.has(negKey)) {
          if (wantNeg) next.add(negKey);
          else next.delete(negKey);
          link.sendKey(negKey, wantNeg);
          changed = true;
          sent = true;
        } else if (wantNeg && keepAlive) {
          link.sendKey(negKey, true);
          sent = true;
        }
        if (wantPos !== next.has(posKey)) {
          if (wantPos) next.add(posKey);
          else next.delete(posKey);
          link.sendKey(posKey, wantPos);
          changed = true;
          sent = true;
        } else if (wantPos && keepAlive) {
          link.sendKey(posKey, true);
          sent = true;
        }
      }
      if (sent) lastSendTsRef.current = now;
      if (changed) setPressed(next);

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
        releaseAll();
      }
      edgeRef.current.options = optionsDown;

      if (now - lastDebugTsRef.current > 100) {
        lastDebugTsRef.current = now;
        const axesStr = pad.axes.map((a, i) => `${i}:${a.toFixed(2)}`).join(" ");
        const btnsStr = pad.buttons
          .map((b, i) => (b.pressed ? i : null))
          .filter((i) => i !== null)
          .join(",");
        setDebugText(`axes[${axesStr}] pressed btns[${btnsStr}]`);
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);

    function onBlur() {
      releaseAll();
    }
    function onVisibility() {
      if (document.hidden) releaseAll();
    }
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      releaseAll();
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
      </div>
      {debugText && <div className="conn-host mono">{debugText}</div>}

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
