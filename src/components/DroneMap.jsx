import { useEffect, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Polyline,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const FALLBACK_CENTER = [37.8065, -122.4305]; // Fort Mason, San Francisco

const droneIcon = L.divIcon({
  className: "",
  html: `<div class="marker-drone"><div></div></div>`,
  iconSize: [26, 26],
  iconAnchor: [13, 13],
});

const userIcon = L.divIcon({
  className: "",
  html: `<div class="marker-user"></div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

const waypointIcon = (i) =>
  L.divIcon({
    className: "",
    html: `<div class="marker-waypoint">${i + 1}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });

function ClickHandler({ onAddWaypoint }) {
  useMapEvents({
    click(e) {
      onAddWaypoint([e.latlng.lat, e.latlng.lng]);
    },
  });
  return null;
}

/** Imperatively controls the map: fly-to requests + follow mode. */
function MapController({ flyTarget, follow, dronePos }) {
  const map = useMap();
  useEffect(() => {
    if (flyTarget) map.flyTo(flyTarget.pos, flyTarget.zoom ?? 16, { duration: 1.2 });
  }, [flyTarget, map]);
  useEffect(() => {
    if (follow && dronePos) map.panTo(dronePos, { animate: true });
  }, [follow, dronePos, map]);
  return null;
}

export default function DroneMap({
  dronePos,
  trail,
  waypoints,
  onAddWaypoint,
  onClearWaypoints,
  heading,
}) {
  const [userPos, setUserPos] = useState(null);
  const [flyTarget, setFlyTarget] = useState(null);
  const [follow, setFollow] = useState(false);
  const [satellite, setSatellite] = useState(false);
  const [locating, setLocating] = useState(false);
  const flewOnce = useRef(false);

  // Watch real device location; fly there on first fix.
  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const pos = [p.coords.latitude, p.coords.longitude];
        setUserPos(pos);
        if (!flewOnce.current) {
          flewOnce.current = true;
          setFlyTarget({ pos, zoom: 16 });
        }
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  function locateMe() {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const pos = [p.coords.latitude, p.coords.longitude];
        setUserPos(pos);
        setFlyTarget({ pos, zoom: 17 });
        setLocating(false);
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  const center = dronePos || userPos || FALLBACK_CENTER;

  return (
    <div className="map-wrap">
      <MapContainer
        center={center}
        zoom={15}
        zoomControl={false}
        style={{ width: "100%", height: "100%" }}
      >
        {satellite ? (
          <TileLayer
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            attribution="Tiles &copy; Esri"
          />
        ) : (
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            attribution='&copy; <a href="https://carto.com/">CARTO</a>'
          />
        )}
        <MapController flyTarget={flyTarget} follow={follow} dronePos={dronePos} />
        <ClickHandler onAddWaypoint={onAddWaypoint} />

        {userPos && (
          <Marker position={userPos} icon={userIcon} zIndexOffset={900}>
            <Popup>Your location</Popup>
          </Marker>
        )}

        {dronePos && (
          <Marker position={dronePos} icon={droneIcon} zIndexOffset={1000}>
            <Popup>
              Seagrass · heading {heading == null ? "—" : `${Math.round(heading)}°`}
            </Popup>
          </Marker>
        )}

        {trail.length > 1 && (
          <Polyline
            positions={trail}
            pathOptions={{ color: "#3bd9bb", weight: 2, opacity: 0.65 }}
          />
        )}

        {waypoints.map((wp, i) => (
          <Marker key={`${wp[0]}-${wp[1]}-${i}`} position={wp} icon={waypointIcon(i)} />
        ))}
        {waypoints.length > 0 && dronePos && (
          <Polyline
            positions={[dronePos, ...waypoints]}
            pathOptions={{ color: "#ffb454", weight: 2, dashArray: "6 5", opacity: 0.85 }}
          />
        )}
      </MapContainer>

      {/* floating controls */}
      <div className="map-controls">
        <button
          className={`map-btn ${locating ? "busy" : ""}`}
          title="Fly to my location"
          onClick={locateMe}
        >
          ◎ {locating ? "Locating…" : "My location"}
        </button>
        <button
          className={`map-btn ${follow ? "on" : ""}`}
          title="Keep the drone centered"
          onClick={() => setFollow((f) => !f)}
        >
          ⌖ Follow drone
        </button>
        <button
          className={`map-btn ${satellite ? "on" : ""}`}
          onClick={() => setSatellite((s) => !s)}
        >
          ▤ {satellite ? "Dark map" : "Satellite"}
        </button>
        {waypoints.length > 0 && (
          <button className="map-btn danger" onClick={onClearWaypoints}>
            ✕ Clear {waypoints.length} waypoint{waypoints.length === 1 ? "" : "s"}
          </button>
        )}
      </div>
      <div className="map-hint mono">Click the map to drop a waypoint</div>
    </div>
  );
}
