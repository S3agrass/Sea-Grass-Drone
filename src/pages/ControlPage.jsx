import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import TopBar from "../components/TopBar";
import DroneMap from "../components/DroneMap";
import CameraView from "../components/CameraView";
import GamepadControl from "../components/GamepadControl";
import ConnectionPanel from "../components/ConnectionPanel";
import Toasts from "../components/Toasts";
import {
  Compass,
  DepthMeter,
  SonarGauge,
  BatteryMeter,
  SpeedGauge,
} from "../components/Instruments";
import { useDrone } from "../context/DroneContext";

export default function ControlPage() {
  const { activeDrone, telemetry, sonar } = useDrone();
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
            <BatteryMeter level={telemetry.battery} />
          </div>
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
      </div>
    </div>
  );
}
