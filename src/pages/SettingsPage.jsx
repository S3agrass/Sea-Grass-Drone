import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import TopBar from "../components/TopBar";
import Toasts from "../components/Toasts";
import ChangePassword from "../components/ChangePassword";
import { useAuth } from "../context/AuthContext";
import { useDrone } from "../context/DroneContext";

export default function SettingsPage() {
  const { user, localMode, signOut, supabaseConfigured } = useAuth();
  const {
    activeDrone,
    saveDrone,
    demoMode,
    setDemoMode,
    disconnect,
    autoRecord,
    setAutoRecord,
    linkStatus,
    reportedDroneId,
    droneIdMismatch,
  } = useDrone();
  // The vehicle reports its own id, so this is normally shown rather than
  // asked for. Editing exists for the drone that has never been connected —
  // locking the field outright would make it impossible to set one up ahead of
  // time — but it is off by default so nobody retypes a value we already know.
  const [editDroneId, setEditDroneId] = useState(false);
  const connected = linkStatus === "connected";
  const navigate = useNavigate();
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    if (activeDrone) setForm({ ...activeDrone });
  }, [activeDrone]);

  async function handleSave() {
    setBusy(true);
    setSaveError("");
    const result = await saveDrone(form);
    setBusy(false);
    // "Saved ✓" used to appear unconditionally, whether or not anything had
    // been written. A rejected write therefore looked identical to a
    // successful one right up until the next refresh, when the settings were
    // simply back to what they had been — which is precisely how "my settings
    // don't save" presents.
    if (result && result.ok === false) {
      setSaveError(result.error || "The settings could not be saved.");
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="app-shell">
      <TopBar />
      <Toasts />
      <main className="settings" id="main">
        <h1 className="settings-title" id="page-title" tabIndex={-1}>Settings</h1>

        {/* Every card's title was a <div class="eyebrow"> — styled like a
            heading and invisible to anything that navigates by structure. As
            real <h2>s they give the page an outline, and as aria-labelledby
            targets they turn each <section> into a named region the rotor can
            list. Same rewrite in all five cards below. */}
        <section className="settings-card" aria-labelledby="settings-drone">
          <h2 className="eyebrow settings-card-title" id="settings-drone">Active drone</h2>
          {form ? (
            <>
              {/* These were wrapping <label>s with the help text inside them.
                  Anything inside a label becomes part of the field's accessible
                  name, so the Drone ID field announced its entire three-sentence
                  explanation — and the "Edit anyway" button's own label — every
                  single time it took focus. Explicit htmlFor plus
                  aria-describedby keeps the help available but separate, which
                  is what describedby is for. */}
              <div className="field">
                <label className="eyebrow" htmlFor="set-name">Name</label>
                <input
                  id="set-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="field">
                <label className="eyebrow" htmlFor="set-host">Drone link (WebSocket URL)</label>
                <input
                  id="set-host"
                  className="mono"
                  value={form.host}
                  placeholder="ws://seagrass.local:8765"
                  aria-describedby="set-host-help"
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                />
                <span className="field-help" id="set-host-help">
                  Local network: <span className="mono">ws://seagrass.local:8765</span>.
                  Remote via Cloudflare Tunnel: <span className="mono">wss://drone.yourdomain.com</span>.
                </span>
              </div>
              <div className="field">
                <label className="eyebrow" htmlFor="set-camera">Camera stream URL</label>
                <input
                  id="set-camera"
                  className="mono"
                  value={form.camera_url || ""}
                  placeholder="https://cam.seagrassrobotics.com/cam/whep"
                  onChange={(e) => setForm({ ...form, camera_url: e.target.value })}
                />
              </div>
              <div className="field">
                <label className="eyebrow" htmlFor="set-media">Media server URL (optional)</label>
                <input
                  id="set-media"
                  className="mono"
                  value={form.media_url || ""}
                  placeholder="https://media.seagrassrobotics.com"
                  aria-describedby="set-media-help"
                  onChange={(e) => setForm({ ...form, media_url: e.target.value })}
                />
                <span className="field-help" id="set-media-help">
                  Where photos and recordings are browsed from. Leave blank to use
                  the camera host on port <span className="mono">8000</span> — set it
                  only if the media server runs somewhere else.
                </span>
              </div>
              <div className="field">
                <label className="eyebrow" htmlFor="set-drone-id">Drone ID</label>
                <input
                  id="set-drone-id"
                  className="mono"
                  value={form.drone_id || ""}
                  placeholder={
                    reportedDroneId
                      ? reportedDroneId
                      : "Set automatically when the drone connects"
                  }
                  readOnly={!editDroneId}
                  // Announced, not just enforced. The field goes from read-only
                  // to editable when "Edit anyway" is pressed, and without this
                  // the only evidence was that typing suddenly started working.
                  aria-readonly={!editDroneId}
                  aria-describedby="set-drone-id-help"
                  onChange={(e) => setForm({ ...form, drone_id: e.target.value })}
                />
                <span className="field-help" id="set-drone-id-help">
                  {droneIdMismatch ? (
                    // Never silently overwritten: the operator may have set this
                    // deliberately. But it has to be said plainly, because the
                    // consequence is invisible everywhere else in the app.
                    <strong>
                      This drone reports{" "}
                      <span className="mono">{droneIdMismatch.reported}</span>, but
                      this says <span className="mono">{droneIdMismatch.configured}</span>.
                      Operator identity is disabled and media is mis-scoped until
                      they match.
                    </strong>
                  ) : (
                    <>
                      The drone's own name for itself, filled in automatically the
                      first time it connects. It has to match for sign-in to
                      authorise you by account rather than by this drone's access
                      token, and it scopes the Media page to this vehicle.
                    </>
                  )}
                </span>
                {/* Moved out of the description entirely. A control nested in
                    another control's label is unreachable in some readers'
                    browse modes and pollutes the name in the rest. */}
                {!editDroneId && (
                  <button
                    type="button"
                    className="btn-small settings-edit-anyway"
                    onClick={() => setEditDroneId(true)}
                  >
                    Edit drone ID anyway
                  </button>
                )}
              </div>
              <div className="field">
                <label className="eyebrow" htmlFor="set-token">Access token</label>
                <input
                  id="set-token"
                  className="mono"
                  value={form.token || ""}
                  placeholder="Must match SEAGRASS_TOKEN on the drone server"
                  onChange={(e) => setForm({ ...form, token: e.target.value })}
                />
              </div>
              {/* Mounted up front so the region exists before the message does,
                  and so a failed save is spoken rather than appearing silently
                  above a button that looks like it did nothing. */}
              <div className="login-error-slot" role="alert" aria-live="assertive">
                {saveError && <div className="login-error">{saveError}</div>}
              </div>
              <div className="settings-actions">
                {/* "Saved ✓" used to replace this button's own text for two
                    seconds. Changing the accessible name of the control that
                    currently has focus is announced as a different button
                    appearing, if it is announced at all — and it was gone before
                    a reader reached it. The button keeps one stable name and the
                    outcome goes to a status region beside it. */}
                <button
                  className="btn btn-primary"
                  onClick={handleSave}
                  disabled={busy}
                  aria-busy={busy}
                >
                  {busy ? "Saving…" : "Save changes"}
                </button>
                <span
                  className="settings-saved"
                  role="status"
                  aria-live="polite"
                  aria-label="Save status"
                >
                  {saved ? "Saved ✓" : ""}
                </span>
              </div>
            </>
          ) : (
            <p className="settings-muted">
              No drone selected. Pick one from the fleet page first.
            </p>
          )}
        </section>

        <section className="settings-card" aria-labelledby="settings-presentation">
          <h2 className="eyebrow settings-card-title" id="settings-presentation">Presentation</h2>
          <div className="settings-toggle-row">
            <div>
              <div className="settings-toggle-title" id="demo-mode-label">Demo mode</div>
              <div className="settings-muted" id="demo-mode-help">
                Simulates live telemetry when no drone is connected — useful for
                pitches and dry runs. Real telemetry always takes over once the
                link is live.
              </div>
            </div>
            {/* aria-pressed was already right; the name was not. The button's
                own text is "On"/"Off", so a reader announced "Off, toggle
                button" with no clue what it toggles — the visible title beside
                it was an unassociated sibling. labelledby binds them, and the
                paragraph becomes the description. */}
            <button
              className={`toggle ${demoMode ? "on" : ""}`}
              onClick={() => setDemoMode(!demoMode)}
              aria-pressed={demoMode}
              aria-labelledby="demo-mode-label"
              aria-describedby="demo-mode-help"
            >
              <span className="toggle-knob" aria-hidden="true" />
              {demoMode ? "On" : "Off"}
            </button>
          </div>
        </section>

        <section className="settings-card" aria-labelledby="settings-recording">
          <h2 className="eyebrow settings-card-title" id="settings-recording">Recording</h2>
          <div className="settings-toggle-row">
            <div>
              <div className="settings-toggle-title" id="auto-record-label">Auto-record missions</div>
              <div className="settings-muted" id="auto-record-help">
                When on, the drone records to its SD card whenever it is armed and
                stops when disarmed — so unattended autonomous runs are captured
                even with no link to this computer. Recordings appear on the{" "}
                <span className="mono">Media</span> page.
              </div>
            </div>
            {/* aria-disabled, not disabled: the reason it cannot be changed
                ("connect to the drone") lived in a `title` on a control that
                was removed from the tab order, so it could not be read by the
                people it was written for. */}
            <button
              className={`toggle ${autoRecord ? "on" : ""}`}
              onClick={connected ? () => setAutoRecord(!autoRecord) : undefined}
              aria-pressed={autoRecord}
              aria-disabled={!connected}
              aria-labelledby="auto-record-label"
              aria-describedby={
                connected ? "auto-record-help" : "auto-record-help auto-record-blocked"
              }
            >
              <span className="toggle-knob" aria-hidden="true" />
              {autoRecord ? "On" : "Off"}
            </button>
          </div>
          {!connected && (
            <div className="settings-muted" id="auto-record-blocked">
              Connect to the drone to change this.
            </div>
          )}
        </section>

        <section className="settings-card" aria-labelledby="settings-mapping">
          <h2 className="eyebrow settings-card-title" id="settings-mapping">Control mapping</h2>
          {/* A description list: each key is the term and what it does is the
              definition. As sibling divs the key and its action were two
              unrelated runs of text, so "W / S" and "propulsion fwd / back"
              arrived with nothing tying them together. */}
          <dl className="mapping mono">
            <div><dt>W / S</dt><dd>Channel 1 · propulsion fwd / back</dd></div>
            <div><dt>A / D</dt><dd>Channel 2 · steer left / right</dd></div>
            <div><dt>Q / E</dt><dd>Channel 3 · buoyancy rise / dive</dd></div>
            <div><dt>L / K</dt><dd>Channel 4 · light on / off</dd></div>
            <div><dt>SPACE</dt><dd>All stop — neutral PWM on all channels</dd></div>
          </dl>
          <div className="settings-muted">
            PWM values are defined on the drone server (1500 neutral, 1650
            forward, 1350 reverse) so the UI and{" "}
            <span className="mono">keyboard_control.py</span> stay in sync.
          </div>
        </section>

        <section className="settings-card" aria-labelledby="settings-account">
          <h2 className="eyebrow settings-card-title" id="settings-account">Account</h2>
          <div className="settings-muted">
            {localMode
              ? supabaseConfigured
                ? "Running in local mode."
                : "Running in local mode — configure Supabase in .env to enable accounts."
              : `Signed in as ${user?.email}`}
          </div>
          {!localMode && user?.id && (
            // The vehicle authorises operators by this id: it goes in
            // SEAGRASS_OWNER_UIDS in the Pi's ~/.seagrass-env. Shown here so
            // setting up a drone doesn't need a trip to the Supabase dashboard
            // to find a value the signed-in app already knows.
            <div className="settings-muted">
              Operator ID (add to <code>SEAGRASS_OWNER_UIDS</code> on the drone):{" "}
              <code>{user.id}</code>
            </div>
          )}
          <div className="settings-actions">
            {!localMode && user?.email && <ChangePassword email={user.email} />}
            <button
              className="btn"
              onClick={async () => {
                disconnect();
                await signOut();
                navigate("/", { replace: true });
              }}
            >
              Sign out
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
