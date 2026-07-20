import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { firebaseConfigured } from "../firebase/config";

export default function LoginPage() {
	const { signIn, signUp, authed, enterLocalMode } = useAuth();
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
				await signUp(email, password);

				setNotice("Account created successfully.");
				navigate("/fleet", { replace: true });
			}
		} catch (err) {
			switch (err.code) {
				case "auth/invalid-credential":
				case "auth/user-not-found":
				case "auth/wrong-password":
					setError("Incorrect email or password.");
					break;

				case "auth/email-already-in-use":
					setError("An account with this email already exists.");
					break;

				case "auth/weak-password":
					setError("Password must be at least 6 characters.");
					break;

				case "auth/invalid-email":
					setError("Please enter a valid email address.");
					break;

				default:
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

					{!firebaseConfigured && (
						<div className="login-notice">
							Firebase is not configured — use "Continue without account" below to test locally.
						</div>
					)}
					{error && <div className="login-error">{error}</div>}
					{notice && <div className="login-notice">{notice}</div>}

					<button
						className="btn btn-primary login-submit"
						onClick={handleSubmit}
						disabled={busy || !firebaseConfigured}
					>
						{busy
							? "Working…"
							: tab === "signin"
								? "Sign in"
								: "Create account"}
					</button>
				</div>

				<button
					className="btn btn-ghost login-local"
					onClick={() => {
						enterLocalMode();
						navigate("/fleet", { replace: true });
					}}
				>
					Continue without account
				</button>

				<div className="login-foot mono">SEAGRASS GCS · v2.0</div>
			</div>
		</div>
	);
}
