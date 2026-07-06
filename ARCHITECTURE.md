# Seagrass GCS — Architecture & Developer Reference

This document explains the full system: what every layer does, how data flows through it, why each technology was chosen, and how to extend it. Read this before touching the code.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Tech Stack](#2-tech-stack)
3. [Repository Structure](#3-repository-structure)
4. [Authentication](#4-authentication)
5. [Fleet Management](#5-fleet-management)
6. [Drone Control — WebSocket Protocol](#6-drone-control--websocket-protocol)
7. [Camera Streaming — WebRTC Stack](#7-camera-streaming--webrtc-stack)
8. [Frontend Component Tree](#8-frontend-component-tree)
9. [State Management](#9-state-management)
10. [Tests](#10-tests)
11. [Adding New Features](#11-adding-new-features)
12. [Key Design Decisions](#12-key-design-decisions)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────┐
│  Operator  (browser or Electron desktop app)            │
│                                                         │
│  ┌─────────┐  ┌──────────┐  ┌──────────────────────┐  │
│  │ LoginPage│  │FleetPage │  │    ControlPage        │  │
│  │ Firebase │  │ Drone    │  │  Map · Camera · Helm  │  │
│  │  auth    │  │ registry │  │  Instruments          │  │
│  └─────────┘  └──────────┘  └──────────────────────┘  │
│                                    │           │        │
│                           WebSocket (DroneLink) │        │
│                                    │    WebRTC (WHEP)    │
└────────────────────────────────────┼───────────┼────────┘
                                     │           │
                          ┌──────────▼───────────▼──────┐
                          │   Raspberry Pi 5              │
                          │                               │
                          │  drone_server.py  :8765       │
                          │   ├─ MAVLink → Pixhawk        │
                          │   └─ spawns camera_stream.py  │
                          │                               │
                          │  camera_stream.py             │
                          │   └─ GStreamer → MediaMTX     │
                          │                               │
                          │  MediaMTX  :8889 (WHEP)       │
                          │            :8554 (RTSP)       │
                          └───────────────────────────────┘
                                     │
                          ┌──────────▼──────────┐
                          │  Pixhawk / ArduSub  │
                          │  RC channels 1–4    │
                          │  MAVLink telemetry  │
                          └─────────────────────┘
```

There are two real-time connections from the browser to the Pi:

- **WebSocket** (`drone_server.py` on port 8765) — carries all control commands, arm/disarm, mode changes, and telemetry back to the browser.
- **WebRTC via WHEP** (MediaMTX on port 8889) — carries the live H.264 camera stream from the ArduCam.

Both connections travel over **Tailscale** (an encrypted mesh VPN) when operating remotely, so neither requires open ports or a relay server.

---

## 2. Tech Stack

### Frontend
| Technology | Role |
|---|---|
| React 19 + Vite | UI framework and build tool |
| React Router v7 (hash routing) | Navigation — hash mode required for Electron file:// protocol |
| Leaflet + react-leaflet | Interactive map with drone position and waypoints |
| Firebase (Auth only) | Email/password authentication |
| Supabase (optional) | Cloud fleet registry (drone list); falls back to localStorage if not configured |
| Electron | Desktop app packaging |
| Vitest + Testing Library | Unit and component tests |

### Backend (Raspberry Pi)
| Technology | Role |
|---|---|
| Python 3 + asyncio | Async WebSocket server |
| websockets library | WebSocket implementation |
| pymavlink | MAVLink protocol to Pixhawk over serial USB |
| GStreamer | Video capture pipeline from ArduCam |
| MediaMTX | RTSP ingest + WebRTC (WHEP) distribution |
| Tailscale | Encrypted remote access without port forwarding |

### Infrastructure
| Technology | Role |
|---|---|
| Firebase Console | Auth provider management, user accounts |
| Tailscale admin | Device VPN mesh, Pi gets a stable 100.x.x.x IP |
| Netlify (optional) | Web app hosting with CI/CD from git push |

---

## 3. Repository Structure

```
Sea-Grass-Drone/
│
├── server/
│   ├── drone_server.py      # WebSocket server — runs on Pi, bridges UI ↔ Pixhawk
│   └── camera_stream.py     # GStreamer pipeline — pushes ArduCam → MediaMTX
│
├── src/
│   ├── main.jsx             # React entry point
│   ├── App.jsx              # Router, AuthProvider, DroneProvider
│   │
│   ├── pages/
│   │   ├── LoginPage.jsx    # Firebase email/password sign-in + sign-up
│   │   ├── FleetPage.jsx    # Drone list, add/edit/remove drones
│   │   ├── ControlPage.jsx  # Main cockpit view
│   │   └── SettingsPage.jsx # App settings, demo mode, key map reference
│   │
│   ├── components/
│   │   ├── TopBar.jsx        # Navigation bar, drone name, demo chip
│   │   ├── ConnectionPanel.jsx # Link status, arm/disarm, Pixhawk state
│   │   ├── CameraView.jsx    # WebRTC WHEP player + camera power toggle
│   │   ├── DroneMap.jsx      # Leaflet map, drone marker, trail, waypoints
│   │   ├── KeyboardControl.jsx # WASD/QE/LK helm pad + E-STOP
│   │   ├── Instruments.jsx   # Compass, DepthMeter, SpeedGauge, BatteryMeter
│   │   └── ProtectedRoute.jsx # Auth guard (unused — inline in App.jsx)
│   │
│   ├── context/
│   │   ├── AuthContext.jsx   # Firebase auth state, localMode, signIn/Out
│   │   └── DroneContext.jsx  # DroneLink instance, fleet, telemetry, camera state
│   │
│   ├── lib/
│   │   ├── droneLink.js      # WebSocket client class — all drone communication
│   │   └── supabase.js       # Supabase client (null when env vars absent)
│   │
│   ├── firebase/
│   │   ├── config.js         # Firebase app init, reads VITE_FIREBASE_* env vars
│   │   ├── auth.js           # login(), register(), logout() wrappers
│   │   └── firestore.js      # Stub — Firestore helpers go here if added later
│   │
│   ├── styles/
│   │   ├── theme.css         # CSS variables — colours, fonts, radius, animation
│   │   └── app.css           # All component styles (single file, section comments)
│   │
│   └── test/
│       ├── setup.js                    # Vitest global setup — jest-dom + storage mocks
│       ├── droneLink.test.js           # DroneLink WebSocket protocol tests
│       ├── droneContext.camera.test.jsx # DroneContext camera state machine tests
│       └── cameraView.test.jsx         # CameraView UI and stream type tests
│
├── electron/
│   └── main.cjs              # Electron main process — opens BrowserWindow
│
├── public/
│   └── favicon.svg
│
├── .env.example              # Template for required environment variables
├── vite.config.js            # Vite + Vitest config
├── package.json
├── README.md                 # Quick start
├── ARCHITECTURE.md           # This file
└── SETUP.md                  # Infrastructure setup guide
```

---

## 4. Authentication

### Flow

```
LoginPage
  │
  ├─ Sign in → Firebase signInWithEmailAndPassword()
  ├─ Sign up → Firebase createUserWithEmailAndPassword()
  └─ (future) Local mode → enterLocalMode() — skips Firebase entirely
       │
       ▼
  AuthContext
  ├─ user: Firebase user object (null if not signed in)
  ├─ localMode: boolean (session-scoped, stored in sessionStorage)
  └─ authed: true if user OR localMode
       │
       ▼
  App.jsx <Protected> wrapper
  └─ redirects to "/" if !authed
```

### Files
- `src/firebase/config.js` — initialises the Firebase app from `VITE_FIREBASE_*` environment variables. These must be present in `.env` for auth to work. Without them Firebase throws on startup.
- `src/firebase/auth.js` — thin wrappers around Firebase SDK functions. Keeps Firebase SDK calls out of components.
- `src/context/AuthContext.jsx` — subscribes to `onAuthStateChanged` (Firebase's auth state listener) so the whole app reacts when a user signs in or out.

### Local mode
`localMode` lets the app run without a Firebase account. The fleet is stored in `localStorage` instead of Supabase/Firestore. Useful for LAN-only deployments. `enterLocalMode()` exists in AuthContext but as of now there is no UI button to trigger it — adding a "Continue without account" button to `LoginPage.jsx` is a known gap.

### Environment variables required
```
VITE_FIREBASE_API_KEY
VITE_FIREBASE_AUTH_DOMAIN
VITE_FIREBASE_PROJECT_ID
VITE_FIREBASE_STORAGE_BUCKET
VITE_FIREBASE_MESSAGING_SENDER_ID
VITE_FIREBASE_APP_ID
VITE_FIREBASE_MEASUREMENT_ID  (optional — only needed for Analytics)
```

---

## 5. Fleet Management

A "fleet" is the list of drones a user has registered. Each drone record has:

```javascript
{
  id: string,
  name: string,          // display name e.g. "Seagrass One"
  host: string,          // WebSocket URL  e.g. "ws://100.64.0.1:8765"
  camera_url: string,    // WHEP URL       e.g. "http://100.64.0.1:8889/cam/whep"
  token: string,         // shared secret matching SEAGRASS_TOKEN on the Pi
}
```

### Storage
Fleet records live in one of two places depending on configuration:

| Condition | Storage |
|---|---|
| Supabase env vars set AND user signed in | Supabase `drones` table (per-user RLS) |
| Local mode OR Supabase not configured | `localStorage` key `seagrass-fleet` |

`DroneContext.jsx` handles both paths transparently — components just call `saveDrone()`, `removeDrone()`, `refreshFleet()`.

### Active drone
`activeDroneId` is persisted in `localStorage` so the app remembers which drone you were using after a page refresh. `selectDrone(id)` sets it; `activeDrone` is the computed object from the fleet array.

---

## 6. Drone Control — WebSocket Protocol

### Connection lifecycle

```
DroneLink.connect(url, token)
    │
    └─ opens WebSocket
         │
         onopen → send { type: "hello", token }
                       │
                       server validates token
                       │
                  ← { type: "hello_ok" }
                  ← { type: "state", armed, mode, pixhawk, camera }
                       │
                  telemetry loop starts (every 0.5s)
                  ← { type: "telemetry", heading, groundspeed, battery, lat, lon, depth }
```

### Message reference

**Browser → Pi**

| Message | When sent | Effect |
|---|---|---|
| `{ type: "hello", token }` | Immediately on connect | Authenticates the session |
| `{ type: "ping" }` | Every 5 seconds | Resets server watchdog timer |
| `{ type: "key", key, pressed }` | Keydown / keyup | Updates RC channel PWM |
| `{ type: "arm" }` | Arm button | Arms Pixhawk motors |
| `{ type: "disarm" }` | Disarm button | Disarms, sends all-stop |
| `{ type: "mode", mode }` | Mode selector | Changes ArduSub flight mode |
| `{ type: "stop" }` | Space bar / E-STOP | Sends neutral PWM to all channels |
| `{ type: "camera_on" }` | Camera power toggle (off → on) | Starts `camera_stream.py` subprocess |
| `{ type: "camera_off" }` | Camera power toggle (on → off) | Terminates `camera_stream.py` subprocess |

**Pi → Browser**

| Message | When sent |
|---|---|
| `{ type: "hello_ok" }` | After successful auth |
| `{ type: "state", armed, mode, pixhawk, camera }` | After every command + every 0.5s |
| `{ type: "telemetry", heading, groundspeed, battery, lat, lon, depth }` | Every 0.5s when data available |
| `{ type: "error", message }` | Bad token, duplicate helm, etc. |

### RC channel mapping (matches `keyboard_control.py`)

| Key | Channel | PWM values |
|---|---|---|
| W (forward) / S (back) | 1 — Propulsion | 1650 / 1350 / 1500 neutral |
| D (right) / A (left) | 2 — Steering | 1650 / 1350 / 1500 neutral |
| Q (rise) / E (dive) | 3 — Buoyancy | 1650 / 1350 / 1500 neutral |
| L (on) / K (off) | 4 — Light | 1900 / 1500 |

### Safety mechanisms
- **Watchdog** — if the client stops sending messages for 1.5 seconds while motion keys are held, the server forces all-stop.
- **Helm lock** — only one client can send commands at a time. The first authenticated client takes the helm; others get an error.
- **Disconnect all-stop** — when a client disconnects, all channels go to neutral.
- **Token auth** — `SEAGRASS_TOKEN` env var must be set on the server. The client sends it in the `hello` message. 4401 close code = bad token, client will not retry.

### DroneLink class (`src/lib/droneLink.js`)

`DroneLink` is a plain ES class (not a React component) that wraps the WebSocket with reconnect logic and an event emitter:

```
DroneLink
├─ connect(url, token)    — opens socket, stores credentials for reconnect
├─ disconnect()           — closes cleanly, no reconnect
├─ send(msg)              — JSON stringifies and sends; returns false if not open
├─ subscribe(fn)          — register event listener; returns unsubscribe function
│
├─ sendKey(key, pressed)
├─ arm() / disarm()
├─ setMode(mode)
├─ allStop()
├─ cameraOn() / cameraOff()
│
└─ internal
   ├─ _open()             — creates WebSocket, attaches handlers
   ├─ _setStatus(status)  — updates this.status + emits { type: "status" }
   └─ _keepAlive          — setInterval sending ping every 5s
```

Events emitted to subscribers:
- `{ type: "status", status: "connecting" | "connected" | "disconnected" | "error", detail? }`
- `{ type: "message", data: <parsed JSON from server> }`

---

## 7. Camera Streaming — WebRTC Stack

### Architecture

```
ArduCam
  │ (libcamera)
  ▼
GStreamer pipeline (camera_stream.py)
  │ RTSP push over TCP
  ▼
MediaMTX (local on Pi, port 8554 RTSP in, 8889 WHEP out)
  │ WebRTC (WHEP protocol) over Tailscale HTTPS
  ▼
RTCPeerConnection (CameraView.jsx)
  │
  ▼
<video> element
```

### Why this stack (not MJPEG)
MJPEG served over HTTP has three problems for remote use:
1. `http://pi.local` doesn't resolve outside the LAN
2. Browsers block HTTP media loaded from an HTTPS page (mixed content)
3. No adaptive bitrate — if bandwidth drops the stream just dies

WebRTC solves all three: it's browser-native, works over HTTPS, and has built-in congestion control.

### GStreamer pipeline explained (`camera_stream.py`)

```python
GST_CMD = [
    "gst-launch-1.0", "-e",
    "libcamerasrc", "!",
    f"video/x-raw,width={WIDTH},height={HEIGHT},framerate={FPS}/1", "!",
    "videoconvert", "!",
    "x264enc", "tune=zerolatency", f"bitrate={BITRATE}", "speed-preset=ultrafast", "!",
    "video/x-h264,profile=baseline", "!",
    "rtspclientsink", f"location={RTSP_SINK}", "protocols=tcp",
]
```

Each `"!"` is the GStreamer element link operator. Reading left to right:

| Element | What it does |
|---|---|
| `libcamerasrc` | Reads frames from ArduCam via the Pi's libcamera stack |
| `video/x-raw,...` | Caps filter — locks resolution and frame rate |
| `videoconvert` | Converts pixel format to whatever x264enc needs |
| `x264enc tune=zerolatency` | Encodes to H.264 with minimal latency (not optimised for file size) |
| `video/x-h264,profile=baseline` | Caps filter — baseline profile is most browser-compatible |
| `rtspclientsink` | Pushes the encoded stream to MediaMTX as an RTSP client |

To use the Pi hardware encoder instead (lower CPU usage, slightly higher latency), replace the `x264enc` line with `v4l2h264enc extra-controls="controls,repeat_sequence_header=1"`.

### Camera subprocess lifecycle (`drone_server.py`)

```
browser sends { type: "camera_on" }
    │
    ▼
start_camera()
  └─ subprocess.Popen(["python3", "camera_stream.py"])
  └─ camera_proc stored as module-level variable

server broadcasts { type: "state", ..., camera: true }
    │
    ▼
browser sends { type: "camera_off" }
    │
    ▼
stop_camera()
  └─ camera_proc.terminate()   (SIGTERM → graceful)
  └─ wait 5s, then kill() if still running
  └─ camera_proc = None

server broadcasts { type: "state", ..., camera: false }
```

`camera_running()` checks `camera_proc.poll() is None` — `.poll()` returns `None` when the process is alive or an exit code when it has finished.

### WHEP connection (`CameraView.jsx`)

WHEP (WebRTC-HTTP Egress Protocol) is the standard way for a browser to pull a WebRTC stream from a media server using a single HTTP POST, with no custom signaling server:

```
Browser                           MediaMTX
   │                                 │
   │── POST /cam/whep ──────────────▶│
   │   body: SDP offer               │
   │                                 │
   │◀── 201 Created ─────────────────│
   │    body: SDP answer             │
   │                                 │
   │   ICE candidates exchanged      │
   │   (via STUN server)             │
   │                                 │
   │◀══ WebRTC stream ═══════════════│
```

The browser implementation in `connectWHEP()`:

```javascript
// 1. Create peer connection
const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
});

// 2. Wire track to <video> element
pc.ontrack = (e) => { videoEl.srcObject = e.streams[0]; };

// 3. Receive-only — we never send media
pc.addTransceiver("video", { direction: "recvonly" });
pc.addTransceiver("audio", { direction: "recvonly" });

// 4. Create SDP offer
await pc.setLocalDescription(await pc.createOffer());

// 5. Wait for all ICE candidates to be gathered (or 5s timeout)
//    Sending a complete SDP is simpler than trickle-ICE
await Promise.race([iceGatheringComplete, timeout(5000)]);

// 6. POST offer to WHEP endpoint, get answer back
const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: pc.localDescription.sdp,
});
await pc.setRemoteDescription({ type: "answer", sdp: await resp.text() });

// Stream now flows into videoEl.srcObject
```

### Stream type detection

`CameraView` supports both old MJPEG and new WebRTC URLs without configuration:

```javascript
function streamType(url) {
    if (!url) return null;
    if (/\.mjpe?g$/i.test(url)) return "mjpeg";  // legacy LAN
    return "webrtc";                               // MediaMTX WHEP
}
```

URLs configured in fleet settings determine which player is used. New drones default to WebRTC.

---

## 8. Frontend Component Tree

```
App.jsx
└─ HashRouter
   └─ AuthProvider (Firebase auth state)
      └─ DroneProvider (drone link, fleet, telemetry, camera state)
         ├─ LoginPage          /
         ├─ FleetPage          /fleet
         ├─ ControlPage        /control
         │  ├─ TopBar
         │  ├─ ConnectionPanel (left sidebar)
         │  ├─ Instruments     (left sidebar)
         │  │  ├─ Compass
         │  │  ├─ DepthMeter
         │  │  ├─ SpeedGauge
         │  │  └─ BatteryMeter
         │  ├─ DroneMap        (center)
         │  ├─ CameraView      (right sidebar)
         │  └─ KeyboardControl (right sidebar)
         └─ SettingsPage       /settings
```

All components inside `DroneProvider` can call `useDrone()` to access drone state. All components inside `AuthProvider` can call `useAuth()` to access auth state.

---

## 9. State Management

There is no Redux or Zustand. State lives in two React contexts:

### AuthContext
```javascript
{
  user,          // Firebase User object | null
  loading,       // boolean — true while Firebase checks stored session
  localMode,     // boolean — true when using app without an account
  authed,        // boolean — user || localMode
  signIn,        // (email, password) => Promise
  signUp,        // (email, password) => Promise
  signOut,       // () => Promise
  enterLocalMode // () => void
}
```

### DroneContext
```javascript
{
  // Fleet
  fleet,          // array of drone objects
  fleetLoading,   // boolean
  refreshFleet,   // () => Promise
  saveDrone,      // (drone) => Promise
  removeDrone,    // (id) => Promise
  activeDrone,    // drone object | null
  selectDrone,    // (id) => void

  // Link
  link,           // DroneLink instance (for direct method calls)
  connect,        // () => void
  disconnect,     // () => void
  linkStatus,     // "disconnected" | "connecting" | "connected" | "error"
  linkDetail,     // string — extra detail for error messages

  // Drone state
  armed,          // boolean
  flightMode,     // string e.g. "MANUAL"
  pixhawkOk,      // boolean — Pixhawk heartbeat received

  // Telemetry
  telemetry: {
    heading,      // degrees 0–359 | null
    groundspeed,  // knots | null
    battery,      // percent 0–100 | null
    lat, lon,     // decimal degrees | null
    depth,        // metres | null
  },

  // Camera
  cameraActive,   // boolean — camera subprocess running on Pi
  cameraOn,       // () => void
  cameraOff,      // () => void

  // Demo
  demoMode,       // boolean — simulates telemetry without a real drone
  setDemoMode,    // (boolean) => void
}
```

---

## 10. Tests

Run with `npm test` (single pass) or `npm run test:watch` (interactive).

### Test files

#### `src/test/droneLink.test.js`
Tests the raw WebSocket layer in isolation. Uses a constructor-based `WsMock` that records sent messages. Key detail: the mock must set `WsMock.OPEN = 1` because `DroneLink.send()` checks `readyState === WebSocket.OPEN`, and replacing the global `WebSocket` would otherwise make `.OPEN` undefined.

| Test | Covers |
|---|---|
| Hello sent on connect | Auth handshake |
| `cameraOn` / `cameraOff` messages | New camera commands |
| Returns false when socket closed | Send guard |
| No reconnect after 4401 | Token rejection |
| Reconnects after normal close | Reconnect logic |

#### `src/test/droneContext.camera.test.jsx`
Tests the React state layer. Uses `vi.hoisted()` to create the mock DroneLink instance before Vitest's module mock hoisting runs — this is necessary because `vi.mock()` calls are hoisted to the top of the file at compile time, which means they execute before `let mockLink` would be in scope.

| Test | Covers |
|---|---|
| `cameraActive` starts false | Initial state |
| Updates to true / false from server state | State handler |
| Resets on disconnect | Connection drop |
| `cameraOn` / `cameraOff` delegate to link | Context functions |

#### `src/test/cameraView.test.jsx`
Tests the UI component. Mocks `useDrone()` via `vi.mock('../context/DroneContext')` to control what state the component receives without needing a real WebSocket.

| Test | Covers |
|---|---|
| Toggle shows "Off" / "On" based on `cameraActive` | Button state |
| Clicking toggle calls `cameraOn` / `cameraOff` | Event handlers |
| Toggle disabled when not connected or no URL | Guard conditions |
| Placeholder text reflects each feed state | Offline / no URL |
| Action buttons disabled when not live | Snapshot / Record guards |
| `<video>` rendered for WHEP URL | WebRTC path |
| `<img>` rendered for MJPEG URL | Legacy path |

#### `src/test/setup.js`
Global test setup. Provides in-memory `localStorage` and `sessionStorage` implementations because jsdom's storage API is not always fully initialised in the Vitest jsdom environment.

### Writing new tests

When testing a component that uses context:
```javascript
vi.mock('../context/DroneContext', () => ({
  useDrone: () => ({ /* your mock values */ }),
}));
```

When testing DroneContext itself, use `vi.hoisted()` for anything the mock factory needs:
```javascript
const { mockLink } = vi.hoisted(() => {
  const link = { subscribe: vi.fn(), ... };
  return { mockLink: link };
});
vi.mock('../lib/droneLink', () => ({
  default: function() { return mockLink; },
}));
```

---

## 11. Adding New Features

### Adding a new drone command

**1. Add the message type to `drone_server.py`:**
```python
elif mtype == "lights_full":
    set_rc(4, 1900)
```

**2. Add a method to `DroneLink`:**
```javascript
lightsOn() { return this.send({ type: "lights_full" }); }
```

**3. Expose through context if needed (`DroneContext.jsx`):**
```javascript
const lightsOn = useCallback(() => link.lightsOn(), [link]);
// add to value object
```

**4. Call from a component:**
```javascript
const { lightsOn } = useDrone();
<button onClick={lightsOn}>Full lights</button>
```

### Adding a new telemetry field

**1. In `drone_server.py`, add to `read_telemetry()`:**
```python
elif t == "SCALED_IMU":
    out["roll"] = msg.xacc / 1000.0
```

**2. Add initial value in `DroneContext.jsx`:**
```javascript
const [telemetry, setTelemetry] = useState({
  ...,
  roll: null,   // ← add
});
```

The telemetry merge `setTelemetry((t) => ({ ...t, ...m }))` handles the rest automatically.

**3. Use in a component:**
```javascript
const { telemetry } = useDrone();
<span>{telemetry.roll?.toFixed(1) ?? '—'}</span>
```

### Adding a new page

**1. Create `src/pages/NewPage.jsx`**

**2. Add route in `App.jsx`:**
```jsx
<Route path="/new" element={<Protected><NewPage /></Protected>} />
```

**3. Add nav link in `TopBar.jsx`**

### Replacing Supabase fleet storage with Firestore

`src/firebase/firestore.js` is a stub waiting to be filled. The pattern in `DroneContext.jsx` already branches on `supabaseConfigured`. Add a `firestoreConfigured` check and mirror the `saveDrone`/`removeDrone`/`refreshFleet` implementations using the Firestore SDK.

---

## 12. Key Design Decisions

### Hash routing instead of history routing
Electron loads the app as `file:///path/to/dist/index.html`. History-based routing (e.g. `/fleet`) would require a web server to redirect all paths to `index.html`. Hash routing (`/#/fleet`) works without a server. Netlify also doesn't need redirect rules.

### DroneLink as a plain class, not a React hook
`DroneLink` manages a WebSocket that must persist across renders and re-renders. Putting it in a plain class (stored in a `useRef` inside `DroneProvider`) keeps the WebSocket lifecycle completely separate from React's render cycle. The context subscribes to link events once and updates state via `setState` calls.

### Single operator helm lock
Only the first authenticated client that sends a command takes the helm. This is intentional safety design — two people trying to drive at once would be dangerous. If you need multi-operator support (e.g. one pilots, one controls lights) you would need to add a concept of "roles" to the server.

### Waiting for full ICE gathering before sending WHEP offer
WHEP supports "trickle ICE" where candidates are sent incrementally, but this requires a second round-trip per candidate. For Tailscale (P2P VPN), all candidates resolve quickly and sending a complete offer in one POST is simpler, more reliable, and adds only ~1-2 seconds of connection setup time.

### Camera subprocess managed by drone_server.py (not systemd)
The camera starts/stops on operator demand via WebSocket commands, not at Pi boot. This saves battery and processing power when the camera isn't needed, and gives the operator explicit control. The trade-off is that if `drone_server.py` crashes, the camera also stops — a deliberate choice to keep the two services tightly coupled.

---

## 13. Troubleshooting

### "SEAGRASS_TOKEN must be set" on server start
Export the token before running: `export SEAGRASS_TOKEN=your-secret`

### Camera shows "Camera error — stream unreachable"
1. Check MediaMTX is running on the Pi (`ps aux | grep mediamtx`)
2. Check the camera URL in Fleet settings matches the Pi's Tailscale IP
3. Check `drone_server.py` logs — if `camera_stream.py` failed to start it will print the error
4. Run `camera_stream.py` manually to see GStreamer errors: `python3 server/camera_stream.py`

### "Another operator has the helm"
Only one WebSocket client can send commands at a time. Either the previous session didn't disconnect cleanly (wait ~10s for the server watchdog to clear it) or someone else is connected. Reconnecting will not take the helm until the current holder disconnects.

### WebRTC stream connects but video is black
- The GStreamer pipeline started but the `rtspclientsink` can't reach MediaMTX. Check that `MEDIAMTX_HOST` matches where MediaMTX is actually listening.
- Alternatively, `libcamerasrc` failed to open the camera device. Check `journalctl -u camera-stream` or run manually.

### Tests fail with "localStorage.getItem is not a function"
This means `src/test/setup.js` is not being loaded. Verify `setupFiles: './src/test/setup.js'` is present in `vite.config.js` under the `test` key.

### Firebase auth fails silently (no error, no redirect)
The `.env` file is missing or has empty values. Open the browser console — you should see the `console.log` in `src/firebase/config.js` printing the project ID. If it prints `undefined`, the env vars are not loaded.
