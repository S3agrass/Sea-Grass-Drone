"""Drain the Pi's captured media to Supabase.

Photos and recordings are written to the SD card by camera_stream.py, and
drone_server.py drops a "<name>.json" sidecar next to each finished capture (see
_write_media_sidecar there). This daemon is the other half: it walks MEDIA_DIR,
uploads anything whose sidecar still says uploaded=false to Supabase Storage,
upserts a row into the `media` table, and marks the sidecar done.

Why Supabase and not Firebase: Cloud Storage for Firebase has required the Blaze
(card-on-file) plan since September 2024, and this project runs on free tiers.
Supabase's free tier gives 1 GB of file storage with no card. Auth and hosting
stay on Firebase; only the media bytes live here.

Why a separate process rather than a thread in one of the others:

  * camera_stream.py is killed whenever the camera goes idle (drone_server sends
    camera_off), which would take a half-finished upload with it.
  * drone_server.py restarts on Pixhawk trouble, and the queue must keep draining
    after a mission when the control server has nothing left to do.

Both are supervised by systemd independently; so is this. See
scripts/media-uploader.service.

The design point that matters: the vehicle has NO NETWORK LINK WHILE SUBMERGED.
Every upload failing for the whole dive is the normal case, not an error state.
So the queue lives on disk (survives power loss), retries are unbounded with
backoff, and nothing is ever deleted from the SD card — the cloud is a backup,
and the card stays the source of truth.

Talks to Supabase over plain HTTP via urllib rather than the supabase-py client,
so the Pi gains no new dependency for this.

Environment
    MEDIA_DIR           Where captures live. MUST match camera_stream.py.
                        default: ~/seagrass-media
    DRONE_ID            Stable id for this vehicle; namespaces the storage path
                        and the row id.              default: the hostname
    SUPABASE_URL        e.g. https://abcdefgh.supabase.co
    SUPABASE_SERVICE_KEY  The service_role key (NOT the anon key) — it bypasses
                        RLS, which is what lets the drone write rows no browser
                        may write. Keep it on the Pi only.
    SUPABASE_BUCKET     Storage bucket name.         default: media
    UPLOAD_TYPES        Which captures to upload: "photo", "video", or
                        "photo,video". Defaults to photos only — a recording at
                        the default 4 Mbit/s is ~1.8 GB per hour and would eat a
                        1 GB free tier in minutes. Recordings stay on the card
                        and remain browsable whenever the drone is powered on.
                        default: photo
    UPLOAD_POLL_S       Seconds between scans when idle.   default: 10
    UPLOAD_QUIET_S      A media file with no sidecar is only backfilled once it
                        has been untouched this long, so a recording still being
                        written by ffmpeg is never uploaded half-finished.
                        default: 60
"""

import datetime
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request

MEDIA_DIR = os.environ.get("MEDIA_DIR", os.path.expanduser("~/seagrass-media"))
DRONE_ID = os.environ.get("DRONE_ID") or socket.gethostname()
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
BUCKET = os.environ.get("SUPABASE_BUCKET", "media")
UPLOAD_TYPES = {
    t.strip() for t in os.environ.get("UPLOAD_TYPES", "photo").split(",") if t.strip()
}
POLL_S = float(os.environ.get("UPLOAD_POLL_S", "10"))
QUIET_S = float(os.environ.get("UPLOAD_QUIET_S", "60"))

# Matches camera_stream.py's MEDIA_TYPES.
CONTENT_TYPES = {".mp4": "video/mp4", ".jpg": "image/jpeg"}

# Retry schedule. Starts responsive (a brief Tailscale hiccup clears in seconds)
# and settles at 5 minutes, which is the right cadence for "the vehicle is 8 m
# underwater and will not have a link for another hour".
BACKOFF_MIN_S = 5.0
BACKOFF_MAX_S = 300.0


# ---------------- sidecars (the on-disk queue) ----------------

def sidecar_path(media_dir: str, name: str) -> str:
    return os.path.join(media_dir, f"{name}.json")


def is_media(name: str) -> bool:
    return os.path.splitext(name)[1].lower() in CONTENT_TYPES


def media_type(name: str) -> str:
    return "video" if name.lower().endswith(".mp4") else "photo"


def read_sidecar(path: str):
    """Parse a sidecar, or None if it is missing or unreadable.

    A corrupt sidecar is skipped rather than crashing the daemon: one bad file
    must not stop every other capture on the card from reaching the cloud."""
    try:
        with open(path) as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def write_sidecar(path: str, payload: dict):
    """Atomically replace a sidecar. Write-then-rename, because this daemon and
    drone_server.py both write here and a torn file would drop a capture from
    the queue."""
    tmp = f"{path}.tmp"
    with open(tmp, "w") as fh:
        json.dump(payload, fh)
    os.replace(tmp, path)


def backfill_sidecars(media_dir: str, quiet_s: float = QUIET_S, now: float = None) -> list:
    """Give a sidecar to any media file that lacks one, and return their names.

    Covers captures that predate this feature, and any written while
    drone_server was down. The quiet period is what keeps an in-progress
    recording out: its mp4 is being appended to right now, so its mtime is
    fresh, and uploading it would ship a truncated clip.
    """
    now = time.time() if now is None else now
    created = []
    try:
        names = os.listdir(media_dir)
    except OSError:
        return created
    for name in sorted(names):
        if not is_media(name):
            continue
        path = os.path.join(media_dir, name)
        side = sidecar_path(media_dir, name)
        if os.path.exists(side):
            continue
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            continue
        if now - mtime < quiet_s:
            continue
        write_sidecar(side, {
            "name": name,
            "type": media_type(name),
            "captured_at": mtime,
            # No context: nothing recorded why this capture happened, and
            # inventing one would be worse than admitting the gap.
            "trigger": "unknown",
            "uploaded": False,
            "context": {},
        })
        created.append(name)
    return created


def pending(media_dir: str, types=None) -> list:
    """Sidecars still waiting to upload, oldest capture first, as
    (sidecar_path, payload) pairs.

    Oldest-first matters on resurfacing: a long dive's backlog uploads in the
    order it was captured, so a link that drops again mid-drain leaves the
    newest gap rather than a scattered one."""
    types = UPLOAD_TYPES if types is None else types
    out = []
    try:
        names = os.listdir(media_dir)
    except OSError:
        return out
    for name in names:
        if not name.endswith(".json"):
            continue
        path = os.path.join(media_dir, name)
        data = read_sidecar(path)
        if not data or data.get("uploaded"):
            continue
        media_name = data.get("name")
        if not media_name or not is_media(media_name):
            continue
        # Excluded types are skipped, not marked done: flipping UPLOAD_TYPES
        # later should pick up everything already on the card.
        if media_type(media_name) not in types:
            continue
        if not os.path.isfile(os.path.join(media_dir, media_name)):
            # The capture was deleted from the Media page but its sidecar
            # survived. Nothing to upload; drop it from the queue.
            continue
        out.append((path, data))
    out.sort(key=lambda pair: pair[1].get("captured_at") or 0)
    return out


def backoff_delay(failures: int) -> float:
    """Seconds to wait after `failures` consecutive failed drains.

    The exponent is clamped before it is applied, not after: retries here are
    unbounded, and a Pi left powered with no link long enough reaches a failure
    count where 2**n overflows a float and the daemon dies of an OverflowError —
    losing the queue drain at the exact moment it has the most to upload."""
    if failures <= 0:
        return 0.0
    steps = min(failures - 1, 32)
    return min(BACKOFF_MAX_S, BACKOFF_MIN_S * (2 ** steps))


def row_id(drone_id: str, name: str) -> str:
    """Deterministic, so a retry after a crash mid-upload overwrites its own
    half-finished row instead of creating a duplicate."""
    return f"{drone_id}__{name}"


def storage_path(drone_id: str, name: str) -> str:
    return f"{drone_id}/{name}"


def iso(ts):
    """Epoch seconds -> a timestamptz Postgres will accept."""
    if not ts:
        return None
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).isoformat()


# ---------------- Supabase ----------------
# Plain REST over urllib. The service_role key bypasses RLS, which is precisely
# why it lives on the Pi and never in the browser bundle.

class Supabase:
    def __init__(self, url: str, key: str, bucket: str):
        if not url or not key:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set — "
                "add them to ~/.seagrass-env"
            )
        self.url = url.rstrip("/")
        self.key = key
        self.bucket = bucket

    def _send(self, method, path, body, headers, timeout=120):
        req = urllib.request.Request(f"{self.url}{path}", data=body, method=method)
        req.add_header("apikey", self.key)
        req.add_header("Authorization", f"Bearer {self.key}")
        for k, v in headers.items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            # Surface the body: Supabase explains refusals there (missing
            # bucket, RLS denial, bad key), and without it the journal shows a
            # bare 400 that could mean anything.
            detail = exc.read().decode("utf-8", "replace")[:400]
            raise RuntimeError(f"{method} {path} -> {exc.code}: {detail}") from None

    def upload(self, local_path: str, remote_path: str, content_type: str):
        with open(local_path, "rb") as fh:
            body = fh.read()
        # x-upsert makes a retry after a crash overwrite rather than 409.
        self._send(
            "POST", f"/storage/v1/object/{self.bucket}/{remote_path}", body,
            {"Content-Type": content_type or "application/octet-stream",
             "x-upsert": "true"},
        )

    def upsert_row(self, row: dict):
        self._send(
            "POST", "/rest/v1/media", json.dumps(row).encode("utf-8"),
            {"Content-Type": "application/json",
             "Prefer": "resolution=merge-duplicates,return=minimal"},
            timeout=30,
        )

    def remove(self, remote_path: str):
        self._send("DELETE", f"/storage/v1/object/{self.bucket}/{remote_path}",
                   None, {}, timeout=30)


def upload_one(client, media_dir: str, side_path: str, data: dict):
    """Upload one capture and record it. Bytes first, then the row, then the
    sidecar — so an interruption at any point leaves work to redo, never a
    database row pointing at bytes that were never uploaded."""
    name = data["name"]
    local = os.path.join(media_dir, name)
    remote = storage_path(DRONE_ID, name)
    ext = os.path.splitext(name)[1].lower()

    client.upload(local, remote, CONTENT_TYPES.get(ext))

    client.upsert_row({
        "id": row_id(DRONE_ID, name),
        "drone_id": DRONE_ID,
        "name": name,
        "type": data.get("type") or media_type(name),
        "size": os.path.getsize(local),
        "captured_at": iso(data.get("captured_at")),
        "storage_path": remote,
        "trigger": data.get("trigger") or "unknown",
        "context": data.get("context") or {},
    })

    data["uploaded"] = True
    data["storage_path"] = remote
    data["uploaded_at"] = time.time()
    write_sidecar(side_path, data)
    return remote


def drain(client, media_dir: str) -> int:
    """Upload everything currently queued. Returns the number uploaded; raises
    on the first failure so the caller can back off — if one upload failed
    because the link is down, the rest will too, and hammering them is pointless."""
    count = 0
    for side_path, data in pending(media_dir):
        remote = upload_one(client, media_dir, side_path, data)
        print(f"Uploaded {data['name']} -> {remote}", flush=True)
        count += 1
    return count


def main():
    print(f"Media uploader starting — dir={MEDIA_DIR} drone={DRONE_ID} "
          f"bucket={BUCKET} types={','.join(sorted(UPLOAD_TYPES)) or '(none)'}",
          flush=True)
    os.makedirs(MEDIA_DIR, exist_ok=True)

    try:
        client = Supabase(SUPABASE_URL, SUPABASE_KEY, BUCKET)
    except Exception as exc:  # noqa: BLE001
        # Missing config is a deployment mistake, not a transient network
        # failure, so fail loudly and let systemd's restart backoff surface it
        # in the journal instead of silently uploading nothing.
        print(f"Media uploader: {exc}", file=sys.stderr)
        return 1

    failures = 0
    while True:
        backfill_sidecars(MEDIA_DIR)
        try:
            uploaded = drain(client, MEDIA_DIR)
            if failures:
                print("Media uploader: link restored, queue draining", flush=True)
            failures = 0
        except Exception as exc:  # noqa: BLE001
            failures += 1
            delay = backoff_delay(failures)
            # One line per backoff step, not per attempt: a submerged vehicle
            # would otherwise fill the journal with hours of identical errors.
            print(f"Media uploader: upload failed ({exc}); "
                  f"retrying in {delay:.0f}s", file=sys.stderr, flush=True)
            time.sleep(delay)
            continue
        time.sleep(POLL_S if not uploaded else 0)


if __name__ == "__main__":
    sys.exit(main() or 0)
