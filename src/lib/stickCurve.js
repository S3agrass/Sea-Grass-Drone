/**
 * Stick shaping for analog gamepad input — the JS port of terminal_control.py's
 * stick_curve, kept in step with it so the browser and the terminal client feel
 * identical on the same hardware.
 *
 * Lives outside GamepadControl.jsx so tuning these constants doesn't break React
 * Fast Refresh for the panel you're tuning them from.
 */

// Fraction of stick travel near center that reads as zero, killing drift. Not a
// gate — stickCurve rescales the remaining travel so output starts from 0 right
// at the deadzone edge, which is why this costs no resolution.
//
// Keep it above the controller's real rest drift: enable the panel, centre the
// sticks, and read the live axes[] line in the diagnostic readout. Drift matters
// more than it used to — the server's CREEP_FLOOR turns a leaked axis into real
// thrust rather than a harmless sub-spin buzz.
export const DEADZONE = 0.03;

// 0 = linear, 1 = fully cubic. Bows the middle down so small deflections stay
// gentle while full lock still reaches 100%. This is the "push more = go faster"
// curve, and the ONLY expo in the chain: the server's STEER_EXPO defaults to 0
// so the two don't compose and squash fine steering to nothing.
export const EXPO = 0.6;

/**
 * Deadzone-rescaled expo response. Rescaling means the output ramps from 0 at
 * the deadzone edge instead of jumping to it.
 * @param {number} raw axis value from the Gamepad API, nominally [-1, 1]
 * @returns {number} shaped value in [-1, 1], sign preserved
 */
export function stickCurve(raw) {
  let mag = Math.abs(raw);
  if (mag < DEADZONE) return 0;
  mag = Math.min(1, (mag - DEADZONE) / (1 - DEADZONE));
  mag = (1 - EXPO) * mag + EXPO * mag ** 3;
  return raw >= 0 ? mag : -mag;
}
