# Camera simulation (local testing, no hardware)

Mocks the Pi side so the GCS UI can be driven end-to-end on a laptop — no
Arducam, no Pixhawk. The mocks reproduce the **wire contract** only (the
WebSocket JSON protocol + the camera HTTP endpoints); they do not run
`picamera2`/`pymavlink`, so on-Pi hardware behaviour still needs a real Pi.

- `mock_camera.py` — HTTP on `:8000`: synthetic moving MJPEG stream at
  `/stream.mjpg`, plus `/health`, `/record/start|stop|status`, `/photo`,
  `/media`, `/media/<name>` (download), and `DELETE /media/<name>`. Mirrors the
  real `camera_stream.py`.
- `mock_drone.py` — WebSocket on `:8765` speaking the real protocol (hello,
  state, telemetry, camera_on/off, record_start/stop, photo, set_autorecord,
  arm/disarm auto-record). Relays record/photo to the mock camera. Mirrors
  `server/drone_server.py`.

## Run

```bash
# from the repo root
python3 sim/mock_camera.py &     # :8000
python3 sim/mock_drone.py &      # :8765
npm run dev                      # :5173
```

Then in the app → Settings:
- **Camera stream URL:** `http://localhost:8000/stream.mjpg`
- **Drone link:** `ws://localhost:8765`  (token: leave blank)

Requires Python `websockets` and `Pillow`. Set `SEAGRASS_TOKEN` on both mocks
(and the token field in Settings) to exercise the auth path.
