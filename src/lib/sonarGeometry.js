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
