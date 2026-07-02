import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** True when Supabase env vars are configured. */
export const supabaseConfigured = Boolean(url && anonKey);

/** Supabase client, or null when running without auth configured. */
export const supabase = supabaseConfigured ? createClient(url, anonKey) : null;
