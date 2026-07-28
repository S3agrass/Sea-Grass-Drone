#!/bin/sh
# Renews the drone control server's TLS certificate, issued by Tailscale for
# the Pi's tailnet name. `tailscale cert` does NOT auto-renew — Tailscale's own
# docs say the caller is responsible for that — so this runs on a schedule (see
# renew-tls-cert.timer). It's a safe no-op most days: --min-validity skips
# re-issuing unless the current cert is close to expiry, so running this daily
# costs nothing on the 89 days out of ~90 nothing needs to happen.
#
# Runs as root (via its systemd service) because restarting drone-server.service
# needs it; the cert/key are chowned to `pi` afterward since drone-server.service
# itself runs as `pi` and must be able to read them.
#
# Requires TLS_HOSTNAME set in ~/.seagrass-env — see /etc/systemd/system/
# renew-tls-cert.service's EnvironmentFile — to the device's full tailnet name
# (e.g. seagrass.tailnet-name.ts.net — find it with `tailscale status`).
set -eu

: "${TLS_HOSTNAME:?TLS_HOSTNAME must be set in ~/.seagrass-env}"
CERT_DIR="/home/pi/.seagrass-tls"
CERT_FILE="$CERT_DIR/$TLS_HOSTNAME.crt"
KEY_FILE="$CERT_DIR/$TLS_HOSTNAME.key"
mkdir -p "$CERT_DIR"

before=""
[ -f "$CERT_FILE" ] && before=$(sha256sum "$CERT_FILE")

tailscale cert \
  --cert-file "$CERT_FILE" \
  --key-file "$KEY_FILE" \
  --min-validity=720h \
  "$TLS_HOSTNAME"

chown pi:pi "$CERT_FILE" "$KEY_FILE"
chmod 600 "$KEY_FILE"

after=$(sha256sum "$CERT_FILE")

# drone-server only reads the cert at startup, so a renewal needs a restart to
# take effect — but only restart the live control link when the cert actually
# changed, not on every no-op check.
if [ "$before" != "$after" ]; then
  echo "Certificate renewed, restarting drone-server"
  systemctl restart drone-server
else
  echo "Certificate still valid, nothing to do"
fi
