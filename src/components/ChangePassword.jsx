import { useState } from "react";
import { changePassword } from "../lib/auth";

// Change-password form for a signed-in operator.
//
// Until this existed the only way to a new password was the "forgot password"
// email, which is a poor fit for someone who already knows their password and
// simply wants a different one — and useless for anyone handed a temporary one
// by an administrator, which is exactly how operators get bootstrapped here.
//
// Its own component rather than more markup inside SettingsPage: it owns four
// pieces of state and a submit path, none of which the rest of that page cares
// about.

const MIN_PASSWORD = 6; // matches the weak_password branch elsewhere

export default function ChangePassword({ email }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const reset = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
    setError("");
  };

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setDone(false);

    if (!current) {
      setError("Enter your current password.");
      return;
    }
    if (next.length < MIN_PASSWORD) {
      setError(`New password must be at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (next !== confirm) {
      setError("Those passwords do not match.");
      return;
    }
    if (next === current) {
      setError("That is already your password — choose a different one.");
      return;
    }

    setBusy(true);
    try {
      await changePassword(email, current, next);
      reset();
      setDone(true);
      setOpen(false);
    } catch (err) {
      const code = err.code ?? "";
      const msg = (err.message ?? "").toLowerCase();

      if (code === "invalid_current_password") {
        setError("Current password is incorrect.");
      } else if (code === "weak_password" || msg.includes("password should be")) {
        setError(`New password must be at least ${MIN_PASSWORD} characters.`);
      } else if (msg.includes("same as the old")) {
        setError("That is already your password — choose a different one.");
      } else if (code === "over_request_rate_limit" || msg.includes("rate limit")) {
        setError("Too many attempts. Wait a minute and try again.");
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <>
        {/* Announced politely: it confirms something that already succeeded,
            so it should not interrupt whatever is being read. */}
        <div role="status" aria-live="polite">
          {done && <div className="login-notice">Password changed.</div>}
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setDone(false);
            setOpen(true);
          }}
        >
          Change password
        </button>
      </>
    );
  }

  return (
    <form className="change-password" onSubmit={handleSubmit} noValidate>
      <label className="field" htmlFor="current-password">
        <span className="eyebrow">Current password</span>
        <input
          id="current-password"
          name="current-password"
          type="password"
          value={current}
          autoComplete="current-password"
          aria-invalid={error ? true : undefined}
          aria-describedby="change-password-status"
          onChange={(e) => setCurrent(e.target.value)}
        />
      </label>

      <label className="field" htmlFor="next-password">
        <span className="eyebrow">New password</span>
        <input
          id="next-password"
          name="next-password"
          type="password"
          value={next}
          autoComplete="new-password"
          aria-invalid={error ? true : undefined}
          aria-describedby="change-password-req change-password-status"
          onChange={(e) => setNext(e.target.value)}
        />
      </label>

      <label className="field" htmlFor="confirm-new-password">
        <span className="eyebrow">Confirm new password</span>
        <input
          id="confirm-new-password"
          name="confirm-new-password"
          type="password"
          value={confirm}
          autoComplete="new-password"
          aria-invalid={error ? true : undefined}
          aria-describedby="change-password-status"
          onChange={(e) => setConfirm(e.target.value)}
        />
      </label>

      <p id="change-password-req" className="field-help">
        Must be at least {MIN_PASSWORD} characters.
      </p>

      {/* Assertive: a failure here stops the task, and the message is the only
          thing telling a screen-reader user why nothing happened. */}
      <div id="change-password-status" role="alert" aria-live="assertive">
        {error && <div className="login-error">{error}</div>}
      </div>

      <div className="settings-actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy}
          aria-busy={busy}
        >
          {busy ? "Saving…" : "Save new password"}
        </button>
        {/* type="button", or it would submit the form it is meant to abandon. */}
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            reset();
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
