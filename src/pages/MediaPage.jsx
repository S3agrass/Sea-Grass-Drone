import { useCallback, useEffect, useState } from "react";
import TopBar from "../components/TopBar";
import Toasts from "../components/Toasts";
import { useDrone } from "../context/DroneContext";

// Photos and recordings live on the Pi's SD card (they must survive an
// autonomous run with no operator connected), so this page talks directly to the
// camera's media server rather than through the control WebSocket.

function fmtSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function fmtTime(mtime) {
  return new Date(mtime * 1000).toLocaleString();
}

export default function MediaPage() {
  const { mediaBase, activeDrone, pushToast } = useDrone();
  const token = activeDrone?.token || "";

  const [items, setItems] = useState([]);
  const [status, setStatus] = useState("idle"); // idle | loading | ready | error
  const [viewing, setViewing] = useState(null); // item open in the lightbox

  const authHeaders = useCallback(
    () => (token ? { Authorization: `Bearer ${token}` } : {}),
    [token],
  );

  const refresh = useCallback(async () => {
    if (!mediaBase) {
      setStatus("error");
      return;
    }
    setStatus("loading");
    try {
      const resp = await fetch(`${mediaBase}/media`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setItems(data.media || []);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [mediaBase]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function remove(item) {
    if (!mediaBase) return;
    if (!window.confirm(`Delete ${item.name}? This cannot be undone.`)) return;
    try {
      const resp = await fetch(`${mediaBase}/media/${encodeURIComponent(item.name)}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setItems((prev) => prev.filter((m) => m.name !== item.name));
      if (viewing?.name === item.name) setViewing(null);
    } catch {
      pushToast?.("error", `Could not delete ${item.name}`);
    }
  }

  return (
    <div className="app-shell">
      <TopBar />
      <div className="media-page">
        <div className="media-head">
          <div>
            <h1 className="settings-title">Media</h1>
            <div className="settings-muted">
              Photos and recordings stored on {activeDrone?.name || "the drone"}.
            </div>
          </div>
          <button className="btn" onClick={refresh} disabled={status === "loading"}>
            {status === "loading" ? "Loading…" : "↻ Refresh"}
          </button>
        </div>

        {status === "error" && (
          <div className="media-empty">
            {mediaBase
              ? "Couldn't reach the drone's media store. Check the camera stream URL and that the drone is powered on."
              : "No camera stream URL configured — add one in Settings to browse media."}
          </div>
        )}

        {status === "ready" && items.length === 0 && (
          <div className="media-empty">
            No photos or recordings yet. Capture some from the Control screen.
          </div>
        )}

        {items.length > 0 && (
          <div className="media-grid">
            {items.map((item) => (
              <div className="media-card" key={item.name}>
                <button
                  className="media-thumb"
                  onClick={() => setViewing(item)}
                  title="View"
                >
                  {item.type === "photo" ? (
                    <img src={`${mediaBase}${item.url}`} alt={item.name} loading="lazy" />
                  ) : (
                    <>
                      <video src={`${mediaBase}${item.url}`} preload="metadata" muted />
                      <span className="media-play">▶</span>
                    </>
                  )}
                </button>
                <div className="media-meta mono">
                  <div className="media-name">{item.name}</div>
                  <div className="media-sub">
                    {fmtTime(item.mtime)} · {fmtSize(item.size)}
                  </div>
                </div>
                <div className="media-actions">
                  <a
                    className="btn"
                    href={`${mediaBase}${item.url}`}
                    download={item.name}
                  >
                    ↓ Download
                  </a>
                  <button className="btn btn-danger" onClick={() => remove(item)}>
                    ✕ Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {viewing && (
        <div className="camera-modal" onClick={() => setViewing(null)}>
          <div className="media-viewer" onClick={(e) => e.stopPropagation()}>
            {viewing.type === "photo" ? (
              <img src={`${mediaBase}${viewing.url}`} alt={viewing.name} />
            ) : (
              <video src={`${mediaBase}${viewing.url}`} controls autoPlay />
            )}
            <button className="camera-close btn" onClick={() => setViewing(null)}>
              ✕ Close
            </button>
          </div>
        </div>
      )}

      <Toasts />
    </div>
  );
}
