import time


def wrap_deg(delta):
    """Wrap an angle difference into [-180, +180) degrees.

    Turning 358 degrees one way is really 2 degrees the other, and a controller
    that doesn't know that will drive the vehicle the long way round.
    """
    return (delta + 180.0) % 360.0 - 180.0


class PIDController:
    """
    Standard PID with:
    - integral windup clamping
    - optional partial integral reset (for sparse GPS-fix-style corrections)
    - derivative-on-measurement (rate limiter) instead of derivative-on-error,
      which avoids derivative kick on sudden setpoint changes and handles
      noisy discrete sampling better.
    - optional angular mode for headings, which wrap at 0/360.
    """

    def __init__(self, kp, ki, kd, setpoint=0.0,
                 output_limits=(-1.0, 1.0),
                 integral_limits=(-1.0, 1.0),
                 angular=False):
        self.kp = kp
        self.ki = ki
        self.kd = kd
        self.setpoint = setpoint
        # Angular mode treats measurement/setpoint as degrees on a circle.
        # Off by default so existing linear users (the altitude-hold demo in
        # server/drone_server.py) are bit-for-bit unaffected.
        self.angular = angular

        self.output_min, self.output_max = output_limits
        self.integral_min, self.integral_max = integral_limits

        self._integral = 0.0
        self._prev_measurement = None
        self._prev_time = None

    def reset(self):
        """Full reset — e.g. after arming or a mode switch."""
        self._integral = 0.0
        self._prev_measurement = None
        self._prev_time = None

    def partial_integral_reset(self, fraction=0.5):
        """
        Bleed off some accumulated integral windup.
        Call this at each GPS fix, per your own architecture notes,
        rather than fully zeroing it (which would cause a jerky response).
        """
        self._integral *= (1.0 - fraction)

    def update(self, measurement, current_time=None):
        if current_time is None:
            current_time = time.time()

        error = self.setpoint - measurement
        if self.angular:
            # Hold 359 while pointing at 1 and the raw subtraction says -358,
            # which would spin the vehicle the long way round for a 2 degree
            # correction. Wrapping makes it take the short way.
            error = wrap_deg(error)

        if self._prev_time is None:
            dt = 0.0
        else:
            dt = current_time - self._prev_time

        # --- Integral term (with clamping to prevent windup) ---
        if dt > 0:
            self._integral += error * dt
            self._integral = max(self.integral_min, min(self.integral_max, self._integral))

        # --- Derivative term: derivative-on-measurement, not on error ---
        if dt > 0 and self._prev_measurement is not None:
            delta = measurement - self._prev_measurement
            if self.angular:
                # This matters more than the error wrap above. Rotating steadily
                # through north makes the raw delta jump ~360, which reads as a
                # huge rate and kicks the output hard — precisely when the
                # vehicle is tracking correctly.
                delta = wrap_deg(delta)
            d_measurement = delta / dt
        else:
            d_measurement = 0.0

        output = (self.kp * error) + (self.ki * self._integral) - (self.kd * d_measurement)
        output = max(self.output_min, min(self.output_max, output))

        self._prev_measurement = measurement
        self._prev_time = current_time

        return output
