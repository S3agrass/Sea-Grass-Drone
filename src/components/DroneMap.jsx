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
import { routePoints, routeLegs, routeLength } from "../lib/route";
import WaypointList from "./WaypointList";
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
  onRemoveWaypoint,
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
  // midpoint to hang the label on. The maths lives in src/lib/route.js so the
  // distances can be checked without rendering a map — see its note on how
  // accurate they are.
  const points = useMemo(() => routePoints(dronePos, waypoints), [dronePos, waypoints]);
  const legs = useMemo(() => routeLegs(points), [points]);

  const totalMetres = routeLength(legs);

  return (
    <div className="map-wrap">
      {/* The tile canvas is a graphic with no text equivalent of its own; the
          route it displays is available as text in <WaypointList> below. */}
      <MapContainer
        center={center}
        zoom={15}
        zoomControl={false}
        aria-label="Survey map. Waypoints are listed as text under Route."
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
        {/* Dotted, and drawn from `points` rather than from the drone — with no
            GPS fix there is no vehicle position, and this used to render
            nothing at all, leaving the distance labels floating between pins
            with no line between them. Round caps make the dashes read as dots
            rather than as very short ticks. */}
        {points.length > 1 && (
          <Polyline
            positions={points}
            pathOptions={{
              color: "#ffb454",
              weight: 2.5,
              dashArray: "1 8",
              lineCap: "round",
              opacity: 0.9,
            }}
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
          // aria-pressed on the three mode toggles below: "on" was carried by a
          // CSS class only, so a reader could not tell whether follow, satellite
          // or focus was engaged.
          <button
            className={`map-btn ${focused ? "on" : ""}`}
            aria-pressed={focused}
            title={
              focused
                ? "Bring the camera and instruments back"
                : "Give the map the whole deck"
            }
            onClick={onToggleFocus}
          >
            <span aria-hidden="true">{focused ? "⤡ " : "⛶ "}</span>
            {focused ? "Exit focus" : "Focus map"}
          </button>
        )}
        <button
          className={`map-btn ${locating ? "busy" : ""}`}
          title="Fly to my location"
          onClick={locateMe}
          aria-busy={locating}
        >
          <span aria-hidden="true">◎ </span>
          {locating ? "Locating…" : "My location"}
        </button>
        <button
          className={`map-btn ${follow ? "on" : ""}`}
          title="Keep the drone centered"
          onClick={() => setFollow((f) => !f)}
          aria-pressed={follow}
        >
          <span aria-hidden="true">⌖ </span>Follow drone
        </button>
        <button
          className={`map-btn ${satellite ? "on" : ""}`}
          onClick={() => setSatellite((s) => !s)}
          aria-pressed={satellite}
          aria-label="Satellite imagery"
        >
          <span aria-hidden="true">▤ </span>
          {satellite ? "Dark map" : "Satellite"}
        </button>
        {waypoints.length > 0 && (
          <button className="map-btn danger" onClick={onClearWaypoints}>
            <span aria-hidden="true">✕ </span>
            Clear {waypoints.length} waypoint{waypoints.length === 1 ? "" : "s"}
          </button>
        )}
      </div>
      {/* Polite live region: the route total changes as waypoints are added or
          removed, and it is the only confirmation that the click or the Add
          button did anything. */}
      <div className="map-hint mono" role="status" aria-live="polite">
        {legs.length > 0
          ? `Route ${formatDistance(totalMetres)} · ${legs.length} leg${legs.length === 1 ? "" : "s"}`
          : "Click the map to drop a waypoint"}
      </div>

      <WaypointList
        waypoints={waypoints}
        dronePos={dronePos}
        onAddWaypoint={onAddWaypoint}
        onRemoveWaypoint={onRemoveWaypoint}
        onClearWaypoints={onClearWaypoints}
      />
    </div>
  );
}
