export default function Compass({ heading = 0 }) {
  const cardinals = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

  return (
    <div className="compass-wrapper">
      <div className="compass-label">HEADING</div>
      <div className="compass" style={{ position: 'relative', width: 140, height: 140 }}>
        {/* Outer ring with tick marks */}
        <svg width="140" height="140" style={{ position: 'absolute', top: 0, left: 0 }}>
          <circle cx="70" cy="70" r="65" fill="none" stroke="#1e3a5f" strokeWidth="2" />
          <circle cx="70" cy="70" r="58" fill="#0a1e35" stroke="#0d2d4f" strokeWidth="1" />
          {Array.from({ length: 36 }).map((_, i) => {
            const angle = (i * 10 * Math.PI) / 180;
            const isMajor = i % 9 === 0;
            const r1 = isMajor ? 55 : 58;
            const r2 = 63;
            return (
              <line
                key={i}
                x1={70 + r1 * Math.sin(angle)}
                y1={70 - r1 * Math.cos(angle)}
                x2={70 + r2 * Math.sin(angle)}
                y2={70 - r2 * Math.cos(angle)}
                stroke={isMajor ? '#4fc3f7' : '#1e3a5f'}
                strokeWidth={isMajor ? 2 : 1}
              />
            );
          })}
          {/* Cardinal labels */}
          {cardinals.map((c, i) => {
            const angle = (i * 45 * Math.PI) / 180;
            const r = 44;
            const isPrimary = i % 2 === 0;
            return (
              <text
                key={c}
                x={70 + r * Math.sin(angle)}
                y={70 - r * Math.cos(angle) + 4}
                textAnchor="middle"
                fill={isPrimary ? '#4fc3f7' : '#2a6090'}
                fontSize={isPrimary ? 11 : 8}
                fontFamily="monospace"
                fontWeight="bold"
              >
                {c}
              </text>
            );
          })}
          {/* Heading needle */}
          <g transform={`rotate(${heading}, 70, 70)`}>
            <polygon points="70,15 73,70 70,78 67,70" fill="#e53935" opacity="0.9" />
            <polygon points="70,125 73,70 70,62 67,70" fill="#90a4ae" opacity="0.7" />
          </g>
          {/* Center dot */}
          <circle cx="70" cy="70" r="5" fill="#1a3a5c" stroke="#4fc3f7" strokeWidth="1.5" />
        </svg>
      </div>
      <div className="compass-deg">{heading.toFixed(0)}°</div>
    </div>
  );
}
