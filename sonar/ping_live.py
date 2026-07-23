"""Live Ping2 distance feed. Ctrl-C to quit.

    python3 ping_live.py [port]     # default /dev/ttyAMA2

Wiring that works on this Pi: green -> pin 7, white -> pin 29, red -> pin 4, black -> pin 6.
Do NOT use pin 8 / uart0 -- GPIO14 is dead on this board.
"""
import shutil
import sys
import time
from collections import deque

from brping import Ping1D

PORT = sys.argv[1] if len(sys.argv) > 1 else "/dev/ttyAMA2"
SPARK = " ▁▂▃▄▅▆▇█"

# The link runs ~3% packet loss, so every exchange needs to tolerate a miss.
def connect():
    p = Ping1D()
    p.connect_serial(PORT, 115200)
    for _ in range(5):
        if p.initialize():
            return p
        time.sleep(0.3)
    return None


def bar(value, lo, hi, width):
    if hi <= lo:
        return " " * width
    filled = int(round(width * (value - lo) / (hi - lo)))
    filled = max(0, min(width, filled))
    return "█" * filled + "·" * (width - filled)


def colour(conf):
    if conf >= 50:
        return "\033[32m"   # green  - trustworthy
    if conf >= 20:
        return "\033[33m"   # yellow - marginal
    return "\033[31m"       # red    - noise (expected in air)


ping = connect()
if ping is None:
    print(f"Could not initialize Ping on {PORT} after 5 attempts.")
    sys.exit(1)

hist = deque(maxlen=60)
lo = hi = None
misses = 0
samples = 0
start = time.time()

print("\033[?25l", end="")  # hide cursor
try:
    while True:
        data = ping.get_distance()
        if data is None:
            misses += 1
            time.sleep(0.05)
            continue

        samples += 1
        mm = data["distance"]
        conf = data["confidence"]
        hist.append(mm)
        lo = mm if lo is None else min(lo, mm)
        hi = mm if hi is None else max(hi, mm)

        width = max(40, shutil.get_terminal_size((100, 24)).columns - 4)
        span_lo, span_hi = min(hist), max(hist)
        spark = "".join(
            SPARK[int((v - span_lo) / (span_hi - span_lo) * (len(SPARK) - 1))]
            if span_hi > span_lo else SPARK[0]
            for v in hist
        )
        rate = samples / max(1e-6, time.time() - start)
        c = colour(conf)

        print("\033[H\033[J", end="")
        print(f"  \033[1mPing2 live feed\033[0m   {PORT}   {rate:4.1f} samples/s   "
              f"misses {misses}\n")
        print(f"  {c}\033[1m{mm/1000:8.2f} m\033[0m   ({mm} mm)     "
              f"confidence {c}{conf:3d}%\033[0m\n")
        print(f"  {c}{bar(mm, span_lo, span_hi, width - 6)}\033[0m\n")
        print(f"  recent: {spark}")
        print(f"  window {span_lo/1000:.2f}–{span_hi/1000:.2f} m    "
              f"session {lo/1000:.2f}–{hi/1000:.2f} m")
        print("\n  \033[2mconfidence is ~0% in air — this is normal, "
              "it needs water to read properly\033[0m")
        print("  \033[2mCtrl-C to quit\033[0m")

        time.sleep(0.05)
except KeyboardInterrupt:
    pass
finally:
    print("\033[?25h")  # restore cursor
    print(f"\nstopped after {samples} samples, {misses} missed reads")
