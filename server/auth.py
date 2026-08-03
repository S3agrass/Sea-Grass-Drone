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

Configuration (all optional — see is_jwt_enabled):
    SEAGRASS_OWNER_UIDS   Comma-separated Supabase user ids allowed to drive.
                          Empty disables JWT auth entirely.
    SUPABASE_URL          Project URL; supplies the JWKS location and the
                          expected issuer.
    SUPABASE_JWT_SECRET   Only for legacy projects still signing with HS256.
    SEAGRASS_JWKS_CACHE   Where the fetched JWKS is kept so an offline boot can
                          still verify. default: ~/.seagrass-jwks.json
"""

import hmac
import json
import os
import urllib.error
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
OWNER_UIDS = {
    u.strip()
    for u in os.environ.get("SEAGRASS_OWNER_UIDS", "").split(",")
    if u.strip()
}
JWKS_CACHE_PATH = os.environ.get(
    "SEAGRASS_JWKS_CACHE", os.path.expanduser("~/.seagrass-jwks.json")
)

# Tolerance on exp/iat. Small: this is a clock-skew allowance, not a way to keep
# using dead tokens. A Pi whose clock is wrong by more than this falls back to
# the static token, which is exactly what that fallback is for.
CLOCK_LEEWAY_S = 60

# Supabase stamps every end-user token with this audience.
EXPECTED_AUDIENCE = "authenticated"

_jwks_client = None


def is_jwt_enabled():
    """JWT auth is on only when it can actually work AND someone is authorised.

    Unconfigured deliberately means "static token only", not "refuse everyone".
    Deploying this to a vehicle that has not been given an owner list yet must
    change nothing about how it behaves.
    """
    if not _JWT_AVAILABLE or not OWNER_UIDS:
        return False
    return bool(SUPABASE_URL or SUPABASE_JWT_SECRET)


def status_line():
    """One line for the startup log, so which mode is live is never a guess."""
    if not OWNER_UIDS:
        return "Operator auth: shared token only (SEAGRASS_OWNER_UIDS unset)"
    if not _JWT_AVAILABLE:
        return ("Operator auth: shared token only — PyJWT is not installed, so the "
                "owner list cannot be enforced. `pip install -r server/requirements.txt`")
    if not (SUPABASE_URL or SUPABASE_JWT_SECRET):
        return "Operator auth: shared token only (SUPABASE_URL unset)"
    return (f"Operator auth: Supabase identity for {len(OWNER_UIDS)} owner(s), "
            f"shared token as fallback")


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
    # whether that person may drive THIS vehicle.
    if subject not in OWNER_UIDS:
        return False, subject, "not an owner of this vehicle"
    return True, subject, "ok"


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
