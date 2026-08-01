import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import ParticleTitle from "../components/ParticleTitle";
import { supabaseConfigured } from "../lib/supabase";

export default function LoginPage() {
	const { signIn, signUp, authed } = useAuth();
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
				await signIn(email, password);
				navigate("/fleet", { replace: true });
			} else {
				const data = await signUp(email, password);

				// With email confirmation enabled, sign-up succeeds but returns
				// no session — the account is not usable until the link is
				// clicked. Navigating to /fleet here would land them on an empty
				// page with no explanation of why they are not really signed in.
				if (!data?.session) {
					setNotice(
						`Account created. Check ${email} for a confirmation link, then sign in.`,
					);
					setTab("signin");
					setPassword("");
					return;
				}

				setNotice("Account created successfully.");
				navigate("/fleet", { replace: true });
			}
		} catch (err) {
			// Supabase reports a machine-readable `code` on newer clients and only
			// a human string on older ones, so match on both rather than trusting
			// either. Invalid credentials are deliberately not distinguished into
			// "no such user" vs "wrong password" — that difference tells an
			// attacker which emails have accounts.
			const code = err.code ?? "";
			const msg = (err.message ?? "").toLowerCase();

			if (code === "invalid_credentials" || msg.includes("invalid login")) {
				setError("Incorrect email or password.");
			} else if (
				code === "user_already_exists" ||
				msg.includes("already registered")
			) {
				setError("An account with this email already exists.");
			} else if (code === "weak_password" || msg.includes("password should be")) {
				setError("Password must be at least 6 characters.");
			} else if (code === "validation_failed" || msg.includes("invalid email")) {
				setError("Please enter a valid email address.");
			} else if (code === "email_not_confirmed" || msg.includes("not confirmed")) {
				setError("Confirm your email address first — check your inbox.");
			} else if (code === "over_request_rate_limit" || msg.includes("rate limit")) {
				setError("Too many attempts. Wait a minute and try again.");
			} else {
				setError(err.message);
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="login">
			<div className="login-hero">
				<div className="login-rings">
					<span />
					<span />
					<span />
				</div>

				<div className="login-hero-inner">
					<ParticleTitle text="SEAGRASS" className="login-brand" />

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
							autoComplete={
								tab === "signin" ? "current-password" : "new-password"
							}
							placeholder="••••••••"
							onChange={(e) => setPassword(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
						/>
					</label>

					{!supabaseConfigured && (
						<div className="login-notice">
							Supabase is not configured — accounts are unavailable until
							VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set.
						</div>
					)}
					{error && <div className="login-error">{error}</div>}
					{notice && <div className="login-notice">{notice}</div>}

					<button
						className="btn btn-primary login-submit"
						onClick={handleSubmit}
						disabled={busy || !supabaseConfigured}
					>
						{busy
							? "Working…"
							: tab === "signin"
								? "Sign in"
								: "Create account"}
					</button>
				</div>

				<div className="login-foot mono">SEAGRASS GCS · v2.0</div>
			</div>
		</div>
	);
}
