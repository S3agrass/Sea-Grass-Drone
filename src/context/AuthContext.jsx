import { createContext, useContext, useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";

import { auth } from "../firebase/config";
import { login, register, logout } from "../firebase/auth";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
	const [user, setUser] = useState(null);
	const [loading, setLoading] = useState(true);

	const [localMode, setLocalMode] = useState(
		() => sessionStorage.getItem("seagrass-local-mode") === "1",
	);

	useEffect(() => {
		const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
			setUser(firebaseUser);
			setLoading(false);
		});

		return unsubscribe;
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
