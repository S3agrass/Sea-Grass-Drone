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
