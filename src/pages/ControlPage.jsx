import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import TopBar from "../components/TopBar";
import DroneMap from "../components/DroneMap";
import CameraView from "../components/CameraView";
import GamepadControl from "../components/GamepadControl";
import ConnectionPanel from "../components/ConnectionPanel";
import SonarView from "../components/SonarView";
import Resizer from "../components/Resizer";
import Toasts from "../components/Toasts";
import FlightStatus from "../components/FlightStatus";
import {
  SonarGauge,
  AttitudeIndicator,
  Vitals,
  Autopilot,
} from "../components/Instruments";
import { useDrone } from "../context/DroneContext";
import { hasFix } from "../lib/geo";

/** A stored panel size, or null when the operator has never set one. Anything
 *  unparseable is treated as unset rather than trusted into the layout. */
function readSize(key) {
  const raw = Number(localStorage.getItem(key));
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

function writeSize(key, value) {
  if (value == null) localStorage.removeItem(key);
  else localStorage.setItem(key, String(value));
}

export default function ControlPage() {
  const {
    activeDrone, telemetry, sonar, pid,
    headingHold, headingHoldOn, headingHoldOff, armed,
  } = useDrone();
  // Focus mode: the map takes the whole deck. Every dial in theme.css is at its
  // floor (--sonar-h 84px, gaps 8px, the left rail already deleted), so the only
  // space left to give the map is space something else is currently using. This
  // borrows it a click at a time instead of taking it permanently. Persisted,
  // like the sonar strip's fold, so it survives a reload mid-survey.
  const [mapFocus, setMapFocus] = useState(
    () => localStorage.getItem("seagrass-map-focus") === "1",
  );
  useEffect(() => {
    localStorage.setItem("seagrass-map-focus", mapFocus ? "1" : "0");
  }, [mapFocus]);

  // The instrument strip folds, like the sonar one below it. Row 1 (map and
  // camera) is the deck's only 1fr, so it swallows whatever the strips give up
  // — folding this hands its whole height to the map and the camera, and unlike
  // focus mode it keeps the camera on screen. Persisted: an operator who wants
  // the readouts out of the way wants them out of the way for the dive.
  const [instCollapsed, setInstCollapsed] = useState(
    () => localStorage.getItem("seagrass-inst-collapsed") === "1",
  );
  useEffect(() => {
    localStorage.setItem("seagrass-inst-collapsed", instCollapsed ? "1" : "0");
  }, [instCollapsed]);

  // Operator-set panel sizes. null means "whatever the stylesheet says", which
  // is how a deck that has never been dragged still follows the theme's clamp()
  // across window sizes — storing a default the moment the page loads would
  // freeze every screen to whatever the first one happened to be.
  const [railW, setRailW] = useState(() => readSize("seagrass-rail-w"));
  const [stripH, setStripH] = useState(() => readSize("seagrass-strip-h"));
  useEffect(() => writeSize("seagrass-rail-w", railW), [railW]);
  useEffect(() => writeSize("seagrass-strip-h", stripH), [stripH]);

  const railRef = useRef(null);
  const stripRef = useRef(null);

  const [waypoints, setWaypoints] = useState([]);
  const [trail, setTrail] = useState([]);
  const lastTrailPoint = useRef(null);

  // hasFix, not a null check: the Pixhawk reports 0/0 before it has a GPS fix,
  // and 0 is not null. See src/lib/geo.js for what that did to the map.
  const dronePos = useMemo(
    () =>
      hasFix(telemetry.lat, telemetry.lon)
        ? [telemetry.lat, telemetry.lon]
        : null,
    [telemetry.lat, telemetry.lon],
  );

  // Breadcrumb trail of where the drone has actually been.
  useEffect(() => {
    if (!dronePos) return;
    const last = lastTrailPoint.current;
    if (
      !last ||
      Math.abs(last[0] - dronePos[0]) > 1e-6 ||
      Math.abs(last[1] - dronePos[1]) > 1e-6
    ) {
      lastTrailPoint.current = dronePos;
      setTrail((t) => [...t.slice(-500), dronePos]);
    }
  }, [dronePos]);

  const addWaypoint = useCallback(
    (pos) => setWaypoints((wps) => [...wps, pos]),
    [],
  );

  // Removing one waypoint rather than the whole route. Clicking a pin was never
  // wired to anything, so before the keyboard route editor existed the only way
  // to undo a misplaced mark was to clear every mark.
  const removeWaypoint = useCallback(
    (index) => setWaypoints((wps) => wps.filter((_, i) => i !== index)),
    [],
  );

  if (!activeDrone) return <Navigate to="/fleet" replace />;

  return (
    <div className="app-shell">
      <TopBar />
      <Toasts />
      {/* <main> now wraps the whole deck. It used to wrap only the map, which
          left the camera, the sonar, the helm and every instrument outside any
          landmark at all — a screen reader jumping to "main content" on the
          app's primary screen landed on the map and could reach none of the
          rest by landmark. */}
      <main
        id="main"
        className={`deck ${mapFocus ? "map-focus" : ""}`}
        style={{
          ...(railW ? { "--deck-right-w": `${railW}px` } : null),
          ...(stripH ? { "--deck-strip-h": `${stripH}px` } : null),
        }}
      >
        {/* The flight deck had no h1 whatsoever. Visually the top bar's brand
            block does this job, so the heading is for readers only — but the
            page still needs one, both as a landmark-free navigation anchor and
            as the target the router moves focus to on arrival. */}
        <h1 className="visually-hidden" id="page-title" tabIndex={-1}>
          Flight deck — {activeDrone.name}
        </h1>
        <FlightStatus />

        <section className="deck-map" aria-label="Map">
          <DroneMap
            dronePos={dronePos}
            trail={trail}
            waypoints={waypoints}
            onAddWaypoint={addWaypoint}
            onRemoveWaypoint={removeWaypoint}
            onClearWaypoints={() => setWaypoints([])}
            heading={telemetry.heading}
            focused={mapFocus}
            onToggleFocus={() => setMapFocus((f) => !f)}
          />
        </section>

        <aside className="deck-right" ref={railRef} aria-label="Camera, sonar and helm">
          <Resizer
            orientation="vertical"
            value={railW}
            min={300}
            max={900}
            measure={() => railRef.current?.getBoundingClientRect().width ?? 420}
            onChange={setRailW}
            onReset={() => setRailW(null)}
            label="Camera and sonar rail width"
          />
          <CameraView />
          {/* The sonar lives in the rail now, next to the other sensor. As a
              full-width strip of its own it cost the deck a whole row — about
              145px — and row 1 is the only 1fr, so the map paid for all of it.
              The echogram gets less time history at this width; that is the
              trade for a map that is ~120px taller. Fold it if you want the
              rail's height back for the camera. */}
          <SonarView />
          <GamepadControl />
        </aside>

        {/* Instruments run as a full-width strip rather than down the left
            rail. Ten of them stacked in a 250px column came to ~1210px of
            content in ~790px of deck, so the rail always scrolled and you
            could never see all your telemetry at once. Laid out across the
            deck's width they fit on screen, and they use room the map had
            going spare.

            The link panel joins them here, and the left rail is gone with it.
            That rail was a full-height 220px column holding this one short
            panel and then several hundred pixels of nothing, all of it taken
            off the map's width. As a wide tile in this strip it costs three
            columns of a row that had spare capacity, and the map gets the
            whole rail back. */}
        <section
          className={`inst-cluster${instCollapsed ? " collapsed" : ""}`}
          ref={stripRef}
          aria-label="Instruments"
          id="inst-cluster"
        >
          {!instCollapsed && (
            <Resizer
              orientation="horizontal"
              value={stripH}
              min={64}
              max={520}
              measure={() => stripRef.current?.getBoundingClientRect().height ?? 150}
              onChange={setStripH}
              onReset={() => setStripH(null)}
              label="Instrument strip height"
            />
          )}
            {/* Absolutely positioned so it costs the strip no height while
                open — a header row here would take back some of what folding
                is meant to give the map. */}
            {/* Expanded, this button's entire content is the glyph "▾" — an
                unnamed control, since `title` is not a reliable accessible name
                and is unreachable by touch and keyboard. aria-label names it in
                both states and aria-controls ties it to what it folds. */}
            <button
              className="strip-collapse inst-collapse"
              onClick={() => setInstCollapsed((c) => !c)}
              aria-expanded={!instCollapsed}
              aria-controls="inst-cluster"
              aria-label={instCollapsed ? "Show the instruments" : "Hide the instruments"}
              title={
                instCollapsed
                  ? "Show the instruments"
                  : "Hide the instruments and give the space to the map and camera"
              }
            >
              <span aria-hidden="true">{instCollapsed ? "▸ Instruments" : "▾"}</span>
            </button>
            <ConnectionPanel />
            {/* Compass is gone: heading is on the attitude tile, and the map
                carries its own heading arrow on the vehicle itself — a third
                copy of one number was a whole tile of the strip. */}
            <AttitudeIndicator
              roll={telemetry.roll}
              pitch={telemetry.pitch}
              yaw={telemetry.yaw}
            />
            <Vitals
              depth={telemetry.depth}
              altitude={telemetry.altitude}
              climb={telemetry.climb}
              speed={telemetry.groundspeed}
              battery={telemetry.battery}
            />
            <SonarGauge
              distance={sonar.distance_m}
              raw={sonar.raw_m}
              confidence={sonar.confidence}
              quality={sonar.quality}
              ok={sonar.ok}
            />
            <Autopilot
              headingHold={headingHold}
              pid={pid}
              armed={armed}
              onEngage={headingHoldOn}
              onRelease={headingHoldOff}
            />
        </section>


      </main>
    </div>
  );
}
