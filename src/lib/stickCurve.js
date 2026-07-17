/**
 * Stick shaping for analog gamepad input — the JS twin of the gas-pedal curve
 * in keyboard_control.py (_stick_curve) and terminal_control.py (stick_curve),
 * kept in step with both so every control path feels identical on the same
 * hardware. Change a constant here, change it there too.
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
export const DEADZONE = 0.05;

// Gas-pedal response: two linear zones meeting at a knee, instead of one expo
// curve. The creep zone (deadzone edge -> CREEP_ZONE_END of the remaining
// travel) climbs gently to CREEP_ZONE_OUTPUT of full authority; past the knee
// the power zone climbs ~5x steeper to exactly 1.0 at full lock. Easing around
// the top of the stick moves output slowly; pushing past the knee gives clearly
// more power per millimetre — a distinction a single expo curve can't make.
//
// Retune CREEP_ZONE_OUTPUT first: it sets how fast "slow" is. Raise it if the
// whole creep zone feels inert, lower it if inching is already too quick.
// CREEP_ZONE_END trades fine-control travel against power-zone travel.
export const CREEP_ZONE_END = 0.55; // fraction of post-deadzone travel in the creep zone
export const CREEP_ZONE_OUTPUT = 0.2; // authority at the knee (1.0 = full)

/**
 * Deadzone-rescaled two-zone "gas pedal" response. Rescaling means the output
 * ramps from 0 at the deadzone edge instead of jumping to it; the two zones are
 * continuous at the knee and reach exactly 1.0 at full deflection.
 * @param {number} raw axis value from the Gamepad API, nominally [-1, 1]
 * @returns {number} shaped value in [-1, 1], sign preserved
 */
export function stickCurve(raw) {
  let mag = Math.abs(raw);
  if (mag < DEADZONE) return 0;
  mag = Math.min(1, (mag - DEADZONE) / (1 - DEADZONE));
  if (mag <= CREEP_ZONE_END) {
    mag = CREEP_ZONE_OUTPUT * (mag / CREEP_ZONE_END);
  } else {
    mag =
      CREEP_ZONE_OUTPUT +
      ((1 - CREEP_ZONE_OUTPUT) * (mag - CREEP_ZONE_END)) / (1 - CREEP_ZONE_END);
  }
  return raw >= 0 ? mag : -mag;
}
