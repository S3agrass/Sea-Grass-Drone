import { useEffect } from "react";
import {
  HashRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
} from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { DroneProvider } from "./context/DroneContext";
import LoginPage from "./pages/LoginPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import FleetPage from "./pages/FleetPage";
import ControlPage from "./pages/ControlPage";
import MediaPage from "./pages/MediaPage";
import SettingsPage from "./pages/SettingsPage";
import "./styles/theme.css";
import "./styles/app.css";

const ROUTE_TITLES = {
  "/": "Sign in",
  "/reset-password": "Reset password",
  "/fleet": "Your fleet",
  "/control": "Flight deck",
  "/media": "Media",
  "/settings": "Settings",
};

/**
 * Client-side routing changes the page without any of the things a real
 * navigation does: the document title stayed "Seagrass GCS — Drone Control" on
 * every screen, nothing was announced, and focus stayed on whichever nav link
 * had been clicked — so moving from Control to Media left a screen-reader user
 * on a link, in silence, with no indication anything had happened.
 *
 * On each route change this sets the title and moves focus to the new page's
 * h1 (every page carries id="page-title" and tabIndex -1 for exactly this).
 * Moving focus to the heading is what makes the reader start reading the new
 * page, and it puts the next Tab at the top of the content rather than back in
 * the middle of the nav.
 */
function RouteAnnouncer() {
  const { pathname } = useLocation();

  useEffect(() => {
    const name = ROUTE_TITLES[pathname];
    document.title = name ? `${name} — Seagrass GCS` : "Seagrass GCS";

    // After paint, so the new route's heading exists to receive focus.
    const id = requestAnimationFrame(() => {
      document.getElementById("page-title")?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [pathname]);

  return null;
}

/**
 * First tab stop in the document. Every screen behind the login puts a brand
 * block and four nav links ahead of its content, and without this they are
 * re-tabbed on every navigation.
 *
 * A button, not the usual `<a href="#main">`. This app is on a HashRouter, so
 * the URL fragment *is* the route — an href of "#main" would navigate to a
 * route called /main, miss every <Route>, and get bounced to the login by the
 * catch-all. Moving focus directly does the same job without touching history.
 */
function SkipLink() {
  return (
    <button
      type="button"
      className="skip-link"
      onClick={() => {
        const main = document.getElementById("main");
        if (!main) return;
        // Not a natural tab stop; -1 lets it receive programmatic focus so the
        // reader starts reading here and the next Tab continues into content.
        main.setAttribute("tabindex", "-1");
        main.focus();
      }}
    >
      Skip to main content
    </button>
  );
}

function Protected({ children }) {
  const { authed, loading } = useAuth();
  if (loading) {
    return (
      // role="status" so the wait is announced. This screen can be up for
      // several seconds while the Supabase session resolves, and it used to be
      // completely silent — indistinguishable from a page that had failed.
      <div className="boot" role="status">
        <div className="ping-dot live" aria-hidden="true" />
        <span className="mono">SEAGRASS GCS</span>
        <span className="visually-hidden">Signing in, please wait…</span>
      </div>
    );
  }
  return authed ? children : <Navigate to="/" replace />;
}

export default function App() {
  return (
    <HashRouter>
      <AuthProvider>
        <DroneProvider>
          <RouteAnnouncer />
          <SkipLink />
          <Routes>
            <Route path="/" element={<LoginPage />} />
            {/* Deliberately NOT wrapped in <Protected>, and ahead of the
                catch-all. Exchanging the recovery code signs the user in, and
                LoginPage sends anyone authed to /fleet — so this has to be a
                route an authed user is allowed to sit on, or the password form
                would never be reachable. */}
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route
              path="/fleet"
              element={
                <Protected>
                  <FleetPage />
                </Protected>
              }
            />
            <Route
              path="/control"
              element={
                <Protected>
                  <ControlPage />
                </Protected>
              }
            />
            <Route
              path="/media"
              element={
                <Protected>
                  <MediaPage />
                </Protected>
              }
            />
            <Route
              path="/settings"
              element={
                <Protected>
                  <SettingsPage />
                </Protected>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </DroneProvider>
      </AuthProvider>
    </HashRouter>
  );
}
