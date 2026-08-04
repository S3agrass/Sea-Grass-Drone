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

/** Trades the `?code=` on a recovery link for a real session. */
export const exchangeRecoveryCode = async (code) => {
  if (!supabaseConfigured) return notConfigured();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) throw error;
  return data;
};
