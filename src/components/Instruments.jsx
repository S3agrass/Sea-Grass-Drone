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

// Confidence colour: the Ping2 reports how much it trusts each echo. In air it
// sits near 0% (noise), so low confidence self-documents as untrustworthy.
function confTone(conf) {
  if (conf == null) return "var(--faint)";
  if (conf >= 50) return "var(--teal)";
  if (conf >= 20) return "var(--amber)";
  return "var(--red)";
}

export function SonarGauge({ distance, confidence, ok = false, maxRange = 30 }) {
  const live = ok && distance != null;
  // Range bar: how far the echo is across the sonar's usable window.
  const rangePct = live ? Math.min(100, (distance / maxRange) * 100) : 0;
  const confPct = confidence == null ? 0 : Math.max(0, Math.min(100, confidence));
  const tone = confTone(live ? confidence : null);

  return (
    <div className="inst">
      <div className="eyebrow">Sonar</div>
      <div className="sonar">
        <div className="sonar-readout">
          <span className="inst-value mono" style={{ color: live ? tone : undefined }}>
            {live ? fmt(distance, 2) : "—"}
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
              style={{ width: `${confPct}%`, background: tone }}
            />
          </div>
          <span className="sonar-conf-value mono" style={{ color: tone }}>
            {live && confidence != null ? `${Math.round(confPct)}%` : "—"}
          </span>
        </div>
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
