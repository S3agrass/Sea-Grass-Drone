import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { DroneProvider, useDrone } from '../context/DroneContext';

// Covers the telemetry fields the EKF/PID work added: baro altitude + climb,
// EKF attitude (roll/pitch/yaw), and the separate `pid` message. Same mock-link
// harness as droneContext.sonar.test.jsx.
const { mockLink, emitToLink } = vi.hoisted(() => {
  const subscribers = [];
  const link = {
    subscribe: (fn) => { subscribers.push(fn); return () => {}; },
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(() => true),
  };
  function emit(event) { subscribers.forEach((fn) => fn(event)); }
  return { mockLink: link, emitToLink: emit };
});

vi.mock('../lib/droneLink', () => ({
  default: function MockDroneLink() { return mockLink; },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, localMode: true }),
}));

vi.mock('../lib/supabase', () => ({
  supabaseConfigured: false,
  supabase: null,
}));

function renderContext() {
  let ctx;
  function Capture() { ctx = useDrone(); return null; }
  render(<DroneProvider><Capture /></DroneProvider>);
  return () => ctx;
}

beforeEach(() => {
  vi.clearAllMocks();
});

const EMPTY_PID = {
  setpoint: null, measurement: null, error: null, integral: null,
  output: null, ok: false,
};

describe('DroneContext — altitude & attitude telemetry', () => {
  it('altitude, climb and attitude start null', () => {
    const getCtx = renderContext();
    const t = getCtx().telemetry;
    expect(t.altitude).toBeNull();
    expect(t.climb).toBeNull();
    expect(t.roll).toBeNull();
    expect(t.pitch).toBeNull();
    expect(t.yaw).toBeNull();
  });

  it('merges altitude and climb from a telemetry message', () => {
    const getCtx = renderContext();
    act(() => {
      emitToLink({
        type: 'message',
        data: { type: 'telemetry', altitude: 12.34, climb: -0.42 },
      });
    });
    expect(getCtx().telemetry.altitude).toBe(12.34);
    expect(getCtx().telemetry.climb).toBe(-0.42);
  });

  it('merges roll/pitch/yaw in degrees, keeping negative values signed', () => {
    const getCtx = renderContext();
    act(() => {
      emitToLink({
        type: 'message',
        data: { type: 'telemetry', roll: -8.3, pitch: 4.1, yaw: 271.5 },
      });
    });
    expect(getCtx().telemetry.roll).toBe(-8.3);
    expect(getCtx().telemetry.pitch).toBe(4.1);
    expect(getCtx().telemetry.yaw).toBe(271.5);
  });

  it('a partial telemetry message does not clobber other fields', () => {
    const getCtx = renderContext();
    act(() => {
      emitToLink({
        type: 'message',
        data: { type: 'telemetry', altitude: 9.0, roll: 3.0 },
      });
    });
    act(() => {
      // VFR_HUD and ATTITUDE arrive in separate drains, so altitude must
      // survive a message that only carries attitude.
      emitToLink({ type: 'message', data: { type: 'telemetry', roll: 5.0 } });
    });
    expect(getCtx().telemetry.altitude).toBe(9.0);
    expect(getCtx().telemetry.roll).toBe(5.0);
  });
});

describe('DroneContext — alt-hold PID state', () => {
  it('pid starts empty and not ok', () => {
    const getCtx = renderContext();
    expect(getCtx().pid).toEqual(EMPTY_PID);
  });

  it('pid updates from a pid message', () => {
    const getCtx = renderContext();
    act(() => {
      emitToLink({
        type: 'message',
        data: {
          type: 'pid', setpoint: 12.0, measurement: 11.7,
          error: 0.3, integral: 0.15, output: 0.097, ok: true,
        },
      });
    });
    expect(getCtx().pid).toEqual({
      setpoint: 12.0, measurement: 11.7, error: 0.3,
      integral: 0.15, output: 0.097, ok: true,
    });
  });

  it('coerces ok to a boolean and missing fields to null', () => {
    const getCtx = renderContext();
    act(() => {
      emitToLink({ type: 'message', data: { type: 'pid', ok: 0 } });
    });
    expect(getCtx().pid).toEqual(EMPTY_PID);
  });

  it('keeps a zero error/output instead of nulling them', () => {
    const getCtx = renderContext();
    act(() => {
      emitToLink({
        type: 'message',
        data: {
          type: 'pid', setpoint: 5, measurement: 5,
          error: 0, integral: 0, output: 0, ok: true,
        },
      });
    });
    expect(getCtx().pid).toEqual({
      setpoint: 5, measurement: 5, error: 0, integral: 0, output: 0, ok: true,
    });
  });

  it('resets pid on disconnect', () => {
    const getCtx = renderContext();
    act(() => {
      emitToLink({
        type: 'message',
        data: {
          type: 'pid', setpoint: 12.0, measurement: 11.7,
          error: 0.3, integral: 0.15, output: 0.097, ok: true,
        },
      });
    });
    act(() => { emitToLink({ type: 'status', status: 'disconnected' }); });
    expect(getCtx().pid).toEqual(EMPTY_PID);
  });
});
