import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { DroneProvider } from "./context/DroneContext";
import LoginPage from "./pages/LoginPage";
import FleetPage from "./pages/FleetPage";
import ControlPage from "./pages/ControlPage";
import MediaPage from "./pages/MediaPage";
import SettingsPage from "./pages/SettingsPage";
import "./styles/theme.css";
import "./styles/app.css";

function Protected({ children }) {
  const { authed, loading } = useAuth();
  if (loading) {
    return (
      <div className="boot">
        <div className="ping-dot live" />
        <span className="mono">SEAGRASS GCS</span>
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
          <Routes>
            <Route path="/" element={<LoginPage />} />
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
