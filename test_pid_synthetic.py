import random
from pid_controller import PIDController, wrap_deg

def simulate(kp, ki, kd, steps=200, dt=0.1, disturbance=0.05, gps_fix_every=None):
    pid = PIDController(kp, ki, kd, setpoint=0.0,
                         output_limits=(-1.0, 1.0),
                         integral_limits=(-2.0, 2.0))

    # Fake plant: current state drifts due to "current," corrected by PID output
    state = 5.0  # start way off target (e.g. 5 degrees off heading)
    t = 0.0

    print(f"{'t':>6} {'state':>8} {'output':>8}")
    for i in range(steps):
        output = pid.update(state, current_time=t)

        # Simulate physical response: output nudges state back,
        # random disturbance (current/wave) pushes it around
        state += output * 0.5 * dt * 10  # rough plant response gain
        state += random.uniform(-disturbance, disturbance)

        if gps_fix_every and i % gps_fix_every == 0 and i > 0:
            pid.partial_integral_reset(fraction=0.5)
            print(f"  -- GPS fix at step {i}, partial integral reset --")

        if i % 10 == 0:
            print(f"{t:6.1f} {state:8.3f} {output:8.3f}")

        t += dt

    print(f"\nFinal state: {state:.4f} (target: 0.0)")

# --------------------------------------------------------------------------
# Angular (heading) checks.
#
# Heading-hold on ch4 is the first closed loop this vehicle can actually fly:
# with two forward-facing thrusters, differential thrust steers and nothing
# controls depth. These checks are self-verifying — they print and then assert,
# so a regression fails loudly instead of needing someone to eyeball a table.
# --------------------------------------------------------------------------

FAILURES = []


def check(name, condition, detail=""):
    print(f"  [{'PASS' if condition else 'FAIL'}] {name}{'  — ' + detail if detail else ''}")
    if not condition:
        FAILURES.append(name)


# Heading gains are much smaller than the generic-plant gains above because the
# error is in DEGREES: kp=0.3 turns a 10 degree error into a saturated full-rate
# command, which is bang-bang control that overshoots and rings. At kp=0.03 a 10
# degree error asks for about a third of full turn rate.
HEADING_GAINS = dict(kp=0.03, ki=0.005, kd=0.02)


def simulate_heading(setpoint, start, steps=200, dt=0.1, rate_gain=30.0):
    """Fake heading plant: output commands a turn rate, heading wraps at 360.

    Returns (headings, outputs) so callers can assert on the whole trajectory
    rather than just the endpoint — turning the *wrong way* still converges.
    """
    pid = PIDController(setpoint=setpoint,
                        output_limits=(-1.0, 1.0), integral_limits=(-2.0, 2.0),
                        angular=True, **HEADING_GAINS)
    heading = start
    headings, outputs = [heading], []
    t = 0.0
    for _ in range(steps):
        out = pid.update(heading, current_time=t)
        heading = (heading + out * rate_gain * dt) % 360.0
        headings.append(heading)
        outputs.append(out)
        t += dt
    return headings, outputs


def test_short_way_round():
    """Setpoint 355, start 5: must correct 10 degrees through north, not 350."""
    print("\n=== Angular test 1: takes the short way round ===")
    headings, _ = simulate_heading(setpoint=355.0, start=5.0)

    final_err = abs(wrap_deg(355.0 - headings[-1]))
    # Total path walked, following the short way at each step. If the controller
    # went the long way round this sums to ~350 instead of ~10.
    path = sum(abs(wrap_deg(b - a)) for a, b in zip(headings, headings[1:]))

    print(f"  start 5.0  ->  final {headings[-1]:.2f}  (target 355.0)")
    print(f"  final error {final_err:.3f} deg, total path walked {path:.1f} deg")
    check("converges to setpoint", final_err < 1.0, f"error {final_err:.3f} deg")
    check("turns the short way", path < 60.0, f"walked {path:.1f} deg, long way is ~350")


def _sweep_pure_derivative(angular):
    """Drive a D-only controller through the 0/360 seam at a constant rate.

    Pure derivative isolates the term under test: with kp=ki=0 the output is
    just -kd * turn-rate, so a steady externally-forced rotation must give a
    FLAT output. Any spike is the wrap bug and nothing else. Gains are small
    enough that the output stays far from its limits, so saturation cannot
    disguise a discontinuity.
    """
    pid = PIDController(kp=0.0, ki=0.0, kd=0.001, setpoint=90.0,
                        output_limits=(-1.0, 1.0), integral_limits=(-2.0, 2.0),
                        angular=angular)
    outputs = []
    for i in range(11):
        heading = (350.0 + 2.0 * i) % 360.0  # 350 -> 010, crossing north mid-run
        outputs.append(pid.update(heading, current_time=i * 0.1))
    # Drop the first two: step 0 has dt=0 and step 1 is the derivative priming
    # sample, so neither reflects steady-state behaviour.
    return outputs, max(abs(b - a) for a, b in zip(outputs[1:], outputs[2:]))


def test_no_derivative_kick_at_seam():
    """An externally forced steady rotation through 0/360 must not spike."""
    print("\n=== Angular test 2: no derivative kick crossing north ===")
    outputs, worst = _sweep_pure_derivative(angular=True)
    print(f"  angular=True  outputs: {', '.join(f'{o:.4f}' for o in outputs)}")
    print(f"  largest step-to-step change: {worst:.6f}")
    check("no output discontinuity at the seam", worst < 1e-9, f"worst jump {worst:.6f}")

    # Negative control: the same sweep on the unwrapped path must blow up, which
    # proves this test can actually detect the bug rather than passing vacuously.
    _, worst_linear = _sweep_pure_derivative(angular=False)
    print(f"  angular=False largest step-to-step change: {worst_linear:.4f} (expected: large)")
    check("test detects the bug when wrapping is off", worst_linear > 1.0,
          f"unwrapped jump {worst_linear:.4f}")


def test_linear_path_unchanged():
    """angular=True must be identical to angular=False away from the seam.

    This is the regression guard: it proves the wrap is a no-op whenever the
    error is already within +/-180, so the altitude-hold demo that shares this
    class cannot have changed behaviour.
    """
    print("\n=== Angular test 3: default/linear path untouched ===")
    lin = PIDController(kp=0.3, ki=0.05, kd=0.1, setpoint=100.0)
    ang = PIDController(kp=0.3, ki=0.05, kd=0.1, setpoint=100.0, angular=True)
    identical = True
    for i in range(50):
        m = 100.0 + 30.0 * (i % 7) / 6.0 - 15.0  # stays well within +/-180
        if lin.update(m, current_time=i * 0.1) != ang.update(m, current_time=i * 0.1):
            identical = False
            break
    check("angular matches linear when no wrap is needed", identical)

    # And the wrap helper itself, including both seam directions.
    cases = [(0.0, 0.0), (10.0, 10.0), (-10.0, -10.0), (350.0, -10.0),
             (-350.0, 10.0), (370.0, 10.0), (540.0, -180.0)]
    ok = all(abs(wrap_deg(raw) - want) < 1e-9 for raw, want in cases)
    check("wrap_deg maps onto [-180, +180)", ok)


if __name__ == '__main__':
    random.seed(20260726)  # deterministic disturbance, so runs are comparable

    print("=== Test 1: no GPS correction ===")
    simulate(kp=0.3, ki=0.05, kd=0.1, gps_fix_every=None)

    print("\n=== Test 2: with periodic GPS-fix integral reset ===")
    simulate(kp=0.3, ki=0.05, kd=0.1, gps_fix_every=30)

    test_short_way_round()
    test_no_derivative_kick_at_seam()
    test_linear_path_unchanged()

    print()
    if FAILURES:
        raise SystemExit(f"FAILED: {', '.join(FAILURES)}")
    print("All angular checks passed.")
