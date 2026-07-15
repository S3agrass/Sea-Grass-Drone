import { useCallback, useEffect, useRef, useState } from "react";
import { useDrone } from "../context/DroneContext";

// Detect stream protocol from URL.
// Anything ending in .mjpg/.mjpeg falls back to legacy MJPEG img tag.
// Everything else is treated as a MediaMTX WHEP endpoint (WebRTC).
function streamType(url) {
  if (!url) return null;
  if (/\.mjpe?g$/i.test(url)) return "mjpeg";
  return "webrtc";
}

// WHEP (WebRTC-HTTP Egress Protocol) client for MediaMTX.
// POSTs an SDP offer to the WHEP URL; MediaMTX replies with an SDP answer;
// the browser then plays the H.264 stream in a <video> element.
async function connectWHEP(url, videoEl, signal) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  // Wire up video track → <video> element as soon as the first track arrives.
  pc.ontrack = (e) => {
    if (videoEl && e.streams[0]) {
      videoEl.srcObject = e.streams[0];
    }
  };

  // Receive-only — we never send media from the browser.
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Wait for ICE gathering to finish (or 5 s timeout) so we send a complete
  // SDP offer — simpler than trickle-ICE and works fine over Tailscale.
  await Promise.race([
    new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      const handler = () => {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", handler);
          resolve();
        }
      };
      pc.addEventListener("icegatheringstatechange", handler);
    }),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);

  if (signal.aborted) { pc.close(); return null; }

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: pc.localDescription.sdp,
    signal,
  });

  if (!resp.ok) throw new Error(`WHEP ${resp.status}: ${await resp.text()}`);
  const sdpAnswer = await resp.text();
  await pc.setRemoteDescription({ type: "answer", sdp: sdpAnswer });

  return pc;
}

export default function CameraView() {
  const {
    activeDrone,
    linkStatus,
    cameraActive,
    cameraOn,
    cameraOff,
    detectActive,
    detections,
    detectOn,
    detectOff,
  } = useDrone();

  const streamUrl = activeDrone?.camera_url || "";
  const type = streamType(streamUrl);
  const connected = linkStatus === "connected";

  // "feed" state: off | connecting | live | error
  const [feedState, setFeedState] = useState("off");
  const [retryKey, setRetryKey] = useState(0);
  const [recording, setRecording] = useState(false);
  const [recTime, setRecTime] = useState(0);
  const [flash, setFlash] = useState(false);
  const [log, setLog] = useState([]);
  const [fullscreen, setFullscreen] = useState(false);

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const timerRef = useRef(null);

  // When the camera subprocess starts/stops on the Pi, or the stream URL
  // changes, reset the feed state so the WHEP hook re-runs.
  useEffect(() => {
    if (!cameraActive || !streamUrl) {
      setFeedState("off");
      return;
    }
    if (type === "webrtc") setFeedState("connecting");
    // mjpeg state is driven by img onLoad/onError below
  }, [cameraActive, streamUrl, type, retryKey]);

  // WebRTC WHEP connection — only runs when camera is active and type is webrtc.
  useEffect(() => {
    if (feedState !== "connecting" || type !== "webrtc" || !streamUrl) return;

    const controller = new AbortController();
    let pc = null;

    connectWHEP(streamUrl, videoRef.current, controller.signal)
      .then((conn) => {
        if (!conn) return; // aborted
        pc = conn;
        pc.oniceconnectionstatechange = () => {
          if (
            pc.iceConnectionState === "failed" ||
            pc.iceConnectionState === "disconnected"
          ) {
            setFeedState("error");
          }
        };
        setFeedState("live");
      })
      .catch((err) => {
        if (err.name !== "AbortError") setFeedState("error");
      });

    return () => {
      controller.abort();
      pc?.close();
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [feedState, type, streamUrl]);

  // Detection overlay — draw normalized bounding boxes onto a canvas sized to
  // the displayed video. Boxes arrive as fractions (0-1) of the full source
  // frame; the video is shown with object-fit: cover, so we replicate that
  // scale/crop here to keep boxes aligned with what the operator sees.
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const draw = () => {
      const rect = video.getBoundingClientRect();
      if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return; // jsdom / no 2D context
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!detectActive) return;

      // Replicate object-fit: cover — scale to fill, centre, crop the overflow.
      const vw = video.videoWidth || rect.width;
      const vh = video.videoHeight || rect.height;
      const scale = Math.max(rect.width / vw, rect.height / vh);
      const dispW = vw * scale;
      const dispH = vh * scale;
      const offX = (rect.width - dispW) / 2;
      const offY = (rect.height - dispH) / 2;

      ctx.font = "12px monospace";
      for (const box of detections) {
        const x = offX + box.x * dispW;
        const y = offY + box.y * dispH;
        const w = box.w * dispW;
        const h = box.h * dispH;
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#00ffa0";
        ctx.strokeRect(x, y, w, h);
        const label = `${box.cls} ${Math.round(box.conf * 100)}%`;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(x, y - 15, tw + 6, 14);
        ctx.fillStyle = "#00ffa0";
        ctx.fillText(label, x + 3, y - 4);
      }
    };

    draw();
    // Re-fit and redraw when the video's displayed size changes (window resize,
    // fullscreen toggle).
    const ro = new ResizeObserver(draw);
    ro.observe(video);
    return () => ro.disconnect();
  }, [detections, detectActive, fullscreen]);

  // Recording timer.
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

  const canCapture = feedState === "live";
  const noUrl = !streamUrl;

  const feed = (
    <div className={`camera-feed ${fullscreen ? "fullscreen" : ""}`}>
      {flash && <div className="camera-flash" />}

      {/* WebRTC video element — always rendered so the ref is stable */}
      {type === "webrtc" && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{ opacity: feedState === "live" ? 1 : 0 }}
        />
      )}

      {/* Detection bounding-box overlay — drawn over the live video */}
      {type === "webrtc" && (
        <canvas ref={canvasRef} className="detection-overlay" />
      )}

      {/* Legacy MJPEG img element */}
      {type === "mjpeg" && cameraActive && (
        <img
          key={retryKey}
          src={streamUrl}
          alt="Live camera feed"
          onLoad={() => setFeedState("live")}
          onError={() => setFeedState("error")}
          style={{ opacity: feedState === "live" ? 1 : 0 }}
        />
      )}

      {/* Overlay shown when not live */}
      {feedState !== "live" && (
        <div className="camera-placeholder">
          <div
            className={`ping-dot ${feedState === "connecting" ? "warn" : "off"}`}
          />
          <div className="camera-placeholder-title">
            {noUrl
              ? "No stream URL configured"
              : !cameraActive
              ? "Camera is off"
              : feedState === "connecting"
              ? "Connecting to camera…"
              : "Camera error — stream unreachable"}
          </div>
          <div className="camera-placeholder-sub mono">
            {noUrl
              ? "Edit this drone in Fleet and add a WHEP URL"
              : streamUrl}
          </div>
          {feedState === "error" && (
            <button
              className="btn"
              onClick={() => setRetryKey((k) => k + 1)}
            >
              Retry
            </button>
          )}
        </div>
      )}

      {feedState === "live" && (
        <div className="camera-badge mono">
          <span className="ping-dot live" /> LIVE
        </div>
      )}

      {recording && feedState === "live" && (
        <div className="camera-rec mono">
          <span className="rec-dot" /> REC {fmtTime(recTime)}
        </div>
      )}

      {fullscreen && (
        <button
          className="camera-close btn"
          onClick={() => setFullscreen(false)}
        >
          ✕ Close
        </button>
      )}
    </div>
  );

  return (
    <div className="camera-panel">
      <div className="panel-head">
        <span className="eyebrow">Camera · Arducam</span>
        <div className="camera-head-actions">
          {/* Camera power toggle — only meaningful when drone is connected */}
          <button
            className={`toggle camera-power ${cameraActive ? "on" : ""}`}
            onClick={cameraActive ? cameraOff : cameraOn}
            disabled={!connected || noUrl}
            title={
              !connected
                ? "Connect to drone first"
                : noUrl
                ? "Configure a camera URL in Fleet settings"
                : cameraActive
                ? "Turn camera off"
                : "Turn camera on"
            }
          >
            <span className="toggle-knob" />
            {cameraActive ? "On" : "Off"}
          </button>

          {/* Object detection toggle — needs the camera running to have frames */}
          <button
            className={`toggle detect-power ${detectActive ? "on" : ""}`}
            onClick={detectActive ? detectOff : detectOn}
            disabled={!connected || !cameraActive}
            title={
              !connected
                ? "Connect to drone first"
                : !cameraActive
                ? "Turn the camera on first"
                : detectActive
                ? "Turn object detection off"
                : "Turn object detection on"
            }
          >
            <span className="toggle-knob" />
            AI
          </button>

          <button
            className="panel-head-btn mono"
            onClick={() => setFullscreen(true)}
            disabled={!canCapture}
          >
            ⛶ Expand
          </button>
        </div>
      </div>

      {fullscreen ? <div className="camera-feed placeholder-slot" /> : feed}
      {fullscreen && <div className="camera-modal">{feed}</div>}

      <div className="camera-actions">
        <button className="btn" onClick={snapshot} disabled={!canCapture}>
          ⊙ Snapshot
        </button>
        <button
          className={`btn ${recording ? "btn-danger" : ""}`}
          onClick={toggleRecord}
          disabled={!canCapture}
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
