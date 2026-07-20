import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import DroneLink from '../lib/droneLink';

const WS_OPEN = 1; // WebSocket.OPEN numeric constant

function makeWsStub() {
  const sent = [];
  const stub = {
    readyState: WS_OPEN,
    send: (raw) => sent.push(JSON.parse(raw)),
    close: vi.fn(),
    onopen: null, onmessage: null, onerror: null, onclose: null,
    _sent: sent,
    _triggerOpen() { this.onopen?.(); },
    _triggerClose(code = 1000) { this.onclose?.({ code }); },
  };
  return stub;
}

// Module-level ref so WsMock constructor can populate it.
let currentWs;
function WsMock() {
  Object.assign(this, makeWsStub());
  currentWs = this;
}
WsMock.OPEN = WS_OPEN;

describe('DroneLink — camera commands', () => {
  let link;

  beforeEach(() => {
    vi.stubGlobal('WebSocket', WsMock);
    link = new DroneLink();
    link.connect('ws://test:8765', 'token');
    currentWs._triggerOpen();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hello message is sent immediately on open', () => {
    expect(currentWs._sent[0]).toMatchObject({ type: 'hello', token: 'token' });
  });

  it('cameraOn sends { type: "camera_on" }', () => {
    currentWs._sent.length = 0;
    link.cameraOn();
    expect(currentWs._sent.at(-1)).toEqual({ type: 'camera_on' });
  });

  it('cameraOff sends { type: "camera_off" }', () => {
    currentWs._sent.length = 0;
    link.cameraOff();
    expect(currentWs._sent.at(-1)).toEqual({ type: 'camera_off' });
  });

  it('cameraOn returns false when socket is closed', () => {
    currentWs.readyState = 3; // WebSocket.CLOSED
    expect(link.cameraOn()).toBe(false);
  });

  it('detectOn sends { type: "detect_on" }', () => {
    currentWs._sent.length = 0;
    link.detectOn();
    expect(currentWs._sent.at(-1)).toEqual({ type: 'detect_on' });
  });

  it('detectOff sends { type: "detect_off" }', () => {
    currentWs._sent.length = 0;
    link.detectOff();
    expect(currentWs._sent.at(-1)).toEqual({ type: 'detect_off' });
  });

  it('allStop sends { type: "stop" }', () => {
    currentWs._sent.length = 0;
    link.allStop();
    expect(currentWs._sent.at(-1)).toEqual({ type: 'stop' });
  });
});

describe('DroneLink — reconnect behaviour', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not reconnect after 4401 (invalid token)', () => {
    vi.useFakeTimers();
    let callCount = 0;
    function WsMock2() {
      Object.assign(this, makeWsStub());
      currentWs = this;
      callCount++;
    }
    WsMock2.OPEN = WS_OPEN;
    vi.stubGlobal('WebSocket', WsMock2);

    const link = new DroneLink();
    link.connect('ws://test:8765', 'bad-token');
    currentWs._triggerOpen();
    currentWs._triggerClose(4401);

    expect(link.status).toBe('error');
    vi.runAllTimers();
    // WebSocket should only be constructed once — no reconnect attempt.
    expect(callCount).toBe(1);
  });

  it('reconnects after a normal close', () => {
    vi.useFakeTimers();
    let callCount = 0;
    function WsMock3() {
      Object.assign(this, makeWsStub());
      currentWs = this;
      callCount++;
    }
    WsMock3.OPEN = WS_OPEN;
    vi.stubGlobal('WebSocket', WsMock3);

    const link = new DroneLink();
    link.connect('ws://test:8765', 'token');
    currentWs._triggerOpen();
    currentWs._triggerClose(1001); // going away — normal drop

    expect(link.status).toBe('connecting');
    vi.runAllTimers(); // advance past 2500 ms reconnect timer
    expect(callCount).toBe(2);
  });
});
