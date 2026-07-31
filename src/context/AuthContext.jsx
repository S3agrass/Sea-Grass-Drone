import { createContext, useContext, useEffect, useState } from "react";

import { supabase, supabaseConfigured } from "../lib/supabase";
import { login, register, logout } from "../lib/auth";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
	const [user, setUser] = useState(null);
	const [loading, setLoading] = useState(true);

	const [localMode, setLocalMode] = useState(
		() => sessionStorage.getItem("seagrass-local-mode") === "1",
	);

	// Signing in supersedes local mode, and nothing used to say so. `signOut`
	// cleared the flag but signing IN did not, and it lives in sessionStorage —
	// so "Continue without account" followed by a real sign-in left localMode
	// true alongside a genuine user. DroneContext gates the cloud fleet on
	// `!localMode`, so that account's drones and settings were quietly read from
	// and written to this browser's storage instead of the account, in that tab
	// only. Open a second tab and the flag is gone, the cloud fleet loads, and
	// none of the work done in the first tab is in it — which is what "my
	// settings don't save" and "adding a drone does nothing" both looked like.
	const applySession = (session) => {
		const nextUser = session?.user ?? null;
		setUser(nextUser);
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

	const enterLocalMode = () => {
		sessionStorage.setItem("seagrass-local-mode", "1");
		setLocalMode(true);
	};

	const value = {
		user,
		loading,
		localMode,
		// SettingsPage reads this off useAuth() and always got undefined, so its
		// Account section told anyone in local mode to "configure Supabase in
		// .env" however configured Supabase actually was.
		supabaseConfigured,
		authed: !!user || localMode,
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
