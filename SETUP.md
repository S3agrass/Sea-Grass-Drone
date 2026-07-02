# Seagrass GCS — Setup Guide

Three layers, matching the production architecture:

```
[React UI — Netlify]  ⇄  [Supabase — auth + drone registry]
        ⇅ wss / https (Cloudflare Tunnel for remote)
[Raspberry Pi 5 — drone_server.py + camera_stream.py]  ⇄  [Pixhawk / ArduSub]
```

---

## 1. Run the UI locally

```bash
npm install
npm run dev          # browser at http://localhost:5173
npm run electron:dev # or as the desktop app
```

Without a `.env`, the app runs in **local mode** (no accounts, drones saved on
the device). Add Supabase to enable secure sign-in.

## 2. Supabase (secure sign-in + drone registry)

1. Create a project at supabase.com.
2. SQL Editor → paste and run `supabase-schema.sql` (creates the `drones`
   table with Row Level Security — each user can only see their own drones).
3. Project Settings → API → copy the URL and anon key.
4. `cp .env.example .env` and fill both values. Restart `npm run dev`.
5. In Netlify: Site settings → Environment variables → add the same two
   `VITE_…` variables, then redeploy.

Auth → Providers → Email: leave "Confirm email" on for real users, or turn it
off while developing so sign-ups log in instantly.

## 3. Drone server on the Pi

```bash
ssh pi@seagrass-pi.local
pip install pymavlink websockets --break-system-packages
cd ~/Sea-Grass-Drone/server

SEAGRASS_TOKEN=pick-a-long-secret python3 drone_server.py
```

- Pixhawk plugs in over USB (`/dev/ttyACM0`); override with `PIXHAWK_PORT`.
- The token must match the "Access token" saved for the drone in the UI.
  With no token set, anyone on the network can drive — LAN testing only.
- Safety built in: watchdog forces all-stop if the link goes silent while
  keys are held, all-stop on disconnect, and only one operator holds the
  helm at a time.
- Keep `camera_stream.py` running (or the `camera-stream.service` systemd
  unit) for the video feed on port 8000.

Autostart (same pattern as the camera service):

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

## 4. Remote access (not just local) — Cloudflare Tunnel

The Netlify site is served over HTTPS, so remote drone links must be
`wss://` and the camera `https://`. A Cloudflare Tunnel gives you both
without opening any ports on the Founders Inc network:

```bash
# on the Pi
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o cloudflared
chmod +x cloudflared && sudo mv cloudflared /usr/local/bin/

cloudflared tunnel login
cloudflared tunnel create seagrass
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: seagrass
credentials-file: /home/pi/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: drone.yourdomain.com
    service: ws://localhost:8765
  - hostname: cam.yourdomain.com
    service: http://localhost:8000
  - service: http_status:404
```

```bash
cloudflared tunnel route dns seagrass drone.yourdomain.com
cloudflared tunnel route dns seagrass cam.yourdomain.com
sudo cloudflared service install && sudo systemctl start cloudflared
```

Then in the UI's Settings page set:

- Drone link: `wss://drone.yourdomain.com`
- Camera: `https://cam.yourdomain.com/stream.mjpg`

Now the deployed Netlify site controls the drone from anywhere.

## 5. Deploy the UI

Netlify is already connected to the repo — push to the deploy branch and it
builds automatically (`npm run build`, publish `dist`). Because the app uses
hash routing, no redirect rules are needed.

## Control mapping (identical to keyboard_control.py)

| Keys  | Channel | Action                     |
|-------|---------|----------------------------|
| W / S | 1       | Propulsion forward / back  |
| A / D | 2       | Steer right / left         |
| Q / E | 3       | Buoyancy rise / dive       |
| L / K | 4       | Light on / off             |
| Space | all     | All stop (neutral PWM)     |

PWM: 1500 neutral · 1650 forward · 1350 reverse · 1900 light on.
