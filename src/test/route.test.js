import { describe, it, expect } from 'vitest';
import { routePoints, routeLegs, routeLength } from '../lib/route';

// "Are the distances accurate?" — checked here against an independent haversine
// implementation and against known ground truth, rather than trusted.

// Leaflet's Earth CRS uses exactly this radius — not the WGS84 mean of
// 6371008.8, which is off by ~1mm per 769m and makes this test fail.
const R = 6371000;

function haversine([lat1, lon1], [lat2, lon2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

describe('route distances', () => {
  it('matches an independent haversine to the millimetre', () => {
    const a = [37.8065, -122.4305];   // Fort Mason
    const b = [37.8102, -122.4231];
    const [leg] = routeLegs([a, b]);
    expect(leg.metres).toBeCloseTo(haversine(a, b), 3);
  });

  it('gets a known ground truth right', () => {
    // One degree of latitude is ~111.19 km on this sphere, everywhere.
    const [leg] = routeLegs([[0, 0], [1, 0]]);
    expect(leg.metres / 1000).toBeCloseTo(111.195, 2);
  });

  it('is accurate enough at survey scale to be worth showing', () => {
    // ~90 m leg. The ellipsoidal (Vincenty) answer differs by well under a
    // metre at this scale — smaller than the GPS fix that produced the points.
    const a = [37.8065, -122.4305];
    const b = [37.80731, -122.4305];
    const [leg] = routeLegs([a, b]);
    expect(leg.metres).toBeGreaterThan(89);
    expect(leg.metres).toBeLessThan(91);
  });

  it('holds up away from the equator, where a flat approximation would not', () => {
    // A degree of longitude shrinks with the cosine of latitude: at 60°N it is
    // half what it is at the equator. Anything treating lat/lon as a plane gets
    // this wrong by 2x, which is the mistake worth pinning.
    const atEquator = routeLegs([[0, 0], [0, 1]])[0].metres;
    const at60 = routeLegs([[60, 0], [60, 1]])[0].metres;
    expect(at60 / atEquator).toBeCloseTo(0.5, 2);
  });

  it('sums the legs for the total', () => {
    const legs = routeLegs([[0, 0], [0, 1], [0, 2]]);
    expect(routeLength(legs)).toBeCloseTo(legs[0].metres + legs[1].metres, 6);
  });

  it('puts each label between its own two points', () => {
    const [leg] = routeLegs([[10, 20], [12, 24]]);
    expect(leg.mid).toEqual([11, 22]);
  });
});

describe('route points', () => {
  it('starts at the vehicle when it has a fix', () => {
    const wps = [[1, 1], [2, 2]];
    expect(routePoints([0, 0], wps)).toEqual([[0, 0], [1, 1], [2, 2]]);
  });

  it('still joins the waypoints when there is no fix', () => {
    // This is the case that used to draw no line at all: the polyline was
    // gated on the drone's position, so with no GPS the distance labels sat
    // between pins with nothing connecting them.
    const wps = [[1, 1], [2, 2]];
    expect(routePoints(null, wps)).toEqual(wps);
    expect(routeLegs(routePoints(null, wps))).toHaveLength(1);
  });

  it('has no legs to draw for a single waypoint', () => {
    expect(routeLegs(routePoints(null, [[1, 1]]))).toEqual([]);
    expect(routeLegs(routePoints(null, []))).toEqual([]);
  });

  it('does not mutate the waypoints it is given', () => {
    const wps = [[1, 1]];
    routePoints([0, 0], wps);
    expect(wps).toEqual([[1, 1]]);
  });
});
