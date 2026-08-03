import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** True when Supabase env vars are configured. */
export const supabaseConfigured = Boolean(url && anonKey);

/** Supabase client, or null when running without auth configured.
 *
 *  flowType PKCE, not the default implicit flow. The implicit flow returns
 *  password-recovery and confirmation tokens in the URL FRAGMENT
 *  (#access_token=...&type=recovery), and this app is mounted on a HashRouter —
 *  the fragment is the router's. The two fight over it and the link lands
 *  somewhere arbitrary. PKCE puts a short-lived `?code=` in the query string
 *  instead, which the router ignores, and ResetPasswordPage trades it for a
 *  session with exchangeCodeForSession(). */
export const supabase = supabaseConfigured
  ? createClient(url, anonKey, { auth: { flowType: "pkce" } })
  : null;
