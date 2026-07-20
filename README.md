# Seagrass GCS

A ground control station for an underwater/surface drone (ROV/USV) built on a Raspberry Pi 5 + Pixhawk/ArduSub stack. Provides remote piloting, live telemetry, WebRTC camera streaming, and fleet management from a browser or Electron desktop app.

## Quick start

```bash
npm install
cp .env.example .env   # fill in Firebase credentials
npm run dev            # browser at http://localhost:5173
```

## Documentation

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — Full developer reference: system design, data flow, file structure, WebSocket protocol, WebRTC camera stack, how to extend
- **[SETUP.md](./SETUP.md)** — Infrastructure setup: Pi configuration, MediaMTX, Tailscale, Firebase, systemd services, deployment

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start Vite dev server |
| `npm run build` | Production build → `dist/` |
| `npm test` | Run test suite (Vitest) |
| `npm run test:watch` | Tests in watch mode |
| `npm run electron:dev` | Desktop app with hot reload |
| `npm run electron:build` | Package as distributable |
| `npm run lint` | Lint with Oxlint |

## Control mapping

| Key | Action |
|---|---|
| W / S | Propulsion forward / back |
| A / D | Steer right / left |
| Q / E | Buoyancy rise / dive |
| L / K | Light on / off |
| Space | Emergency all-stop |
