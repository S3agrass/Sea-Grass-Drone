import { createContext, useContext, useEffect, useState } from "react";
import { supabase, supabaseConfigured } from "../lib/supabase";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(supabaseConfigured);
  const [localMode, setLocalMode] = useState(
    () => sessionStorage.getItem("seagrass-local-mode") === "1",
  );

  useEffect(() => {
    if (!supabaseConfigured) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const signIn = (email, password) =>
    supabase.auth.signInWithPassword({ email, password });

  const signUp = (email, password) => supabase.auth.signUp({ email, password });

  const signOut = async () => {
    sessionStorage.removeItem("seagrass-local-mode");
    setLocalMode(false);
    if (supabaseConfigured) await supabase.auth.signOut();
  };

  const enterLocalMode = () => {
    sessionStorage.setItem("seagrass-local-mode", "1");
    setLocalMode(true);
  };

  const value = {
    session,
    user: session?.user ?? null,
    loading,
    localMode,
    supabaseConfigured,
    authed: Boolean(session) || localMode,
    signIn,
    signUp,
    signOut,
    enterLocalMode,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
