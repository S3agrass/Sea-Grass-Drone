# Ping2 Sonar (BlueRobotics Ping1D) on Raspberry Pi 5

Driver + diagnostic scripts for reading distance from a BlueRobotics **Ping2** echosounder
wired into the Pi 5 GPIO UART. Hardware-validated 2026-07-22 — live distance data flows over
`uart2` at 115200 baud.

## Wiring (THE known-good setup)

| Ping wire | Signal            | Pi 5 header pin | GPIO / function |
|-----------|-------------------|-----------------|-----------------|
| red       | 5V power          | **pin 4**       | 5V (battery net)|
| black     | GND               | **pin 6**       | GND             |
| green     | Ping RX (Pi → Ping)| **pin 7**      | GPIO4 / TXD2    |
| white     | Ping TX (Ping → Pi)| **pin 29**     | GPIO5 / RXD2    |

Serial device: **`/dev/ttyAMA2`** (uart2).

> ⚠️ **Do NOT use pins 8/10 (uart0 / GPIO14).** GPIO14 on this specific board is dead
> (reads a hard low). uart2 on pins 7/29 is the only working UART for the Ping.

## Two gotchas that cost real debugging time

1. **TXD2/RXD2 on GPIO4/5 is alt `a2`, NOT `a4`.** `a4` on these pins is RI0/DTR0 (uart0
   modem-control lines), which silently disconnects the UART from the header — the port opens
   fine and every read times out with zero bytes. If the Ping stops responding, check first:
   ```bash
   pinctrl get 4    # must read: a2 ... TXD2
   pinctrl get 5    # must read: a2 ... RXD2
   ```
   Fix without rebooting: `pinctrl set 4 a2; pinctrl set 5 a2`
   (A reboot also restores it via `dtoverlay=uart2-pi5` in `/boot/firmware/config.txt`.)

2. **The Ping's power/signal leads share crowded header holes** (pin 4/6 also feed the Pi from
   the battery). Reaching across to the signal pins can unseat power. Confirm the Ping is
   powered before blaming software — pin 29 must read `hi` under a forced pull-down:
   ```bash
   pinctrl set 5 ip pd; pinctrl get 5   # want: pd | hi   (Ping TX idling high = powered)
   pinctrl set 5 a2                     # restore RXD2 afterwards
   ```

## Prerequisites (one-time)

```bash
pip install bluerobotics-ping pyserial     # provides the `brping` module
sudo usermod -aG dialout $USER             # serial access without sudo (re-login after)
# /boot/firmware/config.txt must contain:  dtoverlay=uart2-pi5
# serial-getty on ttyAMA2 must be disabled: sudo systemctl disable --now serial-getty@ttyAMA2
```

## Scripts

| Script          | What it does |
|-----------------|--------------|
| `ping_live.py`  | **Visual live feed** — distance in metres, confidence-coloured bar, scrolling sparkline. `python3 ping_live.py [port]` (default `/dev/ttyAMA2`). Ctrl-C to quit. |
| `test_ping.py`  | Minimal sanity check — initializes with retries, prints 10 distance readings. `python3 test_ping.py /dev/ttyAMA2`. |
| `loopback.py`   | Diagnostic — bridge TX→RX with a bare wire (Ping removed) to prove the Pi's UART works. Tests every `ttyAMA*`. |
| `pincheck.sh`   | Diagnostic — is a device alive on a pin, with no multimeter/bridge? (written for uart0 pins 8/10; adapt GPIO numbers for other pins). |

Both drivers retry `initialize()` up to 5× — the link runs ~3% packet loss, so a single
attempt fails ~20–25% of the time. Keep that retry pattern in any new Ping script.

## Reading meaningfully

**In air the Ping reads garbage at ~0% confidence — this is normal.** It needs water to couple
acoustically. Only trust readings (green confidence) with the transducer submerged.

## Quick start

```bash
cd sonar
python3 test_ping.py /dev/ttyAMA2     # sanity check — expect distance + confidence lines
python3 ping_live.py                  # visual feed
```
