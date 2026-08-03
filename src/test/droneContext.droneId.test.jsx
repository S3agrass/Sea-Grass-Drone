import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { DroneProvider, useDrone } from '../context/DroneContext';

// The vehicle names itself, and the app records that.
//
// drone_id has to match the drones row for two things to work: the Pi's owner
// lookup (so sign-in authorises you by account rather than by the drone's
// long-lived token) and media scoping. Until now the only way it got set was an
// operator copying it accurately into a field labelled "optional" whose help
// text suggested leaving it blank — so it stayed blank, and identity auth was
// silently off with no symptom anywhere in the UI.
//
// Blank is filled in from the vehicle. A DIFFERENT value is never overwritten:
// someone may have set it deliberately, and rewriting an operator's data to
// work around a design problem is not a fix.

const { mockLink, emitToLink } = vi.hoisted(() => {
  const subscribers = [];
  const link = {
    subscribe: (fn) => {
      subscribers.push(fn);
      return () => {
        const i = subscribers.indexOf(fn);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(() => true),
  };
  return { mockLink: link, emitToLink: (e) => subscribers.slice().forEach((f) => f(e)) };
});

vi.mock('../lib/droneLink', () => ({
  default: function MockDroneLink() { return mockLink; },
}));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, localMode: true, accessToken: '', loading: false }),
}));
vi.mock('../lib/supabase', () => ({ supabaseConfigured: false, supabase: null }));

const DRONE = {
  id: 'd1',
  name: 'Seagrass One',
  host: 'ws://pi.local:8765',
  token: 'drone-token',
  camera_url: 'https://cam.example.com/cam/whep',
};

function renderContext() {
  let ctx;
  function Capture() { ctx = useDrone(); return null; }
  render(<DroneProvider><Capture /></DroneProvider>);
  return () => ctx;
}

const stateWith = (droneId) => ({
  type: 'message',
  data: { type: 'state', armed: false, pixhawk: true, drone_id: droneId },
});

function setFleet(drone) {
  localStorage.setItem('seagrass-fleet', JSON.stringify([drone]));
  localStorage.setItem('seagrass-active-drone', 'd1');
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setFleet(DRONE);
});

describe('drone id reconciliation', () => {
  it('fills a blank id in from the connected vehicle', async () => {
    const ctx = renderContext();
    await waitFor(() => expect(ctx().activeDrone).toBeTruthy());
    expect(ctx().activeDrone.drone_id).toBeUndefined();

    act(() => { emitToLink(stateWith('seagrass-one')); });

    await waitFor(() =>
      expect(ctx().fleet.find((d) => d.id === 'd1').drone_id).toBe('seagrass-one'),
    );
    expect(ctx().droneIdMismatch).toBeNull();
  });

  it('reports what the vehicle called itself', async () => {
    const ctx = renderContext();
    await waitFor(() => expect(ctx().activeDrone).toBeTruthy());

    act(() => { emitToLink(stateWith('seagrass-one')); });

    await waitFor(() => expect(ctx().reportedDroneId).toBe('seagrass-one'));
  });

  it('leaves a deliberately different id alone, and says so', async () => {
    setFleet({ ...DRONE, drone_id: 'something-else' });
    const ctx = renderContext();
    await waitFor(() => expect(ctx().activeDrone).toBeTruthy());

    act(() => { emitToLink(stateWith('seagrass-one')); });

    await waitFor(() =>
      expect(ctx().droneIdMismatch).toEqual({
        reported: 'seagrass-one',
        configured: 'something-else',
      }),
    );
    // Not overwritten — that is the operator's data.
    expect(ctx().fleet.find((d) => d.id === 'd1').drone_id).toBe('something-else');
  });

  it('says nothing when they already agree', async () => {
    setFleet({ ...DRONE, drone_id: 'seagrass-one' });
    const ctx = renderContext();
    await waitFor(() => expect(ctx().activeDrone).toBeTruthy());

    act(() => { emitToLink(stateWith('seagrass-one')); });

    await waitFor(() => expect(ctx().reportedDroneId).toBe('seagrass-one'));
    expect(ctx().droneIdMismatch).toBeNull();
  });

  it('writes once, not on every state message', async () => {
    // state arrives on connect and again on any change; retrying the save each
    // time would hammer Supabase for the rest of the session.
    const ctx = renderContext();
    await waitFor(() => expect(ctx().activeDrone).toBeTruthy());

    act(() => {
      emitToLink(stateWith('seagrass-one'));
      emitToLink(stateWith('seagrass-one'));
      emitToLink(stateWith('seagrass-one'));
    });

    await waitFor(() =>
      expect(ctx().fleet.find((d) => d.id === 'd1').drone_id).toBe('seagrass-one'),
    );
    const writes = JSON.parse(localStorage.getItem('seagrass-fleet'));
    expect(writes).toHaveLength(1);
  });

  it('ignores a state message with no id, from an older drone server', async () => {
    const ctx = renderContext();
    await waitFor(() => expect(ctx().activeDrone).toBeTruthy());

    act(() => {
      emitToLink({ type: 'message', data: { type: 'state', armed: false } });
    });

    expect(ctx().reportedDroneId).toBe('');
    expect(ctx().droneIdMismatch).toBeNull();
  });
});
