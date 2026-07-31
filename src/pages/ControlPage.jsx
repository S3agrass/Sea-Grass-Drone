import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import TopBar from "../components/TopBar";
import DroneMap from "../components/DroneMap";
import CameraView from "../components/CameraView";
import GamepadControl from "../components/GamepadControl";
import ConnectionPanel from "../components/ConnectionPanel";
import SonarView from "../components/SonarView";
import Toasts from "../components/Toasts";
import {
  Compass,
  SonarGauge,
  VerticalStack,
  CruisePower,
  AttitudeIndicator,
  PIDGauge,
  HeadingHoldGauge,
} from "../components/Instruments";
import { useDrone } from "../context/DroneContext";

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

  const [waypoints, setWaypoints] = useState([]);
  const [trail, setTrail] = useState([]);
  const lastTrailPoint = useRef(null);

  const dronePos = useMemo(
    () =>
      telemetry.lat != null && telemetry.lon != null
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

  if (!activeDrone) return <Navigate to="/fleet" replace />;

  return (
    <div className="app-shell">
      <TopBar />
      <Toasts />
      <div className={`deck ${mapFocus ? "map-focus" : ""}`}>
        <main className="deck-map">
          <DroneMap
            dronePos={dronePos}
            trail={trail}
            waypoints={waypoints}
            onAddWaypoint={addWaypoint}
            onClearWaypoints={() => setWaypoints([])}
            heading={telemetry.heading}
            focused={mapFocus}
            onToggleFocus={() => setMapFocus((f) => !f)}
          />
        </main>

        <aside className="deck-right">
          <CameraView />
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
        <div className="inst-cluster">
            <ConnectionPanel />
            <Compass heading={telemetry.heading} />
            {/* Depth, altitude and climb in one tile; speed and battery in
                another. Ten boxes each carrying an eyebrow, a border and its
                own padding cost more height than what was in them, and the
                strip's height comes straight off the map and the camera. */}
            <VerticalStack
              depth={telemetry.depth}
              altitude={telemetry.altitude}
              climb={telemetry.climb}
            />
            <CruisePower speed={telemetry.groundspeed} battery={telemetry.battery} />
            <SonarGauge
              distance={sonar.distance_m}
              raw={sonar.raw_m}
              confidence={sonar.confidence}
              quality={sonar.quality}
              ok={sonar.ok}
            />
            <AttitudeIndicator
              roll={telemetry.roll}
              pitch={telemetry.pitch}
              yaw={telemetry.yaw}
            />
            <HeadingHoldGauge
              engaged={headingHold.engaged}
              suspended={headingHold.suspended}
              setpoint={headingHold.setpoint}
              heading={headingHold.heading}
              error={headingHold.error}
              output={headingHold.output}
              ok={headingHold.ok}
              armed={armed}
              onEngage={headingHoldOn}
              onRelease={headingHoldOff}
            />
            <PIDGauge
              setpoint={pid.setpoint}
              measurement={pid.measurement}
              error={pid.error}
              output={pid.output}
              ok={pid.ok}
            />
        </div>

        {/* Full-width strip under the three columns — the echogram needs
            horizontal room for time history, which the 250px rail can't give. */}
        <SonarView />
      </div>
    </div>
  );
}
