import {
	signInWithEmailAndPassword,
	createUserWithEmailAndPassword,
	signOut,
} from "firebase/auth";

import { auth, firebaseConfigured } from "./config";

const notConfigured = () =>
	Promise.reject(new Error("Firebase is not configured — contact your administrator."));

export const login = (email, password) =>
	firebaseConfigured
		? signInWithEmailAndPassword(auth, email, password)
		: notConfigured();

export const register = (email, password) =>
	firebaseConfigured
		? createUserWithEmailAndPassword(auth, email, password)
		: notConfigured();

export const logout = () =>
	firebaseConfigured ? signOut(auth) : Promise.resolve();
