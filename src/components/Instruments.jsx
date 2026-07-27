/* Instrument cluster — compass, depth, battery, speed. Values may be null
   (no telemetry yet); every instrument renders a calm "—" state. */

function fmt(v, digits = 1) {
  return v == null ? "—" : Number(v).toFixed(digits);
}

export function Compass({ heading }) {
  const h = heading ?? 0;
  const ticks = Array.from({ length: 24 }, (_, i) => i * 15);
  return (
    <div className="inst">
      <div className="eyebrow">Heading</div>
      <div className="compass">
        <svg viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="54" fill="none" stroke="var(--line)" strokeWidth="1.5" />
          <g style={{ transform: `rotate(${-h}deg)`, transformOrigin: "60px 60px", transition: "transform 0.4s ease" }}>
            {ticks.map((t) => (
              <line
                key={t}
                x1="60" y1="8" x2="60" y2={t % 90 === 0 ? 18 : 13}
                stroke={t === 0 ? "var(--teal)" : "var(--faint)"}
                strokeWidth={t % 90 === 0 ? 2 : 1}
                transform={`rotate(${t} 60 60)`}
              />
            ))}
            <text x="60" y="30" textAnchor="middle" fill="var(--teal)" fontSize="11" fontFamily="var(--font-mono)" fontWeight="700">N</text>
            <text x="93" y="64" textAnchor="middle" fill="var(--muted)" fontSize="9" fontFamily="var(--font-mono)">E</text>
            <text x="60" y="97" textAnchor="middle" fill="var(--muted)" fontSize="9" fontFamily="var(--font-mono)">S</text>
            <text x="27" y="64" textAnchor="middle" fill="var(--muted)" fontSize="9" fontFamily="var(--font-mono)">W</text>
          </g>
          {/* fixed vessel needle */}
          <path d="M60 34 L66 66 L60 60 L54 66 Z" fill="var(--teal)" />
        </svg>
        <div className="compass-readout mono">
          {heading == null ? "—" : `${Math.round(((h % 360) + 360) % 360)}°`}
        </div>
      </div>
    </div>
  );
}

export function DepthMeter({ depth, maxDepth = 10 }) {
  const pct = depth == null ? 0 : Math.min(100, (depth / maxDepth) * 100);
  return (
    <div className="inst">
      <div className="eyebrow">Depth</div>
      <div className="depth">
        <div className="depth-column">
          <div className="depth-fill" style={{ height: `${pct}%` }} />
          <div className="depth-marker" style={{ top: `calc(${pct}% - 1px)` }} />
        </div>
        <div className="depth-readout">
          <span className="inst-value mono">{fmt(depth)}</span>
          <span className="inst-unit mono">m</span>
        </div>
      </div>
    </div>
  );
}

export function BatteryMeter({ level }) {
  const pct = level == null ? 0 : Math.max(0, Math.min(100, level));
  const tone = level == null ? "var(--faint)" : pct > 40 ? "var(--teal)" : pct > 20 ? "var(--amber)" : "var(--red)";
  return (
    <div className="inst">
      <div className="eyebrow">Battery</div>
      <div className="battery">
        <div className="battery-shell">
          <div className="battery-fill" style={{ width: `${pct}%`, background: tone }} />
        </div>
        <span className="inst-value mono" style={{ color: tone }}>
          {level == null ? "—" : `${Math.round(pct)}%`}
        </span>
      </div>
    </div>
  );
}

// Lock quality drives the whole gauge: the server only publishes distance_m when
// echoes pass its confidence gate, so "NO LOCK" (in air / too close / reverb)
// shows a calm "—" instead of a confident-looking noise reading.
const SONAR_QUALITY = {
  good: { label: "LOCK", tone: "var(--teal)" },
  weak: { label: "WEAK", tone: "var(--amber)" },
  none: { label: "NO LOCK", tone: "var(--red)" },
};

export function SonarGauge({ distance, raw, confidence, quality = "none", ok = false, maxRange = 30 }) {
  const q = SONAR_QUALITY[ok ? quality : "none"] || SONAR_QUALITY.none;
  const locked = ok && distance != null && quality !== "none";
  const rangePct = locked ? Math.min(100, (distance / maxRange) * 100) : 0;
  const confPct = confidence == null ? 0 : Math.max(0, Math.min(100, confidence));

  return (
    <div className="inst">
      <div className="eyebrow">
        Sonar
        <span
          className="sonar-quality mono"
          style={{ color: ok ? q.tone : "var(--faint)", borderColor: ok ? q.tone : "var(--faint)" }}
        >
          {ok ? q.label : "OFF"}
        </span>
      </div>
      <div className="sonar">
        <div className="sonar-readout">
          <span className="inst-value mono" style={{ color: locked ? q.tone : undefined }}>
            {locked ? fmt(distance, 2) : "—"}
          </span>
          <span className="inst-unit mono">m</span>
        </div>
        <div className="sonar-range-track" title={`0–${maxRange} m range`}>
          <div className="sonar-range-fill" style={{ width: `${rangePct}%` }} />
        </div>
        <div className="sonar-conf">
          <span className="sonar-conf-label mono">conf</span>
          <div className="sonar-conf-track">
            <div
              className="sonar-conf-fill"
              style={{ width: `${confPct}%`, background: q.tone }}
            />
          </div>
          <span className="sonar-conf-value mono" style={{ color: q.tone }}>
            {ok && confidence != null ? `${Math.round(confPct)}%` : "—"}
          </span>
        </div>
        {ok && raw != null && (
          <div className="sonar-raw mono">
            raw {fmt(raw, 1)} m — unfiltered echo
          </div>
        )}
      </div>
    </div>
  );
}

export function SpeedGauge({ speed, max = 5 }) {
  const pct = speed == null ? 0 : Math.min(100, (speed / max) * 100);
  return (
    <div className="inst">
      <div className="eyebrow">Speed</div>
      <div className="speed">
        <span className="inst-value mono">{fmt(speed)}</span>
        <span className="inst-unit mono">kn</span>
      </div>
      <div className="speed-track">
        <div className="speed-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// Barometric altitude (meters). Real even with no external sensors — the
// Pixhawk's onboard baro provides it. Baro alt drifts and can be negative, so
// this shows a signed readout rather than a fixed-range bar.
export function AltitudeMeter({ altitude }) {
  return (
    <div className="inst">
      <div className="eyebrow">Altitude</div>
      <div className="alt">
        <span className="inst-value mono">{fmt(altitude, 2)}</span>
        <span className="inst-unit mono">m</span>
      </div>
    </div>
  );
}

// Vertical speed (m/s), signed. Teal when rising, amber when falling.
export function ClimbGauge({ climb, max = 2 }) {
  const tone = climb == null ? "var(--faint)" : climb >= 0 ? "var(--teal)" : "var(--amber)";
  // Center-zero bar: fill grows from the midline up (rising) or down (falling).
  const pct = climb == null ? 0 : Math.min(100, (Math.abs(climb) / max) * 100);
  return (
    <div className="inst">
      <div className="eyebrow">Climb</div>
      <div className="climb">
        <span className="inst-value mono" style={{ color: tone }}>
          {climb == null ? "—" : `${climb >= 0 ? "▲" : "▼"} ${Math.abs(climb).toFixed(2)}`}
        </span>
        <span className="inst-unit mono">m/s</span>
      </div>
      <div className="climb-track">
        <div className="climb-mid" />
        <div
          className="climb-fill"
          style={{
            width: `${pct / 2}%`,
            background: tone,
            left: climb >= 0 ? "50%" : `${50 - pct / 2}%`,
          }}
        />
      </div>
    </div>
  );
}

// EKF-fused attitude, in degrees (the server converts from MAVLink radians).
// Artificial horizon: the horizon line counter-rotates with roll and slides with
// pitch, so the fixed centre mark reads like a real attitude indicator. Roll and
// pitch are signed; yaw is 0–360.
export function AttitudeIndicator({ roll, pitch, yaw }) {
  const r = roll ?? 0;
  const p = pitch ?? 0;
  // 2 px of horizon travel per degree of pitch, clamped so the line stays in view.
  const pitchOffset = Math.max(-40, Math.min(40, p * 2));
  const live = roll != null || pitch != null;
  return (
    <div className="inst">
      <div className="eyebrow">Attitude</div>
      <div className="attitude">
        <div className="attitude-ball">
          <svg viewBox="0 0 120 120">
            {/* circular window the horizon is drawn inside */}
            <defs>
              <clipPath id="att-clip">
                <circle cx="60" cy="60" r="52" />
              </clipPath>
            </defs>
            <g clipPath="url(#att-clip)">
              <g
                style={{
                  transform: `rotate(${-r}deg) translateY(${pitchOffset}px)`,
                  transformOrigin: "60px 60px",
                  transition: "transform 0.25s ease",
                }}
              >
                <rect x="-40" y="-40" width="200" height="100" fill="var(--abyss)" />
                <rect x="-40" y="60" width="200" height="140" fill="rgba(30,143,124,0.28)" />
                <line x1="-40" y1="60" x2="160" y2="60" stroke="var(--teal)" strokeWidth="2" />
                {/* pitch ladder at ±10° and ±20° (2 px per degree) */}
                {[-40, -20, 20, 40].map((dy) => (
                  <line
                    key={dy}
                    x1="45" y1={60 + dy} x2="75" y2={60 + dy}
                    stroke="var(--faint)" strokeWidth="1"
                  />
                ))}
              </g>
            </g>
            <circle cx="60" cy="60" r="52" fill="none" stroke="var(--line)" strokeWidth="1.5" />
            {/* fixed vehicle reference */}
            <path d="M40 60 L54 60 M66 60 L80 60" stroke="var(--amber)" strokeWidth="2" />
            <circle cx="60" cy="60" r="2" fill="var(--amber)" />
          </svg>
        </div>
        <div className="attitude-readout mono">
          <div className="attitude-row">
            <span className="attitude-label">roll</span>
            <span className="attitude-num">{live ? `${fmt(roll, 1)}°` : "—"}</span>
          </div>
          <div className="attitude-row">
            <span className="attitude-label">pitch</span>
            <span className="attitude-num">{live ? `${fmt(pitch, 1)}°` : "—"}</span>
          </div>
          <div className="attitude-row">
            <span className="attitude-label">yaw</span>
            <span className="attitude-num">{yaw == null ? "—" : `${fmt(yaw, 1)}°`}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Altitude-hold PID. Shows the held setpoint vs live measurement, the error,
// and a center-zero output bar (−1…+1). Output is display-only — nothing
// actuates on it. Greyed "OFF" state until the server feeds it altitude.
/* Compass heading hold — the one control loop on this deck that actually steers.
   Three distinct states the operator has to be able to tell apart at a glance:
     OFF     not engaged
     MANUAL  engaged but yielding, because the pilot is on the stick
     HOLD    engaged and actively steering
   MANUAL is the one worth calling out: the hold is still armed and will resume
   the moment the stick centres, which is different from it being off. */
export function HeadingHoldGauge({
  engaged = false,
  suspended = false,
  setpoint,
  heading,
  error,
  output,
  ok = false,
  armed = false,
  onEngage,
  onRelease,
}) {
  const state = !engaged ? "OFF" : suspended ? "MANUAL" : "HOLD";
  const tone =
    state === "HOLD" ? "var(--teal)"
      : state === "MANUAL" ? "var(--amber)"
        : "var(--faint)";
  const outPct = output == null ? 0 : Math.min(100, Math.abs(output) * 100);
  const outTone = !ok ? "var(--faint)" : output >= 0 ? "var(--teal)" : "var(--amber)";

  // The server refuses to engage unless armed, so disable rather than let the
  // operator fire a command that can only come back as a rejection toast.
  const blocked = !engaged && !armed;

  return (
    <div className="inst">
      <div className="eyebrow">
        Heading Hold
        <span className="pid-tag mono" style={{ color: tone, borderColor: tone }}>
          {state}
        </span>
      </div>
      <div className="pid">
        <div className="pid-row mono">
          <span className="pid-label">hold</span>
          <span className="pid-num">{setpoint == null ? "—" : `${fmt(setpoint, 0)}°`}</span>
          <span className="pid-label">now</span>
          <span className="pid-num">{heading == null ? "—" : `${fmt(heading, 0)}°`}</span>
        </div>
        <div className="pid-row mono">
          <span className="pid-label">err</span>
          <span className="pid-num" style={{ color: ok ? "var(--amber)" : undefined }}>
            {error == null ? "—" : `${fmt(error, 1)}°`}
          </span>
          <span className="pid-label">steer</span>
          <span className="pid-num" style={{ color: outTone }}>{fmt(output, 2)}</span>
        </div>
        <div className="pid-track" title="steering command −1…+1">
          <div className="pid-mid" />
          <div
            className="pid-fill"
            style={{
              width: `${outPct / 2}%`,
              background: outTone,
              left: (output ?? 0) >= 0 ? "50%" : `${50 - outPct / 2}%`,
            }}
          />
        </div>
        <button
          className={`btn${engaged ? "" : " btn-primary"}`}
          style={{ width: "100%", padding: "7px 8px", fontSize: 12 }}
          disabled={blocked}
          title={
            blocked
              ? "Arm the vehicle first — the server refuses to hold a heading while disarmed"
              : engaged
                ? "Stop holding and return steering to manual"
                : "Hold the heading the vehicle is pointing at right now"
          }
          onClick={engaged ? onRelease : onEngage}
        >
          {engaged ? "Release" : "Hold this heading"}
        </button>
      </div>
    </div>
  );
}

export function PIDGauge({ setpoint, measurement, error, output, ok = false }) {
  const tone = !ok ? "var(--faint)" : "var(--teal)";
  // Output bar is centered at 0; fill extends right for +output, left for −.
  const outPct = output == null ? 0 : Math.min(100, Math.abs(output) * 100);
  const outTone = !ok ? "var(--faint)" : output >= 0 ? "var(--teal)" : "var(--amber)";
  return (
    <div className="inst">
      <div className="eyebrow">
        Alt-Hold PID
        <span
          className="pid-tag mono"
          style={{ color: tone, borderColor: tone }}
        >
          {ok ? "LIVE" : "OFF"}
        </span>
      </div>
      <div className="pid">
        <div className="pid-row mono">
          <span className="pid-label">set</span>
          <span className="pid-num">{fmt(setpoint, 2)}</span>
          <span className="pid-label">meas</span>
          <span className="pid-num">{fmt(measurement, 2)}</span>
        </div>
        <div className="pid-row mono">
          <span className="pid-label">err</span>
          <span className="pid-num" style={{ color: ok ? "var(--amber)" : undefined }}>
            {fmt(error, 3)}
          </span>
          <span className="pid-label">out</span>
          <span className="pid-num" style={{ color: outTone }}>{fmt(output, 3)}</span>
        </div>
        <div className="pid-track" title="controller output −1…+1">
          <div className="pid-mid" />
          <div
            className="pid-fill"
            style={{
              width: `${outPct / 2}%`,
              background: outTone,
              left: (output ?? 0) >= 0 ? "50%" : `${50 - outPct / 2}%`,
            }}
          />
        </div>
      </div>
    </div>
  );
}
