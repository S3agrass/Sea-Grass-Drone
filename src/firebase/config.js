import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;

export const firebaseConfigured = Boolean(apiKey);

// When Firebase credentials are absent the app runs in local mode only.
// Auth sign-in will be unavailable but the rest of the UI works fine.
const app = firebaseConfigured
	? initializeApp({
			apiKey,
			authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
			projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
			storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
			messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
			appId: import.meta.env.VITE_FIREBASE_APP_ID,
			measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
		})
	: null;

export const auth = app ? getAuth(app) : null;

// Optional
// export const analytics = getAnalytics(app);
