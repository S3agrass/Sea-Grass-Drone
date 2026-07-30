import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { DroneProvider, useDrone } from '../context/DroneContext';

// Regression cover for the bug where every account saw the same fleet.
//
// Two causes, both represented here. The app authenticated with Firebase while
// its data lived in Supabase, so auth.uid() was NULL inside RLS and the only
// policies that worked were `using (true)` — one shared table. And the client
// wrote `user?.id` from a Firebase user object whose property is `uid`, so the
// owner column recorded the literal string "local" for everyone.
//
// The database is the real boundary (see supabase-schema.sql); these assert the
// client half: that it only queries the cloud when there is a session to scope
// by, and that it stamps rows with the signed-in user's actual id.
const { mockLink } = vi.hoisted(() => ({
  mockLink: {
    subscribe: () => () => {},
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(() => true),
  },
}));

vi.mock('../lib/droneLink', () => ({
  default: function MockDroneLink() { return mockLink; },
}));

let mockAuth;
vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

const { insert, select, from } = vi.hoisted(() => {
  const order = vi.fn(() => Promise.resolve({ data: [], error: null }));
  const select = vi.fn(() => ({ order }));
  const insert = vi.fn(() => Promise.resolve({ error: null }));
  const update = vi.fn(() => ({ eq: () => Promise.resolve({ error: null }) }));
  const from = vi.fn(() => ({ select, insert, update }));
  return { insert, select, from };
});

vi.mock('../lib/supabase', () => ({
  supabaseConfigured: true,
  supabase: { from },
}));

function renderContext() {
  let ctx;
  function Capture() { ctx = useDrone(); return null; }
  render(<DroneProvider><Capture /></DroneProvider>);
  return () => ctx;
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mockAuth = { user: { id: 'uuid-alice' }, localMode: false };
});

describe('DroneContext — fleet isolation', () => {
  it('queries the cloud fleet when signed in', async () => {
    renderContext();
    await waitFor(() => expect(from).toHaveBeenCalledWith('drones'));
    expect(select).toHaveBeenCalled();
  });

  it('stamps a saved drone with the signed-in user id, not "local"', async () => {
    const getCtx = renderContext();
    await waitFor(() => expect(from).toHaveBeenCalled());

    await getCtx().saveDrone({ name: 'S1', host: 'ws://x:8765', camera_url: '' });

    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0][0];
    expect(row.owner).toBe('uuid-alice');
    // The exact symptom of the old Firebase `user?.id` read.
    expect(row.owner).not.toBe('local');
  });

  it('never touches the cloud fleet when signed out', async () => {
    mockAuth = { user: null, localMode: false };
    renderContext();
    // Signed out, RLS would return nothing anyway — but not asking is what stops
    // a future permissive policy from quietly leaking somebody else's fleet.
    await waitFor(() => expect(from).not.toHaveBeenCalled());
  });

  it('uses local storage, not the cloud, in "Continue without account" mode', async () => {
    mockAuth = { user: null, localMode: true };
    const getCtx = renderContext();
    await waitFor(() => expect(getCtx().fleetLoading).toBe(false));
    expect(from).not.toHaveBeenCalled();
    expect(getCtx().fleet.length).toBeGreaterThan(0); // the built-in local drone
  });
});
