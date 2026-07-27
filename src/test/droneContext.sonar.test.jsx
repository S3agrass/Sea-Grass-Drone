import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { DroneProvider, useDrone } from '../context/DroneContext';

// Mirrors droneContext.detect.test.jsx: vi.hoisted builds the mock link before
// vi.mock() consumes it, and a local emit() pushes server events at the context.
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

const EMPTY_SONAR = {
  distance_m: null, raw_m: null, confidence: null, quality: 'none', ok: false,
  // Sonar brake state. Rides the sonar message because it is derived from the
  // sonar, but describes what the SERVER is doing to forward thrust.
  brake: 0, braking: false,
};

describe('DroneContext — sonar state', () => {
  it('sonar starts empty and not ok', () => {
    const getCtx = renderContext();
    expect(getCtx().sonar).toEqual(EMPTY_SONAR);
  });

  it('sonar updates from a sonar message', () => {
    const getCtx = renderContext();
    act(() => {
      emitToLink({
        type: 'message',
        data: { type: 'sonar', distance_m: 2.34, raw_m: 2.31, confidence: 62, quality: 'good', ok: true },
      });
    });
    expect(getCtx().sonar).toEqual({
      distance_m: 2.34, raw_m: 2.31, confidence: 62, quality: 'good', ok: true,
      brake: 0, braking: false,
    });
  });

  it('keeps raw_m while distance_m is null when there is no lock', () => {
    const getCtx = renderContext();
    act(() => {
      emitToLink({
        type: 'message',
        data: { type: 'sonar', distance_m: null, raw_m: 89.9, confidence: 0, quality: 'none', ok: true },
      });
    });
    expect(getCtx().sonar).toEqual({
      distance_m: null, raw_m: 89.9, confidence: 0, quality: 'none', ok: true,
      brake: 0, braking: false,
    });
  });

  it('carries the sonar brake state through to consumers', () => {
    const getCtx = renderContext();
    act(() => {
      emitToLink({
        type: 'message',
        data: {
          type: 'sonar', distance_m: 0.55, raw_m: 0.55, confidence: 88,
          quality: 'good', ok: true, brake: 1, braking: true,
        },
      });
    });
    expect(getCtx().sonar.brake).toBe(1);
    expect(getCtx().sonar.braking).toBe(true);
  });

  it('defaults the brake to released when the server omits it', () => {
    // An older server build has no brake fields; the UI must read that as "not
    // braking" rather than as undefined, which would render as a live warning.
    const getCtx = renderContext();
    act(() => {
      emitToLink({
        type: 'message',
        data: { type: 'sonar', distance_m: 3.2, raw_m: 3.2, confidence: 70, quality: 'good', ok: true },
      });
    });
    expect(getCtx().sonar.brake).toBe(0);
    expect(getCtx().sonar.braking).toBe(false);
  });

  it('coerces ok to a boolean and missing fields to defaults', () => {
    const getCtx = renderContext();
    act(() => {
      emitToLink({ type: 'message', data: { type: 'sonar', ok: 0 } });
    });
    expect(getCtx().sonar).toEqual(EMPTY_SONAR);
  });

  it('resets sonar on disconnect', () => {
    const getCtx = renderContext();
    act(() => {
      emitToLink({
        type: 'message',
        data: { type: 'sonar', distance_m: 5.1, raw_m: 5.2, confidence: 80, quality: 'good', ok: true },
      });
    });
    act(() => { emitToLink({ type: 'status', status: 'disconnected' }); });
    expect(getCtx().sonar).toEqual(EMPTY_SONAR);
  });
});
