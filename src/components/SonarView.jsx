/* Visual Ping2 sonar — a scrolling echogram plus a live beam cone.
 *
 * Two views of the same acoustic profile (~200 amplitude samples per ping, the
 * same data BlueRobotics' Ping Viewer draws):
 *   - Echogram: range down, time left-to-right, brightness = echo strength.
 *     Shows history, so you can tell a closing wall from a passing fish.
 *   - Beam cone: where the return sits relative to the drone RIGHT NOW, split
 *     into "how far ahead" and "how far below" using the mount angle. That's
 *     the pair of numbers that actually informs how you move.
 *
 * PERFORMANCE — why this component subscribes to the link itself rather than
 * reading sonar profiles from DroneContext: the context value is rebuilt on
 * every provider state change and is not memoized, so every useDrone() consumer
 * (including the Leaflet map and the camera panel) re-renders on any update.
 * Pushing ~5 Hz arrays through it would re-render all of them. Instead profiles
 * land in a ref via a direct subscription, drawing happens in a rAF loop, and
 * setState fires only for the low-rate text readouts — the same approach
 * GamepadControl.jsx uses for its 10 Hz stream.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useDrone } from "../context/DroneContext";
import {
  amplitudeToRGB,
  decomposeRange,
  peakRange,
  rangeToRow,
  PING_BEAM_DEG,
  PING_MIN_RANGE_M,
} from "../lib/sonarGeometry";

const ECHO_COLS = 480; // echogram width in pixels == pings of history retained
const ECHO_ROWS = 220; // vertical resolution of the range axis
const READOUT_HZ = 4; // text refresh rate; drawing runs at full frame rate
const RANGE_CHOICES = [2, 5, 10, 20, 30];
const MOUNT_KEY = "seagrass-sonar-mount-deg";
const RANGE_KEY = "seagrass-sonar-max-range";

const QUALITY_TONE = {
  good: { label: "LOCK", tone: "var(--teal)" },
  weak: { label: "WEAK", tone: "var(--amber)" },
  none: { label: "NO LOCK", tone: "var(--red)" },
};

/* Synthetic profile for demo mode — a Gaussian bump at `targetM` on a noise
 * floor, so the panel can be exercised with no hardware attached. Kept here
 * rather than in DroneContext's simulator so the 5 Hz data never touches
 * React state. */
function simulateProfile(targetM, scanLengthM, len = 200) {
  const profile = new Array(len);
  const peakIdx = (targetM / scanLengthM) * (len - 1);
  const width = len * 0.035;
  for (let i = 0; i < len; i += 1) {
    const bump = 235 * Math.exp(-((i - peakIdx) ** 2) / (2 * width * width));
    // Transducer ringing near zero range, then a decaying noise floor.
    const ring = i < len * 0.04 ? 200 * (1 - i / (len * 0.04)) : 0;
    const noise = 18 * Math.random() * (1 - i / len);
    profile[i] = Math.max(0, Math.min(255, Math.round(bump + ring + noise)));
  }
  return profile;
}

export default function SonarView() {
  const { link, sonar, telemetry, demoMode } = useDrone();

  const [mountDeg, setMountDeg] = useState(() => {
    const saved = Number(localStorage.getItem(MOUNT_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : 45;
  });
  const [maxRange, setMaxRange] = useState(() => {
    const saved = Number(localStorage.getItem(RANGE_KEY));
    return RANGE_CHOICES.includes(saved) ? saved : 10;
  });
  const [usePitch, setUsePitch] = useState(true);
  const [paused, setPaused] = useState(false);

  // Low-rate mirror of the latest ping, for the text/SVG side of the panel.
  const [readout, setReadout] = useState({
    range: null, gated: false, confidence: null, quality: "none",
    scanLengthM: null, gain: null, rows: 0, live: false,
  });

  const canvasRef = useRef(null);
  const pendingRef = useRef([]); // profiles received but not yet drawn
  const latestRef = useRef(null); // most recent ping, for the cone
  const rowsRef = useRef(0);
  const lastReadoutRef = useRef(0);
  const pausedRef = useRef(paused);
  const maxRangeRef = useRef(maxRange);

  // Mirror the controls into refs — the draw loop reads them every frame and
  // must not be torn down and restarted each time one changes.
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { maxRangeRef.current = maxRange; }, [maxRange]);

  useEffect(() => { localStorage.setItem(MOUNT_KEY, String(mountDeg)); }, [mountDeg]);
  useEffect(() => { localStorage.setItem(RANGE_KEY, String(maxRange)); }, [maxRange]);

  /* ---------- ingest: real profiles straight off the link ---------- */
  useEffect(() => {
    if (demoMode) return undefined;
    return link.subscribe((event) => {
      if (event.type === "message" && event.data?.type === "sonar_profile") {
        pendingRef.current.push(event.data);
        // Bound the queue: if the tab is backgrounded rAF stops firing while
        // messages keep arriving, and an unbounded queue would replay minutes
        // of history in one burst on return.
        if (pendingRef.current.length > ECHO_COLS) {
          pendingRef.current = pendingRef.current.slice(-ECHO_COLS);
        }
      } else if (event.type === "status" && event.status !== "connected") {
        latestRef.current = null;
      }
    });
  }, [link, demoMode]);

  /* ---------- ingest: synthetic profiles in demo mode ---------- */
  useEffect(() => {
    if (!demoMode) return undefined;
    let target = 3.2;
    const id = setInterval(() => {
      target += Math.random() * 0.5 - 0.25;
      target = Math.max(0.8, Math.min(maxRangeRef.current * 0.85, target));
      const scanLengthM = maxRangeRef.current;
      pendingRef.current.push({
        ping: Date.now(),
        raw_m: Number(target.toFixed(2)),
        distance_m: Number(target.toFixed(2)),
        confidence: Math.round(60 + Math.random() * 30),
        quality: "good",
        scan_start_m: 0,
        scan_length_m: scanLengthM,
        gain: 3,
        profile: simulateProfile(target, scanLengthM),
      });
    }, 200);
    return () => clearInterval(id);
  }, [demoMode]);

  /* ---------- draw loop ---------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined; // jsdom / no 2D context

    canvas.width = ECHO_COLS;
    canvas.height = ECHO_ROWS;
    // Deliberately a 1:1 logical bitmap scaled by CSS: each column is exactly
    // one ping, so letting the browser scale is both crisper and cheaper than
    // redrawing at devicePixelRatio.
    ctx.fillStyle = "#06111e";
    ctx.fillRect(0, 0, ECHO_COLS, ECHO_ROWS);

    const column = ctx.createImageData(1, ECHO_ROWS);
    let raf = 0;

    const drawColumn = (ping) => {
      const px = column.data;
      px.fill(0);
      const profile = ping.profile;
      const maxR = maxRangeRef.current;
      const scanStart = ping.scan_start_m ?? 0;
      const scanLen = ping.scan_length_m ?? maxR;

      if (profile && profile.length) {
        // Walk display rows and pull the matching sample, so the column is
        // fully covered regardless of whether the device window is narrower or
        // wider than the display range. Rows outside the scanned window stay
        // transparent-dark rather than being stretched to fill.
        for (let row = 0; row < ECHO_ROWS; row += 1) {
          const rangeAtRow = (row / (ECHO_ROWS - 1)) * maxR;
          if (rangeAtRow < scanStart || rangeAtRow > scanStart + scanLen) {
            px[row * 4 + 0] = 4; px[row * 4 + 1] = 10; px[row * 4 + 2] = 18;
            px[row * 4 + 3] = 255;
            continue;
          }
          const frac = scanLen > 0 ? (rangeAtRow - scanStart) / scanLen : 0;
          const idx = Math.round(frac * (profile.length - 1));
          const [r, g, b] = amplitudeToRGB(profile[idx]);
          px[row * 4 + 0] = r; px[row * 4 + 1] = g; px[row * 4 + 2] = b;
          px[row * 4 + 3] = 255;
        }
      } else {
        // Distance-only fallback (PING_PROFILE=0 or a degraded link): draw a
        // single bright pixel at the reported range so the trace still reads.
        for (let row = 0; row < ECHO_ROWS; row += 1) {
          px[row * 4 + 0] = 6; px[row * 4 + 1] = 17; px[row * 4 + 2] = 30;
          px[row * 4 + 3] = 255;
        }
        const r = ping.distance_m ?? ping.raw_m;
        const row = rangeToRow(r, maxR, ECHO_ROWS);
        if (row != null) {
          px[row * 4 + 0] = 59; px[row * 4 + 1] = 217; px[row * 4 + 2] = 187;
          px[row * 4 + 3] = 255;
        }
      }

      // Scroll one pixel left, then blit the new column at the right edge.
      ctx.drawImage(canvas, -1, 0);
      ctx.putImageData(column, ECHO_COLS - 1, 0);
    };

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const queue = pendingRef.current;
      if (!queue.length) return;
      if (pausedRef.current) {
        pendingRef.current = [];
        return;
      }
      pendingRef.current = [];
      for (const ping of queue) {
        drawColumn(ping);
        latestRef.current = ping;
        rowsRef.current += 1;
      }

      const now = performance.now();
      if (now - lastReadoutRef.current > 1000 / READOUT_HZ) {
        lastReadoutRef.current = now;
        const p = latestRef.current;
        // Prefer the device's confidence-gated distance; fall back to the
        // brightest thing in the profile so the cone still points somewhere
        // when there is no hard lock (in air, that's all there ever is).
        const gated = p.distance_m;
        const range = gated ?? peakRange(p.profile, p.scan_start_m ?? 0,
                                        p.scan_length_m ?? maxRangeRef.current);
        setReadout({
          range,
          gated: gated != null,
          confidence: p.confidence ?? null,
          quality: p.quality ?? "none",
          scanLengthM: p.scan_length_m ?? null,
          gain: p.gain ?? null,
          rows: rowsRef.current,
          live: true,
        });
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const onRangeChange = useCallback((e) => setMaxRange(Number(e.target.value)), []);

  const pitchDeg = usePitch ? (telemetry.pitch ?? 0) : 0;
  const { forward, down } = decomposeRange(readout.range, mountDeg, pitchDeg);
  // Until the first profile arrives, borrow the lock state from the 2 Hz gauge
  // message — both come from the same reader, so the two sonar displays must
  // not contradict each other while this one is still waiting for a ping.
  const quality = readout.live ? readout.quality : sonar.quality;
  const q = QUALITY_TONE[quality] || QUALITY_TONE.none;
  const linkOk = demoMode || sonar.ok;

  return (
    <section className="sonar-panel">
      <div className="panel-head">
        <span className="eyebrow">Sonar</span>
        <span
          className="sonar-quality mono"
          style={{ color: linkOk ? q.tone : "var(--faint)",
                   borderColor: linkOk ? q.tone : "var(--faint)" }}
        >
          {linkOk ? q.label : "OFF"}
        </span>
        <div className="sonar-controls">
          <label className="sonar-ctl mono">
            mount
            <input
              type="range" min="0" max="90" step="1" value={mountDeg}
              onChange={(e) => setMountDeg(Number(e.target.value))}
              aria-label="Sonar mount angle off vertical"
            />
            <span className="sonar-ctl-val">{mountDeg}°</span>
          </label>
          <label className="sonar-ctl mono">
            range
            <select value={maxRange} onChange={onRangeChange} aria-label="Echogram max range">
              {RANGE_CHOICES.map((r) => <option key={r} value={r}>{r} m</option>)}
            </select>
          </label>
          <button
            type="button"
            className={`sonar-toggle mono ${usePitch ? "on" : ""}`}
            onClick={() => setUsePitch((v) => !v)}
            title="Correct the beam angle with live EKF pitch"
          >
            pitch {usePitch ? "on" : "off"}
          </button>
          <button
            type="button"
            className={`sonar-toggle mono ${paused ? "on" : ""}`}
            onClick={() => setPaused((v) => !v)}
          >
            {paused ? "resume" : "freeze"}
          </button>
        </div>
      </div>

      <div className="sonar-body">
        {/* ---- beam cone: where the echo is, right now ---- */}
        <div className="sonar-cone">
          <svg viewBox="0 0 150 130" role="img" aria-label="Sonar beam cone">
            <defs>
              <pattern id="deadzone" width="5" height="5" patternTransform="rotate(45)"
                       patternUnits="userSpaceOnUse">
                <line x1="0" y1="0" x2="0" y2="5" stroke="var(--faint)"
                      strokeWidth="1" opacity="0.5" />
              </pattern>
            </defs>
            {(() => {
              // Drone sits top-left; the beam sweeps down-right. Scale so the
              // selected max range fits the box.
              const ox = 22;
              const oy = 20;
              const span = 104; // px representing maxRange
              const eff = mountDeg - pitchDeg;
              const half = PING_BEAM_DEG / 2;
              const pt = (rangeM, angleDeg) => {
                const rad = (angleDeg * Math.PI) / 180;
                const px = ox + (rangeM / maxRange) * span * Math.sin(rad);
                const py = oy + (rangeM / maxRange) * span * Math.cos(rad);
                return [px, py];
              };
              const [ax, ay] = pt(maxRange, eff - half);
              const [bx, by] = pt(maxRange, eff + half);
              const [dx, dy] = pt(PING_MIN_RANGE_M, eff);
              const echo = readout.range != null ? pt(readout.range, eff) : null;
              return (
                <>
                  {/* full-range beam wedge */}
                  <path d={`M${ox} ${oy} L${ax} ${ay} L${bx} ${by} Z`}
                        fill="rgba(30,143,124,0.16)" stroke="var(--line)" strokeWidth="0.6" />
                  {/* range rings at 1/3 and 2/3 of scale */}
                  {[1 / 3, 2 / 3, 1].map((f) => {
                    const [rx, ry] = pt(maxRange * f, eff - half);
                    const [sx, sy] = pt(maxRange * f, eff + half);
                    return (
                      <path key={f} d={`M${rx} ${ry} L${sx} ${sy}`} stroke="var(--line)"
                            strokeWidth="0.5" fill="none" opacity="0.7" />
                    );
                  })}
                  {/* dead zone — nothing inside 0.5 m can be resolved */}
                  <path d={`M${ox} ${oy} L${dx} ${dy}`} stroke="url(#deadzone)"
                        strokeWidth="7" />
                  {/* beam axis */}
                  <path d={`M${ox} ${oy} L${pt(maxRange, eff)[0]} ${pt(maxRange, eff)[1]}`}
                        stroke="var(--faint)" strokeWidth="0.5" strokeDasharray="2 2" />
                  {/* the echo */}
                  {echo && (
                    <circle cx={echo[0]} cy={echo[1]} r="4.5"
                            fill={readout.gated ? q.tone : "var(--amber)"}
                            opacity={readout.gated ? 0.95 : 0.55} />
                  )}
                  {/* the drone */}
                  <circle cx={ox} cy={oy} r="4" fill="var(--ink)" />
                  <path d={`M${ox - 6} ${oy} L${ox + 6} ${oy}`} stroke="var(--ink)"
                        strokeWidth="1.5" />
                </>
              );
            })()}
          </svg>
          <div className="sonar-cone-readout mono">
            <div className="sonar-cone-row">
              <span className="sonar-lbl">range</span>
              <span className="sonar-num" style={{ color: readout.gated ? q.tone : undefined }}>
                {readout.range == null ? "—" : `${readout.range.toFixed(2)} m`}
              </span>
            </div>
            <div className="sonar-cone-row">
              <span className="sonar-lbl">ahead</span>
              <span className="sonar-num">
                {forward == null ? "—" : `${forward.toFixed(2)} m`}
              </span>
            </div>
            <div className="sonar-cone-row">
              <span className="sonar-lbl">below</span>
              <span className="sonar-num">
                {down == null ? "—" : `${down.toFixed(2)} m`}
              </span>
            </div>
            <div className="sonar-cone-row">
              <span className="sonar-lbl">conf</span>
              <span className="sonar-num">
                {readout.confidence == null ? "—" : `${readout.confidence}%`}
              </span>
            </div>
            {!readout.gated && readout.range != null && (
              <div className="sonar-note mono">peak echo — below confidence gate</div>
            )}
          </div>
        </div>

        {/* ---- echogram ---- */}
        <div className="sonar-echo">
          <canvas ref={canvasRef} className="sonar-echo-canvas" />
          <div className="sonar-echo-axis mono">
            <span>0</span>
            <span>{(maxRange / 2).toFixed(0)} m</span>
            <span>{maxRange} m</span>
          </div>
          {!readout.live && (
            <div className="sonar-echo-empty mono">
              {linkOk ? "waiting for pings…" : "sonar offline — enable demo mode to preview"}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
