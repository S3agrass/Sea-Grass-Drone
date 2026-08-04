// Authentication, on Supabase Auth.
//
// This used to be Firebase Auth, which was the root cause of every account
// seeing the same fleet. The data lives in Supabase, and Postgres had no way to
// learn who the Firebase user was: inside RLS, auth.uid() was always NULL, so
// the only policies that worked at all were `using (true)` — every row visible
// to everybody. See the note at the top of supabase-schema.sql.
//
// Authenticating against Supabase itself means auth.uid() is a real value in
// every query, and the isolation is enforced by Postgres rather than by the
// client asking nicely. Firebase Hosting is untouched — this was only ever
// about auth.

import { supabase, supabaseConfigured } from "./supabase";

const notConfigured = () =>
  Promise.reject(
    new Error("Supabase is not configured — contact your administrator."),
  );

export const login = async (email, password) => {
  if (!supabaseConfigured) return notConfigured();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  return data;
};

/** Returns the sign-up result. `session` is null when the project has email
 *  confirmation switched on — the caller has to tell the user to go and click
 *  the link rather than dropping them on the fleet page as if they were in. */
export const register = async (email, password) => {
  if (!supabaseConfigured) return notConfigured();
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
};

export const logout = async () => {
  if (!supabaseConfigured) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
};

/** Where Supabase sends someone after they click an emailed link. The GCS is
 *  served under /desktop/ (see scripts/assemble-hosting.mjs) and routes on a
 *  hash, so this is the origin plus that sub-path plus the hash route.
 *
 *  This exact URL has to be allow-listed in the Supabase dashboard under
 *  Authentication -> URL Configuration -> Redirect URLs. Supabase silently
 *  falls back to the project's Site URL when it is not, which sends people to
 *  the login page with a code no one ever exchanges. */
/** Where the hosted GCS lives. Only used as a fallback for builds that have no
 *  usable origin of their own — see below. */
const HOSTED_RESET_URL = "https://seagrassrobotics.com/desktop/#/reset-password";

const resetRedirect = () => {
  const { origin, protocol, pathname } = window.location;

  // Electron loads the bundle from file://, where `origin` is "null" or "file://"
  // — not a valid redirect target and impossible to allow-list. Desktop users get
  // sent to the hosted GCS to finish the reset, which works because the session
  // the link establishes is per-browser anyway.
  if (protocol !== "http:" && protocol !== "https:") return HOSTED_RESET_URL;

  // The directory the app is actually served from, NOT a hardcoded "/desktop/".
  // Under `vite dev` the GCS is at the origin root, and assemble-hosting.mjs only
  // moves it under /desktop/ for the Firebase build. Hardcoding the production
  // path meant a reset requested from a dev server emailed a link to
  // localhost:5173/desktop/, which does not exist there — the link opened a page
  // that could never complete the reset.
  const base = pathname.replace(/[^/]*$/, "");
  return `${origin}${base}#/reset-password`;
};

/** Emails a password-recovery link. Resolves either way — Supabase does not
 *  reveal whether an address has an account, and neither should we. */
export const sendPasswordReset = async (email) => {
  if (!supabaseConfigured) return notConfigured();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: resetRedirect(),
  });
  if (error) throw error;
};

/** Re-sends the sign-up confirmation email. Only useful for an account that
 *  exists and has never been confirmed — the state where sign-in fails with
 *  email_not_confirmed and there was previously no way out of it from the app. */
export const resendConfirmation = async (email) => {
  if (!supabaseConfigured) return notConfigured();
  const { error } = await supabase.auth.resend({ type: "signup", email });
  if (error) throw error;
};

/** Sets a new password for whoever the current session belongs to. Only called
 *  from the reset page, where that session came from a recovery code. */
export const updatePassword = async (password) => {
  if (!supabaseConfigured) return notConfigured();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
};

/** Changes the signed-in operator's password, after proving they know the
 *  current one.
 *
 *  Supabase's updateUser() does NOT ask for the existing password — a live
 *  session is enough. That is fine for the recovery page, where the session was
 *  just minted by an emailed link, but not here: an unattended, signed-in
 *  console is a normal state for this app, and without this check anyone
 *  walking past one could lock out its owner. Re-authenticating is how the
 *  current password gets verified; Supabase exposes no "check password" call.
 *
 *  signInWithPassword on the same account returns a session for the same user,
 *  so the existing one is refreshed rather than replaced — the caller stays
 *  signed in either way. */
export const changePassword = async (email, currentPassword, newPassword) => {
  if (!supabaseConfigured) return notConfigured();

  const { error: authError } = await supabase.auth.signInWithPassword({
    email,
    password: currentPassword,
  });
  // Surfaced as a wrong-current-password message by the caller. Not conflated
  // with the update failing, because the two need different fixes.
  if (authError) {
    const err = new Error("Current password is incorrect.");
    err.code = "invalid_current_password";
    throw err;
  }

  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
};

/**
 * Finds the recovery code wherever Supabase happened to put it.
 *
 * The redirect we ask for already carries a fragment (`#/reset-password`,
 * because this app hash-routes), and Supabase then has to attach `?code=` to
 * it. Parsed as a URL the query lands BEFORE the fragment —
 * `/desktop/?code=x#/reset-password` — and concatenated as a string it lands
 * after it: `/desktop/#/reset-password?code=x`. Only the first leaves anything
 * in `window.location.search`, and which one we get is not ours to decide.
 *
 * So look in both. Also picks up `error`/`error_description`, which is how a
 * link that expired before it was opened comes back.
 */
export const readRecoveryParams = (loc) => {
  const fromSearch = new URLSearchParams(loc.search);
  // Everything after the first "?" inside the fragment, if there is one.
  const hashQuery = loc.hash.includes("?")
    ? loc.hash.slice(loc.hash.indexOf("?") + 1)
    : "";
  const fromHash = new URLSearchParams(hashQuery);

  const pick = (key) => fromSearch.get(key) || fromHash.get(key) || "";
  return {
    // Preferred. Carries everything needed in the link itself, so it works on
    // whatever device the email was opened on — see verifyRecoveryToken.
    tokenHash: pick("token_hash"),
    // Legacy PKCE path, kept for links issued before the email template moved
    // to token_hash. Only works in the browser that requested the reset.
    code: pick("code"),
    error: pick("error"),
    errorDescription: pick("error_description"),
  };
};

/**
 * Verifies a recovery link that carries a `token_hash`, and signs the holder in
 * so they can set a new password.
 *
 * This exists because PKCE cannot survive an email. Requesting a reset makes
 * supabase-js stash a `code_verifier` in THAT browser's localStorage, and
 * exchangeCodeForSession needs it back — so a link requested on a laptop and
 * opened on a phone fails, and fails looking exactly like an expired link.
 * People open password-reset mail on their phones constantly, so that is the
 * common case, not the edge one.
 *
 * verifyOtp carries the whole proof in the URL and needs nothing stored
 * locally, so it works wherever the mail was opened. It requires the email
 * template to send `token_hash` — see SETUP.md.
 */
export const verifyRecoveryToken = async (tokenHash) => {
  if (!supabaseConfigured) return notConfigured();
  const { data, error } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type: "recovery",
  });
  if (error) throw error;
  return data;
};

/** Trades the `?code=` on a recovery link for a real session. */
export const exchangeRecoveryCode = async (code) => {
  if (!supabaseConfigured) return notConfigured();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) throw error;
  return data;
};
