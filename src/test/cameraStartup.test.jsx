import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getIceServers } from '../components/CameraView';

// The camera took seconds to appear. Two of the three causes are covered here;
// the third (tearing down the in-flight negotiation the moment the link
// connected) is in cameraView.test.jsx.
//
// This one is the TURN credential fetch, which sat in front of the peer
// connection being constructed at all — one round trip to the Pi, paid again on
// every reconnect, retry and remount.

vi.mock('../context/DroneContext', () => ({ useDrone: () => ({}) }));

// The cache is module-level on purpose — it has to survive remounts, which is
// most of its value — so each test needs its own base to actually miss it.
let n = 0;
const freshBase = () => `https://media-${++n}.seagrassrobotics.com`;
const SERVERS = [{ urls: 'turn:turn.example.com:3478', username: 'u', credential: 'c' }];

beforeEach(() => {
  vi.useFakeTimers();
  globalThis.fetch = vi.fn(async () => ({
    json: async () => ({ iceServers: SERVERS }),
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TURN credential caching', () => {
  it('fetches once and serves the rest from cache', async () => {
    const base = freshBase();
    const first = await getIceServers(base);
    const second = await getIceServers(base);

    expect(first).toEqual(SERVERS);
    expect(second).toEqual(SERVERS);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not fire two requests when calls overlap', async () => {
    // Warming on mount and connecting can race; the second must join the first
    // rather than open its own.
    const base = freshBase();
    const [a, b] = await Promise.all([getIceServers(base), getIceServers(base)]);

    expect(a).toEqual(SERVERS);
    expect(b).toEqual(SERVERS);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to STUN rather than failing when the Pi cannot be reached', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    });

    const servers = await getIceServers('https://unreachable.invalid');

    expect(servers).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
  });

  it('needs no request at all when there is no media server configured', async () => {
    const servers = await getIceServers(null);

    expect(servers).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
