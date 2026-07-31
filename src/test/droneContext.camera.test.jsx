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

  // The camera is on whenever there is a connected drone with a stream URL.
  // Viewer presence used to be part of this and is deliberately not any more —
  // see the note on shouldCameraBeOn.
  function connect() {
    act(() => { emitToLink({ type: 'status', status: 'connected' }); });
  }

  it('turns the camera ON as soon as a drone with a URL connects', () => {
    renderContext();
    connect();
    expect(mockLink.cameraOn).toHaveBeenCalled();
    expect(mockLink.cameraOff).not.toHaveBeenCalled();
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
        emitToLink({ type: 'message', data: { type: 'state', camera: true, recording: i % 2 === 0 } });
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
    act(() => { emitToLink({ type: 'message', data: { type: 'state', camera: true, recording: true } }); });
    act(() => { vi.advanceTimersByTime(2000); });
    act(() => { emitToLink({ type: 'message', data: { type: 'state', camera: true, recording: false } }); });
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

  it('retries camera_on while the server keeps reporting the camera off', () => {
    // The Pi's camera_stream.py can exit at startup (busy sensor, missing
    // dependency). The transition gate fired its one camera_on and considered
    // the job done, so the panel showed "Camera is off" forever with nothing
    // retrying. Reconciling against the reported state is what recovers it.
    renderContext();
    connect();
    mockLink.cameraOn.mockClear();
    act(() => { emitToLink({ type: 'message', data: { type: 'state', camera: false } }); });

    act(() => { vi.advanceTimersByTime(8000); });
    expect(mockLink.cameraOn).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(8000); });
    expect(mockLink.cameraOn).toHaveBeenCalledTimes(2);
  });

  it('stops retrying as soon as the server confirms the camera is up', () => {
    renderContext();
    connect();
    act(() => { emitToLink({ type: 'message', data: { type: 'state', camera: false } }); });
    act(() => { vi.advanceTimersByTime(8000); });
    mockLink.cameraOn.mockClear();

    act(() => { emitToLink({ type: 'message', data: { type: 'state', camera: true } }); });
    act(() => { vi.advanceTimersByTime(60000); });
    expect(mockLink.cameraOn).not.toHaveBeenCalled();
  });

  it('does not retry into a healthy start still inside its startup grace', () => {
    // start_camera() sleeps ~1s checking the process survived, then answers with
    // state. Retrying inside that window would stack starts on the Pi.
    renderContext();
    connect();
    mockLink.cameraOn.mockClear();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(mockLink.cameraOn).not.toHaveBeenCalled();
  });

  it('re-sends camera_on after a reconnect the off debounce swallowed', () => {
    // Drop and restore faster than CAMERA_OFF_DEBOUNCE_MS: the pending OFF is
    // cancelled, so appliedRef still reads "on" and the gate stays silent. If
    // the server restarted in the gap, only reconciliation gets the camera back.
    renderContext();
    connect();
    act(() => { emitToLink({ type: 'message', data: { type: 'state', camera: true } }); });
    mockLink.cameraOn.mockClear();

    act(() => { emitToLink({ type: 'status', status: 'disconnected' }); });
    act(() => { vi.advanceTimersByTime(100); }); // under the 400ms off debounce
    connect();
    expect(mockLink.cameraOff).not.toHaveBeenCalled();
    expect(mockLink.cameraOn).not.toHaveBeenCalled(); // gate is gated shut

    act(() => { vi.advanceTimersByTime(8000); });
    expect(mockLink.cameraOn).toHaveBeenCalledTimes(1);
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
    act(() => { vi.advanceTimersByTime(1000); });

    expect(mockLink.cameraOn).toHaveBeenCalledTimes(1);
    expect(mockLink.cameraOff).not.toHaveBeenCalled();
  });
});
