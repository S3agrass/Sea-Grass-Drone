export default function BatteryMeter({ level = 85, charging = false }) {
  const color = level > 50 ? '#69f0ae' : level > 20 ? '#ffca28' : '#ef5350';
  const pct = Math.min(Math.max(level, 0), 100);

  return (
    <div className="battery-meter">
      <div className="depth-label">BATTERY</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Battery body */}
        <div style={{ position: 'relative', width: 52, height: 24, border: `2px solid ${color}`, borderRadius: 4 }}>
          {/* Terminal nub */}
          <div style={{
            position: 'absolute', right: -6, top: '50%', transform: 'translateY(-50%)',
            width: 4, height: 10, background: color, borderRadius: '0 2px 2px 0',
          }} />
          {/* Fill */}
          <div style={{
            position: 'absolute', left: 2, top: 2, bottom: 2,
            width: `calc(${pct}% - 4px)`,
            background: `${color}cc`,
            borderRadius: 2,
            transition: 'width 0.5s ease',
          }} />
          {/* Percentage text */}
          <div style={{
            position: 'absolute', inset: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            fontSize: 9, fontFamily: 'monospace', fontWeight: 'bold',
            color: '#fff', zIndex: 1, textShadow: '0 0 4px #000',
          }}>{pct}%</div>
        </div>
        <div style={{ fontSize: 10, fontFamily: 'monospace', color }}>
          {charging ? '⚡ CHG' : pct > 20 ? 'OK' : 'LOW'}
        </div>
      </div>
      {/* Voltage estimate */}
      <div style={{ fontSize: 9, fontFamily: 'monospace', color: '#4a7fa5', marginTop: 3 }}>
        {(14.4 * (pct / 100) + 10.8).toFixed(1)} V
      </div>
    </div>
  );
}
