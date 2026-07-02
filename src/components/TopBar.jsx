import { Link, useLocation } from "react-router-dom";
import { useDrone } from "../context/DroneContext";

export default function TopBar() {
  const { activeDrone, linkStatus, telemetry, demoMode } = useDrone();
  const { pathname } = useLocation();
  const connected = linkStatus === "connected";

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path d="M4 16c2-4 3-10 3-13 1 3 2 9 1 13M11 16c1.5-3.5 2.5-8 2.5-11 .8 2.6 1.7 7.5 1 11M18 16c1-2.5 1.6-5.5 1.6-8 .7 2 1.2 5.5.6 8" fill="none" stroke="var(--teal)" strokeWidth="1.6" strokeLinecap="round"/>
            <path d="M2 19c3 1.6 6 1.6 9 0s6-1.6 9 0" fill="none" stroke="var(--blue)" strokeWidth="1.6" strokeLinecap="round"/>
          </svg>
        </span>
        <span className="brand-name">SEAGRASS</span>
        {activeDrone && <span className="brand-sub">{activeDrone.name}</span>}
        {demoMode && <span className="demo-chip mono">DEMO</span>}
      </div>

      <div className="topbar-center mono">
        <span className={`ping-dot ${connected ? "live" : "off"}`} />
        <span>{connected ? "LINK LIVE" : "LINK DOWN"}</span>
        <span className="topbar-sep">·</span>
        <span>
          {telemetry.lat != null && telemetry.lon != null
            ? `${telemetry.lat.toFixed(5)}, ${telemetry.lon.toFixed(5)}`
            : "NO GPS FIX"}
        </span>
      </div>

      <nav className="topbar-nav">
        <Link className={pathname === "/control" ? "active" : ""} to="/control">
          Control
        </Link>
        <Link className={pathname === "/fleet" ? "active" : ""} to="/fleet">
          Fleet
        </Link>
        <Link className={pathname === "/settings" ? "active" : ""} to="/settings">
          Settings
        </Link>
      </nav>
    </header>
  );
}
