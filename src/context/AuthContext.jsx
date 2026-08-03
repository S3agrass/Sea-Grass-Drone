import { createContext, useContext, useEffect, useState } from "react";

import { supabase, supabaseConfigured } from "../lib/supabase";
import { login, register, logout } from "../lib/auth";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
	const [user, setUser] = useState(null);
	const [accessToken, setAccessToken] = useState("");
	const [loading, setLoading] = useState(true);

	const [localMode, setLocalMode] = useState(
		() => sessionStorage.getItem("seagrass-local-mode") === "1",
	);

	// Signing in supersedes local mode, and nothing used to say so. `signOut`
	// cleared the flag but signing IN did not, and it lives in sessionStorage,
	// so a session that entered local mode and then signed in kept localMode
	// true alongside a genuine user. The cloud fleet was gated on `!localMode`,
	// so that account's drones and settings were quietly read from and written
	// to this browser's storage instead of the account — in that tab only.
	// Open a second tab, no flag, real cloud fleet, none of the first tab's
	// work in it: "my settings don't save" and "adding a drone does nothing"
	// were the same bug.
	//
	// The entry point is gone now — "Continue without account" was removed — so
	// only a tab that was already in local mode can still reach this. Kept
	// anyway: it costs two lines, and it is what makes a stale flag harmless
	// rather than something DroneContext has to keep trusting.
	const applySession = (session) => {
		const nextUser = session?.user ?? null;
		setUser(nextUser);
		// The vehicle authenticates operators by this token now, rather than by a
		// per-drone secret kept in localStorage. Captured here because this runs
		// on every auth event including TOKEN_REFRESHED, so the value in context
		// is always the current one — which is what lets the camera and media
		// pages read it synchronously while rendering an <img src> without ever
		// serving a stale token.
		setAccessToken(session?.access_token ?? "");
		if (nextUser) {
			sessionStorage.removeItem("seagrass-local-mode");
			setLocalMode(false);
		}
	};

	useEffect(() => {
		if (!supabaseConfigured) {
			setLoading(false);
			return;
		}

		// Two steps, both needed. getSession() resolves the session already in
		// storage, which is what restores the login across a page refresh;
		// onAuthStateChange does not reliably fire for a session that was
		// present before it was subscribed, so relying on it alone would bounce
		// a signed-in user back to the login screen on every reload.
		let active = true;
		supabase.auth.getSession().then(({ data }) => {
			if (!active) return;
			applySession(data.session);
			setLoading(false);
		});

		const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
			applySession(session);
			setLoading(false);
		});

		return () => {
			active = false;
			sub.subscription.unsubscribe();
		};
	}, []);

	const signIn = login;

	const signUp = register;

	const signOut = async () => {
		sessionStorage.removeItem("seagrass-local-mode");
		setLocalMode(false);

		await logout();
	};

	// No enterLocalMode any more: "Continue without account" is gone from the
	// login screen, so nothing may put a session INTO local mode. The flag is
	// still read above and still honoured by DroneContext, which keeps a tab
	// that entered local mode before this change working on its local fleet
	// until it closes — sessionStorage does not outlive the tab, so the state
	// retires itself rather than stranding anyone mid-session.

	const value = {
		user,
		loading,
		localMode,
		// Empty in local mode (no Supabase session), which is exactly when
		// callers must fall back to the drone's own token.
		accessToken,
		// SettingsPage reads this off useAuth() and always got undefined, so its
		// Account section told anyone in local mode to "configure Supabase in
		// .env" however configured Supabase actually was.
		supabaseConfigured,
		authed: !!user || localMode,
		signIn,
		signUp,
		signOut,
	};

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
	return useContext(AuthContext);
}
