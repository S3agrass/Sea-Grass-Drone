#!/usr/bin/env python3
"""
Renews MediaMTX's static TURN/STUN ICE servers using Cloudflare Realtime TURN.

Unlike the browser side (server/media_server.py's /turn-credentials, refreshed
fresh per viewing session with a 1-hour TTL), MediaMTX reads its ICE server
list once from mediamtx.yml at process start — there is no live API to push
updated credentials into a running instance. So this mints a long-lived
(30-day) credential instead, rewrites the `webrtcICEServers2:` block in
/mediamtx.yml in place, and restarts mediamtx only when that block actually
changed (every run mints a fresh credential, so "changed" is normally "yes" —
this still only restarts once per timer interval, not per viewer).

Requires TURN_KEY_ID and TURN_KEY_API_TOKEN in ~/.seagrass-env (see
server/media_server.py's module docstring for where these come from).

Install: see renew-turn-credentials.service/.timer in this directory.
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

MEDIAMTX_YML = "/mediamtx.yml"
TTL_S = 30 * 24 * 3600  # 30 days — the weekly timer renews well before expiry

TURN_KEY_ID = os.environ.get("TURN_KEY_ID", "")
TURN_KEY_API_TOKEN = os.environ.get("TURN_KEY_API_TOKEN", "")


def fetch_ice_servers():
    req = urllib.request.Request(
        f"https://rtc.live.cloudflare.com/v1/turn/keys/{TURN_KEY_ID}/credentials/generate-ice-servers",
        method="POST",
        data=json.dumps({"ttl": TTL_S}).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {TURN_KEY_API_TOKEN}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))["iceServers"]


def render_block(ice_servers):
    lines = ["webrtcICEServers2:"]
    for entry in ice_servers:
        urls = entry.get("urls")
        for url in (urls if isinstance(urls, list) else [urls]):
            lines.append(f"  - url: {url}")
            if entry.get("username"):
                lines.append(f"    username: {entry['username']}")
            if entry.get("credential"):
                lines.append(f"    password: {entry['credential']}")
    return lines


def main():
    if not (TURN_KEY_ID and TURN_KEY_API_TOKEN):
        print("TURN_KEY_ID/TURN_KEY_API_TOKEN not set — nothing to renew")
        return

    try:
        ice_servers = fetch_ice_servers()
    except (urllib.error.URLError, OSError, ValueError, KeyError) as exc:
        print(f"TURN credential fetch failed: {exc}", file=sys.stderr)
        sys.exit(1)

    new_block = render_block(ice_servers)

    with open(MEDIAMTX_YML) as fh:
        old_lines = fh.read().splitlines()

    start = next(
        (i for i, l in enumerate(old_lines) if l.startswith("webrtcICEServers2:")), None
    )
    if start is None:
        print(f"No webrtcICEServers2: key found in {MEDIAMTX_YML}", file=sys.stderr)
        sys.exit(1)
    end = start + 1
    while end < len(old_lines) and (
        old_lines[end] == "" or old_lines[end].startswith((" ", "#"))
    ):
        end += 1

    new_lines = old_lines[:start] + new_block + old_lines[end:]

    if new_lines == old_lines:
        print("ICE servers unchanged, nothing to do")
        return

    with open(MEDIAMTX_YML, "w") as fh:
        fh.write("\n".join(new_lines) + "\n")

    print(f"Updated {MEDIAMTX_YML} with {len(ice_servers)} ICE server entr(y/ies), restarting mediamtx")
    subprocess.run(["systemctl", "restart", "mediamtx"], check=True)


if __name__ == "__main__":
    main()
