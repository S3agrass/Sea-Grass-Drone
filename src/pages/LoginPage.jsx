import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export default function LoginPage() {
  const { signIn, signUp, enterLocalMode, supabaseConfigured, authed } =
    useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState("signin"); // signin | signup
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  if (authed) return <Navigate to="/fleet" replace />;

  async function handleSubmit() {
    setError("");
    setNotice("");
    if (!email || !password) {
      setError("Enter an email and password.");
      return;
    }
    setBusy(true);
    try {
      if (tab === "signin") {
        const { error: err } = await signIn(email, password);
        if (err) setError(err.message);
        else navigate("/fleet", { replace: true });
      } else {
        const { data, error: err } = await signUp(email, password);
        if (err) setError(err.message);
        else if (data.session) navigate("/fleet", { replace: true });
        else setNotice("Account created. Check your email to confirm, then sign in.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login-hero">
        <div className="login-rings">
          <span /><span /><span />
        </div>
        <div className="login-hero-inner">
          <div className="login-brand">SEAGRASS</div>
          <div className="login-tagline">
            Autonomous ocean vehicle command. Connect, pilot, and survey from
            anywhere.
          </div>
          <div className="login-specs mono">
            <span>PIXHAWK · ARDUSUB</span>
            <span>RASPBERRY PI 5 · BLUEOS</span>
            <span>MAVLINK LIVE LINK</span>
          </div>
        </div>
      </div>

      <div className="login-panel">
        <div className="login-card">
          <div className="eyebrow">Operator access</div>
          <h1 className="login-title">
            {tab === "signin" ? "Sign in" : "Create account"}
          </h1>

          {supabaseConfigured ? (
            <>
              <div className="login-tabs">
                <button
                  className={tab === "signin" ? "active" : ""}
                  onClick={() => setTab("signin")}
                >
                  Sign in
                </button>
                <button
                  className={tab === "signup" ? "active" : ""}
                  onClick={() => setTab("signup")}
                >
                  Sign up
                </button>
              </div>

              <label className="field">
                <span className="eyebrow">Email</span>
                <input
                  type="email"
                  value={email}
                  autoComplete="email"
                  placeholder="you@seagrass.io"
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                />
              </label>
              <label className="field">
                <span className="eyebrow">Password</span>
                <input
                  type="password"
                  value={password}
                  autoComplete={tab === "signin" ? "current-password" : "new-password"}
                  placeholder="••••••••"
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                />
              </label>

              {error && <div className="login-error">{error}</div>}
              {notice && <div className="login-notice">{notice}</div>}

              <button
                className="btn btn-primary login-submit"
                onClick={handleSubmit}
                disabled={busy}
              >
                {busy
                  ? "Working…"
                  : tab === "signin"
                    ? "Sign in"
                    : "Create account"}
              </button>
            </>
          ) : (
            <>
              <p className="login-muted">
                Supabase isn't configured yet, so accounts are disabled. Add
                <span className="mono"> VITE_SUPABASE_URL</span> and
                <span className="mono"> VITE_SUPABASE_ANON_KEY</span> to your
                <span className="mono"> .env</span> to enable secure sign-in.
              </p>
              <button
                className="btn btn-primary login-submit"
                onClick={() => {
                  enterLocalMode();
                  navigate("/fleet", { replace: true });
                }}
              >
                Continue in local mode
              </button>
            </>
          )}
        </div>
        <div className="login-foot mono">SEAGRASS GCS · v2.0</div>
      </div>
    </div>
  );
}
