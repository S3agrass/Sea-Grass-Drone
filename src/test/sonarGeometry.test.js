import { describe, it, expect } from 'vitest';
import {
  amplitudeToRGB,
  sampleToRange,
  rangeToRow,
  sectorIndex,
  sectorMemoryToPoints,
  clusterContacts,
  decomposeRange,
  findEchoes,
  mapPointXY,
  peakRange,
  planHalfAngleDeg,
  povBlipStyle,
  povRingRadius,
  PING_BEAM_DEG,
  PING_MIN_RANGE_M,
} from '../lib/sonarGeometry';

describe('amplitudeToRGB', () => {
  it('maps 0 to the abyss background and 255 to the hot end', () => {
    expect(amplitudeToRGB(0)).toEqual([6, 17, 30]);
    expect(amplitudeToRGB(255)).toEqual([255, 92, 108]);
  });

  it('clamps out-of-range and non-numeric input instead of wrapping', () => {
    expect(amplitudeToRGB(-40)).toEqual([6, 17, 30]);
    expect(amplitudeToRGB(9999)).toEqual([255, 92, 108]);
    expect(amplitudeToRGB(undefined)).toEqual([6, 17, 30]);
    expect(amplitudeToRGB(NaN)).toEqual([6, 17, 30]);
  });

  it('reproduces each declared palette stop exactly', () => {
    // Stops are at 0, 0.35, 0.6, 0.82, 1.0 of full scale.
    expect(amplitudeToRGB(0.35 * 255)).toEqual([30, 143, 124]); // --teal-dim
    expect(amplitudeToRGB(0.6 * 255)).toEqual([59, 217, 187]); // --teal
    expect(amplitudeToRGB(0.82 * 255)).toEqual([255, 180, 84]); // --amber
  });

  it('interpolates linearly between two stops', () => {
    // Halfway between abyss (0) and teal-dim (0.35) should be the midpoint.
    const mid = amplitudeToRGB(0.175 * 255);
    expect(mid[0]).toBeCloseTo((6 + 30) / 2, 0);
    expect(mid[1]).toBeCloseTo((17 + 143) / 2, 0);
    expect(mid[2]).toBeCloseTo((30 + 124) / 2, 0);
  });

  it('rises steadily out of the background across the cool half', () => {
    // Green channel carries the ramp from abyss through teal; red only takes
    // over at the amber/red end, so channel-sum is NOT monotonic overall.
    const greens = [0, 40, 90, 140].map((a) => amplitudeToRGB(a)[1]);
    for (let i = 1; i < greens.length; i += 1) {
      expect(greens[i]).toBeGreaterThan(greens[i - 1]);
    }
  });
});

describe('sampleToRange', () => {
  it('maps the first and last sample to the window edges', () => {
    expect(sampleToRange(0, 200, 0, 10)).toBe(0);
    expect(sampleToRange(199, 200, 0, 10)).toBe(10);
  });

  it('honours a non-zero scan_start', () => {
    expect(sampleToRange(0, 200, 2, 8)).toBe(2);
    expect(sampleToRange(199, 200, 2, 8)).toBe(10);
  });

  it('places the midpoint halfway through the window', () => {
    expect(sampleToRange(100, 201, 0, 10)).toBeCloseTo(5, 6);
  });

  it('degrades safely on empty or single-sample profiles', () => {
    expect(sampleToRange(0, 0, 3, 10)).toBe(3);
    expect(sampleToRange(0, 1, 3, 10)).toBe(3);
  });
});

describe('rangeToRow', () => {
  it('puts the nearest range at the top row and max range at the bottom', () => {
    expect(rangeToRow(0, 10, 100)).toBe(0);
    expect(rangeToRow(10, 10, 100)).toBe(99);
  });

  it('returns null outside the display window rather than clamping', () => {
    // A 30 m echo must not be drawn on the bottom edge of a 10 m display —
    // that would read as a real return at 10 m.
    expect(rangeToRow(30, 10, 100)).toBeNull();
    expect(rangeToRow(-1, 10, 100)).toBeNull();
  });

  it('guards against degenerate geometry and bad numbers', () => {
    expect(rangeToRow(5, 0, 100)).toBeNull();
    expect(rangeToRow(5, 10, 0)).toBeNull();
    expect(rangeToRow(NaN, 10, 100)).toBeNull();
  });
});

describe('decomposeRange', () => {
  // Angle is off VERTICAL: 0 = straight down, 90 = dead ahead.
  it('is all depth and no reach when pointing straight down', () => {
    const { forward, down } = decomposeRange(4, 0, 0);
    expect(down).toBeCloseTo(4, 6);
    expect(forward).toBeCloseTo(0, 6);
  });

  it('is all reach and no depth when pointing dead ahead', () => {
    const { forward, down } = decomposeRange(4, 90, 0);
    expect(down).toBeCloseTo(0, 6);
    expect(forward).toBeCloseTo(4, 6);
  });

  it('splits evenly at the 45 degree diagonal mount', () => {
    const { forward, down } = decomposeRange(10, 45, 0);
    expect(forward).toBeCloseTo(10 / Math.SQRT2, 6);
    expect(down).toBeCloseTo(10 / Math.SQRT2, 6);
    expect(forward).toBeCloseTo(down, 6);
  });

  it('nose-up pitch trades depth for forward reach', () => {
    const level = decomposeRange(10, 45, 0);
    const noseUp = decomposeRange(10, 45, 20);
    expect(noseUp.down).toBeGreaterThan(level.down);
    expect(noseUp.forward).toBeLessThan(level.forward);
    // Total range is unchanged — pitch only rotates the beam.
    expect(Math.hypot(noseUp.forward, noseUp.down)).toBeCloseTo(10, 6);
  });

  it('returns nulls for a missing range instead of a confident zero', () => {
    expect(decomposeRange(null)).toEqual({ forward: null, down: null });
    expect(decomposeRange(NaN)).toEqual({ forward: null, down: null });
  });
});

describe('peakRange', () => {
  it('finds the range of the brightest sample', () => {
    const profile = new Array(200).fill(10);
    profile[100] = 250;
    // 200 samples over a 0-10 m window: index 100 sits just past halfway.
    expect(peakRange(profile, 0, 10)).toBeCloseTo(sampleToRange(100, 200, 0, 10), 6);
  });

  it('ignores dead-zone ringing, which is always the brightest thing', () => {
    const profile = new Array(200).fill(5);
    profile[0] = 255; // transducer ringing at ~0 m
    profile[150] = 200; // the actual target
    const r = peakRange(profile, 0, 10);
    expect(r).toBeGreaterThanOrEqual(PING_MIN_RANGE_M);
    expect(r).toBeCloseTo(sampleToRange(150, 200, 0, 10), 6);
  });

  it('returns null when there is no profile or the window is all dead zone', () => {
    expect(peakRange(null, 0, 10)).toBeNull();
    expect(peakRange([], 0, 10)).toBeNull();
    // A 0.3 m window is entirely inside the 0.5 m dead zone.
    expect(peakRange(new Array(200).fill(100), 0, 0.3)).toBeNull();
  });
});

describe('planHalfAngleDeg', () => {
  it('matches the physical beam half-angle when the beam looks dead ahead', () => {
    // At 90deg off vertical the beam is horizontal, so its footprint seen from
    // above is just the beam itself.
    expect(planHalfAngleDeg(90, 25)).toBeCloseTo(12.5, 1);
  });

  it('widens as the mount tilts down toward the seabed', () => {
    const ahead = planHalfAngleDeg(90, PING_BEAM_DEG);
    const tilted = planHalfAngleDeg(45, PING_BEAM_DEG);
    const steep = planHalfAngleDeg(15, PING_BEAM_DEG);
    expect(tilted).toBeGreaterThan(ahead);
    expect(steep).toBeGreaterThan(tilted);
  });

  it('saturates rather than degenerating when the beam points straight down', () => {
    // sin(0) = 0 would be an infinite fan; the clamp keeps the wedge drawable.
    expect(planHalfAngleDeg(0, PING_BEAM_DEG)).toBe(89);
    expect(planHalfAngleDeg(-10, PING_BEAM_DEG)).toBe(89);
  });

  it('returns null for non-finite input', () => {
    expect(planHalfAngleDeg(NaN)).toBeNull();
    expect(planHalfAngleDeg(45, NaN)).toBeNull();
  });
});

describe('povRingRadius', () => {
  it('fills the frame at zero range and vanishes at max range', () => {
    expect(povRingRadius(0, 10, 150)).toBeCloseTo(75, 6);
    expect(povRingRadius(10, 10, 150)).toBeCloseTo(0, 6);
  });

  it('shrinks monotonically with range', () => {
    const radii = [0, 2, 4, 6, 8, 10].map((r) => povRingRadius(r, 10, 150));
    for (let i = 1; i < radii.length; i += 1) {
      expect(radii[i]).toBeLessThan(radii[i - 1]);
    }
  });

  it('crowds far rings together — that is the perspective', () => {
    // Equal steps in metres must NOT be equal steps in pixels, or the tunnel
    // reads as a flat set of circles.
    const near = povRingRadius(0, 10, 150) - povRingRadius(2, 10, 150);
    const far = povRingRadius(8, 10, 150) - povRingRadius(10, 10, 150);
    expect(near).toBeGreaterThan(far * 2);
  });

  it('returns null outside the display window or for degenerate args', () => {
    expect(povRingRadius(11, 10, 150)).toBeNull();
    expect(povRingRadius(-1, 10, 150)).toBeNull();
    expect(povRingRadius(5, 0, 150)).toBeNull();
    expect(povRingRadius(5, 10, 0)).toBeNull();
    expect(povRingRadius(NaN, 10, 150)).toBeNull();
  });
});

describe('povBlipStyle', () => {
  it('draws near contacts larger than far ones', () => {
    expect(povBlipStyle(1, 10, 90).size).toBeGreaterThan(povBlipStyle(9, 10, 90).size);
  });

  it('keeps a far contact visible rather than shrinking it to nothing', () => {
    expect(povBlipStyle(10, 10, 90).size).toBeGreaterThan(0.03);
  });

  it('carries confidence in the opacity so a weak lock looks weak', () => {
    expect(povBlipStyle(5, 10, 100).opacity).toBeGreaterThan(povBlipStyle(5, 10, 10).opacity);
    expect(povBlipStyle(5, 10, 100).opacity).toBeCloseTo(1, 6);
  });

  it('clamps out-of-range confidence instead of producing a wild opacity', () => {
    expect(povBlipStyle(5, 10, 500).opacity).toBeCloseTo(1, 6);
    expect(povBlipStyle(5, 10, -50).opacity).toBeCloseTo(0.25, 6);
    expect(povBlipStyle(5, 10, null).opacity).toBeCloseTo(0.25, 6);
  });

  it('returns null outside the display window', () => {
    expect(povBlipStyle(11, 10, 90)).toBeNull();
    expect(povBlipStyle(NaN, 10, 90)).toBeNull();
  });
});

describe('findEchoes', () => {
  // Helper: a profile with Gaussian bumps at the given ranges over a 0-10 m window.
  const bumps = (specs, len = 200, scanLen = 10) => {
    const p = new Array(len).fill(8);
    for (const { at, peak } of specs) {
      const idx = (at / scanLen) * (len - 1);
      for (let i = 0; i < len; i += 1) {
        p[i] = Math.min(255, p[i] + peak * Math.exp(-((i - idx) ** 2) / (2 * 3 ** 2)));
      }
    }
    return p.map(Math.round);
  };

  it('finds several objects and returns them nearest first', () => {
    const echoes = findEchoes(bumps([{ at: 2, peak: 120 }, { at: 5, peak: 200 },
                                     { at: 8, peak: 90 }]), 0, 10);
    expect(echoes.length).toBe(3);
    expect(echoes[0].range).toBeCloseTo(2, 0);
    expect(echoes[1].range).toBeCloseTo(5, 0);
    expect(echoes[2].range).toBeCloseTo(8, 0);
  });

  it('reports a near weak object the device would miss for a far strong one', () => {
    // The whole point: the device's own `distance` picks the STRONGEST return,
    // which here is the 6 m wall — but the 1.5 m object is what you'd hit.
    const echoes = findEchoes(bumps([{ at: 1.5, peak: 90 }, { at: 6, peak: 240 }]), 0, 10);
    expect(echoes[0].range).toBeCloseTo(1.5, 0);
    expect(echoes[0].amplitude).toBeLessThan(echoes[1].amplitude);
  });

  it('reports one broad return as a single object, not a cluster', () => {
    const wide = new Array(200).fill(8);
    for (let i = 90; i < 115; i += 1) wide[i] = 200; // a plateau ~4.5-5.7 m
    expect(findEchoes(wide, 0, 10).length).toBe(1);
  });

  it('ignores dead-zone ringing, which is always the loudest thing', () => {
    const p = bumps([{ at: 4, peak: 150 }]);
    for (let i = 0; i < 6; i += 1) p[i] = 255; // transducer ring at ~0-0.3 m
    const echoes = findEchoes(p, 0, 10);
    expect(echoes.every((e) => e.range >= PING_MIN_RANGE_M)).toBe(true);
    expect(echoes[0].range).toBeCloseTo(4, 0);
  });

  it('finds nothing in a flat noise floor', () => {
    expect(findEchoes(new Array(200).fill(10), 0, 10)).toEqual([]);
    expect(findEchoes(null, 0, 10)).toEqual([]);
    expect(findEchoes([], 0, 10)).toEqual([]);
  });

  it('caps how many objects it reports', () => {
    const many = [1, 2, 3, 4, 5, 6, 7, 8].map((at) => ({ at, peak: 150 }));
    expect(findEchoes(bumps(many), 0, 10, { maxEchoes: 3 }).length).toBe(3);
  });

  it('scales its threshold to the profile, so gain changes do not hide objects', () => {
    // Same shape, quarter the amplitude: still found, because the threshold is
    // relative to the profile's own peak rather than a fixed level.
    const loud = findEchoes(bumps([{ at: 3, peak: 200 }]), 0, 10);
    const quiet = findEchoes(bumps([{ at: 3, peak: 60 }]), 0, 10);
    expect(loud.length).toBe(1);
    expect(quiet.length).toBe(1);
    expect(quiet[0].range).toBeCloseTo(loud[0].range, 1);
  });
});

describe('mapPointXY', () => {
  // 200px canvas, 10 m range: centre (100,100), edge radius 100px.
  it('puts north up, east right, south down and west left', () => {
    expect(mapPointXY(0, 10, 10, 200)).toEqual({ x: 100, y: 0 });
    const e = mapPointXY(90, 10, 10, 200);
    expect(e.x).toBeCloseTo(200, 6); expect(e.y).toBeCloseTo(100, 6);
    const s = mapPointXY(180, 10, 10, 200);
    expect(s.x).toBeCloseTo(100, 6); expect(s.y).toBeCloseTo(200, 6);
    const w = mapPointXY(270, 10, 10, 200);
    expect(w.x).toBeCloseTo(0, 6); expect(w.y).toBeCloseTo(100, 6);
  });

  it('puts a zero-range contact on the vehicle itself', () => {
    expect(mapPointXY(123, 0, 10, 200)).toEqual({ x: 100, y: 100 });
  });

  it('scales linearly with range, unlike the POV view', () => {
    // A map is a map: 5 m must sit exactly halfway out on a 10 m scale.
    const half = mapPointXY(0, 5, 10, 200);
    expect(half.y).toBeCloseTo(50, 6);
  });

  it('wraps bearings past 360 the same as their base angle', () => {
    const a = mapPointXY(45, 7, 10, 200);
    const b = mapPointXY(405, 7, 10, 200);
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(a.y).toBeCloseTo(b.y, 6);
  });

  it('returns null outside the display range or for degenerate args', () => {
    expect(mapPointXY(0, 11, 10, 200)).toBeNull();
    expect(mapPointXY(0, -1, 10, 200)).toBeNull();
    expect(mapPointXY(NaN, 5, 10, 200)).toBeNull();
    expect(mapPointXY(0, 5, 0, 200)).toBeNull();
    expect(mapPointXY(0, 5, 10, 0)).toBeNull();
  });
});

describe('clusterContacts', () => {
  // A sweep past one object: recorded across a full beam width at fixed range.
  const smear = (bearing, range, span = PING_BEAM_DEG, n = 12, conf = 80) =>
    Array.from({ length: n }, (_, i) => ({
      bearing: bearing - span / 2 + (span * i) / (n - 1),
      range: range + (i % 3) * 0.02, // ranging jitter
      conf,
      t: 0,
    }));

  it('collapses one beam-width smear into a single object', () => {
    // The case the asymmetric tolerance exists for: 25 deg of arc at 3 m is ONE
    // thing, even though its endpoints are 1.3 m apart in space.
    const c = clusterContacts(smear(90, 3));
    expect(c.length).toBe(1);
    expect(c[0].range).toBeCloseTo(3, 1);
    expect(c[0].bearing).toBeCloseTo(90, 0);
  });

  it('keeps objects at different ranges on the same bearing separate', () => {
    const c = clusterContacts([...smear(90, 2), ...smear(90, 5)]);
    expect(c.length).toBe(2);
    expect(c[0].range).toBeCloseTo(2, 1);
    expect(c[1].range).toBeCloseTo(5, 1);
  });

  it('keeps objects at the same range on different bearings separate', () => {
    const c = clusterContacts([...smear(30, 4), ...smear(200, 4)]);
    expect(c.length).toBe(2);
    expect(c.map((x) => Math.round(x.bearing)).sort((a, b) => a - b))
      .toEqual([30, 200]);
  });

  it('treats an object straddling north as one object, not two', () => {
    const c = clusterContacts(smear(0, 3)); // spans ~347 deg through ~12 deg
    expect(c.length).toBe(1);
    // Circular mean: a plain average of those bearings would give ~180.
    const b = c[0].bearing;
    expect(Math.min(b, 360 - b)).toBeLessThan(3);
    expect(c[0].span).toBeLessThan(60); // one object, not a wrapping surface
  });

  it('discards sparse noise that never repeats', () => {
    const specks = [
      { bearing: 10, range: 1.2, conf: 5, t: 0 },
      { bearing: 140, range: 6.7, conf: 3, t: 0 },
      { bearing: 305, range: 3.3, conf: 8, t: 0 },
    ];
    expect(clusterContacts(specks)).toEqual([]);
    // ...but keeps them alongside a real object, if asked to.
    expect(clusterContacts([...specks, ...smear(90, 3)]).length).toBe(1);
  });

  it('returns objects nearest first and caps how many', () => {
    const many = [6, 5, 4, 3, 2, 1].flatMap((r, i) => smear(i * 60, r));
    const c = clusterContacts(many, { maxClusters: 3 });
    expect(c.length).toBe(3);
    expect(c[0].range).toBeLessThan(c[1].range);
    expect(c[1].range).toBeLessThan(c[2].range);
    expect(c[0].range).toBeCloseTo(1, 1);
  });

  it('reports a wrapping surface by its closest approach, with no bearing', () => {
    // A tank encloses the vehicle, so it chains into one cluster — correctly,
    // being one continuous surface. Its MEAN range describes nothing you can
    // act on, and its near walls sit at opposite bearings whose circular mean
    // cancels to a direction with nothing in it. Closest approach is the number
    // that matters; the bearing is withheld rather than invented.
    const ring = [];
    for (let b = 0; b < 360; b += 2) {
      const r = (b * Math.PI) / 180;
      const e = Math.abs(Math.sin(r)), n = Math.abs(Math.cos(r));
      ring.push({ bearing: b, conf: 80, t: 0,
                  range: Math.min(e === 0 ? Infinity : 4 / e,
                                  n === 0 ? Infinity : 2.5 / n) });
    }
    const c = clusterContacts(ring);
    expect(c.length).toBe(1);
    expect(c[0].range).toBeCloseTo(2.5, 1);   // the near wall, not the 3.5 mean
    expect(c[0].bearing).toBeNull();
    expect(c[0].span).toBeGreaterThan(300);
  });

  it('gives a compact object a bearing and a beam-width span', () => {
    const [o] = clusterContacts(smear(90, 3));
    expect(o.bearing).toBeCloseTo(90, 0);
    expect(o.span).toBeLessThan(60);
  });

  it('averages confidence so an unverified object can be shown as such', () => {
    expect(clusterContacts(smear(90, 3, 25, 12, 20))[0].conf).toBeCloseTo(20, 0);
  });

  it('handles empty and malformed input', () => {
    expect(clusterContacts([])).toEqual([]);
    expect(clusterContacts(null)).toEqual([]);
    expect(clusterContacts([{ bearing: NaN, range: 3, conf: 90 }])).toEqual([]);
  });
});

describe('clusterContacts', () => {
  // A sweep past one object: recorded across a full beam width at fixed range.
  const smear = (bearing, range, span = PING_BEAM_DEG, n = 12, conf = 80) =>
    Array.from({ length: n }, (_, i) => ({
      bearing: bearing - span / 2 + (span * i) / (n - 1),
      range: range + (i % 3) * 0.02, // ranging jitter
      conf,
      t: 0,
    }));

  it('collapses one beam-width smear into a single object', () => {
    // The case the asymmetric tolerance exists for: 25 deg of arc at 3 m is ONE
    // thing, even though its endpoints are 1.3 m apart in space.
    const c = clusterContacts(smear(90, 3));
    expect(c.length).toBe(1);
    expect(c[0].range).toBeCloseTo(3, 1);
    expect(c[0].bearing).toBeCloseTo(90, 0);
  });

  it('keeps objects at different ranges on the same bearing separate', () => {
    const c = clusterContacts([...smear(90, 2), ...smear(90, 5)]);
    expect(c.length).toBe(2);
    expect(c[0].range).toBeCloseTo(2, 1);
    expect(c[1].range).toBeCloseTo(5, 1);
  });

  it('keeps objects at the same range on different bearings separate', () => {
    const c = clusterContacts([...smear(30, 4), ...smear(200, 4)]);
    expect(c.length).toBe(2);
    expect(c.map((x) => Math.round(x.bearing)).sort((a, b) => a - b))
      .toEqual([30, 200]);
  });

  it('treats an object straddling north as one object, not two', () => {
    const c = clusterContacts(smear(0, 3)); // spans ~347 deg through ~12 deg
    expect(c.length).toBe(1);
    // Circular mean: a plain average of those bearings would give ~180.
    const b = c[0].bearing;
    expect(Math.min(b, 360 - b)).toBeLessThan(3);
    expect(c[0].span).toBeLessThan(60); // one object, not a wrapping surface
  });

  it('discards sparse noise that never repeats', () => {
    const specks = [
      { bearing: 10, range: 1.2, conf: 5, t: 0 },
      { bearing: 140, range: 6.7, conf: 3, t: 0 },
      { bearing: 305, range: 3.3, conf: 8, t: 0 },
    ];
    expect(clusterContacts(specks)).toEqual([]);
    // ...but keeps them alongside a real object, if asked to.
    expect(clusterContacts([...specks, ...smear(90, 3)]).length).toBe(1);
  });

  it('returns objects nearest first and caps how many', () => {
    const many = [6, 5, 4, 3, 2, 1].flatMap((r, i) => smear(i * 60, r));
    const c = clusterContacts(many, { maxClusters: 3 });
    expect(c.length).toBe(3);
    expect(c[0].range).toBeLessThan(c[1].range);
    expect(c[1].range).toBeLessThan(c[2].range);
    expect(c[0].range).toBeCloseTo(1, 1);
  });

  it('reports a wrapping surface by its closest approach, with no bearing', () => {
    // A tank encloses the vehicle, so it chains into one cluster — correctly,
    // being one continuous surface. Its MEAN range describes nothing you can
    // act on, and its near walls sit at opposite bearings whose circular mean
    // cancels to a direction with nothing in it. Closest approach is the number
    // that matters; the bearing is withheld rather than invented.
    const ring = [];
    for (let b = 0; b < 360; b += 2) {
      const r = (b * Math.PI) / 180;
      const e = Math.abs(Math.sin(r)), n = Math.abs(Math.cos(r));
      ring.push({ bearing: b, conf: 80, t: 0,
                  range: Math.min(e === 0 ? Infinity : 4 / e,
                                  n === 0 ? Infinity : 2.5 / n) });
    }
    const c = clusterContacts(ring);
    expect(c.length).toBe(1);
    expect(c[0].range).toBeCloseTo(2.5, 1);   // the near wall, not the 3.5 mean
    expect(c[0].bearing).toBeNull();
    expect(c[0].span).toBeGreaterThan(300);
  });

  it('gives a compact object a bearing and a beam-width span', () => {
    const [o] = clusterContacts(smear(90, 3));
    expect(o.bearing).toBeCloseTo(90, 0);
    expect(o.span).toBeLessThan(60);
  });

  it('averages confidence so an unverified object can be shown as such', () => {
    expect(clusterContacts(smear(90, 3, 25, 12, 20))[0].conf).toBeCloseTo(20, 0);
  });

  it('handles empty and malformed input', () => {
    expect(clusterContacts([])).toEqual([]);
    expect(clusterContacts(null)).toEqual([]);
    expect(clusterContacts([{ bearing: NaN, range: 3, conf: 90 }])).toEqual([]);
  });
});

describe('sector memory', () => {
  const blank = () => new Array(180).fill(null);
  // Mirrors what the component does per ping: the slot is REPLACED, whether or
  // not anything was seen.
  const observe = (slots, bearing, ranges, t = 0, conf = 85) => {
    slots[sectorIndex(bearing)] = ranges.length ? { bearing, ranges, conf, t } : null;
    return slots;
  };

  it('indexes bearings into slots, wrapping at north', () => {
    expect(sectorIndex(0)).toBe(0);
    expect(sectorIndex(2)).toBe(1);
    expect(sectorIndex(360)).toBe(0);
    expect(sectorIndex(-2)).toBe(179);
    expect(sectorIndex(359.9)).toBe(179);
    expect(sectorIndex(NaN)).toBeNull();
  });

  it('keeps a contact while other bearings are swept', () => {
    let s = observe(blank(), 90, [2.5]);
    for (let b = 100; b < 200; b += 2) s = observe(s, b, []); // sweep away, empty
    const pts = sectorMemoryToPoints(s, 0, 60000);
    expect(pts.length).toBe(1);
    expect(pts[0].bearing).toBe(90);
  });

  it('drops a contact as soon as its own bearing is re-swept empty', () => {
    let s = observe(blank(), 90, [2.5]);
    expect(sectorMemoryToPoints(s, 0, 60000).length).toBe(1);
    s = observe(s, 90, []); // looked again, nothing there
    expect(sectorMemoryToPoints(s, 0, 60000)).toEqual([]);
  });

  it('replaces rather than accumulates when a bearing is re-observed', () => {
    let s = observe(blank(), 90, [2.5]);
    s = observe(s, 90, [4.0]); // it moved, or it was never at 2.5
    const pts = sectorMemoryToPoints(s, 0, 60000);
    expect(pts.length).toBe(1);
    expect(pts[0].range).toBe(4.0);
  });

  it('expires slots that were never re-swept', () => {
    const s = observe(blank(), 90, [2.5], 0);
    expect(sectorMemoryToPoints(s, 30000, 60000).length).toBe(1);
    expect(sectorMemoryToPoints(s, 61000, 60000)).toEqual([]);
  });

  it('carries every echo in a slot, not just the nearest', () => {
    const s = observe(blank(), 90, [1.5, 4.0]);
    expect(sectorMemoryToPoints(s, 0, 60000).map((p) => p.range)).toEqual([1.5, 4.0]);
  });

  it('handles an empty memory', () => {
    expect(sectorMemoryToPoints(blank(), 0, 60000)).toEqual([]);
    expect(sectorMemoryToPoints(null, 0, 60000)).toEqual([]);
  });
});
