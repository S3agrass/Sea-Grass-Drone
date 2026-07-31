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
			setUser(data.session?.user ?? null);
			setLoading(false);
		});

		const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
			setUser(session?.user ?? null);
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
