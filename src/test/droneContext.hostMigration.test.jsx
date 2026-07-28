import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { DroneProvider, useDrone } from '../context/DroneContext';

// A saved fleet entry overrides the code default forever, so correcting the
// default was not enough on its own: the stale host produced a UI stuck on
// "Connecting…" with nothing whatsoever in the server log, because the
// connection never left the laptop. These cover the self-repair.
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
  localStorage.clear();
  vi.clearAllMocks();
});

describe('DroneContext — stale host migration', () => {
  it('rewrites a saved seagrass-pi.local host to seagrass.local', () => {
    localStorage.setItem('seagrass-fleet', JSON.stringify([
      { id: 'a', name: 'Seagrass One', host: 'ws://seagrass-pi.local:8765', token: 't' },
    ]));
    const getCtx = renderContext();
    expect(getCtx().fleet[0].host).toBe('ws://seagrass.local:8765');
  });

  it('persists the repair so it survives a reload', () => {
    localStorage.setItem('seagrass-fleet', JSON.stringify([
      { id: 'a', name: 'Seagrass One', host: 'ws://seagrass-pi.local:8765', token: 't' },
    ]));
    renderContext();
    const saved = JSON.parse(localStorage.getItem('seagrass-fleet'));
    expect(saved[0].host).toBe('ws://seagrass.local:8765');
  });

  it('preserves the token and every other field', () => {
    localStorage.setItem('seagrass-fleet', JSON.stringify([
      {
        id: 'a', name: 'Seagrass One', host: 'ws://seagrass-pi.local:8765',
        token: 'f303d18', camera_url: 'http://seagrass-pi.local:8000/stream.mjpg',
      },
    ]));
    const getCtx = renderContext();
    const d = getCtx().fleet[0];
    expect(d.token).toBe('f303d18');
    expect(d.name).toBe('Seagrass One');
    expect(d.id).toBe('a');
  });

  it('leaves a correct host untouched', () => {
    localStorage.setItem('seagrass-fleet', JSON.stringify([
      { id: 'a', name: 'Seagrass One', host: 'ws://seagrass.local:8765', token: 't' },
    ]));
    const getCtx = renderContext();
    expect(getCtx().fleet[0].host).toBe('ws://seagrass.local:8765');
  });

  it('leaves an unrelated custom host untouched', () => {
    localStorage.setItem('seagrass-fleet', JSON.stringify([
      { id: 'a', name: 'Tunnelled', host: 'wss://drone.example.com', token: 't' },
    ]));
    const getCtx = renderContext();
    expect(getCtx().fleet[0].host).toBe('wss://drone.example.com');
  });

  // Same class of fault as the dead host — a wrong shipped default that
  // localStorage pins forever. A blank camera_url renders no feed AND blocks
  // the camera from ever starting, with nothing in the UI saying why.
  it('fills in a blank camera_url with the Pi default', () => {
    localStorage.setItem('seagrass-fleet', JSON.stringify([
      { id: 'a', name: 'Seagrass One', host: 'ws://seagrass.local:8765', token: 't', camera_url: '' },
    ]));
    const getCtx = renderContext();
    expect(getCtx().fleet[0].camera_url).toBe('http://seagrass.local:8000/stream.mjpg');
  });

  it('fills in a camera_url that is missing entirely', () => {
    localStorage.setItem('seagrass-fleet', JSON.stringify([
      { id: 'a', name: 'Seagrass One', host: 'ws://seagrass.local:8765', token: 't' },
    ]));
    const getCtx = renderContext();
    expect(getCtx().fleet[0].camera_url).toBe('http://seagrass.local:8000/stream.mjpg');
  });

  it('never overwrites a camera_url the operator set', () => {
    // The whole point of only touching blanks: a tunnelled or custom address is
    // a deliberate choice and repairing it would break a working setup.
    localStorage.setItem('seagrass-fleet', JSON.stringify([
      { id: 'a', name: 'Tunnelled', host: 'wss://drone.example.com', token: 't',
        camera_url: 'https://cam.example.com/feed.mjpg' },
    ]));
    const getCtx = renderContext();
    expect(getCtx().fleet[0].camera_url).toBe('https://cam.example.com/feed.mjpg');
  });

  it('persists the filled-in camera_url so it survives a reload', () => {
    localStorage.setItem('seagrass-fleet', JSON.stringify([
      { id: 'a', name: 'Seagrass One', host: 'ws://seagrass.local:8765', token: 't', camera_url: '' },
    ]));
    renderContext();
    const saved = JSON.parse(localStorage.getItem('seagrass-fleet'));
    expect(saved[0].camera_url).toBe('http://seagrass.local:8000/stream.mjpg');
  });
});
