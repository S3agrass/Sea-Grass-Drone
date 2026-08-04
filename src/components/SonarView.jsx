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
  clusterContacts,
  decomposeRange,
  findEchoes,
  mapPointXY,
  peakRange,
  sectorIndex,
  sectorMemoryToPoints,
  MAP_SECTORS,
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
// No ping for this long and the readout is blanked rather than left showing its
// last value. A frozen number is indistinguishable from a live one, so a stalled
// feed would otherwise read as "there is definitely something 1.2 m ahead" long
// after the sonar stopped saying anything at all.
const PROFILE_STALE_MS = 3000;

// Accumulation map. The vehicle IS the scanning mechanism: one fixed beam plus
// a compass gives (bearing, range) per ping, and yawing sweeps that into a plan
// of the surroundings — the same picture a mechanically-scanned head produces,
// built over seconds instead of in one sweep.
const MAP_SIZE = 240;
// Removal is primarily by SECTOR REFRESH — sweep a bearing again and whatever
// the beam now reports replaces what was there, so a contact that has gone
// disappears the moment you look back at it rather than when a timer says so.
//
// This TTL is the backstop for the other way the map can go wrong: nothing here
// tracks POSITION, only heading, so every point is a claim about where
// something sat relative to a spot the vehicle may since have drifted off. That
// error grows whether or not the bearing is ever re-swept, so it needs its own
// expiry. 60 s because a full hand-flown sweep is slower than it sounds — at
// the demo's ~7.8 deg/s a circle takes 46 s — and a TTL shorter than one sweep
// would erase the picture faster than it could be built.
const MAP_TTL_MS = 60000;
// Re-cluster at 4 Hz rather than per frame. Grouping is cheap but not free, and
// objects do not appear and vanish fast enough for 60 Hz to buy anything.
const MAP_CLUSTER_MS = 250;
const MAP_VIEWS = ["plan", "pov", "map"];

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
  // Collapsed sonar gives its whole height to the map and the camera, which
  // share the deck's only flexible row. Remembered, because whichever way an
  // operator wants this strip they want it every session, not once.
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("seagrass-sonar-collapsed") === "1",
  );
  useEffect(() => {
    localStorage.setItem("seagrass-sonar-collapsed", collapsed ? "1" : "0");
  }, [collapsed]);
  // Clustered objects mirrored out of the draw loop for the text list. Only the
  // map view needs it, and only at MAP_CLUSTER_MS, so the 5 Hz point stream
  // still never reaches React.
  const [objects, setObjects] = useState([]);
  // "plan" = looking straight down on the vehicle; "pov" = looking out from the
  // transducer itself. Same data, and both are live at once — the toggle only
  // chooses which one occupies the slot.
  const [view, setView] = useState(() => {
    const saved = localStorage.getItem(VIEW_KEY);
    return MAP_VIEWS.includes(saved) ? saved : "plan";
  });

  // Low-rate mirror of the latest ping, for the text/SVG side of the panel.
  const [readout, setReadout] = useState({
    range: null, gated: false, confidence: null, quality: "none",
    scanLengthM: null, gain: null, rows: 0, live: false,
    echoes: [], // every contact in the profile, nearest first
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
  const lastPingAtRef = useRef(0); // performance.now() of the last profile received
  const mapRef = useRef(null);
  // One slot per bearing holding only the beam's LAST look at it, so re-sweeping
  // a bearing replaces what was there and finding nothing erases it.
  const mapSectorsRef = useRef(new Array(MAP_SECTORS).fill(null));
  const mapObjectsRef = useRef([]); // clustered objects, recomputed at MAP_CLUSTER_MS
  const mapClusteredAtRef = useRef(0);
  // Yaw mirrored into a ref so the draw loop can read the CURRENT heading every
  // frame without the effect being torn down and restarted twice a second.
  const yawRef = useRef(null);

  // Mirror the controls into refs — the draw loop reads them every frame and
  // must not be torn down and restarted each time one changes.
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { maxRangeRef.current = maxRange; }, [maxRange]);

  useEffect(() => { localStorage.setItem(MOUNT_KEY, String(mountDeg)); }, [mountDeg]);
  useEffect(() => { localStorage.setItem(RANGE_KEY, String(maxRange)); }, [maxRange]);
  useEffect(() => { localStorage.setItem(VIEW_KEY, view); }, [view]);
  // Works for the live link and for demo mode alike: this component already
  // re-renders on telemetry (it reads pitch), so mirroring costs nothing extra.
  useEffect(() => { yawRef.current = telemetry.yaw; }, [telemetry.yaw]);

  /* ---------- ingest: real profiles straight off the link ---------- */
  useEffect(() => {
    if (demoMode) return undefined;
    return link.subscribe((event) => {
      if (event.type === "message" && event.data?.type === "sonar_profile") {
        pendingRef.current.push(event.data);
        // Stamped on ARRIVAL, not on draw: "is the feed alive" is a fact about
        // the link, and a frozen tab or a paused display must not be mistaken
        // for a dead sonar.
        lastPingAtRef.current = performance.now();
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
      // Range to the wall of a virtual rectangular tank, along whatever bearing
      // the (simulated) vehicle is pointing. Ranging a real room rather than
      // wandering randomly is what makes the accumulation map previewable: a
      // random walk sweeps into a fuzzy ring, whereas this draws the room.
      const yaw = yawRef.current;
      if (yaw != null && Number.isFinite(yaw)) {
        const rad = (yaw * Math.PI) / 180;
        const east = Math.abs(Math.sin(rad));
        const north = Math.abs(Math.cos(rad));
        const halfW = 4.0;   // metres to the east/west walls
        const halfH = 2.5;   // metres to the north/south walls
        const wall = Math.min(east === 0 ? Infinity : halfW / east,
                              north === 0 ? Infinity : halfH / north);
        target = wall + (Math.random() * 0.12 - 0.06); // ranging noise
      } else {
        target += Math.random() * 0.5 - 0.25;
      }
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

    /* ---- accumulation map: turn each ping into world-referenced points ---- */
    const recordMapPoints = (ping) => {
      const yaw = yawRef.current;
      if (yaw == null || !Number.isFinite(yaw)) return; // no compass, no bearing
      // Bearing is the vehicle's heading: a fixed forward beam looks wherever
      // the nose does. Mount tilt is ignored on purpose — this is a PLAN view,
      // and a tilted beam's contact still lies along the same compass bearing,
      // just nearer than its slant range. The range plotted is the slant range
      // for that reason; see the caption in the panel.
      const bearing = ((yaw % 360) + 360) % 360;
      const maxR = maxRangeRef.current;
      const found = findEchoes(ping.profile, ping.scan_start_m ?? 0,
                               ping.scan_length_m ?? maxR);
      const ranges = found.length ? found.map((e) => e.range)
                                  : (ping.distance_m != null ? [ping.distance_m] : []);

      // This ping REPLACES whatever was believed about this bearing. Assigning
      // null on an empty result is the whole feature: a look that finds nothing
      // has to erase the slot, or a contact that has gone would sit on the map
      // until its timer expired.
      const idx = sectorIndex(bearing);
      if (idx == null) return;
      const visible = ranges.filter((r) => r <= maxR);
      mapSectorsRef.current[idx] = visible.length
        ? { bearing, ranges: visible, conf: ping.confidence ?? 0, t: performance.now() }
        : null;
    };

    const drawMap = (nowMs) => {
      const el = mapRef.current;
      if (!el) return;
      const mctx = el.getContext("2d");
      if (!mctx) return; // jsdom / no 2D context
      if (el.width !== MAP_SIZE) {
        el.width = MAP_SIZE;
        el.height = MAP_SIZE;
      }
      const size = MAP_SIZE;
      const cx = size / 2;
      const cy = size / 2;
      const rad = size / 2;
      const maxR = maxRangeRef.current;

      const bg = mctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      bg.addColorStop(0, "#08161f");
      bg.addColorStop(1, "#040d16");
      mctx.fillStyle = "#040d16";
      mctx.fillRect(0, 0, size, size);
      mctx.beginPath();
      mctx.arc(cx, cy, rad - 1, 0, Math.PI * 2);
      mctx.fillStyle = bg;
      mctx.fill();

      // Range rings, labelled in metres so the picture has a scale.
      mctx.setLineDash([2, 3]);
      mctx.strokeStyle = "rgba(30,143,124,0.35)";
      mctx.lineWidth = 1;
      for (let i = 1; i <= 4; i += 1) {
        mctx.beginPath();
        mctx.arc(cx, cy, (rad - 1) * (i / 4), 0, Math.PI * 2);
        mctx.stroke();
      }
      mctx.setLineDash([]);
      mctx.fillStyle = "rgba(124,151,173,0.75)";
      mctx.font = "8px ui-monospace, monospace";
      mctx.textAlign = "left";
      for (let i = 1; i <= 4; i += 1) {
        mctx.fillText(`${((maxR * i) / 4).toFixed(0)}m`, cx + 3, cy - (rad - 1) * (i / 4) + 9);
      }

      // Cardinals — the map is north-up, and without these that isn't obvious.
      mctx.fillStyle = "rgba(124,151,173,0.9)";
      mctx.font = "700 9px ui-monospace, monospace";
      mctx.textAlign = "center";
      mctx.textBaseline = "middle";
      for (const [label, deg] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]]) {
        const p = mapPointXY(deg, maxR * 0.93, maxR, size);
        mctx.fillStyle = deg === 0 ? "rgba(59,217,187,0.95)" : "rgba(124,151,173,0.8)";
        mctx.fillText(label, p.x, p.y);
      }
      mctx.textBaseline = "alphabetic";

      // Accumulated contacts. Age fades them out, confidence sets how solid they
      // look, and overlapping returns compound — so a wall the beam crossed
      // repeatedly builds into a solid arc while noise stays as isolated specks.
      const live = sectorMemoryToPoints(mapSectorsRef.current, nowMs, MAP_TTL_MS);
      for (const p of live) {
        const age = (nowMs - p.t) / MAP_TTL_MS;
        const xy = mapPointXY(p.bearing, p.range, maxR, size);
        if (!xy) continue;
        const trust = Math.max(0, Math.min(1, p.conf / 100));
        const alpha = (1 - age) ** 1.6 * (0.18 + 0.62 * trust);
        mctx.beginPath();
        mctx.arc(xy.x, xy.y, 1.4 + 1.4 * (1 - age), 0, Math.PI * 2);
        mctx.fillStyle = trust >= 0.5
          ? `rgba(59,217,187,${alpha})`
          : `rgba(255,180,84,${alpha * 0.8})`;
        mctx.fill();
      }

      // Distinct objects, labelled with their distance. The raw points are the
      // evidence; this is the reading of it, and it is what turns a dot cloud
      // into "there are three things around me, at 2.4, 3.1 and 4.0 m".
      if (nowMs - mapClusteredAtRef.current > MAP_CLUSTER_MS) {
        mapClusteredAtRef.current = nowMs;
        mapObjectsRef.current = clusterContacts(live);
        setObjects(mapObjectsRef.current);
      }
      mctx.textAlign = "center";
      mctx.textBaseline = "middle";
      for (let i = 0; i < mapObjectsRef.current.length; i += 1) {
        const o = mapObjectsRef.current[i];
        // No bearing means a surface wrapping the vehicle, which has no one
        // place to pin a marker. Drawn as a ring at its closest approach
        // instead — the shape of the claim being made.
        if (o.bearing == null) {
          const rr = (o.range / maxR) * (rad - 1);
          mctx.beginPath();
          mctx.arc(cx, cy, rr, 0, Math.PI * 2);
          mctx.strokeStyle = o.conf >= 50 ? "rgba(59,217,187,0.5)" : "rgba(255,180,84,0.4)";
          mctx.lineWidth = 1.2;
          mctx.setLineDash([4, 3]);
          mctx.stroke();
          mctx.setLineDash([]);
          continue;
        }
        const xy = mapPointXY(o.bearing, o.range, maxR, size);
        if (!xy) continue;
        const trusted = o.conf >= 50;
        const nearest = i === 0;
        const tone = trusted ? "59,217,187" : "255,180,84";

        // Marker on the object itself.
        mctx.beginPath();
        mctx.arc(xy.x, xy.y, nearest ? 4 : 3, 0, Math.PI * 2);
        mctx.strokeStyle = `rgba(${tone},${nearest ? 0.95 : 0.6})`;
        mctx.lineWidth = nearest ? 1.6 : 1.1;
        mctx.stroke();

        // Label pushed further out along the same bearing, so it sits clear of
        // the object's own smear rather than on top of it.
        const lp = mapPointXY(o.bearing, Math.min(maxR, o.range + maxR * 0.09),
                              maxR, size)
                || xy;
        const text = `${o.range.toFixed(2)}m`;
        mctx.font = `${nearest ? "700 " : ""}9px ui-monospace, monospace`;
        const w = mctx.measureText(text).width;
        mctx.fillStyle = "rgba(4,13,22,0.78)"; // plate, so labels stay legible
        mctx.fillRect(lp.x - w / 2 - 2, lp.y - 6, w + 4, 12);
        mctx.fillStyle = `rgba(${tone},${nearest ? 1 : 0.75})`;
        mctx.fillText(text, lp.x, lp.y);
      }
      mctx.textBaseline = "alphabetic";

      // Where the beam is pointing right now.
      const yaw = yawRef.current;
      if (yaw != null && Number.isFinite(yaw)) {
        const half = PING_BEAM_DEG / 2;
        const a0 = ((yaw - half - 90) * Math.PI) / 180;
        const a1 = ((yaw + half - 90) * Math.PI) / 180;
        const wedge = mctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
        wedge.addColorStop(0, "rgba(59,217,187,0.30)");
        wedge.addColorStop(1, "rgba(59,217,187,0.02)");
        mctx.beginPath();
        mctx.moveTo(cx, cy);
        mctx.arc(cx, cy, rad - 1, a0, a1);
        mctx.closePath();
        mctx.fillStyle = wedge;
        mctx.fill();

        // Vehicle: a nose-on arrow, so heading is readable at a glance.
        const r = (yaw * Math.PI) / 180;
        mctx.save();
        mctx.translate(cx, cy);
        mctx.rotate(r);
        mctx.beginPath();
        mctx.moveTo(0, -7);
        mctx.lineTo(4.5, 5);
        mctx.lineTo(0, 2.5);
        mctx.lineTo(-4.5, 5);
        mctx.closePath();
        mctx.fillStyle = "#e9f2f8";
        mctx.fill();
        mctx.restore();
      } else {
        mctx.beginPath();
        mctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
        mctx.fillStyle = "var(--faint)";
        mctx.fillStyle = "#4d6a82";
        mctx.fill();
      }
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

      // Every contact, not just the device's pick — farthest first so a near
      // one is drawn over the top of anything behind it.
      const p = latestRef.current;
      if (!p) return;
      const found = findEchoes(p.profile, p.scan_start_m ?? 0, p.scan_length_m ?? maxR);
      const ranges = found.length ? found.map((e) => e.range)
                                  : (p.distance_m != null ? [p.distance_m] : []);
      for (let i = ranges.length - 1; i >= 0; i -= 1) {
        const contact = ranges[i];
        const r = povRingRadius(contact, maxR, size);
        const style = povBlipStyle(contact, maxR, p.confidence);
        if (r == null || style == null) continue;
        const nearest = i === 0;
        const hot = contact <= maxR * 0.25; // close enough to matter
        pctx.save();
        pctx.globalAlpha = style.opacity * (nearest ? 1 : 0.45);
        pctx.strokeStyle = hot ? "#ffb454" : "#3bd9bb";
        pctx.shadowColor = pctx.strokeStyle;
        pctx.shadowBlur = nearest ? 12 : 4;
        pctx.lineWidth = Math.max(1.5, style.size * size * (nearest ? 1 : 0.5));
        pctx.beginPath();
        pctx.arc(cx, cy, Math.max(r, 1), 0, Math.PI * 2);
        pctx.stroke();
        pctx.restore();

        // Range label on the ring. Placed above it so a stack of contacts reads
        // as a list rather than as overlapping text through the middle.
        if (r > 6) {
          pctx.save();
          pctx.globalAlpha = nearest ? 0.95 : 0.5;
          pctx.fillStyle = hot ? "#ffb454" : "#3bd9bb";
          pctx.font = `${nearest ? "700 " : ""}9px ui-monospace, monospace`;
          pctx.textAlign = "center";
          pctx.fillText(`${contact.toFixed(2)}`, cx, cy - r + 10);
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
          recordMapPoints(ping);
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
            echoes: findEchoes(p.profile, p.scan_start_m ?? 0,
                               p.scan_length_m ?? maxRangeRef.current),
          });
        }
      }

      // Blank a feed that has stopped, rather than leaving its last reading up
      // looking live. Also drops the contact so the cone and tunnel stop drawing
      // an echo that is no longer being reported.
      const t = performance.now();
      if (lastPingAtRef.current && t - lastPingAtRef.current > PROFILE_STALE_MS) {
        lastPingAtRef.current = 0;
        latestRef.current = null;
        setReadout((r) => (r.live
          ? { ...r, live: false, range: null, gated: false, confidence: null,
              quality: "none", echoes: [] }
          : r));
      }

      // Outside the queue check: the pulses have to keep travelling between
      // pings, or the tunnel freezes for 200ms at a time and reads as broken.
      // The map likewise has to keep ageing its points and tracking the heading
      // while the vehicle turns, whether or not a ping happened this frame.
      drawPov(t);
      drawMap(t);
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
    <section
      className={`sonar-panel${collapsed ? " collapsed" : ""}`}
      aria-labelledby="sonar-panel-title"
    >
      <div className="panel-head">
        {/* Was a bare "▸"/"▾" with the meaning only in `title` — an unnamed
            control. aria-controls ties it to the body it folds. */}
        <button
          className="strip-collapse"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-controls="sonar-body"
          aria-label={collapsed ? "Show the sonar display" : "Hide the sonar display"}
          title={collapsed ? "Show the sonar display" : "Hide the sonar display and give the space to the map"}
        >
          <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
        </button>
        <h2 className="eyebrow panel-title" id="sonar-panel-title">Sonar</h2>
        <span
          className="sonar-quality mono"
          style={{ color: linkOk ? q.tone : "var(--faint)",
                   borderColor: linkOk ? q.tone : "var(--faint)" }}
        >
          <span className="visually-hidden">Signal quality: </span>
          {linkOk ? q.label : "OFF"}
        </span>
        <div className="sonar-controls">
          {/* These carried an aria-label that replaced the visible word beside
              them, so the control read as "Sonar mount angle off vertical"
              while the screen said "mount" — speech input users saying "click
              mount" hit nothing (SC 2.5.3). The visible text is now the start
              of the name, and the longer explanation moved to a description. */}
          <label className="sonar-ctl mono" htmlFor="sonar-mount">
            mount
            <input
              id="sonar-mount"
              type="range" min="0" max="90" step="1" value={mountDeg}
              onChange={(e) => setMountDeg(Number(e.target.value))}
              aria-describedby="sonar-mount-help"
              aria-valuetext={`${mountDeg} degrees off vertical`}
            />
            <span className="sonar-ctl-val">{mountDeg}°</span>
          </label>
          <span className="visually-hidden" id="sonar-mount-help">
            Sonar mount angle off vertical, in degrees.
          </span>
          <label className="sonar-ctl mono" htmlFor="sonar-range">
            range
            <select id="sonar-range" value={maxRange} onChange={onRangeChange}
                    aria-describedby="sonar-range-help">
              {RANGE_CHOICES.map((r) => <option key={r} value={r}>{r} m</option>)}
            </select>
          </label>
          <span className="visually-hidden" id="sonar-range-help">
            Maximum range shown on the echogram.
          </span>
          {/* A cycle button whose label was its own current value — "plan" —
              with the purpose only in `title`, so it announced as "plan,
              button" and gave no hint that pressing it changes the view. The
              name states the action and the value comes through as the state. */}
          <button
            type="button"
            className={`sonar-toggle mono ${view !== "plan" ? "on" : ""}`}
            onClick={() => setView((v) => MAP_VIEWS[(MAP_VIEWS.indexOf(v) + 1) % MAP_VIEWS.length])}
            aria-label={`Sonar view: ${view}. Press to change view.`}
            title={"plan: looking down on the vehicle. "
                 + "pov: looking out along the beam. "
                 + "map: contacts accumulated as you turn, north up."}
          >
            {view}
          </button>
          <button
            type="button"
            className={`sonar-toggle mono ${usePitch ? "on" : ""}`}
            onClick={() => setUsePitch((v) => !v)}
            aria-pressed={usePitch}
            aria-label="Pitch correction"
            title="Correct the beam angle with live EKF pitch"
          >
            pitch {usePitch ? "on" : "off"}
          </button>
          {/* The label names the action it will perform, which is the opposite
              of the current state — so state goes on aria-pressed rather than
              being inferred from a label that flips. */}
          <button
            type="button"
            className={`sonar-toggle mono ${paused ? "on" : ""}`}
            onClick={() => setPaused((v) => !v)}
            aria-pressed={paused}
            aria-label="Freeze the echogram"
          >
            {paused ? "resume" : "freeze"}
          </button>
        </div>
      </div>

      <div className="sonar-body" id="sonar-body" hidden={collapsed}>
        {/* ---- where the echo is, right now: plan view or POV tunnel ---- */}
        <div className={`sonar-cone${view === "map" ? " map" : ""}`}>
          {view === "map" ? (
            <div className="sonar-map-wrap">
              <canvas ref={mapRef} className="sonar-map-canvas"
                      role="img" aria-label="Sonar accumulation map" />
              <div className="sonar-map-note mono">
                {telemetry.yaw == null
                  ? "no compass — turn on telemetry to build the map"
                  : "yaw the vehicle to sweep · north up · slant range"}
              </div>
              {/* Mirrors the labels drawn on the canvas. The canvas answers
                  "where", this answers "exactly how far, on what bearing" —
                  which is the thing you can act on. Low-rate state, so it does
                  not put the 5 Hz point stream through React. */}
              {objects.length > 0 && (
                <div className="sonar-objects mono">
                  {objects.map((o, i) => (
                    <div key={`${o.bearing?.toFixed(0) ?? "all"}-${o.range.toFixed(2)}`}
                         className={`sonar-object-row${
                           i === 0 && o.conf >= 50 ? " near" : ""}${
                           o.conf < 50 ? " weak" : ""}`}>
                      <span>{o.bearing == null ? "surface"
                             : i === 0 ? "nearest" : `#${i + 1}`}</span>
                      <span>{o.range.toFixed(2)} m</span>
                      {/* No bearing = it wraps around you; saying "all round"
                          is honest where a number would not be. */}
                      <span>{o.bearing == null ? "all round"
                             : `${o.bearing.toFixed(0)}°`}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : view === "pov" ? (
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
              // Every detected contact, projected forward. Anything past the
              // selected display range is dropped rather than clamped onto the
              // outer arc, where it would read as a real contact at maxRange —
              // same rule as rangeToRow. Falls back to the single gated reading
              // when no profile is available (PING_PROFILE=0 or a degraded link).
              const contacts = (readout.echoes.length
                ? readout.echoes.map((e) => e.range)
                : (readout.range != null ? [readout.range] : [])
              ).filter((r) => r <= maxRange).map((r) => ({ fwd: fwdOf(r) }));
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
                  {/* Every contact in the profile, each labelled with its own
                      distance AHEAD — not the slant range, since forward
                      distance is what decides whether you hit it.

                      Each is an arc spanning the beam, never a dot: one fixed
                      beam resolves range but NO bearing within the cone, so a
                      dot would be inventing an angle the vehicle cannot know.

                      The nearest is drawn solid and labelled in the lock colour
                      because it is the one that matters; the rest are dimmed. On
                      a 45deg mount the farthest is usually the seabed. */}
                  {contacts.map((c, i) => {
                    // Only promote the nearest to "this is the one" when there
                    // is a confidence lock behind it. Without one these are
                    // amplitude peaks, which in a reverberant space are folded
                    // multipath as often as they are objects.
                    const near = i === 0 && readout.gated;
                    const tone = i === 0 ? (readout.gated ? q.tone : "var(--amber)")
                                         : "var(--faint)";
                    const [, cy] = pt(c.fwd, 0);
                    return (
                      <g key={`${c.fwd.toFixed(2)}-${i}`}>
                        {near && (
                          // Lead-in from the vehicle so the gap reads as distance.
                          <path d={`M${ox} ${oy} L${ox} ${cy}`} stroke={tone}
                                strokeWidth="0.6" strokeDasharray="1.5 2" opacity="0.5" />
                        )}
                        <path d={arc(c.fwd)} fill="none" stroke={tone}
                              strokeWidth={near ? 3.5 : 2} strokeLinecap="round"
                              opacity={near ? (readout.gated ? 0.95 : 0.6) : 0.5} />
                        <text x={ox} y={cy - 4} textAnchor="middle" fill={tone}
                              fontSize={near ? 9 : 7.5} fontFamily="monospace"
                              fontWeight={near ? 700 : 400}>
                          {c.fwd.toFixed(2)} m
                        </text>
                      </g>
                    );
                  })}
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
            {/* Exact numbers for every contact. The device only ever reports its
                own single pick (the STRONGEST return); these come from reading
                the profile directly, so a near soft object is listed even when a
                far hard one is louder. "ahead" is the forward projection.

                findEchoes() reads the RAW profile and applies no confidence
                gating, so without the banner below this list renders reverb as
                crisp monospace metres — which is how a Ping2 in a 0.46 m box
                came to report a contact at 1.19 m, a folded multipath return
                roughly three traversals long. Amplitude peaks are real peaks;
                whether they are real OBJECTS is what confidence answers, and
                only `gated` carries that. */}
            {readout.echoes.length > 1 && (
              <div className={`sonar-contacts mono${readout.gated ? "" : " unverified"}`}>
                {!readout.gated && (
                  <div className="sonar-contacts-warn">
                    unverified — no confidence lock
                  </div>
                )}
                {readout.echoes.map((e, i) => {
                  const ahead = decomposeRange(e.range, mountDeg, pitchDeg).forward;
                  return (
                    <div key={`${e.range}-${i}`}
                         className={`sonar-contact-row${i === 0 && readout.gated ? " near" : ""}`}>
                      <span>{i === 0 ? "nearest" : `#${i + 1}`}</span>
                      <span>{e.range.toFixed(2)} m</span>
                      <span>{ahead == null ? "—" : `${ahead.toFixed(2)} ahead`}</span>
                    </div>
                  );
                })}
              </div>
            )}
            {/* Why forward thrust went away. Without this the operator reads an
                unresponsive throttle as a broken vehicle. */}
            {sonar.braking && (
              <div className="sonar-brake mono">
                {/* Percentage is thrust REMAINING. "FWD LIMIT 32%" was read as
                    "32% has been taken away", which is the opposite of what it
                    meant — hence the explicit "capped to". */}
                {sonar.brake >= 1
                  ? "FWD STOP — obstacle ahead"
                  : `FWD capped to ${Math.round((1 - sonar.brake) * 100)}%`}
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
