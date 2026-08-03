import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import CameraView from '../components/CameraView';

// How often the camera renegotiates, and why.
//
// The operator's credential is not a stable string: it starts empty, becomes the
// drone token, then the Supabase session JWT once getSession() resolves, and
// changes again on every hourly refresh. Depending on it directly meant each of
// those tore down the peer connection and built a new one — two negotiations per
// page load, and a video dropout every hour on a vehicle steered by this picture.
//
// A WebRTC connection needs a credential at negotiation time. It does not need
// rebuilding because the string later changed. What must still force a
// reconnect is a change of credential KIND — the demotion to the drone token
// after a 4401 — or the camera stays dark after that fallback has already
// rescued the control link. These tests hold that line, in both directions.

const WHEP = 'https://cam.example.com/cam/whep';

let mockCtx;
vi.mock('../context/DroneContext', () => ({ useDrone: () => mockCtx }));

function whepCalls() {
  return global.fetch.mock.calls.filter(([url]) => String(url).includes('/whep'));
}

class FakePeerConnection {
  constructor() {
    this.iceGatheringState = 'complete'; // resolve waitForCandidates immediately
    this.localDescription = { type: 'offer', sdp: 'v=0' };
    this.closed = false;
    FakePeerConnection.instances.push(this);
  }
  addTransceiver() {}
  addEventListener() {}
  removeEventListener() {}
  async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  getReceivers() { return []; }
  close() { this.closed = true; }
}
FakePeerConnection.instances = [];

function baseCtx(overrides = {}) {
  return {
    activeDrone: { camera_url: WHEP, token: 'drone-token' },
    mediaBase: 'https://media.example.com',
    linkStatus: 'connected',
    cameraActive: true,
    cameraKnown: true,
    cameraError: null,
    detectActive: false,
    detections: [],
    detectOn: vi.fn(),
    detectOff: vi.fn(),
    recording: false,
    recElapsed: 0,
    recordStart: vi.fn(),
    recordStop: vi.fn(),
    capturePhoto: vi.fn(),
    setCameraViewing: vi.fn(),
    operatorCredential: 'jwt.one.sig',
    credentialMode: 'identity',
    credentialReady: true,
    ...overrides,
  };
}

beforeEach(() => {
  FakePeerConnection.instances = [];
  global.RTCPeerConnection = FakePeerConnection;
  global.fetch = vi.fn(async (url) => {
    if (String(url).includes('turn-credentials')) {
      return { ok: true, json: async () => ({ iceServers: [{ urls: 'stun:x' }] }) };
    }
    return { ok: true, text: async () => 'v=0\r\n' }; // WHEP answer
  });
  mockCtx = baseCtx();
});

afterEach(() => vi.restoreAllMocks());

describe('camera negotiation', () => {
  it('negotiates once for a page load', async () => {
    const { rerender } = render(<CameraView />);
    await waitFor(() => expect(whepCalls().length).toBe(1));
    rerender(<CameraView />);
    expect(whepCalls().length).toBe(1);
  });

  it('does not renegotiate when the session token merely refreshes', async () => {
    // supabase-js does this roughly hourly, unprompted. Before the fix it took
    // the live camera down with it.
    const { rerender } = render(<CameraView />);
    await waitFor(() => expect(whepCalls().length).toBe(1));

    mockCtx = baseCtx({ operatorCredential: 'jwt.two.sig' });
    rerender(<CameraView />);
    await new Promise((r) => setTimeout(r, 20));

    expect(whepCalls().length).toBe(1);
    expect(FakePeerConnection.instances.filter((p) => p.closed)).toHaveLength(0);
  });

  it('renegotiates when the credential kind changes', async () => {
    // The 4401 fallback demoting identity -> drone token. The camera must
    // follow, or it stays dark while the control link works.
    const { rerender } = render(<CameraView />);
    await waitFor(() => expect(whepCalls().length).toBe(1));

    mockCtx = baseCtx({ credentialMode: 'drone', operatorCredential: 'drone-token' });
    rerender(<CameraView />);

    await waitFor(() => expect(whepCalls().length).toBe(2));
  });

  it('sends the current credential even though it is not a dependency', async () => {
    // Read through a ref: not depended on, but never stale either.
    mockCtx = baseCtx({ operatorCredential: 'jwt.current.sig' });
    render(<CameraView />);
    await waitFor(() => expect(whepCalls().length).toBe(1));

    const [, init] = whepCalls()[0];
    expect(init.headers.Authorization).toBe(`Basic ${btoa('seagrass:jwt.current.sig')}`);
  });

  it('waits for the session to resolve before negotiating at all', async () => {
    // Connecting during this window is what produced the thrown-away first
    // negotiation: whatever credential existed a tick after mount, discarded
    // moments later when the real one arrived.
    mockCtx = baseCtx({ credentialReady: false });
    const { rerender } = render(<CameraView />);
    await new Promise((r) => setTimeout(r, 20));
    expect(whepCalls().length).toBe(0);

    mockCtx = baseCtx({ credentialReady: true });
    rerender(<CameraView />);
    await waitFor(() => expect(whepCalls().length).toBe(1));
  });

  it('clears a failed attempt when the credential changes', async () => {
    // The refused attempt leaves feedState "error". Without resetting it on a
    // credential change, that error sits on screen through the whole of the
    // successful negotiation that follows — so a recovery reads as a fault.
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('turn-credentials')) {
        return { ok: true, json: async () => ({ iceServers: [] }) };
      }
      return { ok: false, status: 401, text: async () => 'unauthorized' };
    });

    const { rerender, queryByText } = render(<CameraView />);
    await waitFor(() => expect(queryByText(/camera error/i)).toBeTruthy());

    // Demotion. The retry is deliberately left hanging: the question is what the
    // operator sees WHILE it is in flight. If the assertion waited for it to
    // succeed, "live" would clear the error by itself and the test would pass
    // with or without the reset.
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('turn-credentials')) {
        return { ok: true, json: async () => ({ iceServers: [] }) };
      }
      return new Promise(() => {}); // never settles
    });
    mockCtx = baseCtx({ credentialMode: 'drone', operatorCredential: 'drone-token' });
    rerender(<CameraView />);

    await waitFor(() => expect(queryByText(/camera error/i)).toBeNull());
  });

  it('does not spend a request warming TURN before it has a credential', async () => {
    // /turn-credentials is authenticated; an early call earns a 401 and parks a
    // shared in-flight promise the first real caller would inherit.
    mockCtx = baseCtx({ credentialReady: false, operatorCredential: '' });
    render(<CameraView />);
    await new Promise((r) => setTimeout(r, 20));

    const turn = global.fetch.mock.calls.filter(([u]) =>
      String(u).includes('turn-credentials'),
    );
    expect(turn).toHaveLength(0);
  });
});
