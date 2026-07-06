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

```bash
ssh pi@seagrass-pi.local
pip install pymavlink websockets --break-system-packages
cd ~/Sea-Grass-Drone/server
SEAGRASS_TOKEN=pick-a-long-secret python3 drone_server.py
```

- Pixhawk connects over USB (`/dev/ttyACM0`). Override with `PIXHAWK_PORT=` env var.
- `SEAGRASS_TOKEN` must match the "Access token" saved for the drone in the Fleet UI.
- Without a token set the server will refuse to start — this is intentional.

**Autostart with systemd:**
```ini
# /etc/systemd/system/drone-server.service
[Unit]
Description=Seagrass drone server
After=network.target

[Service]
Environment=SEAGRASS_TOKEN=pick-a-long-secret
ExecStart=/usr/bin/python3 /home/pi/Sea-Grass-Drone/server/drone_server.py
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now drone-server
```

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
