#!/usr/bin/env bash
# Copy the vehicle's ~/.seagrass-env somewhere safe.
#
# That file is the only thing on the Pi that a reflash does not bring back. The
# code is a git clone away; the token, the Supabase service key and the hardware
# paths are not written down anywhere else. Losing the SD card without a copy
# means re-pairing the drone and re-deriving which /dev/serial/by-id path the
# Pixhawk answers on.
#
# Backups land OUTSIDE the repo, in ~/seagrass-backups, deliberately. Writing
# secrets into a working tree is one .gitignore mistake away from publishing
# them, and the file being absent from the repo entirely is a stronger guarantee
# than a rule saying to ignore it.
#
# Usage:
#   scripts/backup-pi-env.sh                 # pi@seagrass.local -> ~/seagrass-backups
#   scripts/backup-pi-env.sh pi@10.0.0.42    # a different host
#   DEST=~/Documents/safe scripts/backup-pi-env.sh
#
# Restore after a reflash:
#   scp ~/seagrass-backups/seagrass-env-TIMESTAMP pi@seagrass.local:~/.seagrass-env
#   ssh pi@seagrass.local 'chmod 600 ~/.seagrass-env && sudo systemctl restart drone-server'
set -euo pipefail

HOST="${1:-pi@seagrass.local}"
DEST="${DEST:-${HOME}/seagrass-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${DEST}/seagrass-env-${STAMP}"

mkdir -p "${DEST}"
chmod 700 "${DEST}"

echo "Copying ${HOST}:~/.seagrass-env"
# scp rather than ssh cat: it fails loudly on a missing file instead of writing
# an empty backup that looks like a successful one until the day it is needed.
scp "${HOST}:.seagrass-env" "${OUT}"

# Readable only by this user. A backup of a secret is still a secret, and the
# default umask would leave it group- and world-readable on a shared machine.
chmod 600 "${OUT}"

# An empty or truncated copy is worse than none, because it will not be
# questioned until a restore. Check it carries the one value nothing else can
# replace.
if ! grep -q "SEAGRASS_TOKEN=." "${OUT}"; then
    echo >&2
    echo "WARNING: no SEAGRASS_TOKEN in the copy at ${OUT}" >&2
    echo "  The file was fetched but looks empty or incomplete. Check the Pi's" >&2
    echo "  ~/.seagrass-env before trusting this as a backup." >&2
    exit 1
fi

ln -sfn "${OUT}" "${DEST}/seagrass-env-latest"

echo "Saved  ${OUT}"
echo "Latest ${DEST}/seagrass-env-latest -> $(basename "${OUT}")"
echo
echo "$(grep -c '^[A-Z]' "${OUT}") settings backed up. Keep this off the repo and"
echo "off shared drives — it contains the drone's access token."
