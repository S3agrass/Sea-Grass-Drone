import time

class PIDController:
    """
    Standard PID with:
    - integral windup clamping
    - optional partial integral reset (for sparse GPS-fix-style corrections)
    - derivative-on-measurement (rate limiter) instead of derivative-on-error,
      which avoids derivative kick on sudden setpoint changes and handles
      noisy discrete sampling better.
    """

    def __init__(self, kp, ki, kd, setpoint=0.0,
                 output_limits=(-1.0, 1.0),
                 integral_limits=(-1.0, 1.0)):
        self.kp = kp
        self.ki = ki
        self.kd = kd
        self.setpoint = setpoint

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
            d_measurement = (measurement - self._prev_measurement) / dt
        else:
            d_measurement = 0.0

        output = (self.kp * error) + (self.ki * self._integral) - (self.kd * d_measurement)
        output = max(self.output_min, min(self.output_max, output))

        self._prev_measurement = measurement
        self._prev_time = current_time

        return output
