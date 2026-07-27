"""Tests for the sonar brake — the code that takes forward thrust away.

Runs with no sonar, no Pixhawk and no water: it writes readings straight into
`sonar.latest` (which the reader replaces wholesale, so a fake one is
indistinguishable from a real one) and drives drone_server's module state.

The point is to pin BOTH directions of the gate. A brake that fails to release
is as dangerous as one that fails to engage: the first strands the vehicle with
no forward authority, the second lets it drive into a wall. Every test below is
one of those two failures.

    python3 test_sonar_brake.py
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


def set_reading(distance_m, confidence=90, age_s=0.0):
    """Publish a fake sonar reading. Mirrors sonar_reader's wholesale replace."""
    ds.sonar.latest = {
        "distance_m": distance_m,
        "raw_m": distance_m,
        "confidence": confidence,
        "quality": "good" if (confidence or 0) >= 50 else "none",
        "ok": True,
        "ts": time.time() - age_s,
        "profile": None,
        "scan_start_m": 0.0,
        "scan_length_m": 10.0,
        "gain": 3,
        "ping_number": 1,
    }


def brake_for(distance_m, confidence=90, age_s=0.0):
    set_reading(distance_m, confidence, age_s)
    ds.step_sonar_brake()
    return ds.sonar_brake


def fresh_state():
    """Neutral sticks, no autonomous steering, motors parked at neutral."""
    ds.disengage_heading_hold()
    ds.pressed.clear()
    for k in ds.axis_targets:
        ds.axis_targets[k] = 0.0
    ds.surge_pwm = ds.steer_pwm = ds.depth_pwm = ds.NEUTRAL_PWM


def test_brake_curve():
    print("\n=== Brake scales with how close the obstacle is ===")
    stop, slow = ds.SONAR_BRAKE_STOP_M, ds.SONAR_BRAKE_SLOW_M

    check("no brake well beyond the slow range", brake_for(slow + 5.0) == 0.0)
    check("no brake exactly at the slow range", brake_for(slow) == 0.0)

    full = brake_for(stop)
    check("full brake at the stop range", full == 1.0, f"brake={full}")
    check("full brake inside the stop range", brake_for(stop / 2.0) == 1.0)

    mid = brake_for((stop + slow) / 2.0)
    check("half brake at the midpoint", abs(mid - 0.5) < 1e-6, f"brake={mid:.3f}")

    # Monotonic: closer must never brake less than further away.
    samples = [(d, brake_for(d)) for d in
               [slow, slow * 0.9, slow * 0.75, (stop + slow) / 2.0, stop * 1.1, stop]]
    monotonic = all(samples[i][1] <= samples[i + 1][1] for i in range(len(samples) - 1))
    check("brake rises monotonically as range closes", monotonic,
          " ".join(f"{d:.2f}m->{b:.2f}" for d, b in samples))


def test_brake_releases_when_it_cannot_see():
    """Every path where the sonar isn't telling us anything trustworthy.

    All of these must RELEASE. A brake latched on by a dead sensor would leave
    the operator with no forward thrust and no explanation — worse than no brake
    at all, since they can still see the obstacle on the camera.
    """
    print("\n=== Releases whenever the reading cannot be trusted ===")
    close = ds.SONAR_BRAKE_STOP_M / 2.0  # close enough to brake if it were valid

    check("releases with no lock (distance_m None)", brake_for(None) == 0.0)
    check("releases below the confidence floor",
          brake_for(close, confidence=ds.SONAR_BRAKE_MIN_CONF - 1) == 0.0)
    check("releases on a stale reading",
          brake_for(close, age_s=ds.SONAR_BRAKE_STALE_S + 1.0) == 0.0)
    check("releases when confidence is missing entirely",
          brake_for(close, confidence=None) == 0.0)

    # Sanity: the same close reading DOES brake when it is trustworthy, so the
    # releases above are the gates firing and not the distance being ignored.
    check("brakes on the same range when the reading is good",
          brake_for(close) == 1.0)


def test_readout_tracks_the_brake():
    print("\n=== Readout reports what the brake is doing ===")
    brake_for(ds.SONAR_BRAKE_SLOW_M + 5.0)
    check("readout idle when not braking",
          ds.brake_readout["braking"] is False and ds.brake_readout["brake"] == 0.0,
          str(ds.brake_readout))

    brake_for(ds.SONAR_BRAKE_STOP_M)
    check("readout active at full brake",
          ds.brake_readout["braking"] is True and ds.brake_readout["brake"] == 1.0,
          str(ds.brake_readout))


def test_channel_frame_brakes_forward_only():
    """End to end through the real PWM path, including the ramp.

    channel_frame() calls step_sonar_brake() itself, so this exercises exactly
    what control_loop() runs at 50 Hz.
    """
    print("\n=== Forward is braked, reverse is never restricted ===")

    def surge_pwm_after_ticks(n=60):
        ds.surge_pwm = ds.steer_pwm = ds.depth_pwm = ds.NEUTRAL_PWM
        for _ in range(n):
            ds.channel_frame(1.0 / ds.CONTROL_HZ)
        return ds.surge_pwm

    # Baseline: full forward with nothing in view must actually drive.
    fresh_state()
    set_reading(None)
    ds.axis_targets["surge"] = 1.0
    clear = surge_pwm_after_ticks()
    check("drives forward when the water is clear",
          abs(clear - ds.NEUTRAL_PWM) > 1.0, f"ch5 pwm={clear:.1f}")

    # Same stick, obstacle inside the stop range: forward must go to neutral.
    fresh_state()
    set_reading(ds.SONAR_BRAKE_STOP_M / 2.0)
    ds.axis_targets["surge"] = 1.0
    blocked = surge_pwm_after_ticks()
    check("forward is cut with an obstacle inside the stop range",
          abs(blocked - ds.NEUTRAL_PWM) < 1.0, f"ch5 pwm={blocked:.1f}")

    # Same obstacle, stick pulled back: backing away must be unaffected. This is
    # the one that matters most — a brake that also blocked reverse would trap
    # the vehicle against whatever it stopped for.
    fresh_state()
    set_reading(ds.SONAR_BRAKE_STOP_M / 2.0)
    ds.axis_targets["surge"] = -1.0
    reversing = surge_pwm_after_ticks()
    check("reverse still works with the same obstacle ahead",
          abs(reversing - ds.NEUTRAL_PWM) > 1.0, f"ch5 pwm={reversing:.1f}")
    check("reverse drives the opposite way from forward",
          (reversing - ds.NEUTRAL_PWM) * (clear - ds.NEUTRAL_PWM) < 0,
          f"forward={clear:.1f} reverse={reversing:.1f}")

    # Partial band: slower than clear water, but still moving.
    fresh_state()
    set_reading((ds.SONAR_BRAKE_STOP_M + ds.SONAR_BRAKE_SLOW_M) / 2.0)
    ds.axis_targets["surge"] = 1.0
    partial = surge_pwm_after_ticks()
    check("partial brake slows forward without stopping it",
          0 < abs(partial - ds.NEUTRAL_PWM) < abs(clear - ds.NEUTRAL_PWM),
          f"clear={clear:.1f} braked={partial:.1f}")

    fresh_state()
    set_reading(None)


def test_brake_does_not_touch_steering():
    """Heading hold must keep its steering authority while the brake is on.

    Stopping is a surge-axis decision; giving up steering at the same time would
    let the vehicle weathercock off its bearing exactly when it is holding
    station in front of something.
    """
    print("\n=== Braking leaves heading hold steering ===")
    fresh_state()
    ds.armed = True
    ds.motion_latched = False
    ds.pixhawk_ok = True
    ds.heading_last_yaw = 90.0
    ds.heading_last_yaw_at = time.time()
    ok, why = ds.engage_heading_hold()
    check("heading hold engaged for the test", ok, why)
    ds.step_heading_hold(60.0)  # 30 deg off course — it should be correcting

    set_reading(ds.SONAR_BRAKE_STOP_M / 2.0)  # full brake
    ds.axis_targets["surge"] = 1.0
    ds.surge_pwm = ds.steer_pwm = ds.depth_pwm = ds.NEUTRAL_PWM
    for _ in range(60):
        ds.channel_frame(1.0 / ds.CONTROL_HZ)

    check("forward cut while braking", abs(ds.surge_pwm - ds.NEUTRAL_PWM) < 1.0,
          f"ch5 pwm={ds.surge_pwm:.1f}")
    check("steering still driven by the hold", abs(ds.steer_pwm - ds.NEUTRAL_PWM) > 1.0,
          f"ch4 pwm={ds.steer_pwm:.1f}")

    ds.disengage_heading_hold()
    fresh_state()
    set_reading(None)


def test_brake_can_be_disabled():
    print("\n=== Kill switch ===")
    original = ds.SONAR_BRAKE
    try:
        ds.SONAR_BRAKE = False
        check("no brake when SEAGRASS_SONAR_BRAKE is off",
              brake_for(ds.SONAR_BRAKE_STOP_M / 2.0) == 0.0)
    finally:
        ds.SONAR_BRAKE = original
    check("brake restored after the kill switch is put back",
          brake_for(ds.SONAR_BRAKE_STOP_M / 2.0) == 1.0)


def test_thresholds_are_sane():
    """Guards against a mis-set env var producing a nonsense band."""
    print("\n=== Configured thresholds are coherent ===")
    check("stop range is inside the slow range",
          ds.SONAR_BRAKE_STOP_M < ds.SONAR_BRAKE_SLOW_M,
          f"stop={ds.SONAR_BRAKE_STOP_M} slow={ds.SONAR_BRAKE_SLOW_M}")
    check("stop range clears the Ping's 0.5 m dead zone",
          ds.SONAR_BRAKE_STOP_M >= 0.5, f"stop={ds.SONAR_BRAKE_STOP_M}")


if __name__ == "__main__":
    test_brake_curve()
    test_brake_releases_when_it_cannot_see()
    test_readout_tracks_the_brake()
    test_channel_frame_brakes_forward_only()
    test_brake_does_not_touch_steering()
    test_brake_can_be_disabled()
    test_thresholds_are_sane()

    print()
    if FAILURES:
        raise SystemExit(f"FAILED: {', '.join(FAILURES)}")
    print("All sonar brake checks passed.")
