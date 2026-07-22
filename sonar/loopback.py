"""Bare UART loopback test.

Bridge TX to RX with a wire (Ping disconnected), then run this.
Tests every candidate UART so you don't have to guess which device is live.

  uart0 -> /dev/ttyAMA0 : GPIO14 pin 8 (TX)  <-> GPIO15 pin 10 (RX)
  uart2 -> /dev/ttyAMA2 : GPIO4  pin 7 (TX)  <-> GPIO5  pin 29 (RX)
"""
import glob
import time

import serial

PINS = {
    "/dev/ttyAMA0": "pin 8 (TX) <-> pin 10 (RX)",
    "/dev/ttyAMA2": "pin 7 (TX) <-> pin 29 (RX)",
}
PROBE = b"HELLO"

ports = sorted(glob.glob("/dev/ttyAMA*"))
if not ports:
    raise SystemExit("No /dev/ttyAMA* devices at all -- check config.txt overlays.")

for port in ports:
    hint = PINS.get(port, "(bluetooth/debug UART -- not on the GPIO header)")
    try:
        ser = serial.Serial(port, 115200, timeout=1)
    except serial.SerialException as exc:
        print(f"{port:16} SKIP  {exc}")
        continue

    with ser:
        ser.reset_input_buffer()
        ser.write(PROBE)
        ser.flush()
        time.sleep(0.3)
        got = ser.read(len(PROBE))

    verdict = "PASS" if got == PROBE else "FAIL"
    print(f"{port:16} {verdict}  sent={PROBE!r} got={got!r}   bridge {hint}")
