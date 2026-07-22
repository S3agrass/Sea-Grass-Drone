#!/usr/bin/env bash
# Is the Ping2 actually alive on pins 8/10? Needs no bridge wire and no multimeter.
#
# Method: force an internal pull-down, then a pull-up, on each pin.
#   - Nothing attached      -> the pin FOLLOWS the pull   (pd=lo, pu=hi)
#   - Powered device driving-> the pin HOLDS its own level (pd=lo is impossible on an idle TX)
#   - Unpowered device      -> pin is clamped toward ground (pd=lo, pu=lo)
#
# A UART line sits idle HIGH. So a live Ping's TX on pin 10 reads "hi" EVEN WITH THE PULLDOWN.
# That single reading is the whole test.
#
# NOTE: this temporarily steals GPIO14/15 from the UART driver. It restores alt-fn at the
# end. If serial acts strange afterwards, just reboot.

set -u

read_pin() { pinctrl get "$1" | grep -oE ' (lo|hi)( |$)' | tr -d ' ' | head -1; }

echo "pin 8  = GPIO14 = Ping GREEN (Ping RX, an input on the Ping)"
echo "pin 10 = GPIO15 = Ping WHITE (Ping TX, an output on the Ping)  <-- the one that matters"
echo

for spec in "14:pin8:GREEN/RX" "15:pin10:WHITE/TX"; do
    gpio=${spec%%:*}; rest=${spec#*:}; hdr=${rest%%:*}; wire=${rest#*:}

    pinctrl set "$gpio" ip pd; sleep 0.2; down=$(read_pin "$gpio")
    pinctrl set "$gpio" ip pu; sleep 0.2; up=$(read_pin "$gpio")

    case "$down/$up" in
        hi/hi) verdict="DRIVEN HIGH  -> device powered and holding the line (GOOD)" ;;
        lo/hi) verdict="FLOATING     -> nothing attached / not powered / open circuit" ;;
        lo/lo) verdict="HELD LOW     -> clamped to ground; device unpowered or shorted" ;;
        *)     verdict="UNSTABLE     -> $down then $up; possibly active traffic" ;;
    esac
    printf '%-6s %-10s pulldown=%-2s pullup=%-2s  %s\n' "$hdr" "$wire" "$down" "$up" "$verdict"
done

echo
# NB: on Pi 5 the UART is alt4 (TXD0/RXD0). alt0 is PWM -- setting a0 here would drive
# the Ping's RX line with a PWM output. Confirm with: pinctrl funcs 14
echo "Restoring UART alt-function (a4 = TXD0/RXD0) on GPIO14/15..."
pinctrl set 14 a4 2>/dev/null; pinctrl set 15 a4 2>/dev/null
pinctrl get 14,15
echo
echo "VERDICT: pin 10 must read pulldown=hi for the Ping to be alive and talking."
