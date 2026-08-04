import { useState } from "react";
import { Link } from "react-router-dom";
import { sendPasswordReset } from "../lib/auth";
import { describeRecoveryError } from "../lib/recoveryErrors";
import { supabaseConfigured } from "../lib/supabase";
import { PASSWORD_RULES } from "../lib/passwordPolicy";

// Asking for a recovery email, on a page of its own.
//
// This used to be a button on the sign-in form that read whatever was in the
// email field. That made "I forgot my password" depend on having already typed
// the right address into a form about something else — and if the field was
// empty, the button's only response was to tell you to go and fill it in. It
// also sat inside the sign-in <form>, so it needed type="button" to stop it
// submitting, which is a bug waiting to be reintroduced every time the form
// changes.
//
// A separate route has its own field, its own submit button, and its own
// success state, and can say what happens next without competing with the
// sign-in copy for room.

export default function ForgotPasswordPage() {
	const [email, setEmail] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	// Set once the send succeeds. The form is replaced by the confirmation
	// rather than left on screen, because leaving it invites the second click
	// that invalidates the link the first one just sent.
	const [sent, setSent] = useState(false);

	async function handleSubmit(e) {
		e.preventDefault();
		setError("");

		if (!email.trim()) {
			setError("Enter your email address.");
			return;
		}

		setBusy(true);
		try {
			await sendPasswordReset(email.trim());
			setSent(true);
		} catch (err) {
			setError(describeRecoveryError(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<main className="login-standalone" id="main">
			<div className="login-panel">
				{sent ? (
					// Deliberately does NOT confirm whether an account exists — Supabase
					// does not disclose that and neither should this page, or it becomes
					// a way to test which of your operators' addresses are registered.
					<div className="login-card">
						<div className="eyebrow">Operator access</div>
						<h1 className="login-title" id="page-title" tabIndex={-1}>
							Check your email
						</h1>

						<div role="status" aria-live="polite">
							<p className="login-muted">
								If an account exists for <strong>{email.trim()}</strong>, a
								password reset link is on its way.
							</p>
						</div>

						<ul className="field-help login-hints">
							<li>The link expires in one hour, and can only be used once.</li>
							<li>
								Open the most recent email — requesting another link
								immediately invalidates the previous one.
							</li>
							<li>
								It works on whichever device you open the mail on, so the phone
								is fine.
							</li>
						</ul>

						<Link className="btn btn-primary login-submit" to="/">
							Back to sign in
						</Link>
					</div>
				) : (
					<form className="login-card" onSubmit={handleSubmit} noValidate>
						<div className="eyebrow">Operator access</div>
						<h1 className="login-title" id="page-title" tabIndex={-1}>
							Reset your password
						</h1>

						<p className="login-muted">
							Enter the email address for your operator account and we will send
							you a link to set a new password.
						</p>

						<label className="field" htmlFor="recovery-email">
							<span className="eyebrow">Email</span>
							<input
								id="recovery-email"
								name="email"
								type="email"
								value={email}
								autoComplete="email"
								placeholder="operator@example.com"
								aria-invalid={error ? true : undefined}
								aria-describedby="forgot-status"
								onChange={(e) => setEmail(e.target.value)}
							/>
						</label>

						{/* Stated here, before the email is even sent, so nobody discovers
						    the rules only after clicking through from their inbox. The same
						    list is repeated on the reset page itself. */}
						<div className="field-help">
							<p>The password you set will need to be:</p>
							<ul className="login-hints">
								{PASSWORD_RULES.map((rule) => (
									<li key={rule}>{rule}</li>
								))}
							</ul>
						</div>

						{/* Assertive: a failure here blocks the whole task, and the message
						    is the only thing telling a screen-reader user why nothing
						    happened. Same pattern as the sign-in and reset forms. */}
						<div id="forgot-status" role="alert" aria-live="assertive">
							{error && <div className="login-error">{error}</div>}
						</div>

						<button
							type="submit"
							className="btn btn-primary login-submit"
							disabled={busy || !supabaseConfigured}
							aria-busy={busy}
						>
							{busy ? "Sending…" : "Send reset link"}
						</button>

						{!supabaseConfigured && (
							<p className="field-help">
								Supabase is not configured — password reset is unavailable until
								VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set.
							</p>
						)}

						<Link className="login-link login-foot-link" to="/">
							Back to sign in
						</Link>
					</form>
				)}

				<div className="login-foot mono">SEAGRASS GCS · v2.0</div>
			</div>
		</main>
	);
}
