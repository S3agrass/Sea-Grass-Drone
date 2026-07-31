import { useEffect, useMemo, useRef, useState } from "react";
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

/** "48 m" up close, "1.24 km" once a leg is long enough that metres are noise. */
function formatDistance(metres) {
  if (!Number.isFinite(metres)) return "—";
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(2)} km`;
}

/** Midpoint label for one leg of the route. */
const legIcon = (text) =>
  L.divIcon({
    className: "",
    html: `<div class="leg-label mono">${text}</div>`,
    // Zero-size icon: the label is centred on the point by a CSS transform
    // instead, because its width depends on the text and a fixed iconAnchor
    // would put "1.24 km" and "8 m" in visibly different places.
    iconSize: [0, 0],
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

// Leaflet sizes its viewport once and caches it. Anything that changes the
// container's box without a window resize — entering focus mode, the sonar
// strip folding — leaves it drawing tiles for the old size: grey gutters where
// the map grew, and clicks landing at the wrong coordinates because the pixel
// origin is stale. An observer is better than invalidating on the focus prop:
// it also covers the strips collapsing and the window itself.
function KeepSized() {
  const map = useMap();
  useEffect(() => {
    const target = map.getContainer();
    const ro = new ResizeObserver(() => map.invalidateSize({ animate: false }));
    ro.observe(target);
    return () => ro.disconnect();
  }, [map]);
  return null;
}

export default function DroneMap({
  dronePos,
  trail,
  waypoints,
  onAddWaypoint,
  onClearWaypoints,
  heading,
  focused = false,
  onToggleFocus,
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

  // Route legs: drone -> wp1 -> wp2 ... Each leg carries its own length and the
  // midpoint to hang the label on. Leaflet's distanceTo does proper spherical
  // distance, so this stays honest at any latitude — no flat-earth approximation.
  const legs = useMemo(() => {
    const points = dronePos ? [dronePos, ...waypoints] : waypoints;
    const out = [];
    for (let i = 1; i < points.length; i++) {
      const a = L.latLng(points[i - 1]);
      const b = L.latLng(points[i]);
      out.push({
        mid: [(a.lat + b.lat) / 2, (a.lng + b.lng) / 2],
        metres: a.distanceTo(b),
      });
    }
    return out;
  }, [dronePos, waypoints]);

  const totalMetres = legs.reduce((sum, leg) => sum + leg.metres, 0);

  return (
    <div className="map-wrap">
      <MapContainer
        center={center}
        zoom={15}
        zoomControl={false}
        style={{ width: "100%", height: "100%" }}
      >
        <KeepSized />
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

        {/* Leg lengths, pinned to each segment's midpoint. `interactive={false}`
            matters: a clickable label would swallow the map click underneath it
            and silently refuse to drop a waypoint there. */}
        {legs.map((leg, i) => (
          <Marker
            key={`leg-${i}-${leg.mid[0]}-${leg.mid[1]}`}
            position={leg.mid}
            icon={legIcon(formatDistance(leg.metres))}
            interactive={false}
            zIndexOffset={800}
          />
        ))}
      </MapContainer>

      {/* floating controls */}
      <div className="map-controls">
        {onToggleFocus && (
          <button
            className={`map-btn ${focused ? "on" : ""}`}
            title={
              focused
                ? "Bring the camera and instruments back"
                : "Give the map the whole deck"
            }
            onClick={onToggleFocus}
          >
            {focused ? "⤡ Exit focus" : "⛶ Focus map"}
          </button>
        )}
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
      <div className="map-hint mono">
        {legs.length > 0
          ? `Route ${formatDistance(totalMetres)} · ${legs.length} leg${legs.length === 1 ? "" : "s"}`
          : "Click the map to drop a waypoint"}
      </div>
    </div>
  );
}
