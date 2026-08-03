import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import TopBar from "../components/TopBar";
import Toasts from "../components/Toasts";
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
  } = useDrone();
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
      <div className="settings">
        <h1 className="settings-title">Settings</h1>

        <section className="settings-card">
          <div className="eyebrow">Active drone</div>
          {form ? (
            <>
              <label className="field">
                <span className="eyebrow">Name</span>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="eyebrow">Drone link (WebSocket URL)</span>
                <input
                  className="mono"
                  value={form.host}
                  placeholder="ws://seagrass.local:8765"
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                />
                <span className="field-help">
                  Local network: <span className="mono">ws://seagrass.local:8765</span>.
                  Remote via Cloudflare Tunnel: <span className="mono">wss://drone.yourdomain.com</span>.
                </span>
              </label>
              <label className="field">
                <span className="eyebrow">Camera stream URL</span>
                <input
                  className="mono"
                  value={form.camera_url || ""}
                  placeholder="https://cam.seagrassrobotics.com/cam/whep"
                  onChange={(e) => setForm({ ...form, camera_url: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="eyebrow">Media server URL (optional)</span>
                <input
                  className="mono"
                  value={form.media_url || ""}
                  placeholder="https://media.seagrassrobotics.com"
                  onChange={(e) => setForm({ ...form, media_url: e.target.value })}
                />
                <span className="field-help">
                  Where photos and recordings are browsed from. Leave blank to use
                  the camera host on port <span className="mono">8000</span> — set it
                  only if the media server runs somewhere else.
                </span>
              </label>
              <label className="field">
                <span className="eyebrow">Drone ID (optional)</span>
                <input
                  className="mono"
                  value={form.drone_id || ""}
                  placeholder="Must match DRONE_ID on the drone"
                  onChange={(e) => setForm({ ...form, drone_id: e.target.value })}
                />
                <span className="field-help">
                  Tags uploaded media so the Media page shows only this drone's
                  captures. Leave blank to show everything in the fleet.
                </span>
              </label>
              <label className="field">
                <span className="eyebrow">Access token</span>
                <input
                  className="mono"
                  value={form.token || ""}
                  placeholder="Must match SEAGRASS_TOKEN on the drone server"
                  onChange={(e) => setForm({ ...form, token: e.target.value })}
                />
              </label>
              {saveError && <div className="login-error">{saveError}</div>}
              <div className="settings-actions">
                <button className="btn btn-primary" onClick={handleSave} disabled={busy}>
                  {busy ? "Saving…" : saved ? "Saved ✓" : "Save changes"}
                </button>
              </div>
            </>
          ) : (
            <p className="settings-muted">
              No drone selected. Pick one from the fleet page first.
            </p>
          )}
        </section>

        <section className="settings-card">
          <div className="eyebrow">Presentation</div>
          <div className="settings-toggle-row">
            <div>
              <div className="settings-toggle-title">Demo mode</div>
              <div className="settings-muted">
                Simulates live telemetry when no drone is connected — useful for
                pitches and dry runs. Real telemetry always takes over once the
                link is live.
              </div>
            </div>
            <button
              className={`toggle ${demoMode ? "on" : ""}`}
              onClick={() => setDemoMode(!demoMode)}
              aria-pressed={demoMode}
            >
              <span className="toggle-knob" />
              {demoMode ? "On" : "Off"}
            </button>
          </div>
        </section>

        <section className="settings-card">
          <div className="eyebrow">Recording</div>
          <div className="settings-toggle-row">
            <div>
              <div className="settings-toggle-title">Auto-record missions</div>
              <div className="settings-muted">
                When on, the drone records to its SD card whenever it is armed and
                stops when disarmed — so unattended autonomous runs are captured
                even with no link to this computer. Recordings appear on the{" "}
                <span className="mono">Media</span> page.
              </div>
            </div>
            <button
              className={`toggle ${autoRecord ? "on" : ""}`}
              onClick={() => setAutoRecord(!autoRecord)}
              aria-pressed={autoRecord}
              disabled={!connected}
              title={connected ? "" : "Connect to the drone to change this"}
            >
              <span className="toggle-knob" />
              {autoRecord ? "On" : "Off"}
            </button>
          </div>
        </section>

        <section className="settings-card">
          <div className="eyebrow">Control mapping</div>
          <div className="mapping mono">
            <div><span>W / S</span> Channel 1 · propulsion fwd / back</div>
            <div><span>A / D</span> Channel 2 · steer left / right</div>
            <div><span>Q / E</span> Channel 3 · buoyancy rise / dive</div>
            <div><span>L / K</span> Channel 4 · light on / off</div>
            <div><span>SPACE</span> All stop — neutral PWM on all channels</div>
          </div>
          <div className="settings-muted">
            PWM values are defined on the drone server (1500 neutral, 1650
            forward, 1350 reverse) so the UI and{" "}
            <span className="mono">keyboard_control.py</span> stay in sync.
          </div>
        </section>

        <section className="settings-card">
          <div className="eyebrow">Account</div>
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
      </div>
    </div>
  );
}
