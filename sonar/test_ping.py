import sys
import time

from brping import Ping1D

# uart0 = pins 8/10, uart2 = pins 7/29. Override from the command line.
PORT = sys.argv[1] if len(sys.argv) > 1 else "/dev/ttyAMA0"

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
    exit(1)

print("Ping initialized — reading distance...")
for _ in range(10):
    data = myPing.get_distance()
    if data:
        print(f"Distance: {data['distance']} mm   Confidence: {data['confidence']}%")
    else:
        print("No response — check TX/RX wiring")
