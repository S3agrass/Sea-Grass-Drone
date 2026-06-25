import { useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, useMapEvents, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix default marker icons
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const droneIcon = L.divIcon({
  className: '',
  html: `<div style="
    width:24px;height:24px;background:#00e5ff;border:2px solid #fff;
    border-radius:50%;box-shadow:0 0 10px #00e5ff88;
    display:flex;align-items:center;justify-content:center;
  "><div style="width:8px;height:8px;background:#fff;border-radius:50%"></div></div>`,
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

const waypointIcon = (index) => L.divIcon({
  className: '',
  html: `<div style="
    width:20px;height:20px;background:#ff6d00;border:2px solid #fff;
    border-radius:50%;display:flex;align-items:center;justify-content:center;
    font-size:9px;color:#fff;font-weight:bold;font-family:monospace;
    box-shadow:0 0 8px #ff6d0088;
  ">${index + 1}</div>`,
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});

function MapClickHandler({ mode, onAddWaypoint }) {
  useMapEvents({
    click(e) {
      if (mode === 'auto') {
        onAddWaypoint([e.latlng.lat, e.latlng.lng]);
      }
    },
  });
  return null;
}

function DroneMarker({ position, heading }) {
  const markerRef = useRef(null);
  useEffect(() => {
    if (markerRef.current) {
      const el = markerRef.current.getElement();
      if (el) el.style.transform += ` rotate(${heading}deg)`;
    }
  }, [heading]);
  return <Marker position={position} icon={droneIcon} ref={markerRef} />;
}

export default function DroneMap({ dronePos, waypoints, onAddWaypoint, mode, heading }) {
  const trailPath = [dronePos, ...waypoints];

  return (
    <div className="map-container">
      {mode === 'auto' && (
        <div className="map-hint">Click map to place waypoints</div>
      )}
      <MapContainer
        center={dronePos}
        zoom={14}
        style={{ width: '100%', height: '100%' }}
        zoomControl={false}
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://carto.com/">CARTO</a>'
        />
        <MapClickHandler mode={mode} onAddWaypoint={onAddWaypoint} />
        {/* Drone position */}
        <DroneMarker position={dronePos} heading={heading} />
        {/* Waypoints */}
        {waypoints.map((wp, i) => (
          <Marker key={i} position={wp} icon={waypointIcon(i)} />
        ))}
        {/* Trail / route line */}
        {waypoints.length > 0 && (
          <Polyline
            positions={trailPath}
            pathOptions={{ color: '#ff6d00', weight: 2, dashArray: '6 4', opacity: 0.8 }}
          />
        )}
      </MapContainer>
    </div>
  );
}
