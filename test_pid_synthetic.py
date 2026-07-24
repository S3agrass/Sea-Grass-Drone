import random
from pid_controller import PIDController

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

if __name__ == '__main__':
    print("=== Test 1: no GPS correction ===")
    simulate(kp=0.3, ki=0.05, kd=0.1, gps_fix_every=None)

    print("\n=== Test 2: with periodic GPS-fix integral reset ===")
    simulate(kp=0.3, ki=0.05, kd=0.1, gps_fix_every=30)
