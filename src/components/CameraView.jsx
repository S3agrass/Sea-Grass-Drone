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
        <img
  src="http://10.104.18.141:8000/stream.mjpg"
  style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0 }}
  alt="Live drone feed"
  onError={(e) => { e.target.style.display = 'none'; }}
/>
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
