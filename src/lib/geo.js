// Is this a position the drone actually has, or a placeholder?
//
// ArduPilot fills GLOBAL_POSITION_INT with zeroes until it has a GPS fix, so a
// vehicle that has never seen a satellite reports lat 0, lon 0 — a real point
// in the Gulf of Guinea. The UI's old test was `lat != null`, and 0 is not
// null, so the drone was placed at Null Island: the marker vanished off the
// map, the route line ran from every waypoint to a spot 11,000 km away (which
// from San Francisco leaves the screen at the bottom-right corner), and the leg
// labels reported the distance in earnest.
//
// (0, 0) is therefore read as "no fix". The cost of that choice is a vehicle
// operating within a few metres of Null Island, 600 km off the coast of Ghana,
// being unable to show its position — which is not a trade worth agonising over
// for a coastal survey robot.
export function hasFix(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0)
  );
}
