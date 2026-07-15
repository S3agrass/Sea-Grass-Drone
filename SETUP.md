# Seagrass GCS — Setup Guide

For full architecture details see [ARCHITECTURE.md](./ARCHITECTURE.md). This guide covers the steps to get everything running.

---

## 1. Frontend

```bash
npm install
cp .env.example .env   # fill in Firebase credentials (see step 2)
npm run dev            # http://localhost:5173
npm run electron:dev   # or run as the desktop app
```

---

## 2. Firebase (authentication)

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and create a project.
2. Authentication → Sign-in method → enable **Email/Password**.
3. Project Settings → Your apps → Add a Web app → copy the config object.
4. Fill in `.env`:
```
VITE_FIREBASE_API_KEY=AIza...
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789
VITE_FIREBASE_APP_ID=1:123:web:abc
```
5. Restart `npm run dev`. The login page will now sign users in with Firebase.

**Sign up:** use the "Create account" tab on the login page. If you want to manage users directly, use the Firebase console Authentication → Users tab.

---

## 3. Supabase (optional — cloud fleet registry)

Without Supabase, drone configs are saved in `localStorage` on the device (local mode). To share a fleet across devices/users, set up Supabase:

1. Create a project at [supabase.com](https://supabase.com).
2. SQL Editor → run `supabase-schema.sql` (creates the `drones` table with Row Level Security).
3. Project Settings → API → copy URL and anon key.
4. Add to `.env`:
```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

---

## 4. Raspberry Pi — drone server

### One-time setup

```bash
ssh pi@seagrass-pi.local
pip install pymavlink websockets --break-system-packages
mkdir -p ~/.local/bin
ln -s ~/Sea-Grass-Drone/scripts/drone ~/.local/bin/drone
drone   # first run creates the ~/.seagrass-env template, then exits
nano ~/.seagrass-env   # paste the drone's "Access token" from the Fleet UI
```

- `~/.local/bin` is on `PATH` by default on Raspberry Pi OS; if the directory
  didn't exist before, log out and back in once so the shell picks it up.
- `~/.seagrass-env` holds `SEAGRASS_TOKEN` (must match the token saved for the
  drone in the Fleet UI) plus optional overrides (`PIXHAWK_PORT`,
  `PIXHAWK_BAUD`, `SEAGRASS_PORT`). It is chmod 600 and never committed.
- Without a token set the server refuses to start — this is intentional.

### Daily use

```bash
drone
```

That's it — from any directory, right after SSH login. The script:

1. loads `SEAGRASS_TOKEN` from `~/.seagrass-env`,
2. kills any stale process still holding the Pixhawk serial port
   (`/dev/ttyACM0` by default) so port contention never blocks a start,
3. starts `server/drone_server.py` and waits for the MAVLink heartbeat,
4. prints `✅ ready` only once the heartbeat **and** websocket are up. If the
   Pixhawk doesn't answer (wrong port, cable out), it stops the server and
   exits non-zero with a clear error instead of running half-alive.

Ctrl-C stops the server. Note: the Pixhawk safety switch does not affect the
heartbeat — it only blocks arming — so `drone` can report ready with the
switch unpressed.

### Optional — autostart with systemd

If you want the server already running before you SSH in, install the unit
shipped in the repo (it reads the same `~/.seagrass-env` via `EnvironmentFile`,
so the token never lives in the unit file):

```bash
sudo cp ~/Sea-Grass-Drone/scripts/drone-server.service /etc/systemd/system/
sudo systemctl enable --now drone-server
journalctl -fu drone-server   # logs
```

**Tradeoffs vs. the manual `drone` command:**

- `drone` (manual): logs stream in your terminal, Ctrl-C stops everything, and
  nothing runs while you're away — but the server only lives as long as your
  SSH session (use tmux to detach).
- systemd: up at boot and auto-restarts on crash, no typing at all — but logs
  live in `journalctl`, there's no interactive "ready" check (it silently
  retries every 3 s), and the drone server is always listening unattended.

They interoperate: running `drone` stops the systemd unit first so the two
never fight over the serial port. Hand the port back afterwards with
`sudo systemctl start drone-server`.

---

## 5. Raspberry Pi — camera (WebRTC via MediaMTX)

The camera system has two parts: MediaMTX (always-on media server) and the GStreamer pipeline (started on demand by drone_server.py when the operator clicks "Camera On" in the UI).

### 5a. Install dependencies

```bash
# GStreamer + plugins
sudo apt update
sudo apt install -y \
  gstreamer1.0-tools \
  gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad \
  gstreamer1.0-libav \
  gstreamer1.0-plugins-ugly

# Verify
gst-launch-1.0 --version
```

### 5b. Install MediaMTX

MediaMTX is a single binary — no dependencies.

```bash
# Check https://github.com/bluenviron/mediamtx/releases for the latest version
wget https://github.com/bluenviron/mediamtx/releases/latest/download/mediamtx_v1.x.x_linux_arm64v8.tar.gz
tar -xzf mediamtx_*.tar.gz
sudo mv mediamtx /usr/local/bin/
```

The default `mediamtx.yml` works out of the box. MediaMTX listens on:
- `:8554` — RTSP ingest (where `camera_stream.py` pushes to)
- `:8889` — WebRTC / WHEP (where the browser connects from)

**Autostart:**
```ini
# /etc/systemd/system/mediamtx.service
[Unit]
Description=MediaMTX media server
After=network.target

[Service]
ExecStart=/usr/local/bin/mediamtx
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now mediamtx
```

### 5c. Test the camera pipeline manually

Before using the UI, verify GStreamer can stream to MediaMTX:

```bash
python3 ~/Sea-Grass-Drone/server/camera_stream.py
```

Then open a browser and go to `http://<pi-tailscale-ip>:8889/cam` — you should see a test page with the live stream.

### 5d. Environment variables for camera_stream.py

All optional — defaults work for most setups:

| Variable | Default | Description |
|---|---|---|
| `MEDIAMTX_HOST` | `127.0.0.1` | Where MediaMTX RTSP is listening |
| `MEDIAMTX_RTSP_PORT` | `8554` | MediaMTX RTSP port |
| `STREAM_NAME` | `cam` | Stream path in MediaMTX |
| `CAM_WIDTH` | `1280` | Capture width in pixels |
| `CAM_HEIGHT` | `720` | Capture height in pixels |
| `CAM_FPS` | `30` | Frame rate |
| `CAM_BITRATE` | `2000` | H.264 bitrate in kbps |

---

## 6. Remote access — Tailscale

Tailscale creates an encrypted P2P VPN between the Pi and the operator's machine. The Pi gets a stable `100.x.x.x` address reachable from anywhere without port forwarding.

### On the Pi

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Note the Pi's Tailscale IP from `tailscale ip -4` (e.g. `100.64.0.1`).

### On the operator's machine

Install the Tailscale client from [tailscale.com/download](https://tailscale.com/download) and sign in to the same account.

### In the Fleet UI

When registering the drone, set:
- **Drone link:** `ws://100.64.0.1:8765`
- **Camera stream URL:** `http://100.64.0.1:8889/cam/whep`
- **Access token:** matches `SEAGRASS_TOKEN` on the Pi

The stream will now work from anywhere the operator has Tailscale running.

---

## 7. Deploy the web UI (Netlify)

```bash
npm run build   # outputs to dist/
```

Netlify auto-deploys on push. The app uses hash routing so no redirect rules are needed. Add the `VITE_FIREBASE_*` environment variables in Netlify → Site settings → Environment variables.

---

## 8. Running tests

```bash
npm test             # single run
npm run test:watch   # watch mode
```

25 tests covering DroneLink protocol, DroneContext camera state, and CameraView UI. All tests are in `src/test/`.

---

## Control mapping

| Key | Channel | Action |
|---|---|---|
| W / S | 1 | Propulsion forward / back |
| A / D | 2 | Steer right / left |
| Q / E | 3 | Buoyancy rise / dive |
| L / K | 4 | Light on / off |
| Space | all | Emergency all-stop |

PWM: `1500` neutral · `1650` forward/right/rise · `1350` back/left/dive · `1900` light on.
