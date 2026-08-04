import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useDrone, DEFAULT_CAMERA_URL, DEFAULT_MEDIA_URL } from "../context/DroneContext";
import Toasts from "../components/Toasts";
import Modal from "../components/Modal";

// Pre-filled rather than blank: a blank camera_url silently means "no feed and
// never start the camera", and the Pi's MJPEG address is fixed and known.
const EMPTY = {
  id: "new",
  name: "",
  host: "ws://seagrass.local:8765",
  camera_url: DEFAULT_CAMERA_URL,
  media_url: DEFAULT_MEDIA_URL,
  token: "",
};

export default function FleetPage() {
  const { user, localMode, signOut } = useAuth();
  const { fleet, fleetLoading, saveDrone, removeDrone, selectDrone } =
    useDrone();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(null); // drone object or null
  const [busy, setBusy] = useState(false);
  // Why the last save didn't take. Shown in the form, which stays open on
  // failure — closing it threw away everything the operator typed and left the
  // fleet looking exactly as it does when a save simply hasn't happened yet.
  const [saveError, setSaveError] = useState("");

  function openEditor(drone) {
    setSaveError("");
    setEditing(drone);
  }

  function launch(drone) {
    selectDrone(drone.id);
    navigate("/control");
  }

  async function handleSave() {
    // Was a bare `return`: pressing Save with a blank name did nothing at all
    // and said nothing about why.
    if (!editing.name.trim()) {
      setSaveError("Give the drone a name.");
      return;
    }
    if (!editing.host.trim()) {
      setSaveError("Enter the drone's WebSocket address.");
      return;
    }
    setSaveError("");
    setBusy(true);
    const result = await saveDrone(editing);
    setBusy(false);
    if (result && result.ok === false) {
      setSaveError(result.error || "The drone could not be saved.");
      return;
    }
    setEditing(null);
  }

  async function handleRemove() {
    setBusy(true);
    const result = await removeDrone(editing.id);
    setBusy(false);
    if (result && result.ok === false) {
      setSaveError(result.error || "The drone could not be removed.");
      return;
    }
    setEditing(null);
  }

  return (
    <div className="fleet">
      <header className="fleet-head">
        <div>
          <div className="eyebrow">Seagrass GCS</div>
          {/* tabIndex -1 so the router can move focus here after navigation;
              not a tab stop. */}
          <h1 className="fleet-title" id="page-title" tabIndex={-1}>Your fleet</h1>
          <div className="fleet-sub">
            {localMode
              ? "Local mode — drones are saved on this device only."
              : `Signed in as ${user?.email}`}
          </div>
        </div>
        <div className="fleet-head-actions">
          <button className="btn" onClick={() => openEditor({ ...EMPTY })}>
            + Add drone
          </button>
          <button
            className="btn btn-ghost"
            onClick={async () => {
              await signOut();
              navigate("/", { replace: true });
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      {/* The fleet is the page's content; the header above is not. Without a
          <main> a screen reader has no landmark to jump to and has to walk the
          whole document from the top. */}
      <main id="main">
        {fleetLoading ? (
          <div className="fleet-empty" role="status">Loading fleet…</div>
        ) : fleet.length === 0 ? (
          <div className="fleet-empty" role="status">
            <div className="ping-dot off" aria-hidden="true" />
            <p>No drones registered yet. Add your first vehicle to launch the
            control deck.</p>
            <button className="btn btn-primary" onClick={() => openEditor({ ...EMPTY })}>
              Register a drone
            </button>
          </div>
        ) : (
          // A real list, so the reader announces "list, 3 items" and the rotor
          // can step drone to drone. The cards were interchangeable divs.
          <ul className="fleet-grid">
            {fleet.map((d) => (
              <li key={d.id} className="drone-card">
                <div className="drone-card-top">
                  <div className="ping-dot live" aria-hidden="true" />
                  {/* A heading, so the fleet is navigable by heading — and so
                      the buttons below inherit a per-drone context instead of
                      being four identical "Edit"s in a row. */}
                  <h2 className="drone-card-name">{d.name}</h2>
                </div>
                <div className="drone-card-meta mono">
                  <div><span>LINK</span>{d.host}</div>
                  <div><span>CAM</span>{d.camera_url || "—"}</div>
                </div>
                <div className="drone-card-actions">
                  {/* The visible label stays short; the accessible name carries
                      the drone so "Edit" is unambiguous when a reader lists all
                      the buttons on the page out of context. */}
                  <button
                    className="btn btn-primary"
                    onClick={() => launch(d)}
                    aria-label={`Open control deck for ${d.name}`}
                  >
                    Open control deck
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => openEditor({ ...d })}
                    aria-label={`Edit ${d.name}`}
                  >
                    Edit
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>

      {editing && (
        <Modal onClose={() => setEditing(null)} labelledBy="drone-editor-title">
          {/* A heading, not a styled div: it is what aria-labelledby points at,
              so the dialog announces "Register drone, dialog" on open instead
              of an unnamed one. */}
          <h2 className="eyebrow modal-title" id="drone-editor-title">
            {editing.id === "new" ? "Register drone" : "Edit drone"}
          </h2>
          {/* Explicit id/htmlFor throughout, and hint text kept OUT of the
              <label>. Wrapping a hint inside the label folds it into the
              field's accessible name, so the media field used to announce as
              "Media server URL (optional) Leave blank only if photos and
              recordings live on the same host as the camera stream" every time
              it took focus. aria-describedby says the same thing as a separate
              description the reader can skip. */}
          <div className="field">
            <label className="eyebrow" htmlFor="drone-name">Name</label>
            <input
              id="drone-name"
              value={editing.name}
              placeholder="Seagrass One"
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </div>
          <div className="field">
            <label className="eyebrow" htmlFor="drone-host">Drone link (WebSocket)</label>
            <input
              id="drone-host"
              className="mono"
              value={editing.host}
              placeholder="ws://seagrass.local:8765"
              onChange={(e) => setEditing({ ...editing, host: e.target.value })}
            />
          </div>
          <div className="field">
            <label className="eyebrow" htmlFor="drone-camera">Camera stream URL</label>
            <input
              id="drone-camera"
              className="mono"
              value={editing.camera_url || ""}
              placeholder="http://100.x.x.x:8889/cam/whep"
              onChange={(e) =>
                setEditing({ ...editing, camera_url: e.target.value })
              }
            />
          </div>
          <div className="field">
            <label className="eyebrow" htmlFor="drone-media">Media server URL (optional)</label>
            <input
              id="drone-media"
              className="mono"
              value={editing.media_url || ""}
              placeholder={DEFAULT_MEDIA_URL}
              aria-describedby="drone-media-hint"
              onChange={(e) =>
                setEditing({ ...editing, media_url: e.target.value })
              }
            />
            {/* Only Settings had this field, so a drone added here kept a blank
                media_url and fell back to "camera host, port 8000" — which for
                any camera URL not served from the Pi itself points at nothing:
                a Media page that 404s and WHEP with no TURN credentials. */}
            <span className="field-hint" id="drone-media-hint">
              Leave blank only if photos and recordings live on the same host
              as the camera stream.
            </span>
          </div>
          <div className="field">
            <label className="eyebrow" htmlFor="drone-token">Access token (optional)</label>
            <input
              id="drone-token"
              className="mono"
              value={editing.token || ""}
              placeholder="Shared secret set on the drone server"
              onChange={(e) => setEditing({ ...editing, token: e.target.value })}
            />
          </div>
          {/* Always mounted, so the assistive tech has the region registered
              before the text arrives — a role="alert" that appears at the same
              moment as its own content is unreliably announced. A rejected save
              was previously silent, which reads exactly like a button that does
              nothing. */}
          <div className="login-error-slot" role="alert" aria-live="assertive">
            {saveError && <div className="login-error">{saveError}</div>}
          </div>
          <div className="modal-actions">
            {editing.id !== "new" && (
              <button className="btn btn-danger" onClick={handleRemove} disabled={busy}>
                Remove
              </button>
            )}
            <div className="modal-actions-right">
              <button className="btn btn-ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSave}
                disabled={busy}
                aria-busy={busy}
              >
                {busy ? "Saving…" : "Save drone"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Without this the provider's error toasts — "could not save drone",
          "could not load fleet" — were raised into a page that renders none of
          them, which is why a failed registration looked like nothing at all
          happening. */}
      <Toasts />
    </div>
  );
}
