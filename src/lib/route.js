import L from "leaflet";

// Route geometry, kept out of the map component so the numbers on screen can be
// checked without rendering Leaflet.
//
// ON ACCURACY: distances come from Leaflet's `distanceTo`, which is the
// haversine formula on a sphere of radius 6371000 m exactly (its Earth CRS —
// not the WGS84 mean of 6371008.8, a difference of about 1mm per 770m).
// It is a great-circle distance, not an ellipsoidal one, so it runs up to about
// 0.3% out against Vincenty — worst at high latitudes, and in the direction of
// under-reporting near the poles. On a 200 m survey leg that is well under a
// metre, which is smaller than the GPS fix that produced the endpoints. It is
// also horizontal only: a leg that changes depth is longer than this says.

/** The points a route runs through: the vehicle, then every waypoint in order.
 *  Without a GPS fix there is no vehicle position to start from, and the route
 *  is simply the waypoints — which is the case that used to render no line at
 *  all, leaving distance labels floating between unconnected pins. */
export function routePoints(dronePos, waypoints = []) {
  return dronePos ? [dronePos, ...waypoints] : [...waypoints];
}

/** Each leg's length and the midpoint to hang its label on. */
export function routeLegs(points = []) {
  const out = [];
  for (let i = 1; i < points.length; i += 1) {
    const a = L.latLng(points[i - 1]);
    const b = L.latLng(points[i]);
    out.push({
      // Midpoint by average, which is a straight-line midpoint in lat/lon
      // rather than a great-circle one. Over a survey leg the two are within
      // centimetres of each other, and this only positions a label.
      mid: [(a.lat + b.lat) / 2, (a.lng + b.lng) / 2],
      metres: a.distanceTo(b),
    });
  }
  return out;
}

/** Total route length in metres. */
export function routeLength(legs = []) {
  return legs.reduce((sum, leg) => sum + leg.metres, 0);
}
