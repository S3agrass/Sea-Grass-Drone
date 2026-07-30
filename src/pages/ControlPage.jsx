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
  DepthMeter,
  SonarGauge,
  BatteryMeter,
  SpeedGauge,
  AltitudeMeter,
  ClimbGauge,
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
      <div className="deck">
        <aside className="deck-left">
          <ConnectionPanel />
        </aside>

        <main className="deck-map">
          <DroneMap
            dronePos={dronePos}
            trail={trail}
            waypoints={waypoints}
            onAddWaypoint={addWaypoint}
            onClearWaypoints={() => setWaypoints([])}
            heading={telemetry.heading}
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
            going spare. */}
        <div className="inst-cluster">
            <Compass heading={telemetry.heading} />
            <DepthMeter depth={telemetry.depth} />
            <SonarGauge
              distance={sonar.distance_m}
              raw={sonar.raw_m}
              confidence={sonar.confidence}
              quality={sonar.quality}
              ok={sonar.ok}
            />
            <SpeedGauge speed={telemetry.groundspeed} />
            <AltitudeMeter altitude={telemetry.altitude} />
            <ClimbGauge climb={telemetry.climb} />
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
            <BatteryMeter level={telemetry.battery} />
        </div>

        {/* Full-width strip under the three columns — the echogram needs
            horizontal room for time history, which the 250px rail can't give. */}
        <SonarView />
      </div>
    </div>
  );
}
