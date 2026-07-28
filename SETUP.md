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

## 3. Supabase (cloud fleet registry + captured media)

Without Supabase, drone configs are saved in `localStorage` on the device (local mode) and captured photos stay on the Pi's SD card only. Set it up to share a fleet across devices and to back up media — see [step 6b](#6b-media-backup-to-supabase) for the media half:

1. Create a project at [supabase.com](https://supabase.com) (free tier, no card).
2. SQL Editor → run `supabase-schema.sql` (creates the `drones` and `media` tables with Row Level Security, plus the `media` storage bucket).
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

### 5e. Object detection (YOLOX)

The detector (`server/vision/detector.py`) reads the JPEG frame that
`camera_stream.py` continuously drops on disk, runs a YOLOX ONNX model over it,
and streams boxes to the browser. The AI button on the Control page starts and
stops it.

**You must fetch a model first.** It is a ~3.5 MB binary and is deliberately not
in git (`.gitignore` excludes `server/vision/models/*.onnx`), so a fresh clone
has no detector at all:

```bash
pip install -r server/requirements.txt   # onnxruntime, opencv-python-headless, numpy
./scripts/fetch-model.sh                 # -> server/vision/models/yolox_nano.onnx
```

**Check it before wiring anything up.** Run it by hand against any photo — this
prints to your terminal, where the server would otherwise route it to the log:

```bash
DETECT_UNDERWATER=0 DETECT_FRAME=/path/to/photo.jpg python3 server/vision/detector.py
```

Expect a banner naming the model and output shape, then one JSON line per
frame. Ctrl-C to stop.

> **The stock model is a test instrument, not the product.** It is trained on
> COCO — 80 land classes, `person`, `car`, `bottle` — and will not recognise
> anything marine. Its job is to prove camera → frame tap → inference →
> WebSocket → overlay in one go. Point the camera at yourself, see a box, and
> the whole path is confirmed. Swap in a trained model by setting
> `DETECT_MODEL`; nothing else changes. See `training/README.md`.

| Variable | Default | Description |
|---|---|---|
| `DETECT_MODEL` | `server/vision/models/yolox_nano.onnx` | ONNX model path |
| `DETECT_LABELS` | `server/vision/models/coco.txt` | One class name per line, order = class index |
| `DETECT_FPS` | `5` | Max inference rate. Drop to 2–3 if the Pi can't keep up |
| `DETECT_SIZE` | `416` | Model input square. Must match the export |
| `DETECT_CONF` | `0.35` | Confidence threshold |
| `DETECT_UNDERWATER` | `1` | Colour filter. **Set 0 for dry testing** — it corrects a blue-green cast that isn't there in air |
| `DETECT_DECODE` | `1` | Set 0 only for a model exported *with* `decode_in_inference` |
| `DETECT_STALE_S` | `3.0` | Clear boxes after this long with no fresh frame |

Put any overrides in `~/.seagrass-env`; systemd reads it via `EnvironmentFile`.

**Troubleshooting.** Detection failures now surface as a toast in the UI and a
`Detector:` line in `journalctl -fu drone-server`. The usual causes:

- *"model not found"* — run `./scripts/fetch-model.sh`.
- *Boxes are tiny and bunched in the top-left corner* — the model was exported
  with the decode already baked in. Set `DETECT_DECODE=0`.
- *No boxes at all, no errors* — check the camera is running
  (`ps aux | grep camera_stream`); the detector needs its frame tap.
- *Detection lags badly* — it is CPU-bound on the Pi and shares the core with
  the MJPEG encoder. Lower `DETECT_FPS`, or `DETECT_SIZE` to 320.

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
- **Media server URL:** leave blank (defaults to the camera host on `:8000`)
- **Drone ID:** matches `DRONE_ID` on the Pi, or blank to show the whole fleet's media
- **Access token:** matches `SEAGRASS_TOKEN` on the Pi

The stream will now work from anywhere the operator has Tailscale running.

> The camera URL points at MediaMTX on `:8889`, but photos and recordings are
> served by `camera_stream.py` on `:8000`. The Media page derives the media host
> from the camera host with the port swapped, which is why the media field can
> stay blank — set it only if the media server runs somewhere else entirely.

---

## 6b. Media backup to Supabase

Captures are written to the Pi's SD card first, because a dive has no operator
connected and often no network link at all. `media_uploader.py` drains them to
the cloud whenever the vehicle has connectivity again — typically on surfacing.
Nothing is deleted from the card; the cloud is a backup.

**Why Supabase and not Firebase.** Cloud Storage for Firebase has required the
paid Blaze plan since September 2024 — on the free Spark plan you get no buckets
at all and calls return 402/403. Supabase's free tier includes 1 GB of file
storage with no credit card. Firebase keeps auth and hosting; only the media
bytes moved.

**Photos only, by default.** At the default `REC_BITRATE` of 4 Mbit/s a recording
is roughly **1.8 GB per hour**, so video cannot fit a 1 GB allowance. The
uploader ships photos (`UPLOAD_TYPES=photo`) and leaves recordings on the card,
where they stay browsable from the Media page whenever the drone is powered on.
Recordings are *skipped, not discarded* — set `UPLOAD_TYPES=photo,video` on a
paid tier and everything already on the card uploads.

### One-time Supabase setup

1. Create a project at [supabase.com](https://supabase.com) (no card required).
2. SQL Editor → New query → paste all of `supabase-schema.sql` → Run. This
   creates the `drones` and `media` tables, their RLS policies, and the `media`
   storage bucket.
3. Project settings → API. Copy into `.env` (and into Netlify's env vars):
   ```
   VITE_SUPABASE_URL=https://xxxxxxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJ...
   ```
4. Optional: Database → Replication → enable realtime for `public.media`, so the
   Media page fills in live as a surfacing drone drains its backlog. Without it
   the page still works, it just needs a manual refresh.

> **Access note.** The app signs in with Firebase, not Supabase, so the browser
> only ever holds the anon key and the media policies grant read to `anon`.
> Captures are effectively *unlisted* rather than access-controlled — anyone with
> the anon key (it ships in the client bundle) could read them. Fine for survey
> footage; move auth to Supabase before storing anything sensitive.

### On the Pi

Add to `~/.seagrass-env` — the **service_role** key, not the anon key. It
bypasses RLS, which is what lets the drone write rows no browser may write, so
it must never reach the web bundle:

```bash
SUPABASE_URL=https://xxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
DRONE_ID=seagrass-one
# UPLOAD_TYPES=photo,video   # only on a paid tier
```

Then install the uploader service (no new Python packages — it uses urllib):

```bash
cd ~/Sea-Grass-Drone && git pull
sudo cp scripts/media-uploader.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now media-uploader
sudo systemctl restart drone-server    # picks up the sidecar writing
journalctl -fu media-uploader
```

A healthy start prints `Media uploader starting — dir=… drone=… bucket=media
types=photo`. A successful upload prints `Uploaded photo-… -> seagrass-one/…`.

> Free Supabase projects pause after ~1 week with no activity. Restore is one
> click in the dashboard, but a paused project means uploads fail and retry —
> which is exactly what the queue is built for, so nothing is lost.

### Autonomous capture (optional, off by default)

With the detector running, the vehicle can photograph what it finds on its own.
Add to `~/.seagrass-env` and restart `drone-server`:

| Variable | Default | Meaning |
|---|---|---|
| `DETECT_AUTOCAPTURE` | `0` | `1` to enable |
| `DETECT_AUTOCAPTURE_MIN_CONF` | `0.6` | Confidence a detection must clear |
| `DETECT_AUTOCAPTURE_COOLDOWN_S` | `15` | Minimum gap between captures |

The cooldown matters: the detector emits several frames a second, and without it
one fish lingering in view becomes hundreds of near-identical JPEGs.

Each capture records what triggered it — detector label, confidence, depth,
heading and position — and the Media page shows that under the thumbnail.

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
