export default function DepthMeter({ depth = 0, maxDepth = 200 }) {
  const pct = Math.min(depth / maxDepth, 1);
  const zones = [
    { label: 'SURFACE', limit: 0.1, color: '#4fc3f7' },
    { label: 'SHALLOW', limit: 0.35, color: '#0288d1' },
    { label: 'MID', limit: 0.65, color: '#01579b' },
    { label: 'DEEP', limit: 1, color: '#0a2a4a' },
  ];
  const zone = zones.find((z) => pct <= z.limit) || zones[zones.length - 1];

  const trackH = 220;
  const fillH = pct * trackH;

  return (
    <div className="depth-meter">
      <div className="depth-label">DEPTH</div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        {/* Vertical bar */}
        <div style={{ position: 'relative', width: 28, height: trackH, background: '#0a1e35', borderRadius: 6, border: '1px solid #1e3a5f', overflow: 'hidden' }}>
          <div style={{
            position: 'absolute', bottom: 0, width: '100%', height: fillH,
            background: `linear-gradient(to top, ${zone.color}99, ${zone.color}dd)`,
            transition: 'height 0.4s ease',
            borderRadius: '0 0 5px 5px',
          }} />
          {/* Tick marks */}
          {[0, 25, 50, 75, 100, 125, 150, 175, 200].map((m) => {
            const y = trackH - (m / maxDepth) * trackH;
            return (
              <div key={m} style={{
                position: 'absolute', top: y, left: 0, width: '40%',
                height: 1, background: '#1e3a5f',
              }} />
            );
          })}
        </div>
        {/* Scale labels */}
        <div style={{ position: 'relative', height: trackH, width: 30 }}>
          {[0, 50, 100, 150, 200].map((m) => {
            const y = trackH - (m / maxDepth) * trackH;
            return (
              <div key={m} style={{
                position: 'absolute', top: y - 6,
                fontSize: 9, color: '#4a7fa5', fontFamily: 'monospace',
              }}>{m}m</div>
            );
          })}
        </div>
      </div>
      <div className="depth-value" style={{ color: zone.color }}>{depth.toFixed(1)} m</div>
      <div className="depth-zone" style={{ color: zone.color, fontSize: 10, opacity: 0.8 }}>{zone.label}</div>
    </div>
  );
}
