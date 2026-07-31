import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { DroneProvider, useDrone, DEFAULT_CAMERA_URL, DEFAULT_MEDIA_URL } from '../context/DroneContext';

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

  it('rewrites the dead host in camera_url too, not just host', () => {
    // This fixture existed above and only its token was ever asserted, so the
    // camera_url quietly kept the dead name: the link connected while the feed
    // showed "Camera error — stream unreachable", which looks like a broken
    // camera rather than a hostname nothing can resolve.
    localStorage.setItem('seagrass-fleet', JSON.stringify([
      {
        id: 'a', name: 'Seagrass One', host: 'ws://seagrass-pi.local:8765',
        token: 't', camera_url: 'http://seagrass-pi.local:8000/stream.mjpg',
      },
    ]));
    const getCtx = renderContext();
    expect(getCtx().fleet[0].camera_url).toBe(DEFAULT_CAMERA_URL);
  });

  it('repairs camera_url even when host is already correct', () => {
    // The two fields drifted apart in exactly this way once host was fixed on
    // its own, so neither may depend on the other being wrong.
    localStorage.setItem('seagrass-fleet', JSON.stringify([
      {
        id: 'a', name: 'Seagrass One', host: 'ws://seagrass.local:8765',
        token: 't', camera_url: 'http://seagrass-pi.local:8000/stream.mjpg',
      },
    ]));
    const getCtx = renderContext();
    expect(getCtx().fleet[0].camera_url).toBe(DEFAULT_CAMERA_URL);
    expect(getCtx().fleet[0].host).toBe('ws://seagrass.local:8765');
  });

  it('persists the camera_url repair so it survives a reload', () => {
    localStorage.setItem('seagrass-fleet', JSON.stringify([
      { id: 'a', name: 'S', host: 'ws://seagrass.local:8765', token: 't',
        camera_url: 'http://seagrass-pi.local:8000/stream.mjpg' },
    ]));
    renderContext();
    const saved = JSON.parse(localStorage.getItem('seagrass-fleet'));
    expect(saved[0].camera_url).toBe(DEFAULT_CAMERA_URL);
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
    expect(getCtx().fleet[0].camera_url).toBe(DEFAULT_CAMERA_URL);
  });

  it('fills in a camera_url that is missing entirely', () => {
    localStorage.setItem('seagrass-fleet', JSON.stringify([
      { id: 'a', name: 'Seagrass One', host: 'ws://seagrass.local:8765', token: 't' },
    ]));
    const getCtx = renderContext();
    expect(getCtx().fleet[0].camera_url).toBe(DEFAULT_CAMERA_URL);
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

  // Third instance of the same fault: the :8000 MJPEG default outlived the
  // server that answered it. camera_stream.py now feeds MediaMTX and :8000 is
  // media_server.py, which 404s /stream.mjpg — and the .mjpg suffix makes the
  // app pick the legacy <img> path instead of WHEP, so it never tries the real
  // endpoint either. Everyone whose blank was filled in back then is pinned to it.
  it('rewrites the retired :8000 MJPEG default to the WHEP endpoint', () => {
    localStorage.setItem('seagrass-fleet', JSON.stringify([
      { id: 'a', name: 'Seagrass One', host: 'ws://seagrass.local:8765', token: 't',
        camera_url: 'http://seagrass.local:8000/stream.mjpg' },
    ]));
    const getCtx = renderContext();
    expect(getCtx().fleet[0].camera_url).toBe(DEFAULT_CAMERA_URL);
  });

  it('repairs the retired default behind a dead host, in one pass', () => {
    // Both migrations have to land on the same field: the host rewrite turns
    // this into the exact old default, which the default repair then replaces.
    localStorage.setItem('seagrass-fleet', JSON.stringify([
      { id: 'a', name: 'Seagrass One', host: 'ws://seagrass-pi.local:8765', token: 't',
        camera_url: 'http://seagrass-pi.local:8000/stream.mjpg' },
    ]));
    const getCtx = renderContext();
    expect(getCtx().fleet[0].camera_url).toBe(DEFAULT_CAMERA_URL);
  });

  it('leaves a custom MJPEG stream alone — a legacy rig may still serve it', () => {
    // Only the EXACT retired default is rewritten. A .mjpg URL anywhere else is
    // a deliberate setup that might work fine, and breaking it would be worse
    // than leaving it: MJPEG support is still in CameraView for this reason.
    localStorage.setItem('seagrass-fleet', JSON.stringify([
      { id: 'a', name: 'Old rig', host: 'ws://10.0.0.5:8765', token: 't',
        camera_url: 'http://10.0.0.5:8000/stream.mjpg' },
    ]));
    const getCtx = renderContext();
    expect(getCtx().fleet[0].camera_url).toBe('http://10.0.0.5:8000/stream.mjpg');
  });

  it('pairs the media URL with the public camera default', () => {
    // Camera and media are separate hosts, so the mediaBase fallback (camera
    // host + :8000) invents cam.seagrassrobotics.com:8000 — nothing serves that,
    // and the Media page 404s while WHEP quietly loses its TURN credentials.
    localStorage.setItem('seagrass-fleet', JSON.stringify([
      { id: 'a', name: 'Seagrass One', host: 'ws://seagrass.local:8765', token: 't',
        camera_url: '' },
    ]));
    localStorage.setItem('seagrass-active-drone', 'a');
    const getCtx = renderContext();
    expect(getCtx().fleet[0].camera_url).toBe(DEFAULT_CAMERA_URL);
    expect(getCtx().fleet[0].media_url).toBe(DEFAULT_MEDIA_URL);
    expect(getCtx().mediaBase).toBe('https://media.seagrassrobotics.com');
  });

  it('leaves a media_url the operator set alone', () => {
    localStorage.setItem('seagrass-fleet', JSON.stringify([
      { id: 'a', name: 'Seagrass One', host: 'ws://seagrass.local:8765', token: 't',
        camera_url: '', media_url: 'http://10.0.0.5:8000' },
    ]));
    const getCtx = renderContext();
    expect(getCtx().fleet[0].media_url).toBe('http://10.0.0.5:8000');
  });

  it('does not force the public media host onto a LAN camera URL', () => {
    // A .local camera URL derives its media host correctly on its own, so
    // pairing must not fire and push a local rig out to the internet.
    localStorage.setItem('seagrass-fleet', JSON.stringify([
      { id: 'a', name: 'LAN rig', host: 'ws://seagrass.local:8765', token: 't',
        camera_url: 'http://seagrass.local:8889/cam/whep' },
    ]));
    localStorage.setItem('seagrass-active-drone', 'a');
    const getCtx = renderContext();
    expect(getCtx().fleet[0].media_url).toBeUndefined();
    expect(getCtx().mediaBase).toBe('http://seagrass.local:8000');
  });

  it('persists the retired-default repair so it survives a reload', () => {
    localStorage.setItem('seagrass-fleet', JSON.stringify([
      { id: 'a', name: 'S', host: 'ws://seagrass.local:8765', token: 't',
        camera_url: 'http://seagrass.local:8000/stream.mjpg' },
    ]));
    renderContext();
    const saved = JSON.parse(localStorage.getItem('seagrass-fleet'));
    expect(saved[0].camera_url).toBe(DEFAULT_CAMERA_URL);
  });

  it('persists the filled-in camera_url so it survives a reload', () => {
    localStorage.setItem('seagrass-fleet', JSON.stringify([
      { id: 'a', name: 'Seagrass One', host: 'ws://seagrass.local:8765', token: 't', camera_url: '' },
    ]));
    renderContext();
    const saved = JSON.parse(localStorage.getItem('seagrass-fleet'));
    expect(saved[0].camera_url).toBe(DEFAULT_CAMERA_URL);
  });
});
