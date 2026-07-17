import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import DroneLink from '../lib/droneLink';
import {
  stickCurve,
  DEADZONE,
  CREEP_ZONE_END,
  CREEP_ZONE_OUTPUT,
} from '../lib/stickCurve';

const WS_OPEN = 1;

let currentWs;
function WsMock() {
  const sent = [];
  Object.assign(this, {
    readyState: WS_OPEN,
    send: (raw) => sent.push(JSON.parse(raw)),
    close: vi.fn(),
    onopen: null, onmessage: null, onerror: null, onclose: null,
    _sent: sent,
    _triggerOpen() { this.onopen?.(); },
  });
  currentWs = this;
}
WsMock.OPEN = WS_OPEN;

describe('DroneLink — analog axis transport', () => {
  let link;

  beforeEach(() => {
    vi.stubGlobal('WebSocket', WsMock);
    link = new DroneLink();
    link.connect('ws://test:8765', 'token');
    currentWs._triggerOpen();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('sendAxis emits an axis frame the server handle_axis understands', () => {
    link.sendAxis({ surge: 0.25, steer: -0.5, depth: 0.1 });
    expect(currentWs._sent.at(-1)).toEqual({
      type: 'axis', surge: 0.25, steer: -0.5, depth: 0.1,
    });
  });

  it('sendAxis defaults any omitted axis to zero rather than undefined', () => {
    // A missing key would be skipped by handle_axis, silently latching that
    // axis at its previous target instead of releasing it.
    link.sendAxis({ surge: 0.5 });
    expect(currentWs._sent.at(-1)).toEqual({
      type: 'axis', surge: 0.5, steer: 0, depth: 0,
    });
  });

  it('softStop is the recoverable latch, distinct from allStop', () => {
    link.softStop();
    expect(currentWs._sent.at(-1)).toEqual({ type: 'soft_stop' });
    link.allStop();
    expect(currentWs._sent.at(-1)).toEqual({ type: 'stop' });
  });
});

describe('stickCurve — the sensitivity fix', () => {
  it('rejects drift inside the deadzone', () => {
    expect(stickCurve(0)).toBe(0);
    expect(stickCurve(DEADZONE - 0.001)).toBe(0);
    expect(stickCurve(-(DEADZONE - 0.001))).toBe(0);
  });

  it('is proportional, not the on/off threshold it replaced', () => {
    // The regression this whole change exists to prevent: the old client
    // emitted a full-power keypress for any deflection past 0.35 and nothing
    // below it. Small deflections must now produce small, distinct outputs.
    const small = stickCurve(0.2);
    const mid = stickCurve(0.5);
    const large = stickCurve(0.8);
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(0.1);
    expect(mid).toBeGreaterThan(small);
    expect(large).toBeGreaterThan(mid);
  });

  it('starts from zero at the deadzone edge instead of jumping', () => {
    // Rescaling is what makes the deadzone cost no resolution.
    expect(stickCurve(DEADZONE + 0.0001)).toBeCloseTo(0, 3);
  });

  // The gas-pedal shape: a gentle creep zone up to a knee, then a visibly
  // steeper power zone. A single expo curve can't produce this distinction —
  // these tests pin the two-zone structure itself.
  it('outputs CREEP_ZONE_OUTPUT exactly at the knee', () => {
    const kneeRaw = DEADZONE + CREEP_ZONE_END * (1 - DEADZONE);
    expect(stickCurve(kneeRaw)).toBeCloseTo(CREEP_ZONE_OUTPUT, 6);
  });

  it('is continuous at the knee — no step in output', () => {
    const kneeRaw = DEADZONE + CREEP_ZONE_END * (1 - DEADZONE);
    const below = stickCurve(kneeRaw - 0.001);
    const above = stickCurve(kneeRaw + 0.001);
    expect(above - below).toBeLessThan(0.01);
  });

  it('climbs much faster per unit of travel in the power zone than the creep zone', () => {
    const creepSlope = CREEP_ZONE_OUTPUT / CREEP_ZONE_END;
    const powerSlope = (1 - CREEP_ZONE_OUTPUT) / (1 - CREEP_ZONE_END);
    // Measured empirically off the curve, not just the constants:
    const kneeRaw = DEADZONE + CREEP_ZONE_END * (1 - DEADZONE);
    const dRaw = 0.05;
    const measuredCreep = stickCurve(kneeRaw - 0.001) - stickCurve(kneeRaw - 0.001 - dRaw);
    const measuredPower = stickCurve(kneeRaw + 0.001 + dRaw) - stickCurve(kneeRaw + 0.001);
    expect(measuredPower).toBeGreaterThan(measuredCreep * 3);
    expect(powerSlope).toBeGreaterThan(creepSlope * 3);
  });

  it('still reaches exactly full authority at full lock', () => {
    expect(stickCurve(1)).toBeCloseTo(1, 6);
    expect(stickCurve(-1)).toBeCloseTo(-1, 6);
  });

  it('is symmetric about center', () => {
    for (const v of [0.2, 0.35, 0.5, 0.75, 1]) {
      expect(stickCurve(-v)).toBeCloseTo(-stickCurve(v), 9);
    }
  });

  it('is monotonic across the whole travel', () => {
    let prev = -Infinity;
    for (let v = 0; v <= 1.0001; v += 0.01) {
      const out = stickCurve(v);
      expect(out).toBeGreaterThanOrEqual(prev);
      prev = out;
    }
  });

  it('clamps past-full raw values instead of overshooting', () => {
    // Some pads report slightly beyond +/-1.
    expect(stickCurve(1.05)).toBeCloseTo(1, 6);
  });
});
