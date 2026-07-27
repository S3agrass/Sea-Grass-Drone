"""One-shot Ping2 connectivity check.

    python3 test_ping.py [port]     # default /dev/ttyAMA2

Wiring that works on this Pi: green -> pin 7, white -> pin 29, red -> pin 4,
black -> pin 6. Do NOT use pin 8 / uart0 -- GPIO14 is dead on this board, which
is why the default here is ttyAMA2 and not ttyAMA0.
"""
import sys
import time

from brping import Ping1D

import ping_preflight

# uart2 = pins 7/29. Override from the command line.
PORT = sys.argv[1] if len(sys.argv) > 1 else "/dev/ttyAMA2"

# Catch "another process owns the port" and "the Ping has no power" up front --
# both otherwise present as a bare initialize() failure that reads like a
# wiring fault and sends you hunting in the wrong place.
# Stop here rather than pressing on: neither problem can be worked around from
# software, and continuing just buries the explanation under a pyserial traceback.
if not ping_preflight.report(PORT):
    print("\n  Fix the above first — the test cannot pass through it.\n")
    sys.exit(1)

myPing = Ping1D()
myPing.connect_serial(PORT, 115200)

# The link runs ~3% packet loss, and initialize() chains several exchanges with no retries
# of its own, so a single attempt fails ~20% of the time. Retrying makes it reliable.
for attempt in range(1, 6):
    if myPing.initialize():
        break
    print(f"initialize attempt {attempt} failed, retrying...")
    time.sleep(0.3)
else:
    print("Failed to initialize Ping after 5 attempts! Check wiring/baud rate.")
    ping_preflight.report(PORT)
    sys.exit(1)

print("Ping initialized — reading distance...")
for _ in range(10):
    data = myPing.get_distance()
    if data:
        print(f"Distance: {data['distance']} mm   Confidence: {data['confidence']}%")
    else:
        print("No response — check TX/RX wiring")
