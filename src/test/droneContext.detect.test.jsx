import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { DroneProvider, useDrone } from '../context/DroneContext';

// Mirrors droneContext.camera.test.jsx: vi.hoisted builds the mock link before
// vi.mock() consumes it, and a local emit() pushes server events at the context.
const { mockLink, emitToLink } = vi.hoisted(() => {
  const subscribers = [];
  const link = {
    subscribe: (fn) => { subscribers.push(fn); return () => {}; },
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(() => true),
    cameraOn: vi.fn(),
    cameraOff: vi.fn(),
    detectOn: vi.fn(),
    detectOff: vi.fn(),
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

describe('DroneContext — detection state', () => {
  it('detectActive starts false and detections empty', () => {
    const getCtx = renderContext();
    expect(getCtx().detectActive).toBe(false);
    expect(getCtx().detections).toEqual([]);
  });

  it('detectActive follows state { detect } from the server', () => {
    const getCtx = renderContext();
    act(() => { emitToLink({ type: 'message', data: { type: 'state', detect: true } }); });
    expect(getCtx().detectActive).toBe(true);
    act(() => { emitToLink({ type: 'message', data: { type: 'state', detect: false } }); });
    expect(getCtx().detectActive).toBe(false);
  });

  it('detections update from a detections message', () => {
    const getCtx = renderContext();
    const boxes = [{ cls: 'person', conf: 0.9, x: 0.1, y: 0.2, w: 0.3, h: 0.4 }];
    act(() => { emitToLink({ type: 'message', data: { type: 'detections', boxes, ts: 1 } }); });
    expect(getCtx().detections).toEqual(boxes);
  });

  it('resets detectActive and detections on disconnect', () => {
    const getCtx = renderContext();
    act(() => { emitToLink({ type: 'message', data: { type: 'state', detect: true } }); });
    act(() => {
      emitToLink({ type: 'message', data: { type: 'detections', boxes: [{ cls: 'x' }] } });
    });
    act(() => { emitToLink({ type: 'status', status: 'disconnected' }); });
    expect(getCtx().detectActive).toBe(false);
    expect(getCtx().detections).toEqual([]);
  });

  it('detectOn() / detectOff() delegate to the link', () => {
    const getCtx = renderContext();
    act(() => { getCtx().detectOn(); });
    expect(mockLink.detectOn).toHaveBeenCalledOnce();
    act(() => { getCtx().detectOff(); });
    expect(mockLink.detectOff).toHaveBeenCalledOnce();
  });
});
