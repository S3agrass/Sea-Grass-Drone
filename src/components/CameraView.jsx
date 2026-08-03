import { useEffect, useRef, useState } from "react";
import { useDrone } from "../context/DroneContext";

// Detect stream protocol from URL.
// Anything ending in .mjpg/.mjpeg falls back to legacy MJPEG img tag.
// Everything else is treated as a MediaMTX WHEP endpoint (WebRTC).
function streamType(url) {
  if (!url) return null;
  if (/\.mjpe?g$/i.test(url)) return "mjpeg";
  return "webrtc";
}

const STUN_ONLY = [{ urls: "stun:stun.l.google.com:19302" }];

// The credentials are good for an hour (Cloudflare Realtime); ten minutes of
// cache keeps every reconnect after the first one instant while leaving plenty
// of headroom before expiry.
const TURN_CACHE_TTL_MS = 10 * 60 * 1000;

// Longest we will ever hold the offer back waiting for candidates. The old code
// waited for ICE gathering to reach "complete" or five seconds, whichever came
// first — and with a TURN server in the list, "complete" routinely means
// seconds, because it is not reached until every relay candidate has been
// allocated. That wait was most of the camera's startup time.
const ICE_GATHER_MAX_MS = 1500;
// Once a reflexive or relay candidate exists we already have something that can
// traverse NAT; this is just a moment's grace to collect its siblings rather
// than sending on the strict first one.
const ICE_GATHER_GRACE_MS = 300;

// Module-level so it survives remounts and the connect/reconnect cycle.
let turnCache = { base: null, token: null, at: 0, iceServers: null, inflight: null };

/** ICE servers for `mediaBase`, cached. Safe to call speculatively — that is
 *  the point: warming this while the page is still connecting takes the fetch
 *  off the critical path entirely. */
export async function getIceServers(mediaBase, token = "") {
  if (!mediaBase) return STUN_ONLY;
  const fresh =
    turnCache.base === mediaBase &&
    turnCache.token === token &&
    turnCache.iceServers &&
    Date.now() - turnCache.at < TURN_CACHE_TTL_MS;
  if (fresh) return turnCache.iceServers;
  // Deliberately not passed the caller's AbortSignal: this result is shared, so
  // one torn-down negotiation must not cancel the fetch another is waiting on.
  if (!turnCache.inflight || turnCache.base !== mediaBase || turnCache.token !== token) {
    turnCache = {
      base: mediaBase,
      token,
      at: 0,
      iceServers: null,
      inflight: (async () => {
        try {
          // Authenticated: this endpoint mints real Cloudflare TURN credentials
          // against the project's account, and relay bandwidth is billed.
          const resp = await fetch(`${mediaBase}/turn-credentials`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          });
          const data = await resp.json();
          if (Array.isArray(data.iceServers) && data.iceServers.length) {
            turnCache.iceServers = data.iceServers;
            turnCache.at = Date.now();
            return data.iceServers;
          }
        } catch {
          // network hiccup — fall through to STUN-only for this attempt
        }
        return STUN_ONLY;
      })(),
    };
  }
  return turnCache.inflight;
}

/** Resolve once the offer has candidates worth sending, rather than once ICE
 *  gathering is exhaustively finished. */
function waitForCandidates(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    let grace = null;
    const finish = () => {
      clearTimeout(grace);
      clearTimeout(cap);
      pc.removeEventListener("icegatheringstatechange", onState);
      pc.removeEventListener("icecandidate", onCandidate);
      resolve();
    };
    const cap = setTimeout(finish, ICE_GATHER_MAX_MS);
    const onState = () => {
      if (pc.iceGatheringState === "complete") finish();
    };
    const onCandidate = (e) => {
      // A null candidate is the end-of-gathering sentinel.
      if (!e.candidate) return finish();
      if (!grace && / typ (srflx|relay)/.test(e.candidate.candidate || "")) {
        grace = setTimeout(finish, ICE_GATHER_GRACE_MS);
      }
    };
    pc.addEventListener("icegatheringstatechange", onState);
    pc.addEventListener("icecandidate", onCandidate);
  });
}

// WHEP (WebRTC-HTTP Egress Protocol) client for MediaMTX.
// POSTs an SDP offer to the WHEP URL; MediaMTX replies with an SDP answer;
// the browser then plays the H.264 stream in a <video> element.
async function connectWHEP(url, videoEl, signal, mediaBase, token = "") {
  // TURN credentials come from the Pi's media_server.py, not hardcoded here —
  // they're short-lived and its secret never reaches the browser. Falls back to
  // STUN-only if mediaBase is unknown or the fetch fails; that still works on
  // networks whose NAT/firewall allows direct inbound UDP, just not the common
  // home-router case this exists for.
  const iceServers = await getIceServers(mediaBase, token);
  if (signal.aborted) return null;

  const pc = new RTCPeerConnection({ iceServers });

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

  // Send the offer as soon as it carries a candidate that can actually get
  // through a NAT, instead of waiting for gathering to be exhaustively
  // complete. Still a single non-trickle offer — just not a patient one.
  await waitForCandidates(pc);

  if (signal.aborted) { pc.close(); return null; }

  // MediaMTX authenticates readers now (server/mediamtx.yml delegates to
  // media_server.py), so the WHEP request carries the drone's token as HTTP
  // Basic credentials. The username is fixed and ignored; only the password is
  // checked. Without this the feed comes back 401 instead of connecting.
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/sdp",
      ...(token ? { Authorization: `Basic ${btoa(`seagrass:${token}`)}` } : {}),
    },
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
    cameraError,
    cameraKnown,
    mediaBase,
    detectActive,
    detections,
    detectOn,
    detectOff,
    recording,
    recElapsed,
    recordStart,
    recordStop,
    capturePhoto,
  } = useDrone();
  // media_server.py authenticates /turn-credentials now — same shared secret the
  // control link uses.
  const camToken = activeDrone?.token || "";

  const streamUrl = activeDrone?.camera_url || "";
  const type = streamType(streamUrl);
  const connected = linkStatus === "connected";

  // Show the feed when the server says the camera is on, OR when there's no drone
  // link connected to ask (standalone viewing straight from the stream URL). This
  // decouples *watching* from the control server: you can see the camera with just
  // a URL, while On/Off, recording and snapshots still require the drone link.
  //
  // `!cameraKnown` is what stops the feed thrashing on every page load. The
  // sequence is: disconnected (wantFeed true, negotiation starts) -> link
  // connects, and for the moment before the server's first `state` arrives
  // cameraActive is still its default false. Without this clause wantFeed
  // flipped to false right there, aborting the in-flight WHEP negotiation, and
  // then back to true when `state` landed — so every load paid for ICE
  // gathering and SDP exchange twice and threw the first one away. Unknown is
  // not the same as off.
  const wantFeed =
    !!streamUrl && (cameraActive || !connected || !cameraKnown);

  // "feed" state: off | connecting | live | error
  const [feedState, setFeedState] = useState("off");
  const [retryKey, setRetryKey] = useState(0);
  const [flash, setFlash] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  const [fullscreen, setFullscreen] = useState(false);

  const videoRef = useRef(null);
  // The MJPEG <img> needs a ref too. It had none, which is half of why
  // detections were invisible on the camera path that actually runs.
  const imgRef = useRef(null);
  const canvasRef = useRef(null);

  // Warm the TURN credentials as soon as we know where to ask, without waiting
  // for a reason to connect. It is one round trip to the Pi that otherwise sits
  // in front of the peer connection being built at all, and by the time the
  // camera is wanted the answer is usually already cached.
  useEffect(() => {
    if (mediaBase) getIceServers(mediaBase, camToken).catch(() => {});
  }, [mediaBase, camToken]);

  // When the camera subprocess starts/stops on the Pi, or the stream URL
  // changes, reset the feed state so the WHEP hook re-runs.
  useEffect(() => {
    if (!wantFeed) {
      setFeedState("off");
      return;
    }
    if (type === "webrtc") setFeedState("connecting");
    // mjpeg state is driven by img onLoad/onError below
  }, [wantFeed, type, retryKey]);

  // WebRTC WHEP connection — only runs when camera is active and type is webrtc.
  // Keyed on wantFeed/type/streamUrl/mediaBase/retryKey — deliberately NOT on
  // feedState. This effect is what SETS feedState (to "live", "error", etc.),
  // so depending on its own output meant every setFeedState("live") call
  // re-triggered this same effect, tearing down the connection that had just
  // succeeded a moment after establishing it — invisible as a bug until ICE
  // actually started succeeding (see the WebRTC NAT-traversal fix), at which
  // point "live" badge showing a permanently blank feed was the symptom.
  useEffect(() => {
    if (!wantFeed || type !== "webrtc" || !streamUrl) return;

    const controller = new AbortController();
    let pc = null;

    connectWHEP(streamUrl, videoRef.current, controller.signal, mediaBase, camToken)
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
  }, [wantFeed, type, streamUrl, mediaBase, camToken, retryKey]);

  // Detection overlay — draw normalized bounding boxes onto a canvas sized to
  // the displayed feed. Boxes arrive as fractions (0-1) of the full source
  // frame; the feed is shown with object-fit: cover, so we replicate that
  // scale/crop here to keep boxes aligned with what the operator sees.
  //
  // Works over BOTH elements. It used to be mounted for WebRTC only, while the
  // Pi actually serves MJPEG (repo-root camera_stream.py, :8000/stream.mjpg) —
  // so on real hardware the canvas never existed and no detection could ever be
  // seen, however well the detector was working. The maths needed no change:
  // `.camera-feed img` and `.camera-feed video` carry identical CSS, so the
  // cover-replication below is already right for both.
  useEffect(() => {
    const canvas = canvasRef.current;
    const media = type === "mjpeg" ? imgRef.current : videoRef.current;
    if (!canvas || !media) return;

    const draw = () => {
      const rect = media.getBoundingClientRect();
      if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return; // jsdom / no 2D context
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!detectActive) return;

      // Replicate object-fit: cover — scale to fill, centre, crop the overflow.
      // <video> reports videoWidth, <img> naturalWidth, and an <img> reports 0
      // until its first frame decodes — hence both fallbacks.
      const vw = media.videoWidth || media.naturalWidth || rect.width;
      const vh = media.videoHeight || media.naturalHeight || rect.height;
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
    // Re-fit and redraw when the displayed size changes (window resize,
    // fullscreen toggle).
    const ro = new ResizeObserver(draw);
    ro.observe(media);
    return () => ro.disconnect();
    // type/feedState/retryKey matter because the <img> is keyed on
    // `${retryKey}-${wantFeed}` and so is REMOUNTED on a retry — without them
    // the observer would stay attached to a detached node and the overlay would
    // quietly stop updating.
  }, [detections, detectActive, fullscreen, type, feedState, retryKey]);

  // Wall clock — current time overlaid on the feed, ticking once a second.
  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const fmtTime = (s) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  // Snapshot + record act on the Pi (capture/recording live on the drone), so
  // they only need the camera running — not a live local view.
  function snapshot() {
    setFlash(true);
    setTimeout(() => setFlash(false), 180);
    capturePhoto();
  }

  function toggleRecord() {
    if (recording) recordStop();
    else recordStart();
  }

  const canCapture = feedState === "live"; // fullscreen/expand needs the video
  const canControl = connected && cameraActive; // snapshot/record are Pi-side
  const noUrl = !streamUrl;

  const feed = (
    <div
      className={`camera-feed ${fullscreen ? "fullscreen" : ""} ${
        recording ? "recording" : ""
      }`}
    >
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

      {/* Detection bounding-box overlay — drawn over whichever feed is live.
          Mounted for MJPEG as well as WebRTC: the Pi serves MJPEG, so gating
          this on webrtc meant boxes were never drawn on real hardware. */}
      {(type === "webrtc" || type === "mjpeg") && (
        <canvas ref={canvasRef} className="detection-overlay" />
      )}

      {/* Legacy MJPEG img element */}
      {type === "mjpeg" && wantFeed && (
        <img
          ref={imgRef}
          key={`${retryKey}-${wantFeed}`}
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
              : !wantFeed
              ? cameraError
                ? "Camera failed to start"
                : "Camera is off"
              : feedState === "connecting"
              ? "Connecting to camera…"
              : "Camera error — stream unreachable"}
          </div>
          {/* The Pi knows why it could not start and used to keep it to itself,
              so "Camera is off" read as "not switched on yet" and invited
              waiting — when the answer was a stranded process no amount of
              waiting would clear. Say the reason where the operator is looking. */}
          <div className="camera-placeholder-sub mono">
            {noUrl
              ? "Edit this drone in Fleet and add a WHEP URL"
              : !wantFeed && cameraError
              ? cameraError
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

      {/* Wall clock — current time, bottom-left of the feed */}
      {feedState === "live" && (
        <div className="camera-clock mono">{clock.toLocaleTimeString()}</div>
      )}

      {/* Recording indicator + elapsed time, bottom-right. Shown whenever the Pi
          is recording (it keeps recording even if the local view drops). */}
      {recording && (
        <div className="camera-rec mono">
          <span className="rec-dot" /> REC {fmtTime(recElapsed || 0)}
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
          {/* No manual camera power control — the camera is fully automatic,
              on whenever the Pixhawk is connected (see shouldCameraBeOn in
              DroneContext.jsx). The detector depends on it running
              continuously, so there was never a real use case for turning it
              off on its own short of the all-stop kill switch. */}

          {/* Object detection toggle — needs the camera running to have frames */}
          <button
            className={`toggle detect-power ${detectActive ? "on" : ""}`}
            onClick={detectActive ? detectOff : detectOn}
            disabled={!connected || !cameraActive}
            title={
              !connected
                ? "Connect to drone first"
                : !cameraActive
                ? "Waiting for the Pixhawk to connect — camera starts automatically"
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
        <button className="btn" onClick={snapshot} disabled={!canControl}>
          ⊙ Snapshot
        </button>
        <button
          className={`btn ${recording ? "btn-danger" : ""}`}
          onClick={toggleRecord}
          disabled={!canControl}
        >
          {recording ? "■ Stop" : "● Record"}
        </button>
      </div>
    </div>
  );
}
