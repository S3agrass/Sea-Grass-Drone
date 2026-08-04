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

      {/* Not a live region. The coordinates change continuously, so announcing
          this block would never stop talking; the link going up or down is the
          part worth interrupting for and <FlightStatus> owns that. The labels
          are spelled out because "LINK LIVE" next to a green dot is a visual
          idiom, and the reading is for someone who cannot see the dot. */}
      <div className="topbar-center mono">
        <span className={`ping-dot ${connected ? "live" : "off"}`} aria-hidden="true" />
        <span>
          <span aria-hidden="true">{connected ? "LINK LIVE" : "LINK DOWN"}</span>
          <span className="visually-hidden">
            {connected ? "Drone link is live" : "Drone link is down"}
          </span>
        </span>
        <span className="topbar-sep" aria-hidden="true">·</span>
        <span>
          {telemetry.lat != null && telemetry.lon != null
            ? `${telemetry.lat.toFixed(5)}, ${telemetry.lon.toFixed(5)}`
            : "NO GPS FIX"}
        </span>
      </div>

      {/* Named, because a page with more than one nav needs them told apart,
          and aria-current so "which page am I on" is carried by something other
          than a CSS class — the .active styling is invisible to a reader. */}
      <nav className="topbar-nav" aria-label="Primary">
        {[
          ["/control", "Control"],
          ["/media", "Media"],
          ["/fleet", "Fleet"],
          ["/settings", "Settings"],
        ].map(([to, label]) => (
          <Link
            key={to}
            to={to}
            className={pathname === to ? "active" : ""}
            aria-current={pathname === to ? "page" : undefined}
          >
            {label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
