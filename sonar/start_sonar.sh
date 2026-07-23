#!/usr/bin/env bash
# One-command Ping2 launcher. Guards the two things that repeatedly break this setup:
#   1. GPIO4/5 must be muxed to a2 (TXD2/RXD2), NOT a4.
#   2. The Ping must actually be powered (pin 29 driven high).
#
# Usage:  ./start_sonar.sh            # visual live feed
#         ./start_sonar.sh test      # 10-reading sanity check instead
set -u
PORT=/dev/ttyAMA2

echo "== fixing uart2 mux (a2 = TXD2/RXD2) =="
pinctrl set 4 a2
pinctrl set 5 a2
pinctrl get 4
pinctrl get 5

echo "== checking Ping power on pin 29 =="
pinctrl set 5 ip pd; sleep 0.1
state=$(pinctrl get 5)
echo "  $state"
pinctrl set 5 a2   # restore RXD2
if ! echo "$state" | grep -q 'hi'; then
    echo "  !! pin 29 is FLOATING -> the Ping is not powered."
    echo "     Reseat red(pin4)/black(pin6) power leads and the Ping's own cable connector,"
    echo "     then run this again. (Every read will time out until this reads 'hi'.)"
    exit 1
fi
echo "  OK - Ping powered."

cd "$(dirname "$0")"
if [ "${1:-}" = "test" ]; then
    exec python3 test_ping.py "$PORT"
else
    exec python3 ping_live.py "$PORT"
fi
