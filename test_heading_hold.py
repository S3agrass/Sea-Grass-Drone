"""Safety-gate tests for heading hold — the first code that steers by itself.

Runs with no Pixhawk, no motors and no water: it drives drone_server's module
state directly. The point is to prove every RELEASE path works before any thrust
is behind them, because a hold that ignores disarm or soft-stop is far worse
than no hold at all.

    python3 test_heading_hold.py
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "server"))

# drone_server refuses to import without a token. Nothing here opens a socket,
# so a placeholder is enough and keeps the real one out of the test.
os.environ.setdefault("SEAGRASS_TOKEN", "test-token-not-used")

import drone_server as ds  # noqa: E402

FAILURES = []


def check(name, condition, detail=""):
    print(f"  [{'PASS' if condition else 'FAIL'}] {name}{'  — ' + detail if detail else ''}")
    if not condition:
        FAILURES.append(name)


def fresh_state(armed=True, yaw=90.0, latched=False, pixhawk=True):
    """Put the module into a known pre-engage state."""
    ds.disengage_heading_hold()
    ds.armed = armed
    ds.motion_latched = latched
    ds.pixhawk_ok = pixhawk
    ds.pressed.clear()
    for k in ds.axis_targets:
        ds.axis_targets[k] = 0.0
    ds.heading_last_yaw = yaw
    ds.heading_last_yaw_at = time.time()


def test_refuses_without_preconditions():
    print("\n=== Refuses to engage unless it is safe ===")
    fresh_state(armed=False)
    ok, why = ds.engage_heading_hold()
    check("refuses when disarmed", not ok, why)

    fresh_state(armed=True, latched=True)
    ok, why = ds.engage_heading_hold()
    check("refuses when soft stop is latched", not ok, why)

    fresh_state(armed=True)
    ds.heading_last_yaw = None
    ok, why = ds.engage_heading_hold()
    check("refuses with no compass reading", not ok, why)

    fresh_state(armed=True)
    ds.heading_last_yaw_at = time.time() - (ds.HEADING_STALE_S + 1.0)
    ok, why = ds.engage_heading_hold()
    check("refuses on a stale compass reading", not ok, why)

    fresh_state(armed=True, yaw=123.4)
    ok, why = ds.engage_heading_hold()
    check("engages when armed with fresh yaw", ok, why)
    check("captures current heading as setpoint",
          ds.heading_setpoint == 123.4, f"setpoint={ds.heading_setpoint}")


def test_release_paths():
    print("\n=== Every release path lets go ===")
    for label, break_it in [
        ("disarm", lambda: setattr(ds, "armed", False)),
        ("soft stop latched", lambda: setattr(ds, "motion_latched", True)),
        ("Pixhawk link lost", lambda: setattr(ds, "pixhawk_ok", False)),
    ]:
        fresh_state()
        ds.engage_heading_hold()
        break_it()
        ds.step_heading_hold(95.0)  # next telemetry sample re-checks the gates
        check(f"releases on {label}", not ds.heading_hold_engaged)

    # all_stop() is the funnel every stop path in the server goes through.
    fresh_state()
    ds.engage_heading_hold()
    ds.all_stop()
    check("releases on all_stop()", not ds.heading_hold_engaged)


def test_manual_override_wins():
    print("\n=== Manual steering always wins ===")
    fresh_state(yaw=90.0)
    ds.engage_heading_hold()
    ds.step_heading_hold(80.0)  # 10 deg off — the hold should be correcting
    corrected = ds.heading_output
    check("corrects when off-course", abs(corrected) > 0.0, f"output={corrected:.3f}")

    ds.axis_targets["steer"] = 0.9  # operator grabs the stick
    ds.step_heading_hold(70.0)
    check("suspends under manual steering", ds.heading_hold_suspended)
    check("commands nothing while suspended", ds.heading_output == 0.0)
    check("stays engaged while suspended", ds.heading_hold_engaged)

    ds.axis_targets["steer"] = 0.0  # released, now pointing at 70
    ds.step_heading_hold(70.0)
    check("resumes when stick is centred", not ds.heading_hold_suspended)
    check("adopts the new bearing the pilot steered onto",
          ds.heading_setpoint == 70.0, f"setpoint={ds.heading_setpoint}")


def test_steers_the_short_way():
    print("\n=== Steers the short way across the 0/360 seam ===")
    fresh_state(yaw=355.0)
    ds.engage_heading_hold()          # holding 355
    ds.step_heading_hold(5.0)         # drifted to 5 — 10 deg away, not 350
    # Setpoint is behind us in decreasing-heading terms, so the correction must
    # be negative (turn back down through north), not a huge positive spin.
    check("corrects the short way", ds.heading_output < 0.0,
          f"output={ds.heading_output:.3f}")
    check("correction is proportionate, not saturated",
          abs(ds.heading_output) < 1.0, f"|output|={abs(ds.heading_output):.3f}")


def test_only_injects_when_it_should():
    print("\n=== Only injects steering when engaged and unsuspended ===")

    def steer_pwm_after_ticks(n=40):
        ds.surge_pwm = ds.steer_pwm = ds.depth_pwm = ds.NEUTRAL_PWM
        for _ in range(n):
            ds.channel_frame(1.0 / ds.CONTROL_HZ)
        return ds.steer_pwm

    fresh_state()
    idle = steer_pwm_after_ticks()
    check("neutral steering when hold is off", abs(idle - ds.NEUTRAL_PWM) < 1.0,
          f"ch4 pwm={idle:.1f}")

    fresh_state(yaw=90.0)
    ds.engage_heading_hold()
    ds.step_heading_hold(60.0)  # well off course, so it should command a turn
    driven = steer_pwm_after_ticks()
    check("drives steering when hold is on", abs(driven - ds.NEUTRAL_PWM) > 1.0,
          f"ch4 pwm={driven:.1f}")

    ds.axis_targets["steer"] = 0.0
    ds.disengage_heading_hold()
    after = steer_pwm_after_ticks()
    check("returns to neutral after disengage", abs(after - ds.NEUTRAL_PWM) < 1.0,
          f"ch4 pwm={after:.1f}")


def test_hold_watchdog_outlives_the_client_keepalive():
    """The autonomous watchdog must be longer than the client's ping interval.

    Regression guard for a real failure: the hold reused WATCHDOG_S (1.5s), which
    is safe for manual control only because a held stick streams input constantly.
    With heading hold there is no input at all — DroneLink's 5s keepalive ping is
    the ONLY thing refreshing last_seen — so the watchdog fired within 1.5s of
    every engage and the hold released itself immediately.

    The 5.0 below mirrors `_keepAlive` in src/lib/droneLink.js. If that interval
    ever changes, this test is the thing that should fail.
    """
    print("\n=== Autonomous watchdog outlives the client keepalive ===")
    client_keepalive_s = 5.0
    check("hold watchdog exceeds the keepalive interval",
          ds.HOLD_WATCHDOG_S > client_keepalive_s,
          f"HOLD_WATCHDOG_S={ds.HOLD_WATCHDOG_S}, keepalive={client_keepalive_s}")
    check("hold watchdog tolerates a lost ping",
          ds.HOLD_WATCHDOG_S > 2 * client_keepalive_s,
          f"HOLD_WATCHDOG_S={ds.HOLD_WATCHDOG_S}")
    check("manual watchdog left untouched", ds.WATCHDOG_S == 1.5,
          f"WATCHDOG_S={ds.WATCHDOG_S}")


if __name__ == "__main__":
    test_refuses_without_preconditions()
    test_release_paths()
    test_manual_override_wins()
    test_steers_the_short_way()
    test_only_injects_when_it_should()
    test_hold_watchdog_outlives_the_client_keepalive()

    print()
    if FAILURES:
        raise SystemExit(f"FAILED: {', '.join(FAILURES)}")
    print("All heading-hold safety checks passed.")
