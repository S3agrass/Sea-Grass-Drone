import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useDrone, DEFAULT_CAMERA_URL } from "../context/DroneContext";
import Toasts from "../components/Toasts";

// Pre-filled rather than blank: a blank camera_url silently means "no feed and
// never start the camera", and the Pi's MJPEG address is fixed and known.
const EMPTY = {
  id: "new",
  name: "",
  host: "ws://seagrass.local:8765",
  camera_url: DEFAULT_CAMERA_URL,
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
          <h1 className="fleet-title">Your fleet</h1>
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

      {fleetLoading ? (
        <div className="fleet-empty">Loading fleet…</div>
      ) : fleet.length === 0 ? (
        <div className="fleet-empty">
          <div className="ping-dot off" />
          <p>No drones registered yet. Add your first vehicle to launch the
          control deck.</p>
          <button className="btn btn-primary" onClick={() => openEditor({ ...EMPTY })}>
            Register a drone
          </button>
        </div>
      ) : (
        <div className="fleet-grid">
          {fleet.map((d) => (
            <div key={d.id} className="drone-card">
              <div className="drone-card-top">
                <div className="ping-dot live" />
                <div className="drone-card-name">{d.name}</div>
              </div>
              <div className="drone-card-meta mono">
                <div><span>LINK</span>{d.host}</div>
                <div><span>CAM</span>{d.camera_url || "—"}</div>
              </div>
              <div className="drone-card-actions">
                <button className="btn btn-primary" onClick={() => launch(d)}>
                  Open control deck
                </button>
                <button className="btn btn-ghost" onClick={() => openEditor({ ...d })}>
                  Edit
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="eyebrow">
              {editing.id === "new" ? "Register drone" : "Edit drone"}
            </div>
            <label className="field">
              <span className="eyebrow">Name</span>
              <input
                value={editing.name}
                placeholder="Seagrass One"
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="eyebrow">Drone link (WebSocket)</span>
              <input
                className="mono"
                value={editing.host}
                placeholder="ws://seagrass.local:8765"
                onChange={(e) => setEditing({ ...editing, host: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="eyebrow">Camera stream URL</span>
              <input
                className="mono"
                value={editing.camera_url || ""}
                placeholder="http://100.x.x.x:8889/cam/whep"
                onChange={(e) =>
                  setEditing({ ...editing, camera_url: e.target.value })
                }
              />
            </label>
            <label className="field">
              <span className="eyebrow">Access token (optional)</span>
              <input
                className="mono"
                value={editing.token || ""}
                placeholder="Shared secret set on the drone server"
                onChange={(e) => setEditing({ ...editing, token: e.target.value })}
              />
            </label>
            {saveError && <div className="login-error">{saveError}</div>}
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
                <button className="btn btn-primary" onClick={handleSave} disabled={busy}>
                  {busy ? "Saving…" : "Save drone"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Without this the provider's error toasts — "could not save drone",
          "could not load fleet" — were raised into a page that renders none of
          them, which is why a failed registration looked like nothing at all
          happening. */}
      <Toasts />
    </div>
  );
}
