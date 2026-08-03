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

	async function handleSubmit(e) {
		// Now driven by the form's onSubmit, so the browser's own submit paths —
		// Enter in any field, the button, assistive-tech activation — all land
		// here. Without this the page would navigate and lose the entry.
		e?.preventDefault();

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
				<div className="login-rings" aria-hidden="true">
					<div className="login-rings-origin">
						<span />
						<span />
						<span />
					</div>
				</div>

				<div className="login-hero-inner">
					{/* Wordmark lockup. ROBOTICS is a sibling of the particle canvas,
					    never inside it — ParticleTitle sizes its canvas from the host
					    box, so anything extra in there would distort the dot field. */}
					<div className="login-lockup">
						<ParticleTitle text="SEAGRASS" className="login-brand" />

						{/* Set as individual letters spread by flexbox, which is what
						    makes the word span exactly the width of SEAGRASS above it
						    whatever the font does — a fixed letter-spacing would drift
						    the moment the display face or size changed. The letters are
						    hidden from assistive tech and one clean word is announced
						    instead, so it is not read out "R, O, B, O...". */}
						<div className="login-brand-sub">
							<span className="visually-hidden">Robotics</span>
							<span className="login-brand-sub-letters" aria-hidden="true">
								{[..."ROBOTICS"].map((letter, i) => (
									<span key={`${letter}-${i}`}>{letter}</span>
								))}
							</span>
						</div>
					</div>

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
				<form className="login-card" onSubmit={handleSubmit} noValidate>
					<div className="eyebrow">Operator access</div>

					<h1 className="login-title">
						{tab === "signin" ? "Sign in" : "Create account"}
					</h1>

					{/* type="button" is load-bearing now that this sits inside a form:
					    the default is type="submit", so switching tabs would have
					    submitted the credentials instead. */}
					<div className="login-tabs" role="tablist" aria-label="Account action">
						<button
							type="button"
							role="tab"
							id="tab-signin"
							aria-selected={tab === "signin"}
							aria-controls="login-fields"
							className={tab === "signin" ? "active" : ""}
							onClick={() => setTab("signin")}
						>
							Sign in
						</button>

						<button
							type="button"
							role="tab"
							id="tab-signup"
							aria-selected={tab === "signup"}
							aria-controls="login-fields"
							className={tab === "signup" ? "active" : ""}
							onClick={() => setTab("signup")}
						>
							Sign up
						</button>
					</div>

					<div
						id="login-fields"
						role="tabpanel"
						aria-labelledby={tab === "signin" ? "tab-signin" : "tab-signup"}
					>
						<label className="field" htmlFor="login-email">
							<span className="eyebrow">Email</span>

							<input
								id="login-email"
								name="email"
								type="email"
								value={email}
								autoComplete="email"
								placeholder="you@seagrass.io"
								aria-invalid={error ? true : undefined}
								aria-describedby="login-status"
								onChange={(e) => setEmail(e.target.value)}
							/>
						</label>

						<label className="field" htmlFor="login-password">
							<span className="eyebrow">Password</span>

							<input
								id="login-password"
								name="password"
								type="password"
								value={password}
								autoComplete={
									tab === "signin" ? "current-password" : "new-password"
								}
								placeholder="••••••••"
								aria-invalid={error ? true : undefined}
								aria-describedby={
									tab === "signup" ? "password-req login-status" : "login-status"
								}
								onChange={(e) => setPassword(e.target.value)}
							/>
						</label>

						{tab === "signup" && (
							<p id="password-req" className="field-help">
								Must be at least 6 characters.
							</p>
						)}
					</div>

					{/* One live region wrapping every outcome. Errors and confirmations
					    were previously rendered as plain divs: sighted users saw the
					    message appear, screen-reader users got nothing at all and were
					    left guessing why sign-in did not proceed. role="alert" is
					    assertive because a failed sign-in blocks the whole task. */}
					<div id="login-status" role="alert" aria-live="assertive">
						{!supabaseConfigured && (
							<div className="login-notice">
								Supabase is not configured — accounts are unavailable until
								VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set.
							</div>
						)}
						{error && <div className="login-error">{error}</div>}
						{notice && <div className="login-notice">{notice}</div>}
					</div>

					<button
						type="submit"
						className="btn btn-primary login-submit"
						disabled={busy || !supabaseConfigured}
						aria-busy={busy}
					>
						{busy
							? "Working…"
							: tab === "signin"
								? "Sign in"
								: "Create account"}
					</button>
				</form>

				<div className="login-foot mono">SEAGRASS GCS · v2.0</div>
			</div>
		</div>
	);
}
