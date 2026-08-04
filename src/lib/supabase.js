import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** True when Supabase env vars are configured. */
export const supabaseConfigured = Boolean(url && anonKey);

/** Supabase client, or null when running without auth configured.
 *
 *  IMPLICIT flow, deliberately — this was PKCE and PKCE cannot survive an
 *  email. Requesting a reset makes supabase-js keep a `code_verifier` in the
 *  localStorage of the browser that asked, and the emailed link is worthless
 *  without it. Anyone opening the mail on a phone was stuck, and so, it turned
 *  out, was the browser that sent it. The implicit flow returns the session
 *  itself in the link, so nothing has to be remembered anywhere and the link
 *  works wherever it is opened.
 *
 *  detectSessionInUrl is off for the same reason it was originally avoided: the
 *  implicit flow hands the session back in the URL FRAGMENT, and this app is
 *  mounted on a HashRouter that owns the fragment. Rather than let the two race
 *  — supabase-js clearing the fragment while the router tries to read it —
 *  captureRecoveryFragment() in lib/auth.js takes the values before React
 *  starts and the reset page installs them explicitly. */
export const supabase = supabaseConfigured
  ? createClient(url, anonKey, { auth: { detectSessionInUrl: false } })
  : null;
