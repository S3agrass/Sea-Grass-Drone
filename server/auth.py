"""
Who is allowed to drive this vehicle.

Both servers authenticate through here, so the control link and the media API
cannot drift apart on what counts as a valid operator.

There are two kinds of credential, and the difference matters:

  Supabase session JWT  — the normal path. The browser already holds one, it
                          expires in about an hour, and supabase-js refreshes it
                          without anyone thinking about it. Verified here against
                          the project's PUBLIC key, so this vehicle holds nothing
                          that could mint one. Authorisation is then a plain
                          question: is this user's id in SEAGRASS_OWNER_UIDS?

  SEAGRASS_TOKEN        — break-glass. A single shared secret, no expiry. It
                          exists because this Pi has no real-time clock: a
                          vehicle that boots offline with a wrong clock would
                          reject every JWT as expired, and "the boat cannot be
                          driven until someone SSHes into it" is a worse outcome
                          than a long-lived secret. It is also what the CLI tools
                          (terminal_control.py) and camera_stream.py's RTSP push
                          use, neither of which has a Supabase session.

Why this exists at all: the token used to be the ONLY credential, it lived in
plaintext in the drones table and in browser localStorage, and it never expired.
Any XSS on the GCS handed over permanent control of a physical vehicle. Moving
the browser onto short-lived identity is the point of this module; the shared
secret surviving on the Pi is a deliberate, much smaller residue.

WHO OWNS THIS VEHICLE is answered by the database, not by hand. The Pi looks up
its own row in `drones` (by DRONE_ID, using the service_role key it already has
for media uploads) and takes the owner from there. Registering a drone in the app
is therefore enough to be able to drive it, and transferring or revoking it takes
effect on the vehicle without anyone SSHing in.

That matters beyond convenience: a hand-maintained list only protects vehicles
whose operator remembered to write one. Deriving it from the database means every
drone in the fleet gets identity checks by default, including other people's.

Ownership previously lived in two places that could disagree — `drones.owner` in
Supabase, and a list typed into this Pi's environment. Now the environment
variable is only an override, for a vehicle that cannot reach Supabase.

Configuration (all optional — see is_jwt_enabled):
    SUPABASE_URL          Project URL; supplies the JWKS location, the expected
                          issuer, and the owner lookup.
    SUPABASE_SERVICE_KEY  Service-role key, shared with media_uploader.py. Used
                          only to read this drone's owner.
    DRONE_ID              Which row in `drones` is this vehicle. Same value
                          media_uploader.py files captures under.
    SEAGRASS_OWNER_UIDS   Extra user ids, always allowed. An override for when
                          the lookup cannot run — not the normal path.
    SUPABASE_JWT_SECRET   Only for legacy projects still signing with HS256.
    SEAGRASS_JWKS_CACHE   Where the fetched JWKS is kept so an offline boot can
                          still verify. default: ~/.seagrass-jwks.json
    SEAGRASS_OWNERS_CACHE Where the looked-up owner list is kept, for the same
                          reason. default: ~/.seagrass-owners.json
"""

import hmac
import json
import os
import socket
import threading
import urllib.error
import urllib.parse
import urllib.request

try:
    import jwt as pyjwt
    _JWT_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised only on an un-provisioned Pi
    pyjwt = None
    _JWT_AVAILABLE = False

TOKEN = os.environ.get("SEAGRASS_TOKEN", "")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET", "")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
# Same default as media_uploader.py, so a vehicle that uploads captures under a
# given id is also known by that id here.
DRONE_ID = os.environ.get("DRONE_ID") or socket.gethostname()

# Manually configured operators. Additive to whatever the database says, and
# meant as an escape hatch rather than the normal way to authorise someone.
OWNER_UIDS = {
    u.strip()
    for u in os.environ.get("SEAGRASS_OWNER_UIDS", "").split(",")
    if u.strip()
}
JWKS_CACHE_PATH = os.environ.get(
    "SEAGRASS_JWKS_CACHE", os.path.expanduser("~/.seagrass-jwks.json")
)
OWNERS_CACHE_PATH = os.environ.get(
    "SEAGRASS_OWNERS_CACHE", os.path.expanduser("~/.seagrass-owners.json")
)

# How often to re-read the owner list. Revocation is eventual, bounded by this:
# removing someone in the app stops them driving within one interval rather than
# instantly. Short enough to matter, long enough to be invisible.
OWNER_REFRESH_S = 300

_owners_from_db = set()
_owners_lock = threading.Lock()

# Tolerance on exp/iat. Small: this is a clock-skew allowance, not a way to keep
# using dead tokens. A Pi whose clock is wrong by more than this falls back to
# the static token, which is exactly what that fallback is for.
CLOCK_LEEWAY_S = 60

# Supabase stamps every end-user token with this audience.
EXPECTED_AUDIENCE = "authenticated"

_jwks_client = None


def _can_look_up_owners():
    return bool(SUPABASE_URL and SUPABASE_SERVICE_KEY and DRONE_ID)


def allowed_owners():
    """Everyone permitted to drive: the database's answer plus any override."""
    with _owners_lock:
        return set(_owners_from_db) | OWNER_UIDS


def _load_cached_owners():
    global _owners_from_db
    try:
        with open(OWNERS_CACHE_PATH, "r", encoding="utf-8") as fh:
            cached = json.load(fh)
    except (OSError, ValueError):
        return
    if isinstance(cached, dict) and cached.get("drone_id") == DRONE_ID:
        with _owners_lock:
            _owners_from_db = set(cached.get("owners", []))


def refresh_owners(timeout=8):
    """Re-read this vehicle's owners from `drones`.

    Returns True when the database answered. A failure leaves the previous list
    in place — an uplink that drops mid-dive must not quietly deauthorise the
    person steering.
    """
    global _owners_from_db
    if not _can_look_up_owners():
        return False

    query = urllib.parse.urlencode({"select": "owner", "drone_id": f"eq.{DRONE_ID}"})
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/drones?{query}",
        headers={
            "apikey": SUPABASE_SERVICE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
            "Accept": "application/json",
            "User-Agent": "seagrass-drone/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            rows = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print(f"Owner lookup failed ({exc}); keeping the previous list", flush=True)
        return False

    owners = {r.get("owner") for r in rows if isinstance(r, dict) and r.get("owner")}

    with _owners_lock:
        changed = owners != _owners_from_db
        _owners_from_db = owners

    if changed:
        # An empty result is honoured, not ignored: it is what a revoked or
        # transferred drone looks like, and refusing to act on it would make
        # revocation impossible. Said out loud because the other way to get here
        # is a DRONE_ID that matches no row, and that reads identically.
        if not owners:
            print(f"No owner registered for drone_id={DRONE_ID!r}. Operator identity "
                  f"cannot be checked; the shared token still works.", flush=True)
        else:
            print(f"Authorised operators for {DRONE_ID!r}: {len(owners)}", flush=True)

    try:
        with open(OWNERS_CACHE_PATH, "w", encoding="utf-8") as fh:
            json.dump({"drone_id": DRONE_ID, "owners": sorted(owners)}, fh)
    except OSError:
        pass
    return True


def start_owner_refresh(interval=OWNER_REFRESH_S):
    """Keep the owner list current on a daemon thread.

    A thread rather than an asyncio task because both servers use this and only
    one of them has an event loop. It is a single HTTP GET every few minutes.
    """
    if not _can_look_up_owners():
        return None

    def loop():
        while True:
            _sleep(interval)
            refresh_owners()

    t = threading.Thread(target=loop, daemon=True, name="owner-refresh")
    t.start()
    return t


def _sleep(seconds):
    # Indirection so tests can drive the loop without waiting.
    import time
    time.sleep(seconds)


def is_jwt_enabled():
    """JWT auth is on only when it can actually work AND someone is authorised.

    Unconfigured deliberately means "static token only", not "refuse everyone".
    Deploying this to a vehicle that has not been given an owner list yet must
    change nothing about how it behaves.
    """
    if not _JWT_AVAILABLE:
        return False
    if not (SUPABASE_URL or SUPABASE_JWT_SECRET):
        return False
    # Either the database can tell us who owns this vehicle, or someone said so
    # explicitly. With neither, there is nobody to authorise and JWT auth would
    # only refuse people.
    return _can_look_up_owners() or bool(OWNER_UIDS)


def status_line():
    """One line for the startup log, so which mode is live is never a guess."""
    if not _JWT_AVAILABLE:
        return ("Operator auth: shared token only — PyJWT is not installed. "
                "`pip install -r server/requirements.txt --break-system-packages`")
    if not (SUPABASE_URL or SUPABASE_JWT_SECRET):
        return "Operator auth: shared token only (SUPABASE_URL unset)"
    if not is_jwt_enabled():
        return ("Operator auth: shared token only — cannot determine who owns this "
                "vehicle (needs SUPABASE_SERVICE_KEY + DRONE_ID, or SEAGRASS_OWNER_UIDS)")

    owners = allowed_owners()
    source = "registered in Supabase" if _can_look_up_owners() else "from SEAGRASS_OWNER_UIDS"
    if not owners:
        return (f"Operator auth: enabled but NO operators authorised yet "
                f"({source}, drone_id={DRONE_ID!r}) — shared token only until then")
    return (f"Operator auth: Supabase identity for {len(owners)} operator(s) "
            f"{source}, shared token as fallback")


def _looks_like_jwt(value):
    return isinstance(value, str) and value.count(".") == 2 and len(value) > 40


def _jwks_url():
    return f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json"


def _read_cached_jwks():
    try:
        with open(JWKS_CACHE_PATH, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _write_cached_jwks(data):
    # Best effort. A vehicle that cannot write the cache still runs; it just
    # re-fetches next boot.
    try:
        with open(JWKS_CACHE_PATH, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
    except OSError:
        pass


def refresh_jwks(timeout=5):
    """Fetch the project's public keys and cache them to disk.

    Called at startup, off the hot path. The disk cache is the whole point: the
    vehicle works at sea, and an operator should not need the internet to prove
    who they are to a Pi three metres away.
    """
    if not SUPABASE_URL:
        return False
    try:
        req = urllib.request.Request(
            _jwks_url(), headers={"User-Agent": "seagrass-drone/1.0"}
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if not data.get("keys"):
            return False
        _write_cached_jwks(data)
        return True
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print(f"JWKS fetch failed ({exc}); using cached keys if present", flush=True)
        return False


def _signing_key(token):
    """Public key for this token, from the on-disk JWKS.

    Reads the cache rather than the network so verification never blocks on a
    link that may not exist.
    """
    jwks = _read_cached_jwks()
    if not jwks:
        return None
    try:
        header = pyjwt.get_unverified_header(token)
    except pyjwt.PyJWTError:
        return None
    kid = header.get("kid")
    for key in jwks.get("keys", []):
        if key.get("kid") == kid:
            return pyjwt.PyJWK(key).key
    return None


def _verify_jwt(token):
    """(ok, subject, reason) for a Supabase session token."""
    try:
        header = pyjwt.get_unverified_header(token)
    except pyjwt.PyJWTError:
        return False, None, "malformed token"

    alg = header.get("alg", "")
    options = {"verify_aud": True}
    kwargs = dict(
        audience=EXPECTED_AUDIENCE,
        leeway=CLOCK_LEEWAY_S,
        options=options,
    )
    if SUPABASE_URL:
        kwargs["issuer"] = f"{SUPABASE_URL}/auth/v1"

    if alg.startswith("HS"):
        # Legacy projects. The secret is symmetric, so this Pi could mint tokens
        # as well as check them — which is why the asymmetric path is preferred
        # and this one only engages when explicitly configured.
        if not SUPABASE_JWT_SECRET:
            return False, None, "HS256 token but SUPABASE_JWT_SECRET is unset"
        key = SUPABASE_JWT_SECRET
        algorithms = ["HS256"]
    else:
        key = _signing_key(token)
        if key is None:
            return False, None, "no cached public key matches this token's kid"
        algorithms = [alg or "ES256"]

    try:
        claims = pyjwt.decode(token, key, algorithms=algorithms, **kwargs)
    except pyjwt.ExpiredSignatureError:
        return False, None, "token expired"
    except pyjwt.InvalidAudienceError:
        return False, None, "wrong audience"
    except pyjwt.InvalidIssuerError:
        return False, None, "wrong issuer"
    except pyjwt.PyJWTError as exc:
        return False, None, f"invalid token ({type(exc).__name__})"

    subject = claims.get("sub")
    if not subject:
        return False, None, "token has no subject"
    # Authentication proved who they are; this is the separate question of
    # whether that person may drive THIS vehicle. Read live rather than captured
    # at import, so a revocation takes effect on the next refresh without a
    # restart.
    if subject not in allowed_owners():
        return False, subject, "not an owner of this vehicle"
    return True, subject, "ok"


def init(background_refresh=True):
    """Bring the verifier up: cached lists first, then the network.

    Cache before fetch is deliberate. A vehicle that boots with no uplink is
    fully functional on what it learned last time; the network calls then improve
    on that if they can, rather than being a precondition for working at all.
    """
    _load_cached_owners()
    if not is_jwt_enabled():
        return
    refresh_jwks()
    refresh_owners()
    if background_refresh:
        start_owner_refresh()


def verify_operator(credential):
    """(ok, subject, reason). `subject` is a Supabase user id, or None for the
    shared token — callers log it, so who drove the vehicle is answerable.

    Credential comes straight off the wire and may be any JSON type.
    """
    if _looks_like_jwt(credential) and is_jwt_enabled():
        return _verify_jwt(credential)

    if not isinstance(credential, str) or not TOKEN:
        return False, None, "invalid credential"
    if hmac.compare_digest(credential.encode("utf-8"), TOKEN.encode("utf-8")):
        return True, None, "shared token"
    return False, None, "invalid credential"
