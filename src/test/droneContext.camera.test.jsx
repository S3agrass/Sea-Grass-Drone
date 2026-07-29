import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { StrictMode } from 'react';
import { render, act } from '@testing-library/react';
import { DroneProvider, useDrone } from '../context/DroneContext';

// vi.hoisted runs before any imports, so the factory value is available
// when vi.mock() builds the module mock below.
const { mockLink, emitToLink } = vi.hoisted(() => {
  const subscribers = [];
  const link = {
    subscribe: (fn) => { subscribers.push(fn); return () => {}; },
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(() => true),
    cameraOn: vi.fn(),
    cameraOff: vi.fn(),
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

describe('DroneContext — cameraActive state', () => {
  it('starts as false', () => {
    const getCtx = renderContext();
    expect(getCtx().cameraActive).toBe(false);
  });

  it('becomes true when server sends state { camera: true }', () => {
    const getCtx = renderContext();
    act(() => {
      emitToLink({
        type: 'message',
        data: { type: 'state', armed: false, mode: 'MANUAL', pixhawk: true, camera: true },
      });
    });
    expect(getCtx().cameraActive).toBe(true);
  });

  it('becomes false when server sends state { camera: false }', () => {
    const getCtx = renderContext();
    act(() => { emitToLink({ type: 'message', data: { type: 'state', camera: true } }); });
    act(() => { emitToLink({ type: 'message', data: { type: 'state', camera: false } }); });
    expect(getCtx().cameraActive).toBe(false);
  });

  it('resets to false on link disconnect', () => {
    const getCtx = renderContext();
    act(() => { emitToLink({ type: 'message', data: { type: 'state', camera: true } }); });
    act(() => { emitToLink({ type: 'status', status: 'disconnected' }); });
    expect(getCtx().cameraActive).toBe(false);
  });

});

describe('DroneContext — camera lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.setItem(
      'seagrass-fleet',
      JSON.stringify([
        { id: 'd1', name: 'Sim', host: 'ws://x:8765', camera_url: 'http://pi:8000/stream.mjpg', token: '' },
      ]),
    );
    localStorage.setItem('seagrass-active-drone', 'd1');
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  // The camera is on once the Pixhawk is connected on a connected drone with a
  // stream URL — not merely once the operator's WebSocket link is up. Viewer
  // presence was never part of this and still isn't — see the note on
  // shouldCameraBeOn.
  function connect({ pixhawk = true } = {}) {
    act(() => { emitToLink({ type: 'status', status: 'connected' }); });
    if (pixhawk) {
      act(() => { emitToLink({ type: 'message', data: { type: 'state', pixhawk: true } }); });
    }
  }

  it('turns the camera ON once the Pixhawk connects on a drone with a URL', () => {
    renderContext();
    connect();
    expect(mockLink.cameraOn).toHaveBeenCalled();
    expect(mockLink.cameraOff).not.toHaveBeenCalled();
  });

  it('does NOT turn the camera on while the link is up but the Pixhawk is not', () => {
    // The whole point of gating on pixhawkOk rather than just linkStatus: the
    // server process being reachable says nothing about whether there is a
    // vehicle to film anything from yet.
    renderContext();
    connect({ pixhawk: false });
    expect(mockLink.cameraOn).not.toHaveBeenCalled();
  });

  it('turns the camera on when the Pixhawk connects after the link already was', () => {
    renderContext();
    connect({ pixhawk: false });
    expect(mockLink.cameraOn).not.toHaveBeenCalled();
    act(() => { emitToLink({ type: 'message', data: { type: 'state', pixhawk: true } }); });
    expect(mockLink.cameraOn).toHaveBeenCalled();
  });

  it('starts the camera even for a fleet entry saved with a blank URL', () => {
    // The end of the chain that made the feed invisible: a blank camera_url
    // rendered nothing AND held shouldCameraBeOn false, so the camera never
    // started either. The load-time migration repairs it, and this asserts the
    // repair reaches the behaviour rather than just the stored value.
    localStorage.setItem('seagrass-fleet', JSON.stringify([
      { id: 'd1', name: 'Sim', host: 'ws://x:8765', camera_url: '', token: '' },
    ]));
    const getCtx = renderContext();
    connect();
    expect(getCtx().activeDrone.camera_url).toBe('http://seagrass.local:8000/stream.mjpg');
    expect(mockLink.cameraOn).toHaveBeenCalled();
  });

  it('does NOT re-send camera_on when re-renders leave the logical state unchanged', () => {
    // Regression for the command storm: state messages (recording toggles,
    // telemetry) re-rendered the provider and re-ran the effect, which re-sent
    // camera_on every time. Sends must be transition-gated.
    renderContext();
    connect();
    mockLink.cameraOn.mockClear();

    for (let i = 0; i < 10; i += 1) {
      act(() => {
        emitToLink({ type: 'message', data: { type: 'state', pixhawk: true, camera: true, recording: i % 2 === 0 } });
      });
    }
    act(() => { vi.advanceTimersByTime(2000); });

    expect(mockLink.cameraOn).not.toHaveBeenCalled();
    expect(mockLink.cameraOff).not.toHaveBeenCalled();
    expect(mockLink.connect).not.toHaveBeenCalled(); // no WS teardown/reconnect
  });

  it('a telemetry flood causes no reconnects and no extra camera sends', () => {
    renderContext();
    connect();
    mockLink.cameraOn.mockClear();

    for (let i = 0; i < 40; i += 1) {
      act(() => {
        emitToLink({ type: 'message', data: { type: 'telemetry', heading: i, depth: i / 10 } });
      });
    }
    expect(mockLink.cameraOn).not.toHaveBeenCalled();
    expect(mockLink.cameraOff).not.toHaveBeenCalled();
    expect(mockLink.connect).not.toHaveBeenCalled();
  });

  it('keeps the camera on for the whole session, viewer or not', () => {
    // This file used to assert the opposite — that leaving the Control page
    // turned the camera off. That was the bug: the JPEG frame tap lives inside
    // camera_stream.py, so closing the page stopped detection along with it, at
    // exactly the times nobody was watching the feed.
    renderContext();
    connect();
    act(() => { vi.advanceTimersByTime(30000); });
    expect(mockLink.cameraOff).not.toHaveBeenCalled();
  });

  it('keeps the camera on across a recording and after it ends', () => {
    renderContext();
    connect();
    act(() => { emitToLink({ type: 'message', data: { type: 'state', pixhawk: true, camera: true, recording: true } }); });
    act(() => { vi.advanceTimersByTime(2000); });
    act(() => { emitToLink({ type: 'message', data: { type: 'state', pixhawk: true, camera: true, recording: false } }); });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(mockLink.cameraOff).not.toHaveBeenCalled();
  });

  it('clears camera state when the link drops', () => {
    // Still one automatic off, and the right one: with no link there is no
    // drone to hold a camera on for, and the state must reset so a reconnect
    // starts clean rather than believing in a camera it cannot see.
    const getCtx = renderContext();
    connect();
    act(() => { emitToLink({ type: 'message', data: { type: 'state', camera: true } }); });
    act(() => { emitToLink({ type: 'status', status: 'disconnected' }); });
    expect(getCtx().cameraActive).toBe(false);
  });

  it('sends camera_on exactly once under real React StrictMode', () => {
    // StrictMode double-invokes effects (mount -> cleanup -> mount). The
    // transition gate must absorb that rather than emitting a command storm.
    function Consumer() { useDrone(); return null; }
    render(
      <StrictMode>
        <DroneProvider><Consumer /></DroneProvider>
      </StrictMode>,
    );
    act(() => { emitToLink({ type: 'status', status: 'connected' }); });
    act(() => { emitToLink({ type: 'message', data: { type: 'state', pixhawk: true } }); });
    act(() => { vi.advanceTimersByTime(1000); });

    expect(mockLink.cameraOn).toHaveBeenCalledTimes(1);
    expect(mockLink.cameraOff).not.toHaveBeenCalled();
  });
});
