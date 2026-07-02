import { useEffect, useRef, useState } from "react";

/**
 * Live Arducam MJPEG feed. Handles three real states — connecting, live,
 * offline — instead of silently hiding a broken <img>.
 */
export default function CameraView({ streamUrl }) {
  const [state, setState] = useState("connecting"); // connecting | live | offline
  const [recording, setRecording] = useState(false);
  const [recTime, setRecTime] = useState(0);
  const [flash, setFlash] = useState(false);
  const [log, setLog] = useState([]);
  const [fullscreen, setFullscreen] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const timerRef = useRef(null);

  useEffect(() => {
    setState(streamUrl ? "connecting" : "offline");
  }, [streamUrl, retryKey]);

  useEffect(() => {
    if (recording) {
      timerRef.current = setInterval(() => setRecTime((t) => t + 1), 1000);
    } else {
      clearInterval(timerRef.current);
      setRecTime(0);
    }
    return () => clearInterval(timerRef.current);
  }, [recording]);

  const fmtTime = (s) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  function addLog(entry) {
    setLog((prev) => [{ id: Date.now(), text: entry }, ...prev].slice(0, 6));
  }

  function snapshot() {
    setFlash(true);
    setTimeout(() => setFlash(false), 180);
    addLog(`Snapshot · ${new Date().toLocaleTimeString()}`);
  }

  function toggleRecord() {
    if (recording) {
      addLog(`Clip ${fmtTime(recTime)} · ${new Date().toLocaleTimeString()}`);
      setRecording(false);
    } else {
      setRecording(true);
    }
  }

  const feed = (
    <div className={`camera-feed ${fullscreen ? "fullscreen" : ""}`}>
      {flash && <div className="camera-flash" />}
      {streamUrl && (
        <img
          key={retryKey}
          src={streamUrl}
          alt="Live Arducam feed"
          onLoad={() => setState("live")}
          onError={() => setState("offline")}
          style={{ opacity: state === "live" ? 1 : 0 }}
        />
      )}
      {state !== "live" && (
        <div className="camera-placeholder">
          <div className={`ping-dot ${state === "connecting" ? "warn" : "off"}`} />
          <div className="camera-placeholder-title">
            {state === "connecting" ? "Connecting to camera…" : "Camera offline"}
          </div>
          <div className="camera-placeholder-sub mono">
            {streamUrl || "No stream URL set — add one in Settings"}
          </div>
          {state === "offline" && streamUrl && (
            <button className="btn" onClick={() => setRetryKey((k) => k + 1)}>
              Retry
            </button>
          )}
        </div>
      )}
      {state === "live" && (
        <div className="camera-badge mono">
          <span className="ping-dot live" /> LIVE
        </div>
      )}
      {recording && state === "live" && (
        <div className="camera-rec mono">
          <span className="rec-dot" /> REC {fmtTime(recTime)}
        </div>
      )}
      {fullscreen && (
        <button className="camera-close btn" onClick={() => setFullscreen(false)}>
          ✕ Close
        </button>
      )}
    </div>
  );

  return (
    <div className="camera-panel">
      <div className="panel-head">
        <span className="eyebrow">Camera · Arducam</span>
        <button
          className="panel-head-btn mono"
          onClick={() => setFullscreen(true)}
          disabled={state !== "live"}
        >
          ⛶ Expand
        </button>
      </div>
      {fullscreen ? <div className="camera-feed placeholder-slot" /> : feed}
      {fullscreen && <div className="camera-modal">{feed}</div>}
      <div className="camera-actions">
        <button className="btn" onClick={snapshot} disabled={state !== "live"}>
          ⊙ Snapshot
        </button>
        <button
          className={`btn ${recording ? "btn-danger" : ""}`}
          onClick={toggleRecord}
          disabled={state !== "live"}
        >
          {recording ? "■ Stop" : "● Record"}
        </button>
      </div>
      {log.length > 0 && (
        <div className="camera-log mono">
          {log.map((l) => (
            <div key={l.id}>{l.text}</div>
          ))}
        </div>
      )}
    </div>
  );
}
