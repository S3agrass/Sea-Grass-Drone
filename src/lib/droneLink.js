/**
 * DroneLink — WebSocket client for the Seagrass drone server (server/drone_server.py).
 *
 * Protocol (JSON):
 *   client → server:
 *     { type: "hello", token }               auth handshake
 *     { type: "key", key: "w", pressed }     mirrors keyboard_control.py mappings
 *     { type: "axis", surge, steer, depth }  analog sticks, floats in [-1, 1];
 *                                            server ramps toward these as targets
 *     { type: "arm" } / { type: "disarm" }
 *     { type: "mode", mode: "MANUAL" }
 *     { type: "stop" }                       hard kill — server process exits
 *     { type: "soft_stop" }                  latched recoverable all-stop (toggle)
 *     { type: "ping" }                       keepalive
 *     { type: "camera_on" } / { type: "camera_off" }
 *     { type: "detect_on" } / { type: "detect_off" }   toggle object detection
 *     { type: "record_start" } / { type: "record_stop" }  SD-card recording (Pi-side)
 *     { type: "photo" }                      capture a still to the Pi's SD card
 *     { type: "set_autorecord", on }         auto-record whole missions on arm
 *   server → client:
 *     { type: "state", armed, mode, pixhawk, camera, detect,
 *                      recording, rec_elapsed_s, autorecord }
 *     { type: "media_saved", kind: "photo", name }   a capture landed on the Pi
 *     { type: "telemetry", heading, groundspeed, battery, lat, lon, depth }
 *     { type: "motors", angle, mag, left, right, left_pwm, right_pwm }  10Hz, helm only
 *     { type: "soft_stop", latched }         latched soft-stop state changed
 *     { type: "detections", boxes: [{ cls, conf, x, y, w, h }], ts }
 *     { type: "error", message }
 *     { type: "notice", level: "error"|"warn", message }   arm rejections, PreArm reasons
 *     { type: "hello_ok" }
 *
 * Motion input: "key" and "axis" are unioned server-side (drone_server.py
 * _axis_value), so a client driving analog must not leave stale keys held.
 */
export default class DroneLink {
  constructor() {
    this.ws = null;
    this.url = null;
    this.token = null;
    this.status = "disconnected"; // disconnected | connecting | connected | error
    this.listeners = new Set();
    this._shouldReconnect = false;
    this._reconnectTimer = null;
    this._keepAlive = null;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(event) {
    for (const fn of this.listeners) fn(event);
  }

  _setStatus(status, detail) {
    this.status = status;
    this._emit({ type: "status", status, detail });
  }

  connect(url, token = "") {
    this.disconnect(false);
    this.url = url;
    this.token = token;
    this._shouldReconnect = true;
    this._open();
  }

  _open() {
    if (!this.url) return;
    this._setStatus("connecting");
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this._setStatus("error", err.message || "Invalid WebSocket URL");
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this._setStatus("connected");
      this.send({ type: "hello", token: this.token });
      // heartbeat so the server watchdog knows we're alive
      this._keepAlive = setInterval(() => this.send({ type: "ping" }), 5000);
    };

    ws.onmessage = (e) => {
      try {
        this._emit({ type: "message", data: JSON.parse(e.data) });
      } catch {
        /* ignore malformed frames */
      }
    };

    ws.onerror = () => {
      this._setStatus("error", "Connection error");
    };

    ws.onclose = (e) => {
      clearInterval(this._keepAlive);
      if (e.code === 4401) {
        this._shouldReconnect = false;
        this._setStatus("error", "Invalid access token — check Settings");
        return;
      }
      if (this._shouldReconnect) {
        this._setStatus("connecting", "Reconnecting…");
        this._reconnectTimer = setTimeout(() => this._open(), 2500);
      } else {
        this._setStatus("disconnected");
      }
    };
  }

  disconnect(emit = true) {
    this._shouldReconnect = false;
    clearTimeout(this._reconnectTimer);
    clearInterval(this._keepAlive);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    if (emit) this._setStatus("disconnected");
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  sendKey(key, pressed) {
    return this.send({ type: "key", key, pressed });
  }
  /** Analog stick targets, each a float in [-1, 1]. The server ramps toward
   *  these rather than applying them directly, and unions them with any held
   *  keys — so an analog client should clear its keys first (see
   *  GamepadControl's purge on enable). */
  sendAxis({ surge = 0, steer = 0, depth = 0 } = {}) {
    return this.send({ type: "axis", surge, steer, depth });
  }
  arm() { return this.send({ type: "arm" }); }
  disarm() { return this.send({ type: "disarm" }); }
  setMode(mode) { return this.send({ type: "mode", mode }); }
  /** Hard kill: the server process exits and needs a manual restart. */
  allStop() { return this.send({ type: "stop" }); }
  /** Latched soft-stop toggle: freezes all motion but keeps the server up and
   *  the vehicle armed, so it's recoverable by toggling again. While latched the
   *  server ignores axis input entirely. */
  softStop() { return this.send({ type: "soft_stop" }); }
  cameraOn() { return this.send({ type: "camera_on" }); }
  cameraOff() { return this.send({ type: "camera_off" }); }
  detectOn() { return this.send({ type: "detect_on" }); }
  detectOff() { return this.send({ type: "detect_off" }); }
  /** Start/stop an SD-card recording on the Pi. Recording lives on the drone, so
   *  it keeps running through an autonomous dive with no link to the browser. */
  recordStart() { return this.send({ type: "record_start" }); }
  recordStop() { return this.send({ type: "record_stop" }); }
  /** Capture a still frame to the Pi's SD card. */
  photo() { return this.send({ type: "photo" }); }
  /** Toggle auto-record: when on, the Pi records whenever the vehicle is armed —
   *  including unattended autonomous missions. Persisted server-side. */
  setAutoRecord(on) { return this.send({ type: "set_autorecord", on: !!on }); }
}
