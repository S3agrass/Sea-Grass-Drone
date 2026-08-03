"""
Seagrass media server — runs on the Raspberry Pi 5, alongside (not inside) the
camera process.

The WebRTC camera path (server/camera_stream.py -> GStreamer -> MediaMTX) only
ever pushes video to MediaMTX; it has no HTTP server of its own, unlike the
legacy MJPEG camera_stream.py which bundled photo capture, recording, and media
browsing into the same process as the video feed. This script splits that
media-facing half out into its own always-on process, independent of whether
the camera pipeline is currently running, so the Media page keeps working
regardless of camera state, and drone_server.py's existing /photo, /media
calls (CAMERA_HTTP) need no changes at all — they just now reach this process
instead of the old combined one.

Recording is NOT implemented here. The GStreamer pipeline only produces a
live RTSP push to MediaMTX and a low-fps JPEG snapshot tap (see
server/camera_stream.py's SNAPSHOT_FRAME) — there is no second on-Pi H.264
encoder to draw an mp4 from, unlike Picamera2's dual-encoder setup. /record/start
and /record/stop both return 501 so callers get a clear, immediate answer
instead of a silent no-op. Revisit if/when MediaMTX's own recording feature
(or a real second encoder) is wired up.

Environment variables:
    MEDIA_HTTP_PORT   Port to listen on                default: 8000
    MEDIA_DIR         Where photos/recordings live      default: ~/seagrass-media
    SNAPSHOT_FRAME    JPEG file camera_stream.py's snapshot tap continuously
                      overwrites; /photo copies whatever is there right now.
                      default: /tmp/seagrass-camera-snapshot.jpg
    SEAGRASS_TOKEN    Shared secret. REQUIRED — this process exits without it,
                      matching drone_server.py. Gates every endpoint except
                      /health: captured media is dive footage, and
                      /turn-credentials spends metered Cloudflare bandwidth.
                      Supply it as `Authorization: Bearer <token>` or, for URLs
                      the browser loads directly (<img>/<video> src), a ?token=
                      query parameter.
    SEAGRASS_ALLOWED_ORIGINS
                      Comma-separated CORS allowlist, same default and meaning
                      as drone_server.py's. Replaces a blanket `*`.
    STREAM_NAME       MediaMTX path this vehicle publishes. default: cam
    TURN_KEY_ID       Cloudflare Realtime TURN key ID.
    TURN_KEY_API_TOKEN
                      Its secret — never sent to the browser; kept here,
                      server-side, to mint credentials for /turn-credentials.
                      Both unset = no TURN (browser falls back to STUN-only,
                      which doesn't traverse most home routers' NAT for
                      inbound video).

This process also backs MediaMTX's authentication: server/mediamtx.yml points
its authHTTPAddress at POST /mediamtx-auth here, so watching or publishing the
camera requires the same SEAGRASS_TOKEN as everything else. That endpoint is
localhost-only and takes its credential from the request body, not a header —
see _mediamtx_auth. Consequence worth knowing: MediaMTX cannot authorise a
viewer while this process is down, so the camera and the media API now fail
together rather than separately.

Spend control: TURN relay is billed per GB and a credential works as a
general-purpose relay, so /turn-credentials shares one cached credential rather
than minting per request, under a hard hourly ceiling. Every endpoint is also
rate limited per source IP, and denials are logged (flushed immediately — a
buffered abuse log tells you nothing while it is happening).

Run standalone (for testing without drone_server.py):
    python3 server/media_server.py
"""

import json
import os
import shutil
import sys
import threading
import time
import urllib.error
import urllib.request
from http import server
from urllib.parse import parse_qs, unquote, urlparse

import auth

MEDIA_HTTP_PORT = int(os.environ.get("MEDIA_HTTP_PORT", "8000"))
MEDIA_DIR = os.environ.get("MEDIA_DIR", os.path.expanduser("~/seagrass-media"))
SNAPSHOT_FRAME = os.environ.get("SNAPSHOT_FRAME", "/tmp/seagrass-camera-snapshot.jpg")
# The single MediaMTX path this vehicle publishes. Must match camera_stream.py's
# STREAM_NAME — /mediamtx-auth refuses to authorise anything else.
STREAM_NAME = os.environ.get("STREAM_NAME", "cam")
TOKEN = os.environ.get("SEAGRASS_TOKEN", "")
if not TOKEN:
    raise SystemExit("SEAGRASS_TOKEN must be set — export it before running this script.")

# See drone_server.py's ALLOWED_ORIGINS for what each default entry is for; this
# list is deliberately the same one, and both read the same env var.
_DEFAULT_ORIGINS = (
    "https://seagrassrobotics.com,"
    "https://www.seagrassrobotics.com,"
    "https://seagrass-d8e39.web.app,"
    "https://seagrass-d8e39.firebaseapp.com,"
    "http://localhost:5173,"
    "file://,"
    "null"
)
ALLOWED_ORIGINS = {
    o.strip()
    for o in os.environ.get("SEAGRASS_ALLOWED_ORIGINS", _DEFAULT_ORIGINS).split(",")
    if o.strip()
}

# Cloudflare Realtime TURN — see module docstring.
#
# COST. Relay traffic is billed per GB, and a TURN credential is a bearer
# credential for a general-purpose relay: it is NOT scoped to this vehicle's
# video. Anyone holding one can push arbitrary traffic through Cloudflare on
# this account until it expires. That makes the number of credentials handed
# out, not just who may ask for them, a spending decision.
#
# So this endpoint no longer mints per request. One credential is minted and
# shared until it nears expiry (see _turn_cache), and TURN_MAX_MINTS_PER_HOUR is
# a hard ceiling on issuance no matter how the endpoint is hammered. A caller
# who found the token can now obtain the same credential everyone else already
# has, rather than an endless supply of fresh ones.
TURN_KEY_ID = os.environ.get("TURN_KEY_ID", "")
TURN_KEY_API_TOKEN = os.environ.get("TURN_KEY_API_TOKEN", "")
TURN_TTL_S = 3600

# Re-mint once the cached credential has less than this left, so nobody is ever
# handed one about to die mid-dive. Deliberately NOT solved by shortening
# TURN_TTL_S: an expired credential kills a live relay, and on a vehicle steered
# by camera, dropping the video to save pennies is the wrong trade. With a 1h
# TTL and a 20min floor this mints roughly once per 40 minutes under load.
TURN_MIN_REMAINING_S = 1200

# Circuit breaker. Normal operation needs ~2/hour; this leaves generous headroom
# for restarts and still bounds the worst case. On breach, callers get the
# existing credential (or STUN) rather than a new one.
TURN_MAX_MINTS_PER_HOUR = 12

# {"iceServers": [...], "minted_at": float} — the shared credential.
_turn_cache = {"data": None, "minted_at": 0.0}
_turn_mints = []          # timestamps of recent mints, for the ceiling
_turn_lock = threading.Lock()

# Used when TURN isn't configured (or its API call fails) — STUN only helps
# the browser discover its own public address; it does not traverse a router
# that blocks unsolicited inbound UDP, so this is a degraded-but-not-broken
# fallback rather than a real fix.
_STUN_FALLBACK = {"iceServers": [{"urls": "stun:stun.l.google.com:19302"}]}

# --- request throttling -----------------------------------------------------
# drone_server.py backs off failed hellos, but this process had nothing: the
# same SEAGRASS_TOKEN was guessable here over plain HTTP, in parallel, at full
# network speed. Hardening one door and leaving the other open just tells an
# attacker which door to use.
#
# The window is per source IP and covers every endpoint, so it also caps how
# fast anyone can pull media (Pi uplink) or trigger TURN work.
# Ceiling on connections served at once (see BoundedThreadingHTTPServer). The Pi
# is also flying a vehicle; the media API is not allowed to spend unbounded
# threads on it.
MAX_CONCURRENT_REQUESTS = 48

RATE_WINDOW_S = 60.0
RATE_MAX_REQUESTS = 240      # generous: a media grid loads many thumbnails at once
AUTH_FAIL_GRACE = 5
AUTH_FAIL_MAX_DELAY_S = 4.0  # short, since this stalls a server thread
AUTH_FAIL_RESET_S = 300.0

_rate_hits = {}       # ip -> [timestamps]
_auth_failures = {}   # ip -> (count, last_failure_ts)
_throttle_lock = threading.Lock()


def _rate_limited(ip):
    """True when `ip` has exceeded RATE_MAX_REQUESTS in the current window."""
    now = time.time()
    with _throttle_lock:
        hits = [t for t in _rate_hits.get(ip, []) if now - t < RATE_WINDOW_S]
        hits.append(now)
        _rate_hits[ip] = hits
        # Keep the table from growing without bound on a long-running process.
        if len(_rate_hits) > 1024:
            for stale_ip in [k for k, v in _rate_hits.items()
                             if not v or now - v[-1] > RATE_WINDOW_S]:
                del _rate_hits[stale_ip]
        return len(hits) > RATE_MAX_REQUESTS


def _auth_fail_delay(ip):
    """Seconds to stall before rejecting a bad token from `ip`."""
    with _throttle_lock:
        count, last = _auth_failures.get(ip, (0, 0.0))
        if last and time.time() - last > AUTH_FAIL_RESET_S:
            count = 0
        _auth_failures[ip] = (count + 1, time.time())
    if count < AUTH_FAIL_GRACE:
        return 0.0
    return min(AUTH_FAIL_MAX_DELAY_S, 2.0 ** (count - AUTH_FAIL_GRACE))


def _fetch_turn_credentials():
    """The shared TURN credential, minting a new one only when it has aged out.

    Holds _turn_lock across the network call. ThreadingHTTPServer gives every
    request its own thread, so without it a burst mints one credential per
    thread — exactly the spend this is here to prevent — and the ceiling below
    would be checked against a count that hasn't been incremented yet."""
    if not (TURN_KEY_ID and TURN_KEY_API_TOKEN):
        return _STUN_FALLBACK

    now = time.time()
    with _turn_lock:
        cached = _turn_cache["data"]
        age = now - _turn_cache["minted_at"]
        if cached and (TURN_TTL_S - age) > TURN_MIN_REMAINING_S:
            return cached

        # Drop mint timestamps older than an hour, then check the ceiling.
        _turn_mints[:] = [t for t in _turn_mints if now - t < 3600]
        if len(_turn_mints) >= TURN_MAX_MINTS_PER_HOUR:
            print(f"TURN mint ceiling hit ({TURN_MAX_MINTS_PER_HOUR}/hour) — "
                  "serving the existing credential. Someone is hammering "
                  "/turn-credentials, or the camera is reconnecting in a loop.",
                  flush=True)
            # Stale beats broken: an old credential may still have life in it,
            # and STUN-only still works on permissive networks.
            return cached or _STUN_FALLBACK

        fresh = _mint_turn_credentials()
        if fresh is not _STUN_FALLBACK:
            _turn_cache["data"] = fresh
            _turn_cache["minted_at"] = now
            _turn_mints.append(now)
        return fresh


def _mint_turn_credentials():
    req = urllib.request.Request(
        f"https://rtc.live.cloudflare.com/v1/turn/keys/{TURN_KEY_ID}/credentials/generate-ice-servers",
        method="POST",
        data=json.dumps({"ttl": TURN_TTL_S}).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {TURN_KEY_API_TOKEN}",
            "Content-Type": "application/json",
            # Cloudflare's edge blocks requests carrying urllib's default
            # "Python-urllib/x.y" User-Agent as a bot signature (403, even with
            # valid credentials) — curl sails through with its own default UA.
            "User-Agent": "seagrass-drone/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print(f"TURN credential fetch failed, falling back to STUN-only: {exc}")
        return _STUN_FALLBACK

os.makedirs(MEDIA_DIR, exist_ok=True)

MEDIA_TYPES = {".mp4": "video/mp4", ".jpg": "image/jpeg"}


def capture_photo():
    """Copy whatever camera_stream.py's snapshot tap most recently wrote.
    Returns the new filename, or None if no snapshot exists yet (camera just
    started, or isn't running at all)."""
    if not os.path.isfile(SNAPSHOT_FRAME):
        return None
    name = f"photo-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}.jpg"
    path = os.path.join(MEDIA_DIR, name)
    try:
        # Copy rather than move — the tap file is being continuously
        # overwritten by GStreamer and must stay in place for the next shot.
        shutil.copyfile(SNAPSHOT_FRAME, path)
    except OSError:
        return None
    return name


def list_media():
    items = []
    try:
        names = os.listdir(MEDIA_DIR)
    except OSError:
        names = []
    for name in names:
        ext = os.path.splitext(name)[1].lower()
        if ext not in MEDIA_TYPES:
            continue
        path = os.path.join(MEDIA_DIR, name)
        try:
            st = os.stat(path)
        except OSError:
            continue
        items.append({
            "name": name,
            "type": "video" if ext == ".mp4" else "photo",
            "size": st.st_size,
            "mtime": st.st_mtime,
            "url": f"/media/{name}",
        })
    items.sort(key=lambda m: m["mtime"], reverse=True)
    return items


def safe_media_path(name):
    """Resolve a request path segment to a file inside MEDIA_DIR, or None if it
    escapes the directory (path traversal) or isn't a recognised media file."""
    name = os.path.basename(unquote(name))
    if not name or os.path.splitext(name)[1].lower() not in MEDIA_TYPES:
        return None
    path = os.path.join(MEDIA_DIR, name)
    if os.path.dirname(os.path.abspath(path)) != os.path.abspath(MEDIA_DIR):
        return None
    return path


class MediaHandler(server.BaseHTTPRequestHandler):
    def _cors(self):
        # Echo the request's origin when it's allowlisted, rather than "*". A
        # wildcard here let any page on the internet read the responses below,
        # which is how a listing of the operator's dive footage became
        # cross-origin readable.
        origin = self.headers.get("Origin")
        if origin and origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")

    def _route(self):
        """Path with any query string stripped. Every routing decision must go
        through this: ?token= now rides along on the URLs the browser loads
        directly, and matching it against the raw self.path would 404 /media and
        push "clip.mp4?token=x" into safe_media_path, which rejects it on the
        extension check."""
        return urlparse(self.path).path

    def _authed(self):
        """Token from the Authorization header, or ?token= for URLs the browser
        fetches on its own. <img src> and <video src> cannot carry a header, and
        those are exactly the requests serving the media files. Request logging
        is suppressed (see log_message), so the query form doesn't land in logs."""
        header = self.headers.get("Authorization", "")
        if header.startswith("Bearer "):
            supplied = header[len("Bearer "):]
        else:
            supplied = parse_qs(urlparse(self.path).query).get("token", [""])[0]
        # A signed-in operator sends their Supabase session token here; the
        # shared secret still works for CLI tools and local-mode browsers.
        ok, _, _ = auth.verify_operator(supplied)
        return ok

    def _mediamtx_auth(self):
        """Authorise one MediaMTX publish/read, per server/mediamtx.yml's
        authHTTPAddress hook.

        MediaMTX POSTs a JSON body describing the attempt and reads only the
        status code: 2xx allows, anything else denies. The password carries the
        vehicle's SEAGRASS_TOKEN, so the camera path ends up gated by the same
        secret as the control link, with no second credential to rotate.

        Localhost only. MediaMTX runs beside this process on the Pi, and this
        endpoint is a bare yes/no on a token — reachable from off-box it would be
        an oracle for guessing that token with no browser in the way."""
        peer = self._peer()
        if peer not in ("127.0.0.1", "::1"):
            return self._deny()
        # Throttled, but on its OWN bucket rather than the shared 127.0.0.1 one.
        # MediaMTX makes a call per connection attempt, so a flood at :8889
        # becomes a flood here — and if that shared a budget with localhost,
        # an outsider could push it over the limit and knock out drone_server's
        # own /photo calls, which also arrive from 127.0.0.1.
        if _rate_limited(f"{peer}#mediamtx"):
            print("Rate limit: MediaMTX auth flood — refusing to authorise", flush=True)
            return self._send_json({"error": "rate limited"}, status=429)

        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        except (ValueError, OSError):
            return self._deny()

        # The password is whatever the viewer or publisher presented: a browser
        # sends its Supabase session token, camera_stream.py sends the shared
        # secret. Both are settled by the same verifier.
        ok, subject, reason = auth.verify_operator(body.get("password"))
        if not ok:
            who = f" (user {subject})" if subject else ""
            print(f"MediaMTX auth denied{who}: {reason} for "
                  f"{body.get('action')!r} on {body.get('path')!r}", flush=True)
            return self._deny()

        # Scope to the one path this vehicle serves. Without it a valid token
        # authorises publishing to any path name, so an attacker holding the
        # token could park a stream somewhere the operator never looks.
        if body.get("path") not in (STREAM_NAME, ""):
            print(f"MediaMTX auth denied: path {body.get('path')!r} is not "
                  f"{STREAM_NAME!r}", flush=True)
            return self._deny()

        self._send_json({"ok": True})

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _peer(self):
        return self.client_address[0] if self.client_address else "?"

    def _deny(self):
        self._send_json({"error": "unauthorized"}, status=401)

    def _guard(self):
        """Rate limit, then authenticate. Returns True when the request may
        proceed; has already answered the client when it returns False.

        Denials are logged on purpose. log_message is suppressed below to keep
        routine traffic out of the terminal, which also meant a token-guessing
        run left no trace at all — the query string is stripped so the log never
        records the token being guessed."""
        ip = self._peer()
        if _rate_limited(ip):
            print(f"Rate limit: {ip} over {RATE_MAX_REQUESTS}/{RATE_WINDOW_S:.0f}s "
                  f"on {self._route()}", flush=True)
            self._send_json({"error": "rate limited"}, status=429)
            return False
        if not self._authed():
            delay = _auth_fail_delay(ip)
            if delay:
                time.sleep(delay)
            print(f"Auth failed: {ip} on {self._route()}", flush=True)
            self._deny()
            return False
        return True

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        route = self._route()
        # /health stays open: it is a liveness probe carrying no data, and
        # systemd/curl checks shouldn't need the secret to ask whether the
        # process is up.
        if route == '/health':
            return self._send_json({"status": "ok"})
        if not self._guard():
            return
        if route == '/turn-credentials':
            self._send_json(_fetch_turn_credentials())
        elif route == '/media':
            self._send_json({"media": list_media()})
        elif route.startswith('/media/'):
            self._serve_media(route[len('/media/'):])
        else:
            self.send_error(404)

    def do_POST(self):
        # Ahead of _authed(): MediaMTX is not one of our clients and sends no
        # Bearer token — the credential it is asking us to check is in the body.
        if self._route() == '/mediamtx-auth':
            return self._mediamtx_auth()
        if not self._guard():
            return
        if self._route() == '/photo':
            name = capture_photo()
            if name:
                self._send_json({"name": name, "url": f"/media/{name}"})
            else:
                self._send_json({"error": "no snapshot available yet"}, status=503)
        elif self._route() in ('/record/start', '/record/stop'):
            self._send_json(
                {"error": "recording is not supported on the WebRTC camera path"},
                status=501,
            )
        else:
            self.send_error(404)

    def do_DELETE(self):
        if not self._guard():
            return
        route = self._route()
        if route.startswith('/media/'):
            path = safe_media_path(route[len('/media/'):])
            if not path or not os.path.isfile(path):
                return self._send_json({"error": "not found"}, status=404)
            try:
                os.remove(path)
            except OSError as exc:
                return self._send_json({"error": str(exc)}, status=500)
            self._send_json({"deleted": os.path.basename(path)})
        else:
            self.send_error(404)

    def _serve_media(self, name):
        path = safe_media_path(name)
        if not path or not os.path.isfile(path):
            return self.send_error(404)
        ext = os.path.splitext(path)[1].lower()
        try:
            size = os.path.getsize(path)
            with open(path, "rb") as fh:
                self.send_response(200)
                self.send_header("Content-Type", MEDIA_TYPES[ext])
                self.send_header("Content-Length", str(size))
                self.send_header(
                    "Content-Disposition",
                    f'attachment; filename="{os.path.basename(path)}"',
                )
                self._cors()
                self.end_headers()
                while True:
                    chunk = fh.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (OSError, BrokenPipeError):
            pass

    def log_message(self, format, *args):
        pass  # suppresses terminal spam


class BoundedThreadingHTTPServer(server.ThreadingHTTPServer):
    """ThreadingHTTPServer with a ceiling on concurrent connections.

    The stock class spawns a thread per connection with no limit, so a few
    thousand open sockets is a few thousand threads on a Pi that is also flying
    a vehicle. The rate limiter caps requests per IP but not sockets, and it
    cannot help before a connection is accepted.

    A refused connection is a far better outcome than an unresponsive Pi: the
    media API degrading under load must not take the control server's CPU with
    it. Backlog rather than error, so a brief burst queues instead of failing.

    The semaphore is taken in process_request — the accept loop, before the
    thread exists — not in process_request_thread. Taking it inside the thread
    would bound how many requests run at once while still spawning a thread per
    connection, which is the resource actually being protected."""

    request_queue_size = 64
    _slots = threading.Semaphore(MAX_CONCURRENT_REQUESTS)

    def process_request(self, request, client_address):
        self._slots.acquire()
        try:
            super().process_request(request, client_address)
        except BaseException:
            # The thread never started, so nothing else will release this.
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


def main():
    # Same keys the control server uses, fetched independently: this is a
    # separate process and may outlive or start before that one.
    if auth.is_jwt_enabled():
        auth.refresh_jwks()
    address = ('', MEDIA_HTTP_PORT)
    httpd = BoundedThreadingHTTPServer(address, MediaHandler)
    print(f"Media server listening on http://0.0.0.0:{MEDIA_HTTP_PORT}  (dir={MEDIA_DIR})")
    print(auth.status_line())
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
