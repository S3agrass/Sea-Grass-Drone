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
