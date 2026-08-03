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

Supabase is **required** — it provides sign-in, and local mode (which used to let you in without an account) was retired. Without it the login screen has nothing to authenticate against and there is no way into the app. It also holds the shared fleet registry and the media backup — see [step 6b](#6b-media-backup-to-supabase) for the media half:

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

### Operator identity

By default the vehicle accepts one shared secret, `SEAGRASS_TOKEN`. That token
is stored in the browser and never expires, so anyone who obtains a copy has
permanent control. Operator identity replaces it for signed-in browsers: the
browser presents its **Supabase session token**, which expires in about an hour
and refreshes itself, and the Pi verifies it against the project's **public**
key. The vehicle holds nothing that could mint a token.

**The vehicle works out who owns it by itself.** On startup, and every few
minutes after, it looks up its own row in the `drones` table and takes the owner
from there — using `SUPABASE_SERVICE_KEY` and `DRONE_ID`, which the media
uploader already needs. Registering a drone in the app is therefore enough to be
able to drive it, and transferring or revoking it takes effect on the vehicle
without anyone SSHing in.

So if media upload is already configured (section 9), there is nothing to add
here beyond the dependency below. Check the boot log:

```
Operator auth: Supabase identity for 1 operator(s) registered in Supabase, shared token as fallback
```

> **`DRONE_ID` must match the drone's "Drone ID" in the Fleet UI.** That is what
> ties the vehicle to its row. If they disagree the vehicle finds no owner, says
> so at boot, and stays on the shared token:
>
> ```
> No owner registered for drone_id='seagrass'. Operator identity cannot be
> checked; the shared token still works.
> ```

`SEAGRASS_OWNER_UIDS` is an optional override, additive to whatever the database
says. Use it for a vehicle that cannot reach Supabase, or to authorise someone
who is not the registered owner:

```bash
# In ~/.seagrass-env — normally unnecessary
SEAGRASS_OWNER_UIDS=<a Supabase user id>   # comma-separated for several
```

Find your user id in the app: **Settings → Account → Operator ID**.

Install the dependency and restart — **the install is not optional**:

```bash
pip install -r ~/Sea-Grass-Drone/server/requirements.txt --break-system-packages
sudo systemctl restart drone-server
```

`drone-server` prints which mode is live at boot:

```
Operator auth: Supabase identity for 1 owner(s), shared token as fallback
Operator auth: shared token only (SEAGRASS_OWNER_UIDS unset)
```

If it says "shared token only" when you expected identity, the log gives the
reason — usually a missing `SEAGRASS_OWNER_UIDS` or PyJWT not installed.

**`SEAGRASS_TOKEN` deliberately keeps working.** This Pi has no real-time clock,
so a vehicle that boots offline can have a wrong clock and reject perfectly valid
tokens as expired. Being unable to drive the boat until someone SSHes into it is
a worse outcome than a long-lived secret existing. The CLI tools
(`terminal_control.py`) and the camera's own RTSP push use it too, neither having
a Supabase session. What changed is that a signed-in *browser* no longer holds it.

**Break-glass:** if identity verification refuses a signed-in operator — wrong
clock, keys never fetched, `DRONE_ID` mismatch — the app notices and retries with
the drone's own token automatically, so you are not locked out of your vehicle.
The connection banner will say so. Fix the underlying cause and reconnect to go
back to identity.

To turn identity off entirely, unset `SUPABASE_SERVICE_KEY` (or
`SEAGRASS_OWNER_UIDS`) and restart; the boot log will confirm shared-token-only.

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

**Do not use the default `mediamtx.yml`.** Copy this repo's
`server/mediamtx.yml` into place instead:

```bash
sudo cp ~/Sea-Grass-Drone/server/mediamtx.yml /mediamtx.yml
```

MediaMTX ships with authentication off, which means anyone who can reach it can
watch the camera *and* publish to it — replacing the operator's video feed with
their own. That is not theoretical here: the WHEP endpoint is published to the
internet through a Cloudflare Tunnel. This repo's config delegates every publish
and read to `media_server.py`, so the camera is gated by the same
`SEAGRASS_TOKEN` as the control link. `media_server.py` must be running for
MediaMTX to authorise anyone.

MediaMTX listens on:
- `:8554` — RTSP ingest (where `camera_stream.py` pushes to, with credentials)
- `:8889` — WebRTC / WHEP (where the browser connects from, with credentials)

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

Then open a browser and go to
`http://<pi-tailscale-ip>:8889/cam?user=seagrass&pass=<SEAGRASS_TOKEN>` — you
should see a test page with the live stream. Without the credentials MediaMTX
answers 401, which is the config working, not a fault.

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
| `CAM_UNDERWATER` | `1` | Live-view boost (below). **Set 0 for dry testing** |
| `CAM_GAMMA` | `1.3` | Midtone lift — the main murky-water knob |
| `CAM_CONTRAST` | `1.15` | Contrast multiplier |
| `CAM_SATURATION` | `1.2` | Saturation multiplier |

**Underwater live-view boost.** In murky water the subject sits in the bottom
third of the histogram and the feed reads as grey soup. `CAM_UNDERWATER` splices
`gamma` + `videobalance` into the operator's H.264 branch to lift the midtones
and contrast. It is deliberately much weaker than the detector's filter (5e):
per-channel white balance and dehazing are NumPy-only and far too slow for every
720p30 frame, so this trims levels rather than correcting colour. If the
`videofilter` plugin is missing the boost is dropped and the camera still
starts — the startup banner says which elements actually loaded.

The detection tap is teed off *ahead* of the boost on purpose, so the detector
still sees raw frames and estimates its own white balance from unskewed colour.

> **Software is the smallest lever here.** Physics beats filtering: a light
> close to the subject, or simply flying closer, does more for visibility than
> anything in this section. A red/magenta lens filter (~$15) helps in clear
> water at 1–3 m on ambient light — but do not combine it with a lamp, they
> fight each other.

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

**Tuning the underwater filter.** `server/vision/underwater_filter.py` runs four
stages on every frame before inference — Shades-of-Gray white balance, dark
channel dehazing, CLAHE, unsharp mask (~6 ms at 320×320, against 100–300 ms of
inference). The right settings depend on the water, so tune them against a still
from the actual dive rather than guessing mid-mission:

```bash
python3 server/vision/underwater_filter.py frame.jpg -o compare.png   # original | enhanced
UW_DEHAZE_STRENGTH=0.95 python3 server/vision/underwater_filter.py frame.jpg -o compare.png
```

| Variable | Default | Description |
|---|---|---|
| `UW_WB_NORM` | `6` | White-balance Minkowski norm. `1` = classic gray-world, `0` = skip |
| `UW_DEHAZE` | `1` | Dark-channel dehazing — the step that cuts through murk |
| `UW_DEHAZE_STRENGTH` | `0.85` | 0–1. Higher is more aggressive; too high crushes distant detail into noise |
| `UW_DEHAZE_PATCH` | `15` | Dark-channel patch size in pixels |
| `UW_CLAHE_CLIP` | `2.0` | CLAHE clip limit, `0` = skip |
| `UW_SHARPEN` | `0.6` | Unsharp amount, `0` = skip |

> Clear open water wants little dehazing; a silty bay wants a lot. If detections
> get *worse* after enhancement, drop `UW_DEHAZE_STRENGTH` first — over-dehazing
> invents texture that the detector reads as objects.

**The biggest lever is not this filter.** A model fine-tuned on underwater
imagery beats any amount of preprocessing on a COCO model, which has never seen
a murky-water artifact. If you are still on `coco.txt`, go do
`training/README.md` before spending time here.

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
- **Drone ID:** matches `DRONE_ID` on the Pi — **required**, see below
- **Access token:** matches `SEAGRASS_TOKEN` on the Pi

> **Drone ID is no longer optional.** It used to be blank-for-everything, which
> worked only because the media table had no per-user policy — everyone saw
> every capture. Media is now reached *through* the drone that owns it
> (`d.owner = auth.uid() and d.drone_id = media.drone_id`), so a blank id
> matches nothing and the Media page comes up empty.
>
> Find the value your uploader is actually writing:
>
> ```sql
> select distinct drone_id, count(*) from public.media group by drone_id;
> ```
>
> With nothing uploaded yet it defaults to the Pi's hostname — see `DRONE_ID`
> in `server/media_uploader.py`.

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
3. Project settings → API. Copy into `.env` (and into the GitHub Actions secrets CI deploys with):
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

## 6c. Making it work from a deployed (non-local) site

Everything above uses `ws://`/`http://` and Tailscale IPs, which is fine for
`npm run dev` — that page is itself served over plain HTTP, so there's no
mismatch. Deploy the frontend somewhere (step 7) and it's served over HTTPS,
and **browsers block a page loaded over HTTPS from making any insecure
`ws://`/`http://` request** ("mixed content") — regardless of the fact that
Tailscale itself already encrypts the traffic underneath; the browser only
looks at the URL scheme. Without the steps below, the deployed site's camera
and control connections just silently fail.

Three endpoints need real TLS: the control WebSocket (`:8765`), the camera
(MediaMTX WHEP, `:8889`), and the media server (`:8000`). They're **not** all
handled the same way:

- **Control (`:8765`) gets its own direct TLS**, terminated inside
  `drone_server.py` itself — not proxied through `tailscale serve`. That proxy
  has open upstream reports of WebSocket connections dropping every 10-40s,
  which is not a corner to cut on the connection actively driving the vehicle.
  `tailscale cert` (free) issues a real Let's Encrypt certificate for the
  device's tailnet name; the server loads it directly, same as any standard
  `wss://` deployment.
- **Camera and media (`:8889`, `:8000`) go through `tailscale serve`.** Both are
  effectively single request/response calls (WHEP's signaling POST, then the
  actual video is a separate peer-to-peer WebRTC/SRTP flow over the tailnet —
  not proxied at all; plain `/media` fetches), so the WebSocket-specific
  flakiness above doesn't apply, and `tailscale serve` auto-renews its own
  certs with no maintenance.

### One-time: enable HTTPS on the tailnet

[Tailscale admin console](https://login.tailscale.com/admin/dns) → DNS →
confirm MagicDNS is on → HTTPS Certificates → **Enable HTTPS**. Free, but it
publishes the device's tailnet name in a public certificate transparency log
(not its IP or anything else — just the name).

Find the Pi's full tailnet name:
```bash
tailscale status   # e.g. seagrass.tailxxxxx.ts.net
```

### Camera + media: `tailscale serve`

On the Pi, two independent listeners (different tailscale-side ports, since
both can't own 443):
```bash
sudo tailscale serve --bg --https=443 localhost:8889
sudo tailscale serve --bg --https=8443 localhost:8000
```
These persist across reboots on their own — no service file needed. Check
`sudo tailscale serve status` any time.

### Control: direct TLS in drone_server.py

```bash
mkdir -p ~/.seagrass-tls
sudo tailscale cert --cert-file ~/.seagrass-tls/<hostname>.crt \
                     --key-file  ~/.seagrass-tls/<hostname>.key \
                     <hostname>   # the tailscale status name, e.g. seagrass.tailxxxxx.ts.net
sudo chown pi:pi ~/.seagrass-tls/*
```

Add to `~/.seagrass-env`:
```bash
WS_TLS_CERT=/home/pi/.seagrass-tls/<hostname>.crt
WS_TLS_KEY=/home/pi/.seagrass-tls/<hostname>.key
TLS_HOSTNAME=<hostname>   # used by the renewal timer below
```
```bash
sudo systemctl restart drone-server
```
The startup log should now say `listening on wss://0.0.0.0:8765` instead of `ws://`.

**Certs expire in ~90 days and do not auto-renew** (unlike `tailscale serve`'s
certs, which Tailscale manages for you) — `tailscale cert` explicitly makes the
caller responsible for that. Install the renewal timer so this isn't a thing
that quietly breaks weeks later:
```bash
sudo cp scripts/renew-tls-cert.service scripts/renew-tls-cert.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now renew-tls-cert.timer
```
It checks daily and only actually renews (and restarts `drone-server`, which is
the only disruptive part) when the cert is close to expiry — a no-op on ~89 of
every 90 days.

### In the Fleet UI

- **Drone link:** `wss://<hostname>.ts.net:8765`
- **Camera stream URL:** `https://<hostname>.ts.net/cam/whep`
- **Media server URL:** `https://<hostname>.ts.net:8443`

Any device with Tailscale installed and signed into the same tailnet can now
reach all three from the deployed HTTPS site — not just devices on the same LAN
as the Pi.

### Later: switching to a public domain

If you outgrow "viewers need Tailscale installed" and get a domain, Cloudflare
Tunnel replaces the pieces above with a public `https://drone.yourdomain.com`
URL reachable from any browser — no Tailscale required on the viewing device.
The control WebSocket becomes reachable from the open internet at that point
(protected only by `SEAGRASS_TOKEN`, not network isolation), which is the real
tradeoff for dropping the "must be on the tailnet" requirement.

---

## 7. Deploy the web UI (Firebase Hosting)

One Firebase site serves the whole domain:

| URL | Serves |
|---|---|
| `/` | marketing landing page (`site/index.html`) |
| `/launch` | the page whose button opens the GCS |
| `/desktop/` | the GCS itself |

```bash
npm run build:web   # vite build, then assembles hosting/
npm run deploy      # the above, then firebase deploy --only hosting
```

`build:web` is the important one: `firebase.json` serves `hosting/`, which only
that script assembles — plain `npm run build` fills `dist/` and would deploy
nothing. Both GitHub Actions workflows already call it, and pushing to `main`
deploys to the live channel; opening a PR builds a preview channel first.

The GCS needs no sub-path configuration. `vite base: './'` keeps asset URLs
relative and the app uses hash routing, so `/desktop/#/fleet` works with no
basename and no SPA rewrite.

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as GitHub Actions secrets —
that is where CI reads them from. There is no way into the app without them:
local mode was retired, so the login screen is the only door.

> Netlify used to host the marketing site on its own domain. It is no longer
> part of the deploy; delete the site so it cannot serve a stale copy. The
> `VITE_FIREBASE_*` variables are dead too — sign-in moved to Supabase Auth.

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
