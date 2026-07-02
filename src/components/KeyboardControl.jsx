import { useEffect, useRef, useState } from "react";
import { useDrone } from "../context/DroneContext";

/* Mirrors keyboard_control.py:
   W/S → ch1 propulsion · A/D → ch2 steering · Q/E → ch3 buoyancy
   L/K → ch4 light on/off · Space → all stop */
const KEYS = [
  { key: "q", label: "Q", hint: "Rise" },
  { key: "w", label: "W", hint: "Fwd" },
  { key: "e", label: "E", hint: "Dive" },
  { key: "a", label: "A", hint: "Left" },
  { key: "s", label: "S", hint: "Back" },
  { key: "d", label: "D", hint: "Right" },
];

const CONTROL_KEYS = new Set(["w", "a", "s", "d", "q", "e", "l", "k"]);

export default function KeyboardControl() {
  const { link, linkStatus, armed, demoMode } = useDrone();
  const [enabled, setEnabled] = useState(false);
  const [pressed, setPressed] = useState(new Set());
  const [lightOn, setLightOn] = useState(false);
  const pressedRef = useRef(pressed);
  pressedRef.current = pressed;

  const canDrive = enabled && (linkStatus === "connected" || demoMode);

  useEffect(() => {
    if (!canDrive) return;

    function down(e) {
      const k = e.key.toLowerCase();
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (k === " ") {
        e.preventDefault();
        link.allStop();
        setPressed(new Set());
        return;
      }
      if (!CONTROL_KEYS.has(k) || e.repeat || pressedRef.current.has(k)) return;
      e.preventDefault();
      if (k === "l") setLightOn(true);
      if (k === "k") setLightOn(false);
      setPressed((p) => new Set(p).add(k));
      link.sendKey(k, true);
    }

    function up(e) {
      const k = e.key.toLowerCase();
      if (!CONTROL_KEYS.has(k) || !pressedRef.current.has(k)) return;
      setPressed((p) => {
        const n = new Set(p);
        n.delete(k);
        return n;
      });
      link.sendKey(k, false);
    }

    function releaseAll() {
      for (const k of pressedRef.current) link.sendKey(k, false);
      setPressed(new Set());
    }

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", releaseAll);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", releaseAll);
      releaseAll();
    };
  }, [canDrive, link]);

  // Pointer fallback so the pad also works on touch devices.
  function pressKey(k, isDown) {
    if (!canDrive) return;
    if (k === "l" || k === "k") {
      if (isDown) {
        setLightOn(k === "l");
        link.sendKey(k, true);
        setTimeout(() => link.sendKey(k, false), 120);
      }
      return;
    }
    setPressed((p) => {
      const n = new Set(p);
      if (isDown) n.add(k);
      else n.delete(k);
      return n;
    });
    link.sendKey(k, isDown);
  }

  return (
    <div className="kbd-panel">
      <div className="panel-head">
        <span className="eyebrow">Helm · keyboard</span>
        <button
          className={`toggle ${enabled ? "on" : ""}`}
          onClick={() => setEnabled((v) => !v)}
          aria-pressed={enabled}
        >
          <span className="toggle-knob" />
          {enabled ? "Active" : "Off"}
        </button>
      </div>

      {enabled && linkStatus !== "connected" && !demoMode && (
        <div className="kbd-warning">Connect to the drone to take the helm.</div>
      )}
      {enabled && canDrive && !armed && !demoMode && (
        <div className="kbd-warning">Thrusters are disarmed — arm to move.</div>
      )}

      <div className={`kbd-grid ${canDrive ? "" : "disabled"}`}>
        {KEYS.map(({ key, label, hint }) => (
          <button
            key={key}
            className={`kbd-key ${pressed.has(key) ? "down" : ""}`}
            onPointerDown={() => pressKey(key, true)}
            onPointerUp={() => pressKey(key, false)}
            onPointerLeave={() => pressed.has(key) && pressKey(key, false)}
          >
            <span className="kbd-key-label mono">{label}</span>
            <span className="kbd-key-hint">{hint}</span>
          </button>
        ))}
      </div>

      <div className="kbd-row">
        <button
          className={`kbd-key wide ${lightOn ? "down" : ""}`}
          onPointerDown={() => pressKey("l", true)}
          disabled={!canDrive}
        >
          <span className="kbd-key-label mono">L</span>
          <span className="kbd-key-hint">Light on</span>
        </button>
        <button
          className="kbd-key wide"
          onPointerDown={() => pressKey("k", true)}
          disabled={!canDrive}
        >
          <span className="kbd-key-label mono">K</span>
          <span className="kbd-key-hint">Light off</span>
        </button>
      </div>

      <button
        className="btn btn-danger estop"
        onClick={() => {
          link.allStop();
          setPressed(new Set());
        }}
        disabled={linkStatus !== "connected"}
      >
        ⏻ ALL STOP <span className="mono estop-hint">SPACE</span>
      </button>
    </div>
  );
}
