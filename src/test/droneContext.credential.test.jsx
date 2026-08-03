import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { DroneProvider, useDrone } from '../context/DroneContext';

// Which credential the browser presents, and what happens when the vehicle
// refuses it.
//
// A signed-in operator sends their Supabase session token rather than the
// drone's long-lived secret — that is the whole point of operator identity. But
// a vehicle that cannot work out who owns it (no DRONE_ID match in the drones
// table, an older Pi, no uplink on first boot) refuses that token, and the
// operator would otherwise be stranded on "check Settings" while holding a
// drone token that works perfectly well. These tests pin the demotion that
// stops that happening, because the failure mode is an operator who cannot
// drive their own vehicle.

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

const JWT = 'header.payload.signature';
const DRONE_TOKEN = 'long-lived-drone-secret';

let authState;
vi.mock('../context/AuthContext', () => ({
  useAuth: () => authState,
}));

vi.mock('../lib/supabase', () => ({ supabaseConfigured: false, supabase: null }));

const DRONE = {
  id: 'd1',
  name: 'Seagrass One',
  host: 'ws://pi.local:8765',
  token: DRONE_TOKEN,
  camera_url: 'https://cam.example.com/cam/whep',
};

function renderContext() {
  let ctx;
  function Capture() { ctx = useDrone(); return null; }
  render(<DroneProvider><Capture /></DroneProvider>);
  return () => ctx;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('seagrass-fleet', JSON.stringify([DRONE]));
  localStorage.setItem('seagrass-active-drone', 'd1');
  authState = { user: { id: 'u1' }, localMode: false, accessToken: JWT };
});

describe('operator credential', () => {
  it('presents the session token, not the drone secret, when signed in', async () => {
    const ctx = renderContext();
    await waitFor(() => expect(ctx().activeDrone).toBeTruthy());
    expect(ctx().operatorCredential).toBe(JWT);
  });

  it('falls back to the drone token in local mode, which has no session', async () => {
    authState = { user: null, localMode: true, accessToken: '' };
    const ctx = renderContext();
    await waitFor(() => expect(ctx().activeDrone).toBeTruthy());
    expect(ctx().operatorCredential).toBe(DRONE_TOKEN);
  });

  it('demotes to the drone token when the vehicle refuses the session token', async () => {
    const ctx = renderContext();
    await waitFor(() => expect(ctx().activeDrone).toBeTruthy());
    expect(ctx().operatorCredential).toBe(JWT);

    act(() => {
      emitToLink({ type: 'status', status: 'error', detail: 'Access refused', authFailed: true });
    });

    // Every surface follows, not just the control link: the camera and media
    // API read this same value, so they cannot disagree about what is live.
    await waitFor(() => expect(ctx().operatorCredential).toBe(DRONE_TOKEN));
    await waitFor(() =>
      expect(mockLink.connect).toHaveBeenCalledWith(DRONE.host, DRONE_TOKEN),
    );
  });

  it('does not demote on an ordinary disconnect', async () => {
    const ctx = renderContext();
    await waitFor(() => expect(ctx().activeDrone).toBeTruthy());

    act(() => {
      emitToLink({ type: 'status', status: 'error', detail: 'Connection error' });
    });

    expect(ctx().operatorCredential).toBe(JWT);
  });

  it('stays demoted rather than flapping between credentials', async () => {
    const ctx = renderContext();
    await waitFor(() => expect(ctx().activeDrone).toBeTruthy());

    act(() => {
      emitToLink({ type: 'status', status: 'error', detail: 'x', authFailed: true });
    });
    await waitFor(() => expect(ctx().operatorCredential).toBe(DRONE_TOKEN));

    // A refusal of the drone token too is a genuine credential problem; there is
    // nothing further to try, and retrying identity would loop.
    act(() => {
      emitToLink({ type: 'status', status: 'error', detail: 'x', authFailed: true });
    });
    expect(ctx().operatorCredential).toBe(DRONE_TOKEN);
  });

  it('retries identity for a drone with no token of its own', async () => {
    // Nothing to demote to, so the refusal must not silently blank the
    // credential — that would turn a clear auth error into an empty one.
    localStorage.setItem(
      'seagrass-fleet',
      JSON.stringify([{ ...DRONE, token: '' }]),
    );
    const ctx = renderContext();
    await waitFor(() => expect(ctx().activeDrone).toBeTruthy());

    act(() => {
      emitToLink({ type: 'status', status: 'error', detail: 'x', authFailed: true });
    });

    expect(ctx().operatorCredential).toBe(JWT);
  });
});
