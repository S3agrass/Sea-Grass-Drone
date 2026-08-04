import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
	exchangeRecoveryCode,
	readRecoveryParams,
	updatePassword,
	verifyRecoveryToken,
} from "../lib/auth";
import { supabaseConfigured } from "../lib/supabase";

// Where a password-recovery email lands.
//
// This route is registered OUTSIDE <Protected> and ahead of the catch-all, and
// that placement is load-bearing: exchanging the recovery code signs the user
// in, and LoginPage redirects anyone already authed straight to /fleet. Routed
// naively, the person clicking the link would be bounced to the fleet with the
// old password still set and no way back to this form.
//
// The code arrives as ?code= in the QUERY string rather than the fragment,
// because the client is configured for the PKCE flow — see src/lib/supabase.js
// for why the fragment is unusable here.

const MIN_PASSWORD = 6; // matches the weak_password branch on the login page

export default function ResetPasswordPage() {
	const navigate = useNavigate();

	// "checking" until the code is exchanged, so we never show a password form
	// that cannot possibly save. "invalid" covers expired, reused and absent.
	const [stage, setStage] = useState("checking");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		if (!supabaseConfigured) {
			setStage("invalid");
			setError(
				"Supabase is not configured — password reset is unavailable until VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set.",
			);
			return;
		}

		const { tokenHash, code, error: linkError, errorDescription } =
			readRecoveryParams(window.location);

		// Supabase reports a link that expired before it was opened this way,
		// rather than by failing the exchange.
		if (linkError) {
			setStage("invalid");
			setError(
				errorDescription
					? `${errorDescription.replace(/\+/g, " ")} Request a new link from the sign-in page.`
					: "That recovery link is no longer valid. Request a new one from the sign-in page.",
			);
			return;
		}

		if (!tokenHash && !code) {
			setStage("invalid");
			setError(
				"This page needs a recovery link. Request a new one from the sign-in page.",
			);
			return;
		}

		// token_hash first: it proves itself from the URL alone, so it works on
		// whichever device opened the mail. `code` is PKCE and only works in the
		// browser that asked for the reset — kept as a fallback for links issued
		// before the email template moved over.
		const verify = tokenHash
			? verifyRecoveryToken(tokenHash)
			: exchangeRecoveryCode(code);

		let active = true;
		verify
			.then(() => {
				if (!active) return;
				setStage("ready");
				// Single-use and now spent. Drop it from the address bar so a refresh
				// does not re-run a doomed exchange, and so the link does not sit in
				// history for anyone reading over a shoulder.
				window.history.replaceState(
					{},
					"",
					`${window.location.pathname}${window.location.hash.split("?")[0]}`,
				);
			})
			.catch(() => {
				if (!active) return;
				setStage("invalid");
				setError(
					tokenHash
						? "That recovery link has expired or was already used. Request a new one from the sign-in page."
						: // The PKCE path fails identically whether the link expired or was
							// simply opened somewhere else, and the second is far more common.
							// Saying so is the difference between a fixable problem and a
							// mystery.
							"This link could not be verified. It may have expired, or it was opened on a different device from the one that requested it. Request a new one and open it on the same device.",
				);
			});

		return () => {
			active = false;
		};
	}, []);

	async function handleSubmit(e) {
		e.preventDefault();
		setError("");

		if (password.length < MIN_PASSWORD) {
			setError(`Password must be at least ${MIN_PASSWORD} characters.`);
			return;
		}
		if (password !== confirm) {
			setError("Those passwords do not match.");
			return;
		}

		setBusy(true);
		try {
			await updatePassword(password);
			navigate("/fleet", { replace: true });
		} catch (err) {
			const code = err.code ?? "";
			const msg = (err.message ?? "").toLowerCase();

			if (code === "weak_password" || msg.includes("password should be")) {
				setError(`Password must be at least ${MIN_PASSWORD} characters.`);
			} else if (msg.includes("same as the old")) {
				setError("That is already your password — choose a different one.");
			} else {
				setError(err.message);
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<main className="login-standalone" id="main">
			<div className="login-panel">
				<form className="login-card" onSubmit={handleSubmit} noValidate>
					<div className="eyebrow">Operator access</div>
					<h1 className="login-title" id="page-title" tabIndex={-1}>Set a new password</h1>

					{/* This sat outside every live region, so the whole recovery-code
					    exchange was silent: the wait was not announced, and neither
					    was the moment two password fields appeared at the end of it.
					    Polite rather than assertive — the failure path is already
					    covered by the assertive #reset-status below. */}
					<div role="status" aria-live="polite">
						{stage === "checking" && (
							<p className="login-muted">Checking your recovery link…</p>
						)}
						{stage === "ready" && (
							<p className="visually-hidden">
								Recovery link accepted. Enter a new password.
							</p>
						)}
					</div>

					{stage === "ready" && (
						<>
							<label className="field" htmlFor="new-password">
								<span className="eyebrow">New password</span>
								<input
									id="new-password"
									name="new-password"
									type="password"
									value={password}
									autoComplete="new-password"
									placeholder="••••••••"
									aria-invalid={error ? true : undefined}
									aria-describedby="reset-req reset-status"
									onChange={(e) => setPassword(e.target.value)}
								/>
							</label>

							<label className="field" htmlFor="confirm-password">
								<span className="eyebrow">Confirm password</span>
								<input
									id="confirm-password"
									name="confirm-password"
									type="password"
									value={confirm}
									autoComplete="new-password"
									placeholder="••••••••"
									aria-invalid={error ? true : undefined}
									aria-describedby="reset-status"
									onChange={(e) => setConfirm(e.target.value)}
								/>
							</label>

							<p id="reset-req" className="field-help">
								Must be at least {MIN_PASSWORD} characters.
							</p>
						</>
					)}

					{/* Same assertive live region the login page uses: a failure here
					    blocks the whole task, and the message is the only thing telling
					    a screen-reader user why nothing happened. */}
					<div id="reset-status" role="alert" aria-live="assertive">
						{error && <div className="login-error">{error}</div>}
					</div>

					{stage === "ready" && (
						<button
							type="submit"
							className="btn btn-primary login-submit"
							disabled={busy}
							aria-busy={busy}
						>
							{busy ? "Saving…" : "Save password"}
						</button>
					)}

					{stage === "invalid" && (
						<Link className="btn btn-primary login-submit" to="/">
							Back to sign in
						</Link>
					)}
				</form>

				<div className="login-foot mono">SEAGRASS GCS · v2.0</div>
			</div>
		</main>
	);
}
