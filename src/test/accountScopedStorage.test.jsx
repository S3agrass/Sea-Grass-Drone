import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { DroneProvider, useDrone } from '../context/DroneContext';

// A signed-in account's drones and settings must go to that account, never to
// this browser's storage.
//
// They could go to the wrong place. Local mode is a sessionStorage flag; signOut
// cleared it but signing IN did not, so "Continue without account" followed by a
// real sign-in left localMode true next to a genuine user. The cloud fleet was
// gated on `!localMode`, so that account's writes went to localStorage — in that
// tab only. A second tab, with no flag, loaded the real (empty) cloud fleet and
// showed none of the work. The visible symptoms were "adding a drone does
// nothing" and "my settings don't save across a refresh".

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
vi.mock('../context/AuthContext', () => ({ useAuth: () => mockAuth }));

const { insert, from } = vi.hoisted(() => {
  const order = vi.fn(() => Promise.resolve({ data: [], error: null }));
  const written = () => Promise.resolve({ data: [{ id: 'row-1' }], error: null });
  const select = vi.fn(() => ({ order }));
  const insert = vi.fn(() => ({ select: written }));
  const update = vi.fn(() => ({ eq: () => ({ select: written }) }));
  const from = vi.fn(() => ({ select, insert, update }));
  return { insert, from };
});

vi.mock('../lib/supabase', () => ({ supabaseConfigured: true, supabase: { from } }));

function renderContext() {
  let ctx;
  function Capture() { ctx = useDrone(); return null; }
  render(<DroneProvider><Capture /></DroneProvider>);
  return () => ctx;
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('account-scoped storage', () => {
  it('writes a signed-in user to their account even if a stale local-mode flag is set', async () => {
    mockAuth = { user: { id: 'uuid-alice' }, localMode: true };
    const getCtx = renderContext();
    await waitFor(() => expect(from).toHaveBeenCalled());

    await getCtx().saveDrone({ name: 'S1', host: 'wss://control.seagrassrobotics.com' });

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0].owner).toBe('uuid-alice');
    // The give-away that it went to the browser instead of the account.
    expect(localStorage.getItem('seagrass-fleet')).toBeNull();
  });

  it('reads a signed-in user from their account, not this browser', async () => {
    localStorage.setItem(
      'seagrass-fleet',
      JSON.stringify([{ id: 'local-1', name: 'Left over', host: 'ws://seagrass.local:8765' }]),
    );
    mockAuth = { user: { id: 'uuid-alice' }, localMode: true };
    const getCtx = renderContext();

    await waitFor(() => expect(getCtx().fleetLoading).toBe(false));
    expect(from).toHaveBeenCalledWith('drones');
    expect(getCtx().fleet.find((d) => d.name === 'Left over')).toBeUndefined();
  });

  it('still uses browser storage when there is genuinely no account', async () => {
    mockAuth = { user: null, localMode: true };
    const getCtx = renderContext();

    await waitFor(() => expect(getCtx().fleetLoading).toBe(false));
    expect(from).not.toHaveBeenCalled();
    expect(getCtx().fleet.length).toBeGreaterThan(0);
  });
});
