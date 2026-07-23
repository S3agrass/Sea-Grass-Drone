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

describe('DroneContext — sonar state', () => {
  it('sonar starts empty and not ok', () => {
    const getCtx = renderContext();
    expect(getCtx().sonar).toEqual({ distance_m: null, confidence: null, ok: false });
  });

  it('sonar updates from a sonar message', () => {
    const getCtx = renderContext();
    act(() => {
      emitToLink({
        type: 'message',
        data: { type: 'sonar', distance_m: 2.34, confidence: 62, ok: true },
      });
    });
    expect(getCtx().sonar).toEqual({ distance_m: 2.34, confidence: 62, ok: true });
  });

  it('coerces ok to a boolean and missing fields to null', () => {
    const getCtx = renderContext();
    act(() => {
      emitToLink({ type: 'message', data: { type: 'sonar', ok: 0 } });
    });
    expect(getCtx().sonar).toEqual({ distance_m: null, confidence: null, ok: false });
  });

  it('resets sonar on disconnect', () => {
    const getCtx = renderContext();
    act(() => {
      emitToLink({
        type: 'message',
        data: { type: 'sonar', distance_m: 5.1, confidence: 80, ok: true },
      });
    });
    act(() => { emitToLink({ type: 'status', status: 'disconnected' }); });
    expect(getCtx().sonar).toEqual({ distance_m: null, confidence: null, ok: false });
  });
});
