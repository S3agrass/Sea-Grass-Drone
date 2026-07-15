/**
 * DroneLink — WebSocket client for the Seagrass drone server (server/drone_server.py).
 *
 * Protocol (JSON):
 *   client → server:
 *     { type: "hello", token }               auth handshake
 *     { type: "key", key: "w", pressed }     mirrors keyboard_control.py mappings
 *     { type: "arm" } / { type: "disarm" }
 *     { type: "mode", mode: "MANUAL" }
 *     { type: "stop" }                       all-stop (space bar / E-STOP)
 *     { type: "camera_on" } / { type: "camera_off" }
 *     { type: "detect_on" } / { type: "detect_off" }   toggle object detection
 *   server → client:
 *     { type: "state", armed, mode, pixhawk, camera, detect }
 *     { type: "telemetry", heading, groundspeed, battery, lat, lon, depth }
 *     { type: "detections", boxes: [{ cls, conf, x, y, w, h }], ts }
 *     { type: "error", message }
 *     { type: "notice", level: "error"|"warn", message }   arm rejections, PreArm reasons
 *     { type: "hello_ok" }
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
  arm() { return this.send({ type: "arm" }); }
  disarm() { return this.send({ type: "disarm" }); }
  setMode(mode) { return this.send({ type: "mode", mode }); }
  allStop() { return this.send({ type: "stop" }); }
  cameraOn() { return this.send({ type: "camera_on" }); }
  cameraOff() { return this.send({ type: "camera_off" }); }
  detectOn() { return this.send({ type: "detect_on" }); }
  detectOff() { return this.send({ type: "detect_off" }); }
}
