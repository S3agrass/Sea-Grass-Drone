import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { DroneProvider, useDrone } from '../context/DroneContext';

// Mirrors droneContext.sonar.test.jsx: vi.hoisted builds the mock link before
// vi.mock() consumes it, and a local emit() pushes server events at the context.
const { mockLink, emitToLink } = vi.hoisted(() => {
  const subscribers = [];
  const link = {
    subscribe: (fn) => { subscribers.push(fn); return () => {}; },
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(() => true),
    headingHoldOn: vi.fn(() => true),
    headingHoldOff: vi.fn(() => true),
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

const RELEASED = {
  engaged: false, suspended: false, setpoint: null,
  heading: null, error: null, output: 0, ok: false,
};

describe('DroneContext — heading hold state', () => {
  it('starts released', () => {
    const getCtx = renderContext();
    expect(getCtx().headingHold).toEqual(RELEASED);
  });

  it('reflects an engaged, actively-steering hold', () => {
    const getCtx = renderContext();
    act(() => {
      emitToLink({
        type: 'message',
        data: {
          type: 'heading_hold', engaged: true, suspended: false,
          setpoint: 92.0, heading: 88.4, error: 3.6, output: 0.108, ok: true,
        },
      });
    });
    expect(getCtx().headingHold).toEqual({
      engaged: true, suspended: false, setpoint: 92.0,
      heading: 88.4, error: 3.6, output: 0.108, ok: true,
    });
  });

  // The distinction the operator most needs: suspended means the hold is still
  // engaged and will resume when the stick centres, but is NOT steering now.
  // Collapsing it into "engaged" would misreport who is driving the vehicle.
  it('separates suspended from engaged', () => {
    const getCtx = renderContext();
    act(() => {
      emitToLink({
        type: 'message',
        data: {
          type: 'heading_hold', engaged: true, suspended: true,
          setpoint: 92.0, heading: 70.1, error: 21.9, output: 0, ok: false,
        },
      });
    });
    const hh = getCtx().headingHold;
    expect(hh.engaged).toBe(true);
    expect(hh.suspended).toBe(true);
    expect(hh.ok).toBe(false);
    expect(hh.output).toBe(0);
  });

  // The server releases the hold whenever a client drops, so a stale "engaged"
  // left on screen after a disconnect would tell the operator the vehicle is
  // steering itself when it is not.
  it('clears back to released on disconnect', () => {
    const getCtx = renderContext();
    act(() => {
      emitToLink({
        type: 'message',
        data: {
          type: 'heading_hold', engaged: true, suspended: false,
          setpoint: 92.0, heading: 92.0, error: 0, output: 0, ok: true,
        },
      });
    });
    expect(getCtx().headingHold.engaged).toBe(true);

    act(() => {
      emitToLink({ type: 'status', status: 'disconnected' });
    });
    expect(getCtx().headingHold).toEqual(RELEASED);
  });

  it('exposes engage/release commands that reach the link', () => {
    const getCtx = renderContext();
    act(() => { getCtx().headingHoldOn(); });
    expect(mockLink.headingHoldOn).toHaveBeenCalledTimes(1);
    act(() => { getCtx().headingHoldOff(); });
    expect(mockLink.headingHoldOff).toHaveBeenCalledTimes(1);
  });
});
