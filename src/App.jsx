import { useState, useEffect, useCallback, useRef } from "react";
import Compass from "./components/Compass";
import DepthMeter from "./components/DepthMeter";
import BatteryMeter from "./components/BatteryMeter";
import DroneMap from "./components/DroneMap";
import CameraView from "./components/CameraView";
import "./App.css";

const START_POS = [25.7617, -80.1918]; // Miami coast

export default function App() {
	const [mode, setMode] = useState("manual"); // 'manual' | 'auto'
	const [heading, setHeading] = useState(45);
	const [depth, setDepth] = useState(12.5);
	const [battery, setBattery] = useState(78);
	const [speed, setSpeed] = useState(2.4);
	const [dronePos, setDronePos] = useState(START_POS);
	const [userLocation, setUserLocation] = useState(null);
	const [waypoints, setWaypoints] = useState([]);
	const [autoProgress, setAutoProgress] = useState(0);
	const hasSetInitialLocation = useRef(false);

	useEffect(() => {
		if (!navigator.geolocation) return;

		const onSuccess = (position) => {
			const coords = [position.coords.latitude, position.coords.longitude];
			setUserLocation(coords);
			if (!hasSetInitialLocation.current) {
				setDronePos(coords);
				hasSetInitialLocation.current = true;
			}
		};

		const onError = () => {
			console.warn("Unable to retrieve your location.");
		};

		const watchId = navigator.geolocation.watchPosition(onSuccess, onError, {
			enableHighAccuracy: true,
			maximumAge: 10000,
			timeout: 10000,
		});

		return () => navigator.geolocation.clearWatch(watchId);
	}, []);

	// Auto-mode: move drone toward next waypoint
	useEffect(() => {
		if (mode !== "auto" || waypoints.length === 0) return;
		const targetIdx = autoProgress % waypoints.length;
		const target = waypoints[targetIdx];
		const id = setInterval(() => {
			setDronePos((pos) => {
				const dlat = target[0] - pos[0];
				const dlng = target[1] - pos[1];
				const dist = Math.sqrt(dlat * dlat + dlng * dlng);
				if (dist < 0.0001) {
					setAutoProgress((p) => p + 1);
					return pos;
				}
				const step = 0.00003;
				const newHeading = (Math.atan2(dlng, dlat) * 180) / Math.PI;
				setHeading(newHeading);
				return [pos[0] + (dlat / dist) * step, pos[1] + (dlng / dist) * step];
			});
		}, 200);
		return () => clearInterval(id);
	}, [mode, waypoints, autoProgress]);

	const addWaypoint = useCallback((pos) => {
		setWaypoints((wps) => [...wps, pos]);
	}, []);

	const clearWaypoints = () => {
		setWaypoints([]);
		setAutoProgress(0);
	};

	return (
		<div className="app">
			{/* Top bar */}
			<header className="topbar">
				<div className="topbar-brand">
					<span className="brand-icon">🌊</span>
					<span className="brand-name">SEAGRASS</span>
					<span className="brand-sub">AQUATIC DRONE CONTROL</span>
				</div>
				<div className="topbar-status">
					<div
						className={`status-dot ${mode === "auto" ? "auto" : "manual"}`}
					/>
					<span className="status-text">
						{mode === "auto" ? "AUTONOMOUS" : "MANUAL CONTROL"}
					</span>
					<div className="signal-bars">
						{[1, 2, 3, 4].map((b) => (
							<div key={b} className={`bar bar-${b}`} />
						))}
					</div>
					<span className="signal-label">SIGNAL STRONG</span>
				</div>
				<div className="topbar-coords">
					<span>{dronePos[0].toFixed(5)}°N</span>
					<span>{Math.abs(dronePos[1]).toFixed(5)}°W</span>
				</div>
			</header>

			<div className="main-layout">
				{/* Left sidebar */}
				<aside className="sidebar-left">
					<Compass heading={heading} />
					<div className="divider" />
					<DepthMeter depth={depth} maxDepth={200} />
					<div className="divider" />
					<BatteryMeter level={Math.round(battery)} />
					<div className="divider" />
					{/* Speed */}
					<div className="stat-block">
						<div className="depth-label">SPEED</div>
						<div className="stat-value">
							{speed.toFixed(1)} <span className="stat-unit">kn</span>
						</div>
						<div className="speed-bar">
							<div
								className="speed-fill"
								style={{ width: `${(speed / 5) * 100}%` }}
							/>
						</div>
					</div>
					<div className="divider" />
					{/* Mode toggle */}
					<div className="mode-panel">
						<div className="depth-label">CONTROL MODE</div>
						<div className="mode-buttons">
							<button
								className={`mode-btn ${mode === "manual" ? "active-manual" : ""}`}
								onClick={() => setMode("manual")}
							>
								🕹 MANUAL
							</button>
							<button
								className={`mode-btn ${mode === "auto" ? "active-auto" : ""}`}
								onClick={() => setMode("auto")}
							>
								🤖 AUTO
							</button>
						</div>
						<div className={`mode-indicator ${mode}`}>
							<div className={`mode-led ${mode}`} />
							{mode === "auto" ? "AUTONOMOUS ACTIVE" : "MANUAL ACTIVE"}
						</div>
					</div>
				</aside>

				{/* Center: map */}
				<main className="center-panel">
					<div className="map-header">
						<span className="panel-title">NAVIGATION MAP</span>
						<div className="map-actions">
							{waypoints.length > 0 && (
								<span className="waypoint-count">
									{waypoints.length} waypoint{waypoints.length !== 1 ? "s" : ""}
								</span>
							)}
							{waypoints.length > 0 && (
								<button className="clear-btn" onClick={clearWaypoints}>
									CLEAR TRAIL
								</button>
							)}
						</div>
					</div>
					<DroneMap
						dronePos={dronePos}
						userLocation={userLocation}
						waypoints={waypoints}
						onAddWaypoint={addWaypoint}
						mode={mode}
						heading={heading}
					/>
				</main>

				{/* Right sidebar */}
				<aside className="sidebar-right">
					<CameraView />
				</aside>
			</div>
		</div>
	);
}
