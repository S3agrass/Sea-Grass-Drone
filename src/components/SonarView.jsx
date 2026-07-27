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
  planHalfAngleDeg,
  povBlipStyle,
  povRingRadius,
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
const VIEW_KEY = "seagrass-sonar-view";

// POV canvas bitmap. Square so the tunnel rings stay circular without the draw
// code having to carry an aspect correction; CSS fits it to the cone slot.
const POV_SIZE = 150;
// How long a ping's expanding pulse ring takes to cross the tunnel. Slower than
// the ~5 Hz ping rate on purpose, so several rings are in flight at once and the
// view reads as continuously sweeping rather than strobing.
const POV_PULSE_MS = 1400;
const POV_MAX_PULSES = 6;

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
    // `>= 0`, not `> 0`: the slider's own minimum is 0 (straight down), so
    // rejecting it here silently threw away a legitimate setting on reload.
    // That matters more now the plan view derives its whole geometry from it.
    const raw = localStorage.getItem(MOUNT_KEY);
    const saved = Number(raw);
    return raw !== null && Number.isFinite(saved) && saved >= 0 && saved <= 90
      ? saved : 45;
  });
  const [maxRange, setMaxRange] = useState(() => {
    const saved = Number(localStorage.getItem(RANGE_KEY));
    return RANGE_CHOICES.includes(saved) ? saved : 10;
  });
  const [usePitch, setUsePitch] = useState(true);
  const [paused, setPaused] = useState(false);
  // "plan" = looking straight down on the vehicle; "pov" = looking out from the
  // transducer itself. Same data, and both are live at once — the toggle only
  // chooses which one occupies the slot.
  const [view, setView] = useState(() => (
    localStorage.getItem(VIEW_KEY) === "pov" ? "pov" : "plan"
  ));

  // Low-rate mirror of the latest ping, for the text/SVG side of the panel.
  const [readout, setReadout] = useState({
    range: null, gated: false, confidence: null, quality: "none",
    scanLengthM: null, gain: null, rows: 0, live: false,
  });

  const canvasRef = useRef(null);
  const povRef = useRef(null);
  const pendingRef = useRef([]); // profiles received but not yet drawn
  const latestRef = useRef(null); // most recent ping, for the cone
  const rowsRef = useRef(0);
  const lastReadoutRef = useRef(0);
  const pausedRef = useRef(paused);
  const maxRangeRef = useRef(maxRange);
  const pulsesRef = useRef([]); // POV pulse rings in flight: array of start times

  // Mirror the controls into refs — the draw loop reads them every frame and
  // must not be torn down and restarted each time one changes.
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { maxRangeRef.current = maxRange; }, [maxRange]);

  useEffect(() => { localStorage.setItem(MOUNT_KEY, String(mountDeg)); }, [mountDeg]);
  useEffect(() => { localStorage.setItem(RANGE_KEY, String(maxRange)); }, [maxRange]);
  useEffect(() => { localStorage.setItem(VIEW_KEY, view); }, [view]);

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

    /* ---- POV tunnel ----
     * Looking out along the beam axis from the transducer itself. Range maps to
     * apparent size the way a tunnel does: a contact at zero range fills the
     * frame, one at max range is a point at the vanishing point in the centre.
     *
     * The expanding rings are RETURNS, not the outgoing ping — the echo travels
     * from the target back to the vehicle, i.e. far to near, i.e. centre to
     * edge. That is both the physically honest direction and the one that reads
     * as a sonar sweep instead of as flying backwards.
     *
     * A single fixed beam gives range but no bearing within the cone, so a
     * contact is drawn as a full ring at its range rather than as a dot at some
     * invented angle: the vehicle genuinely does not know where in the beam it
     * is.
     */
    const drawPov = (nowMs) => {
      const el = povRef.current;
      if (!el) return; // plan view is showing — nothing mounted to draw into
      const pctx = el.getContext("2d");
      if (!pctx) return; // jsdom / no 2D context
      if (el.width !== POV_SIZE) {
        el.width = POV_SIZE;
        el.height = POV_SIZE;
      }
      const size = POV_SIZE;
      const cx = size / 2;
      const cy = size / 2;
      const maxR = maxRangeRef.current;

      const bg = pctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
      bg.addColorStop(0, "#02090f"); // deepest at the vanishing point
      bg.addColorStop(1, "#07131f");
      pctx.fillStyle = bg;
      pctx.fillRect(0, 0, size, size);

      // Static range rings — the tunnel's depth cue. Evenly spaced in metres,
      // so their crowding toward the centre is the perspective made visible.
      pctx.lineWidth = 1;
      for (let i = 1; i <= 5; i += 1) {
        const r = povRingRadius((i / 5) * maxR, maxR, size);
        if (r == null || r < 0.5) continue;
        pctx.beginPath();
        pctx.arc(cx, cy, r, 0, Math.PI * 2);
        pctx.strokeStyle = `rgba(30,143,124,${0.28 - 0.04 * i})`;
        pctx.stroke();
      }

      // Boresight crosshair, so the centre reads as "straight ahead" and not as
      // an empty hole.
      pctx.strokeStyle = "rgba(77,106,130,0.5)";
      pctx.beginPath();
      pctx.moveTo(cx - 5, cy); pctx.lineTo(cx + 5, cy);
      pctx.moveTo(cx, cy - 5); pctx.lineTo(cx, cy + 5);
      pctx.stroke();

      // Returns in flight.
      const pulses = pulsesRef.current;
      while (pulses.length && nowMs - pulses[0] > POV_PULSE_MS) pulses.shift();
      for (const start of pulses) {
        const t = (nowMs - start) / POV_PULSE_MS; // 0 = at max range, 1 = arrived
        const r = povRingRadius((1 - t) * maxR, maxR, size);
        if (r == null || r < 0.5) continue;
        pctx.beginPath();
        pctx.arc(cx, cy, r, 0, Math.PI * 2);
        pctx.strokeStyle = `rgba(59,217,187,${0.55 * (1 - t)})`; // fades as it passes
        pctx.lineWidth = 1.5;
        pctx.stroke();
      }
      pctx.lineWidth = 1;

      // The contact itself.
      const p = latestRef.current;
      const contact = p?.distance_m;
      if (contact != null) {
        const r = povRingRadius(contact, maxR, size);
        const style = povBlipStyle(contact, maxR, p.confidence);
        if (r != null && style) {
          const hot = contact <= maxR * 0.25; // close enough to matter
          pctx.save();
          pctx.globalAlpha = style.opacity;
          pctx.strokeStyle = hot ? "#ffb454" : "#3bd9bb";
          pctx.shadowColor = pctx.strokeStyle;
          pctx.shadowBlur = 12;
          pctx.lineWidth = Math.max(1.5, style.size * size);
          pctx.beginPath();
          pctx.arc(cx, cy, Math.max(r, 1), 0, Math.PI * 2);
          pctx.stroke();
          pctx.restore();
        }
      }
    };

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const queue = pendingRef.current;
      if (queue.length && pausedRef.current) {
        pendingRef.current = [];
      } else if (queue.length) {
        pendingRef.current = [];
        for (const ping of queue) {
          drawColumn(ping);
          latestRef.current = ping;
          rowsRef.current += 1;
          if (pulsesRef.current.length < POV_MAX_PULSES) {
            pulsesRef.current.push(performance.now());
          }
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
      }

      // Outside the queue check: the pulses have to keep travelling between
      // pings, or the tunnel freezes for 200ms at a time and reads as broken.
      drawPov(performance.now());
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
            className={`sonar-toggle mono ${view === "pov" ? "on" : ""}`}
            onClick={() => setView((v) => (v === "pov" ? "plan" : "pov"))}
            title="Plan: looking down on the vehicle. POV: looking out along the beam."
          >
            {view === "pov" ? "pov" : "plan"}
          </button>
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
        {/* ---- where the echo is, right now: plan view or POV tunnel ---- */}
        <div className="sonar-cone">
          {view === "pov" ? (
            <canvas ref={povRef} className="sonar-pov-canvas"
                    role="img" aria-label="Sonar POV view" />
          ) : (
          <svg viewBox="0 0 150 130" role="img" aria-label="Sonar beam cone">
            <defs>
              <pattern id="deadzone" width="5" height="5" patternTransform="rotate(45)"
                       patternUnits="userSpaceOnUse">
                <line x1="0" y1="0" x2="0" y2="5" stroke="var(--faint)"
                      strokeWidth="1" opacity="0.5" />
              </pattern>
            </defs>
            {(() => {
              // Plan view: straight down on the vehicle, which sits at the bottom
              // with forward = up.
              //
              // Everything is plotted on the FORWARD PROJECTION of the range, not
              // the slant range, because a beam tilted toward the seabed reaches
              // less far ahead than it reaches in total — and it is the distance
              // ahead, not the slant distance, that decides whether you hit
              // something. A 10 m return on a 45deg mount is only 7 m ahead of
              // you, and this view says so.
              const ox = 75;   // bottom centre of the 150x130 box
              const oy = 114;
              const span = 100; // px representing maxRange of FORWARD distance
              const eff = mountDeg - pitchDeg;
              const half = planHalfAngleDeg(eff, PING_BEAM_DEG) ?? PING_BEAM_DEG / 2;
              const fwdOf = (slantM) =>
                decomposeRange(slantM, mountDeg, pitchDeg).forward ?? 0;
              // Polar: radius is forward distance, angle is bearing off the nose.
              const pt = (fwdM, bearingDeg) => {
                const rad = (bearingDeg * Math.PI) / 180;
                const r = (fwdM / maxRange) * span;
                return [ox + r * Math.sin(rad), oy - r * Math.cos(rad)];
              };
              // Arc across the wedge at a given forward distance. Split so the
              // wedge below can reuse the sweep without restating it.
              const arcTo = (fwdM) => {
                const [x2, y2] = pt(fwdM, half);
                const r = (fwdM / maxRange) * span;
                return `A${r} ${r} 0 0 1 ${x2} ${y2}`;
              };
              const arc = (fwdM) => {
                const [x1, y1] = pt(fwdM, -half);
                return `M${x1} ${y1} ${arcTo(fwdM)}`;
              };
              const reach = fwdOf(maxRange);   // how far ahead this tilt can see
              const dead = fwdOf(PING_MIN_RANGE_M);
              // Skip an echo beyond the selected display range rather than
              // clamping it onto the wedge's outer edge, where it would read as
              // a real contact at maxRange — same rule as rangeToRow.
              const echoFwd = readout.range != null && readout.range <= maxRange
                ? fwdOf(readout.range) : null;
              // Under 2% of the display range the wedge is a sliver and the
              // drawing says nothing useful — better to say so in words.
              const blind = reach < maxRange * 0.02;
              if (blind) {
                return (
                  <>
                    <circle cx={ox} cy={oy} r="4" fill="var(--ink)" />
                    <path d={`M${ox - 6} ${oy} L${ox + 6} ${oy}`} stroke="var(--ink)"
                          strokeWidth="1.5" />
                    <text x={ox} y={oy - 24} textAnchor="middle" fill="var(--amber)"
                          fontSize="9" fontFamily="monospace">
                      no forward reach
                    </text>
                    <text x={ox} y={oy - 12} textAnchor="middle" fill="var(--faint)"
                          fontSize="8" fontFamily="monospace">
                      beam points straight down
                    </text>
                  </>
                );
              }
              const [ax, ay] = pt(reach, -half);
              return (
                <>
                  {/* footprint the beam actually covers, seen from above */}
                  <path d={`M${ox} ${oy} L${ax} ${ay} ${arcTo(reach)} Z`}
                        fill="rgba(30,143,124,0.16)" stroke="var(--line)" strokeWidth="0.6" />
                  {/* range arcs at 1/3 and 2/3 of the reach */}
                  {[1 / 3, 2 / 3].map((f) => (
                    <path key={f} d={arc(reach * f)} stroke="var(--line)"
                          strokeWidth="0.5" fill="none" opacity="0.7" />
                  ))}
                  {/* dead zone — nothing inside 0.5 m slant can be resolved */}
                  <path d={`M${ox} ${oy} L${pt(dead, 0)[0]} ${pt(dead, 0)[1]}`}
                        stroke="url(#deadzone)" strokeWidth="7" />
                  {/* boresight */}
                  <path d={`M${ox} ${oy} L${pt(reach, 0)[0]} ${pt(reach, 0)[1]}`}
                        stroke="var(--faint)" strokeWidth="0.5" strokeDasharray="2 2" />
                  {/* the echo, drawn as an arc: one beam gives range but no
                      bearing within the cone, so a dot would invent an angle */}
                  {echoFwd != null && (
                    <path d={arc(echoFwd)} fill="none"
                          stroke={readout.gated ? q.tone : "var(--amber)"}
                          strokeWidth="3" strokeLinecap="round"
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
          )}
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
            {/* Why forward thrust went away. Without this the operator reads an
                unresponsive throttle as a broken vehicle. */}
            {sonar.braking && (
              <div className="sonar-brake mono">
                {sonar.brake >= 1
                  ? "FWD STOP — obstacle ahead"
                  : `FWD LIMIT ${Math.round((1 - sonar.brake) * 100)}%`}
              </div>
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
