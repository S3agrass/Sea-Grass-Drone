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

  it('cameraOn() calls link.cameraOn()', () => {
    const getCtx = renderContext();
    act(() => { getCtx().cameraOn(); });
    expect(mockLink.cameraOn).toHaveBeenCalledOnce();
  });

  it('cameraOff() calls link.cameraOff()', () => {
    const getCtx = renderContext();
    act(() => { getCtx().cameraOff(); });
    expect(mockLink.cameraOff).toHaveBeenCalledOnce();
  });
});

describe('DroneContext — debounced camera lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // A drone with a camera URL, selected + active (localMode reads localStorage).
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

  // Bring the context to: connected + viewing, so the camera should be ON.
  function connectAndView(getCtx) {
    act(() => { emitToLink({ type: 'status', status: 'connected' }); });
    act(() => { getCtx().setCameraViewing(true); });
  }

  it('turns the camera ON instantly when viewing a connected drone with a URL', () => {
    const getCtx = renderContext();
    connectAndView(getCtx);
    expect(mockLink.cameraOn).toHaveBeenCalled();
    expect(mockLink.cameraOff).not.toHaveBeenCalled();
  });

  it('does NOT re-send camera_on when re-renders/state updates leave the logical state unchanged', () => {
    // Regression for the command storm: state messages (recording toggles,
    // telemetry) re-rendered the provider and re-ran the effect, which re-sent
    // camera_on every time. Sends must be transition-gated.
    const getCtx = renderContext();
    connectAndView(getCtx);
    expect(mockLink.cameraOn).toHaveBeenCalledTimes(1);

    // One act() per message so every state update commits its own render, like
    // real server messages arriving 0.5s apart (a single act() would batch them
    // all into one commit and mask the per-render re-fire).
    for (let i = 0; i < 10; i++) {
      act(() => {
        emitToLink({
          type: 'message',
          data: {
            type: 'state', armed: true, mode: 'MANUAL', pixhawk: true,
            camera: true, recording: i % 2 === 0, rec_elapsed_s: i,
          },
        });
      });
      act(() => {
        emitToLink({
          type: 'message',
          data: { type: 'telemetry', heading: i * 10, groundspeed: 1.5, battery: 80 },
        });
      });
    }
    act(() => { vi.advanceTimersByTime(2000); });

    expect(mockLink.cameraOn).toHaveBeenCalledTimes(1); // still exactly once
    expect(mockLink.cameraOff).not.toHaveBeenCalled();
  });

  it('a telemetry flood causes no reconnects and no extra camera sends', () => {
    const getCtx = renderContext();
    connectAndView(getCtx);

    for (let i = 0; i < 20; i++) {
      act(() => {
        emitToLink({
          type: 'message',
          data: { type: 'telemetry', heading: i, groundspeed: 2, battery: 79, lat: 43.6 + i * 1e-5, lon: -79.3 },
        });
      });
    }
    act(() => { vi.advanceTimersByTime(2000); });

    expect(mockLink.connect).not.toHaveBeenCalled(); // no WS teardown/reconnect
    expect(mockLink.cameraOn).toHaveBeenCalledTimes(1);
    expect(mockLink.cameraOff).not.toHaveBeenCalled();
  });

  it('does NOT turn the camera off on a rapid off→on (StrictMode/fast-nav)', () => {
    const getCtx = renderContext();
    connectAndView(getCtx);
    mockLink.cameraOn.mockClear();

    act(() => { getCtx().setCameraViewing(false); }); // viewer "unmounts"
    act(() => { vi.advanceTimersByTime(100); });       // < debounce window
    act(() => { getCtx().setCameraViewing(true); });   // viewer "remounts"
    act(() => { vi.advanceTimersByTime(1000); });       // let any timer fire

    expect(mockLink.cameraOff).not.toHaveBeenCalled();
  });

  it('keeps the camera on after the operator navigates away', () => {
    // This used to assert the opposite, and the opposite was wrong. Viewer
    // presence deciding whether the camera runs meant closing the Control page
    // stopped the camera — and with it the JPEG frame tap, and with that all
    // detection, at precisely the moments nobody was watching. The camera is
    // now on whenever the drone is; only a deliberate toggle turns it off.
    const getCtx = renderContext();
    connectAndView(getCtx);

    act(() => { getCtx().setCameraViewing(false); });
    act(() => { vi.advanceTimersByTime(5000); }); // well past any debounce
    expect(mockLink.cameraOff).not.toHaveBeenCalled();
  });

  it('turns the camera off when the link drops', () => {
    // Still one automatic off, and it is the right one: with no link there is
    // no drone to keep a camera on for, and the state has to reset so a
    // reconnect starts clean rather than believing a camera it cannot see.
    const getCtx = renderContext();
    connectAndView(getCtx);
    mockLink.cameraOn.mockClear();

    act(() => { emitToLink({ type: 'status', status: 'disconnected' }); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(getCtx().cameraActive).toBe(false);
  });

  it('never turns the camera off while a recording is in progress', () => {
    const getCtx = renderContext();
    connectAndView(getCtx);
    act(() => { emitToLink({ type: 'message', data: { type: 'state', camera: true, recording: true } }); });

    act(() => { getCtx().setCameraViewing(false); });
    act(() => { vi.advanceTimersByTime(1000); });

    expect(mockLink.cameraOff).not.toHaveBeenCalled();
  });

  it('keeps the camera on across a whole recording and after it ends', () => {
    // Previously the camera shut down once a recording finished if the operator
    // had left. Nothing should turn it off now — the recording-in-progress
    // guard remains in the code for the manual-off path, but viewer presence no
    // longer starts that path at all.
    const getCtx = renderContext();
    connectAndView(getCtx);
    act(() => { emitToLink({ type: 'message', data: { type: 'state', camera: true, recording: true } }); });

    act(() => { getCtx().setCameraViewing(false); });
    act(() => { vi.advanceTimersByTime(2000); });
    act(() => { emitToLink({ type: 'message', data: { type: 'state', camera: true, recording: false } }); });
    act(() => { vi.advanceTimersByTime(2000); });

    expect(mockLink.cameraOff).not.toHaveBeenCalled();
  });

  // Faithful repro of the reported bug: StrictMode double-invokes the viewer's
  // mount effect (mount→cleanup→mount), which must NOT churn camera on/off.
  it('does not flap camera on/off under real React StrictMode', () => {
    function Viewer() {
      const { setCameraViewing } = useDrone();
      // Mirrors CameraView's registration effect.
      React.useEffect(() => {
        setCameraViewing(true);
        return () => setCameraViewing(false);
      }, [setCameraViewing]);
      return null;
    }
    render(
      <StrictMode>
        <DroneProvider>
          <Viewer />
        </DroneProvider>
      </StrictMode>,
    );
    act(() => { emitToLink({ type: 'status', status: 'connected' }); });
    act(() => { vi.advanceTimersByTime(1000); });

    expect(mockLink.cameraOn).toHaveBeenCalledTimes(1); // exactly once — no storm
    expect(mockLink.cameraOff).not.toHaveBeenCalled();  // and never flapped off
  });
});
