import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TopBar from "../components/TopBar";
import Toasts from "../components/Toasts";
import Modal from "../components/Modal";
import { useDrone } from "../context/DroneContext";
import {
  deleteMedia,
  mediaCloudEnabled,
  mediaUrls,
  subscribeMedia,
} from "../lib/mediaStore";

// Captures are written to the Pi's SD card first — they must survive an
// autonomous run with no operator connected — and the drone uploads them to
// Supabase on its own (server/media_uploader.py) once it has a link again.
//
// So a capture can be in one of two places, or both, and which one is a detail
// of upload timing that no operator should have to reason about. This page reads
// both and shows ONE list: the SD card while the drone is powered on, the cloud
// always. Cloud copies win for playback, because they keep working after the
// drone is switched off and put away.
//
// Recordings are normally "On drone only": the uploader ships photos by default
// because video does not fit a 1 GB free tier. That is worth showing plainly
// rather than hiding, so an operator knows which captures are backed up.

function fmtSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function fmtTime(mtime) {
  return new Date(mtime * 1000).toLocaleString();
}

/** One line describing why an autonomous capture happened, or null. */
function fmtContext(item) {
  const c = item.context;
  if (!c) return null;
  const bits = [];
  if (c.label) {
    const pct = c.confidence != null ? ` ${Math.round(c.confidence * 100)}%` : "";
    bits.push(`${c.label}${pct}`);
  }
  if (c.depth_m != null) bits.push(`${c.depth_m.toFixed(1)} m down`);
  if (c.heading_deg != null) bits.push(`bearing ${Math.round(c.heading_deg)}°`);
  return bits.length ? bits.join(" · ") : null;
}

export default function MediaPage() {
  const { mediaBase, activeDrone, pushToast, operatorCredential } = useDrone();
  // The operator's session token when signed in, the drone's own token in local
  // mode — see DroneContext. Either way media_server settles it the same way.
  const token = operatorCredential || "";

  const [local, setLocal] = useState([]); // on the drone's SD card
  const [cloud, setCloud] = useState([]); // uploaded to Supabase
  const [localStatus, setLocalStatus] = useState("idle"); // idle|loading|ready|error
  const [cloudReady, setCloudReady] = useState(!mediaCloudEnabled);
  const [urls, setUrls] = useState({}); // storagePath -> resolved download URL
  const requested = useRef(new Set()); // storagePaths already asked for
  const [viewing, setViewing] = useState(null); // item open in the lightbox

  const authHeaders = useCallback(
    () => (token ? { Authorization: `Bearer ${token}` } : {}),
    [token],
  );

  const refresh = useCallback(async () => {
    if (!mediaBase) {
      setLocalStatus("error");
      return;
    }
    setLocalStatus("loading");
    try {
      const resp = await fetch(`${mediaBase}/media`, { headers: authHeaders() });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setLocal(data.media || []);
      setLocalStatus("ready");
    } catch {
      setLocalStatus("error");
    }
  }, [mediaBase, authHeaders]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live subscription rather than a one-shot read: a drone that has just
  // surfaced drains its backlog over minutes, and the grid should fill in as
  // that happens instead of waiting for someone to hit Refresh.
  useEffect(() => {
    if (!mediaCloudEnabled) return undefined;
    return subscribeMedia(
      activeDrone?.drone_id || null,
      (list) => {
        setCloud(list);
        setCloudReady(true);
      },
      () => setCloudReady(true),
    );
  }, [activeDrone]);

  // Merge by filename. A capture that exists in both places is one item, not
  // two; the cloud record wins because it carries the capture context and
  // outlives the drone being switched off.
  const items = useMemo(() => {
    const byName = new Map();
    for (const item of local) {
      byName.set(item.name, { ...item, onDrone: true });
    }
    for (const item of cloud) {
      const existing = byName.get(item.name);
      byName.set(item.name, { ...existing, ...item, onDrone: Boolean(existing) });
    }
    return [...byName.values()].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  }, [local, cloud]);

  // Storage URLs are resolved lazily and cached: getDownloadURL is a network
  // round-trip per object, so re-resolving on every render would hammer it.
  //
  // In-flight requests are tracked in a ref, not in state. Marking them in
  // `urls` would make this effect depend on its own output, and every resolved
  // URL would re-run it — with a cleanup that cancelled the requests still in
  // flight from the previous run. Those paths were already recorded as started,
  // so nothing ever retried them and no cloud media would play at all.
  useEffect(() => {
    const pending = items
      .map((item) => item.storagePath)
      .filter((path) => path && !requested.current.has(path));
    if (!pending.length) return;

    for (const path of pending) requested.current.add(path);

    // One request and one state update for the whole batch. Signing these
    // individually meant a round trip per capture and a re-render per response.
    mediaUrls(pending)
      .then((resolved) => {
        setUrls((prev) => ({ ...prev, ...resolved }));
        // Anything the batch didn't resolve is released so a later pass retries
        // it, matching the old per-item catch.
        for (const path of pending) {
          if (!resolved[path]) requested.current.delete(path);
        }
      })
      .catch(() => {
        for (const path of pending) requested.current.delete(path);
      });
  }, [items]);

  /** Best playable URL for an item: cloud first, drone as the fallback. */
  const srcOf = useCallback(
    (item) => {
      const cloudUrl = item.storagePath ? urls[item.storagePath] : null;
      if (cloudUrl) return cloudUrl;
      // Token in the query string, not a header: the browser issues these
      // requests itself from <img src>/<video src> below, where there is no
      // opportunity to set one. The media server accepts either form.
      if (item.onDrone && mediaBase) {
        const q = token ? `?token=${encodeURIComponent(token)}` : "";
        return `${mediaBase}/media/${encodeURIComponent(item.name)}${q}`;
      }
      return undefined;
    },
    [urls, mediaBase, token],
  );

  async function remove(item) {
    if (!window.confirm(`Delete ${item.name}? This cannot be undone.`)) return;
    // Delete means delete: remove both copies, so a capture cannot reappear on
    // the next upload cycle after the operator thought it was gone.
    let failed = false;
    if (item.onDrone && mediaBase) {
      try {
        const resp = await fetch(`${mediaBase}/media/${encodeURIComponent(item.name)}`, {
          method: "DELETE",
          headers: authHeaders(),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        setLocal((prev) => prev.filter((m) => m.name !== item.name));
      } catch {
        failed = true;
      }
    }
    if (item.cloud) {
      try {
        await deleteMedia(item);
        setCloud((prev) => prev.filter((m) => m.name !== item.name));
      } catch {
        failed = true;
      }
    }
    if (failed) pushToast?.("error", `Could not delete ${item.name}`);
    else if (viewing?.name === item.name) setViewing(null);
  }

  const loading = localStatus === "loading" || !cloudReady;
  // The drone being unreachable is only an error when there is nothing else to
  // show — with uploaded captures on screen it is just a powered-off vehicle.
  const showDroneError = localStatus === "error" && items.length === 0;
  const empty = !loading && !showDroneError && items.length === 0;

  return (
    <div className="app-shell">
      <TopBar />
      <main className="media-page" id="main">
        <div className="media-head">
          <div>
            <h1 className="settings-title" id="page-title" tabIndex={-1}>Media</h1>
            <div className="settings-muted">
              Photos and recordings from {activeDrone?.name || "the drone"}.
            </div>
          </div>
          <button
            className="btn"
            onClick={refresh}
            disabled={localStatus === "loading"}
            aria-busy={localStatus === "loading"}
          >
            <span aria-hidden="true">↻ </span>
            {localStatus === "loading" ? "Loading…" : "Refresh"}
          </button>
        </div>

        {/* One always-mounted status region covering all three mutually
            exclusive outcomes — loading, unreachable, empty. Previously the
            loading state rendered nothing at all and the two failure messages
            were inert divs, so a fetch that failed after a slow wait was
            indistinguishable from one that had not finished. */}
        <div className="media-status" role="status" aria-live="polite">
          {loading && <div className="media-empty">Loading media…</div>}
          {showDroneError && (
            <div className="media-empty">
              {mediaBase
                ? "Couldn't reach the drone's media store, and nothing has been uploaded yet. Check the camera stream URL and that the drone is powered on."
                : "No camera stream URL configured — add one in Settings to browse media."}
            </div>
          )}
          {empty && (
            <div className="media-empty">
              No photos or recordings yet. Capture some from the Control screen.
            </div>
          )}
        </div>

        {items.length > 0 && (
          <ul className="media-grid">
            {items.map((item) => {
              const src = srcOf(item);
              const context = fmtContext(item);
              const backup = item.cloud ? "Backed up" : "On drone only";
              return (
                <li className="media-card" key={item.name}>
                  {/* The whole card's identity is in the meta block below, but
                      a reader listing buttons hears only the button. For a
                      photo the <img alt> named it; for a video the name was the
                      bare glyph "▶", so every video opened an unidentified
                      thing. An explicit name covers both. */}
                  <button
                    className="media-thumb"
                    onClick={() => setViewing(item)}
                    aria-label={`View ${item.type === "photo" ? "photo" : "video"} ${item.name}`}
                  >
                    {item.type === "photo" ? (
                      <img src={src} alt="" loading="lazy" />
                    ) : (
                      <>
                        {/* Decorative preview — the button is already named,
                            and a muted metadata-only thumbnail has nothing to
                            caption. */}
                        <video src={src} preload="metadata" muted aria-hidden="true" />
                        <span className="media-play" aria-hidden="true">▶</span>
                      </>
                    )}
                  </button>
                  <div className="media-meta mono">
                    <div className="media-name">{item.name}</div>
                    <div className="media-sub">
                      {fmtTime(item.mtime)} · {fmtSize(item.size)}
                    </div>
                    {context && <div className="media-sub">{context}</div>}
                    <div className="media-sub">
                      <span aria-hidden="true">{item.cloud ? "☁ " : ""}</span>
                      {backup}
                    </div>
                  </div>
                  <div className="media-actions">
                    {/* srcOf() returns undefined for an item whose host is not
                        resolvable, and an <a> with no href is not focusable and
                        not activatable — it looked like a button and was a dead
                        span. Render a disabled control instead, so the state is
                        both reachable and announced. */}
                    {src ? (
                      <a
                        className="btn"
                        href={src}
                        download={item.name}
                        aria-label={`Download ${item.name}`}
                      >
                        <span aria-hidden="true">↓ </span>Download
                      </a>
                    ) : (
                      <button className="btn" disabled aria-label={`Download ${item.name} — unavailable`}>
                        <span aria-hidden="true">↓ </span>Download
                      </button>
                    )}
                    <button
                      className="btn btn-danger"
                      onClick={() => remove(item)}
                      aria-label={`Delete ${item.name}`}
                    >
                      <span aria-hidden="true">✕ </span>Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>

      {viewing && (
        <Modal
          onClose={() => setViewing(null)}
          label={`${viewing.type === "photo" ? "Photo" : "Video"}: ${viewing.name}`}
          backdropClassName="camera-modal"
          className="media-viewer"
        >
          {viewing.type === "photo" ? (
            <img src={srcOf(viewing)} alt={viewing.name} />
          ) : (
            // autoPlay removed: media that starts on its own talks over a
            // screen reader mid-sentence and there was no way to stop it before
            // finding the controls. It has controls; the user can press play.
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video src={srcOf(viewing)} controls />
          )}
          <button className="camera-close btn" onClick={() => setViewing(null)}>
            <span aria-hidden="true">✕ </span>Close
          </button>
        </Modal>
      )}

      <Toasts />
    </div>
  );
}
