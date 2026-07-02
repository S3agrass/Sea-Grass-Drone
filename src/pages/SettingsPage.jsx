import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import TopBar from "../components/TopBar";
import { useAuth } from "../context/AuthContext";
import { useDrone } from "../context/DroneContext";

export default function SettingsPage() {
  const { user, localMode, signOut, supabaseConfigured } = useAuth();
  const { activeDrone, saveDrone, demoMode, setDemoMode, disconnect } =
    useDrone();
  const navigate = useNavigate();
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (activeDrone) setForm({ ...activeDrone });
  }, [activeDrone]);

  async function handleSave() {
    setBusy(true);
    await saveDrone(form);
    setBusy(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="app-shell">
      <TopBar />
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
                  placeholder="ws://seagrass-pi.local:8765"
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                />
                <span className="field-help">
                  Local network: <span className="mono">ws://seagrass-pi.local:8765</span>.
                  Remote via Cloudflare Tunnel: <span className="mono">wss://drone.yourdomain.com</span>.
                </span>
              </label>
              <label className="field">
                <span className="eyebrow">Camera stream URL</span>
                <input
                  className="mono"
                  value={form.camera_url || ""}
                  placeholder="http://seagrass-pi.local:8000/stream.mjpg"
                  onChange={(e) => setForm({ ...form, camera_url: e.target.value })}
                />
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
