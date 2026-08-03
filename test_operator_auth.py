"""Who may drive the vehicle — server/auth.py.

The credential used to be one shared secret with no expiry, sitting in plaintext
in the drones table and in browser localStorage. These tests pin the replacement:
a Supabase session JWT verified against the project's public key, with the shared
secret surviving only as break-glass for a Pi whose clock or network is unusable.

The signing key is generated here, so nothing depends on a live Supabase project
and the negative cases can use a genuinely wrong key.
"""

import importlib
import json
import os
import time

import pytest

jwt = pytest.importorskip("jwt", reason="PyJWT is required for operator auth")
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402

ISSUER_BASE = "https://proj.supabase.co"
OWNER = "11111111-2222-3333-4444-555555555555"
STRANGER = "99999999-8888-7777-6666-555555555555"
SHARED = "shared-break-glass-token"


def _jwk_from_public_key(key, kid):
    """Public half as a JWKS entry, the way Supabase publishes it."""
    return json.loads(jwt.algorithms.ECAlgorithm.to_jwk(key.public_key())) | {
        "kid": kid,
        "alg": "ES256",
        "use": "sig",
    }


@pytest.fixture
def env(tmp_path, monkeypatch):
    """A configured module, plus the key its JWKS cache trusts."""
    signing_key = ec.generate_private_key(ec.SECP256R1())
    cache = tmp_path / "jwks.json"
    cache.write_text(json.dumps({"keys": [_jwk_from_public_key(signing_key, "k1")]}))

    monkeypatch.setenv("SEAGRASS_TOKEN", SHARED)
    monkeypatch.setenv("SUPABASE_URL", ISSUER_BASE)
    monkeypatch.setenv("SEAGRASS_OWNER_UIDS", f"{OWNER}, ")
    monkeypatch.setenv("SEAGRASS_JWKS_CACHE", str(cache))
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "")
    monkeypatch.syspath_prepend(os.path.join(os.path.dirname(__file__), "server"))

    import auth
    importlib.reload(auth)
    return auth, signing_key


def make_token(key, *, sub=OWNER, aud="authenticated", iss=f"{ISSUER_BASE}/auth/v1",
               exp_delta=3600, kid="k1"):
    now = int(time.time())
    return jwt.encode(
        {"sub": sub, "aud": aud, "iss": iss, "iat": now, "exp": now + exp_delta},
        key,
        algorithm="ES256",
        headers={"kid": kid},
    )


class TestJwt:
    def test_owner_with_a_valid_token_is_accepted(self, env):
        auth, key = env
        ok, subject, reason = auth.verify_operator(make_token(key))
        assert ok, reason
        # The subject is what makes "who drove the vehicle" answerable at all.
        assert subject == OWNER

    def test_expired_token_is_refused(self, env):
        auth, key = env
        ok, _, reason = auth.verify_operator(make_token(key, exp_delta=-3600))
        assert not ok and "expired" in reason

    def test_small_clock_skew_is_tolerated(self, env):
        auth, key = env
        # Within CLOCK_LEEWAY_S. A Pi without an RTC is always a little wrong.
        ok, _, reason = auth.verify_operator(make_token(key, exp_delta=-30))
        assert ok, reason

    def test_token_signed_by_another_key_is_refused(self, env):
        auth, _ = env
        attacker = ec.generate_private_key(ec.SECP256R1())
        # Same kid, so it resolves to the real public key and fails on signature
        # rather than on lookup — the case that actually matters.
        ok, _, reason = auth.verify_operator(make_token(attacker))
        assert not ok and "invalid token" in reason

    def test_unknown_kid_is_refused(self, env):
        auth, key = env
        ok, _, reason = auth.verify_operator(make_token(key, kid="not-ours"))
        assert not ok and "public key" in reason

    def test_wrong_issuer_is_refused(self, env):
        auth, key = env
        ok, _, reason = auth.verify_operator(
            make_token(key, iss="https://evil.supabase.co/auth/v1")
        )
        assert not ok and "issuer" in reason

    def test_wrong_audience_is_refused(self, env):
        auth, key = env
        ok, _, reason = auth.verify_operator(make_token(key, aud="anon"))
        assert not ok and "audience" in reason

    def test_valid_token_from_a_non_owner_is_refused(self, env):
        auth, key = env
        # Authentication succeeded; authorisation did not. Someone with a real
        # account on the same Supabase project must not be able to drive.
        ok, subject, reason = auth.verify_operator(make_token(key, sub=STRANGER))
        assert not ok
        assert subject == STRANGER  # identified, then rejected — worth logging
        assert "owner" in reason


class TestSharedToken:
    def test_shared_token_still_works(self, env):
        auth, _ = env
        ok, subject, _ = auth.verify_operator(SHARED)
        assert ok
        assert subject is None  # no identity behind the break-glass path

    def test_wrong_shared_token_is_refused(self, env):
        auth, _ = env
        ok, _, _ = auth.verify_operator("nope")
        assert not ok

    @pytest.mark.parametrize("credential", [None, 123, {"a": 1}, [], b"bytes", ""])
    def test_non_string_credentials_are_refused_not_crashed_on(self, env, credential):
        auth, _ = env
        ok, _, _ = auth.verify_operator(credential)
        assert not ok


class TestUnconfigured:
    """Deploying to a vehicle with no owner list must change nothing."""

    def test_without_owner_uids_jwt_is_off_and_shared_token_works(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setenv("SEAGRASS_TOKEN", SHARED)
        monkeypatch.setenv("SUPABASE_URL", ISSUER_BASE)
        monkeypatch.setenv("SEAGRASS_OWNER_UIDS", "")
        monkeypatch.syspath_prepend(os.path.join(os.path.dirname(__file__), "server"))
        import auth
        importlib.reload(auth)

        assert not auth.is_jwt_enabled()
        assert auth.verify_operator(SHARED)[0]
        assert "shared token only" in auth.status_line()

    def test_a_jwt_is_refused_when_jwt_auth_is_off(self, tmp_path, monkeypatch):
        # It falls through to the shared-token compare and fails there, rather
        # than being honoured by a vehicle that was never told who owns it.
        key = ec.generate_private_key(ec.SECP256R1())
        monkeypatch.setenv("SEAGRASS_TOKEN", SHARED)
        monkeypatch.setenv("SEAGRASS_OWNER_UIDS", "")
        monkeypatch.syspath_prepend(os.path.join(os.path.dirname(__file__), "server"))
        import auth
        importlib.reload(auth)

        assert not auth.verify_operator(make_token(key))[0]


class TestStatusLine:
    def test_reports_enabled_when_configured(self, env):
        auth, _ = env
        assert auth.is_jwt_enabled()
        assert "Supabase identity" in auth.status_line()
