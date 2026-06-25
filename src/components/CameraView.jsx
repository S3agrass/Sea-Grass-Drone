import { useState, useRef, useEffect } from 'react';

export default function CameraView() {
  const [recording, setRecording] = useState(false);
  const [snapFlash, setSnapFlash] = useState(false);
  const [recTime, setRecTime] = useState(0);
  const [captures, setCaptures] = useState([]);
  const timerRef = useRef(null);

  useEffect(() => {
    if (recording) {
      timerRef.current = setInterval(() => setRecTime((t) => t + 1), 1000);
    } else {
      clearInterval(timerRef.current);
      setRecTime(0);
    }
    return () => clearInterval(timerRef.current);
  }, [recording]);

  function handleSnapshot() {
    setSnapFlash(true);
    setTimeout(() => setSnapFlash(false), 200);
    const ts = new Date().toLocaleTimeString();
    setCaptures((prev) => [`📷 Snapshot @ ${ts}`, ...prev].slice(0, 5));
  }

  function handleRecord() {
    if (!recording) {
      setRecording(true);
    } else {
      const ts = new Date().toLocaleTimeString();
      setCaptures((prev) => [`🎥 Video ${formatTime(recTime)} @ ${ts}`, ...prev].slice(0, 5));
      setRecording(false);
    }
  }

  function formatTime(s) {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  }

  return (
    <div className="camera-panel">
      <div className="panel-title">CAMERA FEED</div>
      {/* Simulated video feed */}
      <div className="camera-feed" style={{ position: 'relative', overflow: 'hidden' }}>
        {snapFlash && (
          <div style={{
            position: 'absolute', inset: 0, background: '#fff',
            opacity: 0.6, zIndex: 10, pointerEvents: 'none',
          }} />
        )}
        {/* Simulated underwater scene */}
        <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0 }}>
          <defs>
            <radialGradient id="uw" cx="50%" cy="60%" r="60%">
              <stop offset="0%" stopColor="#013a63" />
              <stop offset="100%" stopColor="#001220" />
            </radialGradient>
          </defs>
          <rect width="100%" height="100%" fill="url(#uw)" />
          {/* Light rays */}
          {[15, 30, 50, 70, 85].map((x, i) => (
            <polygon key={i}
              points={`${x}%,0 ${x - 4}%,100% ${x + 4}%,100%`}
              fill={`rgba(79,195,247,${0.03 + i * 0.01})`}
            />
          ))}
          {/* Particles */}
          {Array.from({ length: 20 }).map((_, i) => (
            <circle key={i}
              cx={`${(i * 37 + 10) % 100}%`}
              cy={`${(i * 53 + 5) % 100}%`}
              r={i % 3 === 0 ? 2 : 1}
              fill="rgba(79,195,247,0.4)"
            />
          ))}
          {/* Seagrass silhouettes */}
          {[10, 25, 40, 60, 75, 90].map((x, i) => (
            <g key={i}>
              <rect x={`${x}%`} y="75%" width="3" height="25%" fill="#0d4a1a" rx="1" />
              <ellipse cx={`${x + 1}%`} cy="75%" rx="8" ry="12" fill="#0d4a1a" opacity="0.7" />
            </g>
          ))}
          {/* HUD overlays */}
          <rect x="4" y="4" width="80" height="18" rx="3" fill="rgba(0,0,0,0.5)" />
          <text x="8" y="17" fill="#4fc3f7" fontSize="10" fontFamily="monospace">LIVE FEED</text>
          <rect x="4" y="26" width="90" height="14" rx="2" fill="rgba(0,0,0,0.4)" />
          <text x="8" y="37" fill="#80cbc4" fontSize="9" fontFamily="monospace">RES 1080p · 30fps</text>
          {/* Crosshair */}
          <line x1="48%" y1="44%" x2="52%" y2="44%" stroke="#4fc3f7" strokeWidth="1" opacity="0.6" />
          <line x1="50%" y1="42%" x2="50%" y2="46%" stroke="#4fc3f7" strokeWidth="1" opacity="0.6" />
          <circle cx="50%" cy="44%" r="12" fill="none" stroke="#4fc3f7" strokeWidth="0.8" opacity="0.4" />
        </svg>
        {/* Recording indicator */}
        {recording && (
          <div style={{
            position: 'absolute', top: 8, right: 8,
            display: 'flex', alignItems: 'center', gap: 5,
            background: 'rgba(0,0,0,0.6)', borderRadius: 4, padding: '3px 7px',
          }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%', background: '#e53935',
              animation: 'blink 1s infinite',
            }} />
            <span style={{ color: '#fff', fontSize: 11, fontFamily: 'monospace' }}>
              REC {formatTime(recTime)}
            </span>
          </div>
        )}
      </div>
      {/* Controls */}
      <div className="camera-controls">
        <button className="cam-btn snapshot-btn" onClick={handleSnapshot}>
          <span className="cam-icon">📷</span>
          SNAPSHOT
        </button>
        <button
          className={`cam-btn record-btn ${recording ? 'recording' : ''}`}
          onClick={handleRecord}
        >
          <span className="cam-icon">{recording ? '⏹' : '⏺'}</span>
          {recording ? 'STOP REC' : 'RECORD'}
        </button>
      </div>
      {/* Recent captures */}
      {captures.length > 0 && (
        <div className="capture-log">
          {captures.map((c, i) => (
            <div key={i} className="capture-entry">{c}</div>
          ))}
        </div>
      )}
    </div>
  );
}
