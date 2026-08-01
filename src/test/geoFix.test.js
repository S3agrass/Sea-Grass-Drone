import { describe, it, expect } from 'vitest';
import { hasFix } from '../lib/geo';

// The map placed the drone at Null Island whenever the Pixhawk had no GPS fix:
// ArduPilot zeroes GLOBAL_POSITION_INT until it locks on, the UI tested
// `lat != null`, and 0 is not null. The visible symptom was a route line
// running off the bottom-right corner of the map from every waypoint dropped —
// it was heading for (0, 0), 11,000 km away.

describe('hasFix', () => {
  it('accepts a real position', () => {
    expect(hasFix(37.8065, -122.4305)).toBe(true);
  });

  it('rejects the no-fix sentinel', () => {
    expect(hasFix(0, 0)).toBe(false);
  });

  it('rejects a missing position', () => {
    expect(hasFix(null, null)).toBe(false);
    expect(hasFix(undefined, undefined)).toBe(false);
  });

  it('rejects a half-present position', () => {
    // One axis alone cannot place anything, and pairing it with a default zero
    // is how a plausible-looking wrong point gets on the map.
    expect(hasFix(37.8065, null)).toBe(false);
    expect(hasFix(null, -122.4305)).toBe(false);
  });

  it('rejects NaN', () => {
    expect(hasFix(NaN, NaN)).toBe(false);
    expect(hasFix(37.8, NaN)).toBe(false);
  });

  it('rejects out-of-range values', () => {
    // A garbled packet should not be trusted to a mapping library.
    expect(hasFix(91, 0)).toBe(false);
    expect(hasFix(0, 181)).toBe(false);
    expect(hasFix(-90.1, 12)).toBe(false);
  });

  it('accepts a genuine position on one axis of the equator or meridian', () => {
    // Only the exact pair (0, 0) is the sentinel. Somewhere on the equator, or
    // on the prime meridian, is a real place and must still map.
    expect(hasFix(0, -122.4305)).toBe(true);
    expect(hasFix(51.4779, 0)).toBe(true);
  });
});
