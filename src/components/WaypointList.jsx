import { useState } from "react";

function fmtCoord(n) {
  return Number(n).toFixed(5);
}

/**
 * The keyboard's route editor.
 *
 * Waypoints could only be created by clicking a point on the Leaflet canvas.
 * There was no keyboard path to add one, no way to reach an individual pin once
 * placed, and the only removal was "Clear all" — so route planning, which is
 * most of what this application is for, was a mouse-only feature. That is a
 * plain SC 2.1.1 failure and no amount of labelling fixes it; the operation
 * itself has to exist for the keyboard.
 *
 * So the route also exists as text: a list of waypoints with their coordinates,
 * each removable on its own, plus two ways to add one without pointing at
 * anything — at the drone's current position, or by typing a latitude and
 * longitude. This is not a lesser parallel version, it is the same route; the
 * map and this list read and write the same array.
 *
 * A <details> so it costs the deck almost no room when closed, and is reachable
 * by Tab in one stop when it is wanted.
 */
export default function WaypointList({
  waypoints = [],
  dronePos,
  onAddWaypoint,
  onRemoveWaypoint,
  onClearWaypoints,
}) {
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [error, setError] = useState("");

  function addTyped(event) {
    event.preventDefault();
    const latN = Number(lat);
    const lonN = Number(lon);
    if (!lat.trim() || !lon.trim() || Number.isNaN(latN) || Number.isNaN(lonN)) {
      setError("Enter a latitude and longitude as numbers.");
      return;
    }
    if (latN < -90 || latN > 90) {
      setError("Latitude must be between −90 and 90.");
      return;
    }
    if (lonN < -180 || lonN > 180) {
      setError("Longitude must be between −180 and 180.");
      return;
    }
    setError("");
    onAddWaypoint?.([latN, lonN]);
    setLat("");
    setLon("");
  }

  return (
    <details className="waypoint-panel">
      <summary className="waypoint-summary mono">
        Route ({waypoints.length} waypoint{waypoints.length === 1 ? "" : "s"})
      </summary>

      <div className="waypoint-body">
        <div className="waypoint-adders">
          {/* The common case, and the one that needs no typing: put a mark
              where the vehicle is. Disabled without a fix, because there is no
              position to use — with the reason given rather than implied. */}
          <button
            type="button"
            className="btn btn-small"
            onClick={() => dronePos && onAddWaypoint?.(dronePos)}
            aria-disabled={!dronePos}
            aria-describedby={dronePos ? undefined : "waypoint-nofix"}
          >
            Add at drone position
          </button>
          {!dronePos && (
            <span className="field-hint" id="waypoint-nofix">
              No GPS fix yet, so there is no position to add.
            </span>
          )}
        </div>

        <form className="waypoint-form" onSubmit={addTyped}>
          <div className="field">
            <label className="eyebrow" htmlFor="wp-lat">Latitude</label>
            <input
              id="wp-lat"
              className="mono"
              value={lat}
              inputMode="decimal"
              placeholder="37.80650"
              aria-invalid={error ? true : undefined}
              aria-describedby="wp-error"
              onChange={(e) => setLat(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="eyebrow" htmlFor="wp-lon">Longitude</label>
            <input
              id="wp-lon"
              className="mono"
              value={lon}
              inputMode="decimal"
              placeholder="-122.43050"
              aria-invalid={error ? true : undefined}
              aria-describedby="wp-error"
              onChange={(e) => setLon(e.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-small">Add waypoint</button>
          <div id="wp-error" role="alert" aria-live="assertive">
            {error && <div className="login-error">{error}</div>}
          </div>
        </form>

        {waypoints.length === 0 ? (
          <p className="field-hint">
            No waypoints yet. Add one above, or click the map.
          </p>
        ) : (
          <ol className="waypoint-items mono">
            {waypoints.map((wp, i) => (
              <li key={`${wp[0]}-${wp[1]}-${i}`}>
                <span>
                  {i + 1}. {fmtCoord(wp[0])}, {fmtCoord(wp[1])}
                </span>
                {/* Per-waypoint removal — previously the route could only be
                    destroyed wholesale. */}
                <button
                  type="button"
                  className="btn-small"
                  onClick={() => onRemoveWaypoint?.(i)}
                  aria-label={`Remove waypoint ${i + 1} at ${fmtCoord(wp[0])}, ${fmtCoord(wp[1])}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ol>
        )}

        {waypoints.length > 0 && (
          <button type="button" className="btn-small" onClick={onClearWaypoints}>
            Clear all waypoints
          </button>
        )}
      </div>
    </details>
  );
}
