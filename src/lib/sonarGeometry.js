/* Geometry + colour maths for the Ping2 sonar views.
 *
 * Pure functions, deliberately kept out of the component: the canvas itself
 * can't be asserted on in jsdom (no 2D context), so the logic that can actually
 * be wrong lives here and is unit-tested directly. Same split as
 * src/lib/stickCurve.js.
 *
 * Two coordinate conventions matter and are easy to mix up:
 *   - A profile sample's index maps to an ABSOLUTE range via the device's scan
 *     window (scan_start .. scan_start + scan_length). That window moves every
 *     ping while the device is auto-ranging, so a bin is NOT a fixed distance.
 *   - The mount angle is measured OFF VERTICAL: 0deg = straight down,
 *     90deg = dead ahead. Pitch is nose-up positive, matching MAVLink.
 */

// Ping2 physical limits, not arbitrary display choices.
export const PING_MIN_RANGE_M = 0.5; // dead zone — nothing closer can be resolved
export const PING_BEAM_DEG = 25; // ~25-30deg cone; the narrow end is the honest one

/* Amplitude 0-255 -> [r,g,b] on the app's palette, dark to hot:
 *   --abyss #06111e -> --teal-dim #1e8f7c -> --teal #3bd9bb -> --amber #ffb454 -> --red #ff5c6c
 * Linear interpolation between stops. Anything out of range clamps rather than
 * wrapping, so a corrupt sample can't produce a wild colour. */
const RAMP = [
  [0.0, [6, 17, 30]],
  [0.35, [30, 143, 124]],
  [0.6, [59, 217, 187]],
  [0.82, [255, 180, 84]],
  [1.0, [255, 92, 108]],
];

export function amplitudeToRGB(amplitude) {
  const a = Number.isFinite(amplitude) ? Math.max(0, Math.min(255, amplitude)) / 255 : 0;
  for (let i = 1; i < RAMP.length; i += 1) {
    const [hi, hiRGB] = RAMP[i];
    if (a <= hi) {
      const [lo, loRGB] = RAMP[i - 1];
      const t = hi === lo ? 0 : (a - lo) / (hi - lo);
      return [
        Math.round(loRGB[0] + (hiRGB[0] - loRGB[0]) * t),
        Math.round(loRGB[1] + (hiRGB[1] - loRGB[1]) * t),
        Math.round(loRGB[2] + (hiRGB[2] - loRGB[2]) * t),
      ];
    }
  }
  return RAMP[RAMP.length - 1][1];
}

/* Profile index -> absolute range in metres. `len` is the sample count, and the
 * window is the device's own reported scan_start/scan_length for THAT ping. */
export function sampleToRange(index, len, scanStartM = 0, scanLengthM = 0) {
  if (!len || len < 1) return scanStartM;
  if (len === 1) return scanStartM;
  return scanStartM + (index / (len - 1)) * scanLengthM;
}

/* Metres -> echogram row (0 = top = nearest). Returns null when the range falls
 * outside the display window, so callers skip rather than clamping a far echo
 * onto the bottom edge where it would read as a real return. */
export function rangeToRow(rangeM, maxRangeM, heightPx) {
  if (!Number.isFinite(rangeM) || maxRangeM <= 0 || heightPx <= 0) return null;
  if (rangeM < 0 || rangeM > maxRangeM) return null;
  const row = Math.round((rangeM / maxRangeM) * (heightPx - 1));
  return Math.max(0, Math.min(heightPx - 1, row));
}

/* Split a slant range into how far AHEAD and how far BELOW the target is.
 *
 *   down    = R * cos(theta - pitch)
 *   forward = R * sin(theta - pitch)
 *
 * with theta measured off vertical. Nose-up pitch tilts the beam upward, which
 * reduces the downward component and extends reach ahead — hence the
 * subtraction. Returns nulls for a missing range so the UI shows "—" rather
 * than a confident 0.0.
 */
export function decomposeRange(rangeM, mountDeg = 45, pitchDeg = 0) {
  if (!Number.isFinite(rangeM)) return { forward: null, down: null };
  const rad = ((mountDeg - pitchDeg) * Math.PI) / 180;
  return {
    forward: rangeM * Math.sin(rad),
    down: rangeM * Math.cos(rad),
  };
}

/* Half-angle of the beam's footprint as seen from DIRECTLY ABOVE, in degrees.
 *
 * The plan view looks straight down, so it shows the beam's horizontal spread —
 * which is not the beam width. Take the cone edge deflected purely sideways by
 * half-angle B: it sits R*sin(B) off to the side, and its along-axis component
 * R*cos(B) projects to R*cos(B)*sin(theta) ahead. From above it therefore
 * subtends atan(tan B / sin theta) — which correctly collapses to B itself when
 * the beam is horizontal (theta = 90).
 *
 * The consequence is the point of drawing it this way: tilt the mount toward
 * vertical and the wedge fans out toward 90deg while its reach collapses to
 * nothing. That is the truth about a downward-looking beam — it sees a wide
 * patch of seabed directly under the vehicle and nothing useful ahead of it —
 * and it is exactly the thing an operator needs to know before trusting the
 * sonar brake to see a wall. Clamped just under 90 so the wedge never degenerates
 * into a half-plane the SVG arc can't draw.
 */
export function planHalfAngleDeg(effectiveMountDeg, beamDeg = PING_BEAM_DEG) {
  if (!Number.isFinite(effectiveMountDeg) || !Number.isFinite(beamDeg)) return null;
  const lateral = Math.tan((Math.min(89, Math.max(0, beamDeg) / 2) * Math.PI) / 180);
  const forward = Math.sin((effectiveMountDeg * Math.PI) / 180);
  // forward <= 0 means the beam points at or above the horizon: no plan-view
  // reach at all, so the footprint is "everywhere and nowhere".
  if (forward <= 0) return 89;
  return Math.min(89, (Math.atan2(lateral, forward) * 180) / Math.PI);
}

/* Accumulation map: an absolute bearing + range -> canvas pixel, NORTH UP.
 *
 * North up rather than heading up, because this view's whole point is that
 * points PERSIST while the vehicle turns. Heading up would spin the accumulated
 * world around the screen every time the pilot yawed, destroying the one thing
 * the map is for; north up leaves the picture still and rotates the boat inside
 * it, which is also what every chart plotter does.
 *
 * Screen convention: bearing 0 (north) is up, 90 (east) is right — hence sin on
 * x and MINUS cos on y, since canvas y grows downward.
 */
export function mapPointXY(bearingDeg, rangeM, maxRangeM, size) {
  if (!Number.isFinite(bearingDeg) || !Number.isFinite(rangeM)) return null;
  if (!(maxRangeM > 0) || !(size > 0)) return null;
  if (rangeM < 0 || rangeM > maxRangeM) return null;
  const r = (rangeM / maxRangeM) * (size / 2);
  const rad = (bearingDeg * Math.PI) / 180;
  return {
    x: size / 2 + r * Math.sin(rad),
    y: size / 2 - r * Math.cos(rad),
  };
}

/* Sector memory: the compass split into slots, each holding only what the beam
 * last saw at that bearing.
 *
 * This is how a contact disappears when it stops being there instead of
 * loitering until a timer expires. Each ping is a fresh statement about ONE
 * bearing and it REPLACES that slot — so a sweep finding nothing empties the
 * slot exactly as a sweep finding something overwrites it, while every other
 * bearing is untouched, which is what lets the picture behind you persist.
 *
 * A slot per bearing, rather than an accumulating list culled by proximity: the
 * obvious version — drop nearby points, then append what was just seen — eats
 * itself. Points land at whatever heading the vehicle held at that instant, so
 * the cull radius has to exceed the per-ping heading step or nothing is ever
 * removed, and the moment it does exceed it, each ping deletes the points the
 * previous few just laid down. Tested it: a full sweep past an object left the
 * map completely empty. Slots have no such coupling — a slot is only ever
 * rewritten by an observation of that same bearing.
 *
 * 2 degrees is well under the beam width, so one object still spans several
 * slots and the clustering above sees the arc it expects.
 */
export const MAP_SECTORS = 180;

export function sectorIndex(bearingDeg, sectors = MAP_SECTORS) {
  if (!Number.isFinite(bearingDeg) || !(sectors > 0)) return null;
  const b = ((bearingDeg % 360) + 360) % 360;
  return Math.min(sectors - 1, Math.floor((b / 360) * sectors));
}

/* Flatten live slots into points for drawing and clustering. The TTL is the
 * backstop for the error slots cannot catch: nothing tracks POSITION, so a slot
 * never re-swept goes on asserting where something sat relative to a spot the
 * vehicle may since have left. */
export function sectorMemoryToPoints(sectors, nowMs, ttlMs) {
  const out = [];
  if (!sectors) return out;
  for (const s of sectors) {
    if (!s || !s.ranges) continue;
    if (nowMs - s.t > ttlMs) continue;
    for (const range of s.ranges) {
      out.push({ bearing: s.bearing, range, conf: s.conf, t: s.t });
    }
  }
  return out;
}

/* Group accumulated map points into distinct OBJECTS, nearest first.
 *
 * The tolerances are deliberately asymmetric, and that asymmetry is the whole
 * design. Sweeping past a single small object records it across a full beam
 * width of heading — it enters the cone half a beam before you point at it and
 * leaves half a beam after — so one object arrives as an arc ~PING_BEAM_DEG
 * wide at a CONSTANT range. Cluster with one symmetric radius and you must
 * either choose a radius wide enough to close that arc (which then swallows
 * genuinely separate objects beside it) or a tight one (which shatters every
 * object into a string of fragments). Being generous in bearing and strict in
 * range instead matches how the smearing actually happens.
 *
 * Points are binned before grouping so cost tracks occupied cells rather than
 * point count — the map holds well over a thousand points and this runs inside
 * the draw loop.
 *
 * `minWeight` is the noise floor: reverb sprays isolated returns that never
 * repeat, while a real surface is re-hit on every ping that crosses it, so
 * requiring several points per object separates the two without thresholding
 * amplitude.
 *
 * `range` is the cluster's CLOSEST approach, not its mean, and `bearing` points
 * at that closest point. A compact object makes the two identical, but a wall
 * chains into one cluster wrapping most of the compass — as it should, being one
 * continuous surface — and its mean range then describes nothing you can act on
 * while its nearest point is exactly what you must not hit. `span` reports how
 * much bearing it covers, which is what separates "an object over there" from
 * "a surface around me".
 *
 * Returns [{ range, bearing, span, count, conf }], nearest first.
 */
const CLUSTER_BEARING_BIN_DEG = 5;

/* How much bearing a set of occupied bins covers, measured as 360 minus the
 * widest gap between them — which is the only definition that behaves for a
 * cluster wrapping past north. A surface enclosing the vehicle has no gap and
 * so spans ~360; a compact object spans about one beam width. */
function bearingSpan(bins) {
  const sorted = [...bins].sort((a, b) => a - b);
  if (sorted.length <= 1) return CLUSTER_BEARING_BIN_DEG;
  let widest = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const next = sorted[(i + 1) % sorted.length];
    const gap = (((next - sorted[i]) * CLUSTER_BEARING_BIN_DEG) + 360) % 360;
    if (gap > widest) widest = gap;
  }
  return Math.max(CLUSTER_BEARING_BIN_DEG, 360 - widest);
}

export function clusterContacts(points, opts = {}) {
  const {
    rangeToleranceM = 0.4,
    bearingToleranceDeg = PING_BEAM_DEG,
    minWeight = 3,
    maxClusters = 6,
    wideSpanDeg = 120, // past this it is a surface around you, not an object
  } = opts;
  if (!points || points.length === 0) return [];

  const cells = new Map();
  for (const p of points) {
    if (!Number.isFinite(p.bearing) || !Number.isFinite(p.range)) continue;
    const bearing = ((p.bearing % 360) + 360) % 360;
    const bb = Math.floor(bearing / CLUSTER_BEARING_BIN_DEG);
    const rb = Math.floor(p.range / rangeToleranceM);
    const key = `${bb}:${rb}`;
    let c = cells.get(key);
    if (!c) {
      c = { bb, rb, n: 0, confSum: 0, minR: Infinity, minBearing: bearing };
      cells.set(key, c);
    }
    c.n += 1;
    c.confSum += p.conf || 0;
    if (p.range < c.minR) { c.minR = p.range; c.minBearing = bearing; }
  }

  const list = [...cells.values()];
  // Wrapped bin distance, so an object sitting across the 0/360 seam is one
  // object and not two.
  const adjacent = (a, b) => {
    if (Math.abs(a.rb - b.rb) > 1) return false;
    const deg = Math.abs((((a.bb - b.bb) * CLUSTER_BEARING_BIN_DEG + 540) % 360) - 180);
    return deg <= bearingToleranceDeg;
  };

  const seen = new Array(list.length).fill(false);
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    if (seen[i]) continue;
    seen[i] = true;
    const stack = [i];
    const members = [];
    let n = 0, confSum = 0, minR = Infinity;
    const bins = new Set();
    while (stack.length) {
      const j = stack.pop();
      const c = list[j];
      members.push(c);
      n += c.n; confSum += c.confSum;
      bins.add(c.bb);
      if (c.minR < minR) minR = c.minR;
      for (let k = 0; k < list.length; k += 1) {
        if (!seen[k] && adjacent(c, list[k])) { seen[k] = true; stack.push(k); }
      }
    }
    if (n < minWeight) continue;
    // Bearing is the circular mean over the cells AT the closest range, not the
    // single nearest sample. Across a compact object the range is effectively
    // flat, so picking one minimum is a coin toss between ties and lands on
    // whichever edge of the smear got binned first; averaging the tied cells
    // recovers the centre. On a wall only the near cells qualify, so it still
    // reports where the surface actually comes closest.
    let sinSum = 0, cosSum = 0, w = 0;
    for (const c of members) {
      if (c.minR > minR + rangeToleranceM) continue;
      const rad = (c.minBearing * Math.PI) / 180;
      sinSum += Math.sin(rad) * c.n;
      cosSum += Math.cos(rad) * c.n;
      w += c.n;
    }
    const span = bearingSpan(bins);
    // A surface wrapping this much of the compass has no single bearing to
    // report, and averaging one out of it is worse than admitting so: a tank
    // has near walls at opposite bearings, whose circular mean cancels to a
    // direction with nothing in it. The closest RANGE stays meaningful — it is
    // the thing you must not hit — so only the bearing is withheld.
    const bearing = (w && span <= wideSpanDeg)
      ? ((Math.atan2(sinSum, cosSum) * 180) / Math.PI + 360) % 360
      : null;
    out.push({ range: minR, bearing, span, count: n, conf: confSum / n });
  }

  out.sort((a, b) => a.range - b.range);
  return out.slice(0, maxClusters);
}

/* POV tunnel: range -> ring radius in px, for the head-on submarine view.
 *
 * Perspective, not linear: a ring right at the transducer fills the frame and
 * rings crowd together as they recede toward a vanishing point at maxRange.
 * PERSPECTIVE_K sets how hard the falloff bites — higher pushes more of the
 * range scale into the near field, which is where the detail matters, since
 * that is where the sonar brake is deciding things.
 */
const PERSPECTIVE_K = 3;

export function povRingRadius(rangeM, maxRangeM, viewSize) {
  if (!Number.isFinite(rangeM) || !(maxRangeM > 0) || !(viewSize > 0)) return null;
  if (rangeM < 0 || rangeM > maxRangeM) return null;
  const t = rangeM / maxRangeM;
  return ((viewSize / 2) * (1 - t)) / (1 + PERSPECTIVE_K * t);
}

/* POV blip: how big and how solid to draw a detection in the tunnel.
 *
 * `size` is a FRACTION of the view size, not pixels, so the caller owns the
 * canvas scale (and the tests don't have to know it). Near contacts are drawn
 * large and far ones small, matching the ring perspective, but with a floor so a
 * contact at maximum range is still a visible dot rather than a sub-pixel one.
 * Opacity carries confidence — a weak lock should look weak, not like a
 * confident return.
 */
export function povBlipStyle(rangeM, maxRangeM, confidence) {
  if (!Number.isFinite(rangeM) || !(maxRangeM > 0)) return null;
  if (rangeM < 0 || rangeM > maxRangeM) return null;
  const t = rangeM / maxRangeM;
  const conf = Number.isFinite(confidence) ? Math.max(0, Math.min(100, confidence)) : 0;
  return {
    size: 0.04 + 0.16 * (1 - t) ** 1.5,
    opacity: 0.25 + 0.75 * (conf / 100),
  };
}

/* Every distinct echo in a profile, NEAREST FIRST.
 *
 * The device reports one distance — its own pick, which is the STRONGEST return
 * rather than the closest. For obstacle work those come apart exactly where it
 * matters: a hard flat wall at 3 m out-echoes a soft, small or angled object at
 * 1 m, and the thing at 1 m is the one you are about to hit. The full profile
 * already contains both; only the summary throws one away.
 *
 * A sample counts as a peak when it is a local maximum, sits outside the dead
 * zone, and clears a threshold set RELATIVE to this profile's own maximum —
 * relative because the device retunes its gain between pings, so any fixed
 * amplitude would drift in and out of meaning. `minSeparationM` then suppresses
 * peaks close to an already-accepted stronger one, since a single wall returns
 * as a broad hump several samples wide and would otherwise be reported as a
 * cluster of separate contacts.
 *
 * Returns [{ range, amplitude }] sorted by range ascending, at most `maxEchoes`.
 */
export function findEchoes(profile, scanStartM = 0, scanLengthM = 0, opts = {}) {
  const {
    minRel = 0.35,        // fraction of this profile's peak to count at all
    minAbs = 25,          // absolute floor, so a flat noisy profile yields nothing
    minSeparationM = 0.3, // closer than this to a stronger peak = same object
    maxEchoes = 4,
  } = opts;
  if (!profile || profile.length < 3) return [];

  const rangeAt = (i) => sampleToRange(i, profile.length, scanStartM, scanLengthM);

  let peak = 0;
  for (let i = 0; i < profile.length; i += 1) {
    if (rangeAt(i) < PING_MIN_RANGE_M) continue; // dead-zone ringing dwarfs everything
    if (profile[i] > peak) peak = profile[i];
  }
  if (peak <= 0) return [];
  const threshold = Math.max(minAbs, minRel * peak);

  const candidates = [];
  for (let i = 1; i < profile.length - 1; i += 1) {
    const r = rangeAt(i);
    if (r < PING_MIN_RANGE_M) continue;
    const a = profile[i];
    if (a < threshold) continue;
    // `>=` on the left and `>` on the right so a flat-topped plateau yields its
    // last sample once, rather than either every sample or none of them.
    if (a >= profile[i - 1] && a > profile[i + 1]) candidates.push({ range: r, amplitude: a });
  }

  // Strongest first, so when two peaks are within minSeparationM the one that
  // survives is the more convincing return rather than whichever came first.
  candidates.sort((x, y) => y.amplitude - x.amplitude);
  const kept = [];
  for (const c of candidates) {
    if (kept.length >= maxEchoes) break;
    if (kept.some((k) => Math.abs(k.range - c.range) < minSeparationM)) continue;
    kept.push(c);
  }
  return kept.sort((x, y) => x.range - y.range);
}

/* Peak-amplitude range from a profile, ignoring the dead zone. The device's own
 * `distance` is confidence-gated and often null in air; this is the "brightest
 * thing out there" used to place the cone marker when there is no hard lock. */
export function peakRange(profile, scanStartM = 0, scanLengthM = 0) {
  if (!profile || profile.length === 0) return null;
  let bestIdx = -1;
  let best = -1;
  for (let i = 0; i < profile.length; i += 1) {
    const r = sampleToRange(i, profile.length, scanStartM, scanLengthM);
    if (r < PING_MIN_RANGE_M) continue; // dead-zone ringing is always brightest
    if (profile[i] > best) {
      best = profile[i];
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;
  return sampleToRange(bestIdx, profile.length, scanStartM, scanLengthM);
}
