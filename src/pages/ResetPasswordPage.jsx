import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
	establishRecoverySession,
	exchangeRecoveryCode,
	takeRecoveryParams,
	updatePassword,
	verifyRecoveryToken,
} from "../lib/auth";
import { supabaseConfigured } from "../lib/supabase";
import {
	PASSWORD_RULES,
	describePasswordError,
	validateNewPassword,
} from "../lib/passwordPolicy";

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

		const {
			accessToken,
			refreshToken,
			tokenHash,
			code,
			error: linkError,
			errorDescription,
		} = takeRecoveryParams(window);

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

		if (!accessToken && !tokenHash && !code) {
			setStage("invalid");
			setError(
				"This page needs a recovery link. Request a new one from the sign-in page.",
			);
			return;
		}

		// Ordered by how well each survives an email.
		//   access_token — the session itself, in the link. Nothing stored, works
		//                  anywhere. What the implicit flow now sends.
		//   token_hash   — proves itself from the URL, also device-independent.
		//   code         — PKCE. Needs a verifier in this browser's localStorage,
		//                  so it only works where the reset was requested, and
		//                  not even reliably there. Last resort, for links that
		//                  were already in flight.
		const verify = accessToken
			? establishRecoverySession(accessToken, refreshToken)
			: tokenHash
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
				//
				// Splits on `#` as well as `?`: the implicit flow appends its fragment
				// to the one we asked to be redirected to, so a live link reads
				// `#/reset-password#access_token=...` and splitting on `?` alone would
				// leave the whole session sitting in the address bar.
				const route = window.location.hash.replace(/^#/, "").split(/[#?]/)[0];
				window.history.replaceState(
					{},
					"",
					`${window.location.pathname}#${route}`,
				);
			})
			.catch(() => {
				if (!active) return;
				setStage("invalid");
				setError(
					code && !accessToken && !tokenHash
						? // Only the PKCE path can fail for reasons other than the link
							// itself, so only it gets the longer explanation.
							"This link could not be verified. It may have expired, or it was issued before the sign-in system was updated. Request a new one from the sign-in page."
						: "That recovery link has expired or was already used. Request a new one from the sign-in page.",
				);
			});

		return () => {
			active = false;
		};
	}, []);

	async function handleSubmit(e) {
		e.preventDefault();
		setError("");

		const invalid = validateNewPassword(password, confirm);
		if (invalid) {
			setError(invalid);
			return;
		}

		setBusy(true);
		try {
			await updatePassword(password);
			navigate("/fleet", { replace: true });
		} catch (err) {
			// Includes the one rule the client cannot check: Supabase rejects a
			// password identical to the current one, and only it knows what that is.
			setError(describePasswordError(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<main className="login-standalone" id="main">
			<div className="login-panel">
				<form className="login-card" onSubmit={handleSubmit} noValidate>
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

							{/* Stated up front, not discovered by failing. Both rules are
							    listed even though only the length one can be checked here
							    — the other is enforced by Supabase on submit, and someone
							    reaching for their old password deserves to know it will be
							    refused before they type it twice. */}
							<div id="reset-req" className="field-help">
								<p>Your new password:</p>
								<ul className="login-hints">
									{PASSWORD_RULES.map((rule) => (
										<li key={rule}>{rule}</li>
									))}
								</ul>
							</div>
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
