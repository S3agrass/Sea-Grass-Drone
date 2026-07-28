"""Tests for the media upload queue (server/media_uploader.py).

No Supabase, no network, no Pi — everything below runs against a temp directory
and a stub Supabase client.

What is pinned here is the behaviour that only shows up in the one situation that
matters and can never be reproduced on a desk: the vehicle is submerged with no
link for the length of a dive, then surfaces with a full queue.

  - An mp4 still being written by ffmpeg must not upload. It has no sidecar
    while recording, and the backfill's quiet period is the second guard. Ship a
    truncated clip and the footage of the thing you dived for is unplayable.
  - Retries must be unbounded and backed off. An hour of failures is normal, not
    an error, so nothing may give up and nothing may hammer.
  - Row ids must be deterministic. A crash mid-upload retries, and a random id
    would leave the same capture in the table twice with one copy pointing at
    bytes that were never finished.
  - The oldest capture uploads first, so a link that drops again mid-drain
    leaves one gap at the end rather than holes scattered through the dive.
  - Video is skipped but NOT marked done. A 1 GB free tier cannot hold footage
    at 1.8 GB/hour, and a skip that marked rows uploaded would silently strand
    every recording already on the card if the limit is ever raised.

    python3 test_media_uploader.py
"""
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "server"))

import media_uploader as mu  # noqa: E402

FAILURES = []


def check(name, condition, detail=""):
    print(f"  [{'PASS' if condition else 'FAIL'}] {name}{'  — ' + detail if detail else ''}")
    if not condition:
        FAILURES.append(name)


# ---------------- helpers ----------------

class FakeSupabase:
    """Stands in for the REST client: records what it was asked to do, and can
    pretend the link is down."""

    def __init__(self, fail=False):
        self.uploaded = []   # (remote_path, content_type)
        self.rows = {}       # id -> row
        self.fail = fail

    def upload(self, local_path, remote_path, content_type):
        if self.fail:
            raise RuntimeError("network is unreachable")
        self.uploaded.append((remote_path, content_type))

    def upsert_row(self, row):
        if self.fail:
            raise RuntimeError("network is unreachable")
        self.rows[row["id"]] = row


def media_dir():
    d = tempfile.mkdtemp(prefix="seagrass-media-")
    return d


def write_media(d, name, content=b"x" * 32, age_s=0):
    path = os.path.join(d, name)
    with open(path, "wb") as fh:
        fh.write(content)
    if age_s:
        old = time.time() - age_s
        os.utime(path, (old, old))
    return path


def write_side(d, name, **over):
    payload = {
        "name": name,
        "type": "video" if name.endswith(".mp4") else "photo",
        "captured_at": time.time(),
        "trigger": "manual",
        "uploaded": False,
        "context": {},
    }
    payload.update(over)
    mu.write_sidecar(mu.sidecar_path(d, name), payload)
    return payload


# ---------------- tests ----------------

def test_pending_lists_only_unuploaded():
    d = media_dir()
    write_media(d, "photo-a.jpg")
    write_media(d, "photo-b.jpg")
    write_side(d, "photo-a.jpg")
    write_side(d, "photo-b.jpg", uploaded=True)

    names = [p["name"] for _, p in mu.pending(d)]
    check("uploaded sidecars are not re-queued", names == ["photo-a.jpg"], str(names))


def test_media_without_a_sidecar_is_not_queued():
    """The in-progress recording case: ffmpeg is still appending to this mp4 and
    drone_server has not written its sidecar yet."""
    d = media_dir()
    write_media(d, "rec-live.mp4")
    check("no sidecar means not queued", mu.pending(d) == [])


def test_backfill_skips_recently_touched_files():
    d = media_dir()
    write_media(d, "rec-live.mp4", age_s=0)      # being written right now
    write_media(d, "rec-old.mp4", age_s=600)     # finished long ago, no sidecar

    created = mu.backfill_sidecars(d, quiet_s=60)
    check("stale file is backfilled", created == ["rec-old.mp4"], str(created))
    check("fresh file is left alone",
          not os.path.exists(mu.sidecar_path(d, "rec-live.mp4")))
    check("backfilled sidecar is queued",
          [p["name"] for _, p in mu.pending(d)] == ["rec-old.mp4"])


def test_backfill_records_unknown_trigger():
    d = media_dir()
    write_media(d, "photo-legacy.jpg", age_s=600)
    mu.backfill_sidecars(d, quiet_s=60)
    data = mu.read_sidecar(mu.sidecar_path(d, "photo-legacy.jpg"))
    # Better to admit the gap than to invent a reason the capture happened.
    check("trigger is 'unknown', not a guess", data["trigger"] == "unknown",
          str(data.get("trigger")))
    check("captured_at comes from the file's mtime", data["captured_at"] > 0)


def test_pending_is_oldest_first():
    d = media_dir()
    now = time.time()
    for name, when in [("photo-new.jpg", now), ("photo-old.jpg", now - 900),
                       ("photo-mid.jpg", now - 300)]:
        write_media(d, name)
        write_side(d, name, captured_at=when)

    names = [p["name"] for _, p in mu.pending(d)]
    check("oldest capture drains first",
          names == ["photo-old.jpg", "photo-mid.jpg", "photo-new.jpg"], str(names))


def test_orphan_sidecar_is_dropped():
    d = media_dir()
    write_side(d, "photo-gone.jpg")  # deleted from the Media page, sidecar left
    check("sidecar with no media file is not queued", mu.pending(d) == [])


def test_corrupt_sidecar_does_not_stop_the_queue():
    d = media_dir()
    write_media(d, "photo-ok.jpg")
    write_side(d, "photo-ok.jpg")
    with open(mu.sidecar_path(d, "photo-bad.jpg"), "w") as fh:
        fh.write("{ truncated")

    names = [p["name"] for _, p in mu.pending(d)]
    check("one bad file does not strand the rest", names == ["photo-ok.jpg"], str(names))


def test_backoff_grows_then_caps():
    seq = [mu.backoff_delay(i) for i in range(1, 12)]
    check("first retry is prompt", seq[0] == mu.BACKOFF_MIN_S, str(seq[0]))
    check("backoff is monotonic", all(b >= a for a, b in zip(seq, seq[1:])), str(seq))
    check("caps at the ceiling", seq[-1] == mu.BACKOFF_MAX_S, str(seq[-1]))
    # A whole dive of failures must still be retrying afterwards.
    check("never gives up", mu.backoff_delay(10_000) == mu.BACKOFF_MAX_S)


def test_row_id_is_deterministic():
    a = mu.row_id("seagrass", "photo-1.jpg")
    b = mu.row_id("seagrass", "photo-1.jpg")
    check("same capture yields the same row id", a == b, a)
    check("different drones do not collide",
          mu.row_id("one", "photo-1.jpg") != mu.row_id("two", "photo-1.jpg"))


def test_video_is_skipped_but_stays_queued():
    """Photos only by default — video does not fit a 1 GB free tier."""
    d = media_dir()
    write_media(d, "photo-a.jpg")
    write_media(d, "rec-a.mp4")
    write_side(d, "photo-a.jpg")
    write_side(d, "rec-a.mp4")

    names = [p["name"] for _, p in mu.pending(d, types={"photo"})]
    check("only the photo is queued", names == ["photo-a.jpg"], str(names))

    client = FakeSupabase()
    mu.drain(client, d)
    check("video was not uploaded", len(client.uploaded) == 1, str(client.uploaded))
    # Not marked done: raising the limit later must pick the recording back up.
    check("video is still queued, not silently dropped",
          [p["name"] for _, p in mu.pending(d, types={"video"})] == ["rec-a.mp4"])


def test_drain_uploads_and_marks_done():
    d = media_dir()
    write_media(d, "photo-a.jpg")
    write_side(d, "photo-a.jpg", context={"label": "fish", "confidence": 0.8},
               trigger="auto")
    client = FakeSupabase()

    count = mu.drain(client, d)
    check("one capture uploaded", count == 1, str(count))
    check("bytes went to the drone's prefix",
          client.uploaded[0][0] == mu.storage_path(mu.DRONE_ID, "photo-a.jpg"),
          str(client.uploaded))
    check("content type is set", client.uploaded[0][1] == "image/jpeg")

    row = client.rows[mu.row_id(mu.DRONE_ID, "photo-a.jpg")]
    check("why the capture happened is preserved",
          row["context"] == {"label": "fish", "confidence": 0.8}, str(row["context"]))
    check("trigger is preserved", row["trigger"] == "auto")
    check("storage_path points at the upload",
          row["storage_path"] == client.uploaded[0][0])
    check("captured_at is a timestamptz, not epoch seconds",
          isinstance(row["captured_at"], str) and "T" in row["captured_at"],
          str(row["captured_at"]))

    check("sidecar is marked uploaded",
          mu.read_sidecar(mu.sidecar_path(d, "photo-a.jpg"))["uploaded"] is True)
    check("a second drain is a no-op", mu.drain(client, d) == 0)


def test_failed_upload_leaves_the_capture_queued():
    """The dive case: the link is down, so nothing must be marked done."""
    d = media_dir()
    write_media(d, "photo-a.jpg")
    write_side(d, "photo-a.jpg")
    client = FakeSupabase(fail=True)

    raised = False
    try:
        mu.drain(client, d)
    except RuntimeError:
        raised = True

    check("failure propagates so the caller backs off", raised)
    check("nothing written to the table", client.rows == {})
    check("still queued for the next attempt",
          [p["name"] for _, p in mu.pending(d)] == ["photo-a.jpg"])

    # ...and when the vehicle surfaces, it drains.
    client.fail = False
    check("drains once the link returns", mu.drain(client, d) == 1)


def test_retry_after_a_crash_does_not_duplicate():
    """Storage succeeded, then the Pi lost power before the sidecar was marked."""
    d = media_dir()
    write_media(d, "photo-a.jpg")
    write_side(d, "photo-a.jpg")
    client = FakeSupabase()

    _, data = mu.pending(d)[0]
    mu.upload_one(client, d, mu.sidecar_path(d, "photo-a.jpg"), dict(data))
    # Simulate the sidecar write never landing.
    write_side(d, "photo-a.jpg", uploaded=False)

    mu.drain(client, d)
    check("one row, not two", len(client.rows) == 1, str(list(client.rows)))


if __name__ == "__main__":
    for fn in [
        test_pending_lists_only_unuploaded,
        test_media_without_a_sidecar_is_not_queued,
        test_backfill_skips_recently_touched_files,
        test_backfill_records_unknown_trigger,
        test_pending_is_oldest_first,
        test_orphan_sidecar_is_dropped,
        test_corrupt_sidecar_does_not_stop_the_queue,
        test_backoff_grows_then_caps,
        test_row_id_is_deterministic,
        test_video_is_skipped_but_stays_queued,
        test_drain_uploads_and_marks_done,
        test_failed_upload_leaves_the_capture_queued,
        test_retry_after_a_crash_does_not_duplicate,
    ]:
        print(fn.__name__)
        fn()

    print()
    if FAILURES:
        raise SystemExit(f"FAILED: {', '.join(FAILURES)}")
    print("All media uploader checks passed.")
