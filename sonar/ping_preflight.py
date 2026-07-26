"""Pre-flight checks for the Ping2 sonar link.

Both failure modes below cost real debugging time before this existed, and both
look identical from brping: initialize() just returns False and you go hunting
for a wiring fault that isn't there.

  1. Another process owns the port. drone-server.service (and the `drone`
     command) hold /dev/ttyAMA2 for the whole time they run, and only ONE
     process can have it. A second reader gets either an exclusive-lock error or
     — worse — a silent tug-of-war over the same bytes where neither side can
     decode a reply.

  2. The Ping has no power. Its TX line idles HIGH, so forcing an internal
     pull-down on the Pi's RX pin and still reading `hi` proves the Ping is
     powered and driving. Reading `lo` means the line is floating: the red/black
     leads have come out of pins 4/6, which is easy to do while reaching across
     to the header. No UART setting can fix that, so there is no point testing
     baud rates or mux state until it reads hi.
"""
import os
import subprocess

# GPIO5 is header pin 29 = RXD2 = where the Ping's white/TX lead lands.
# See the repo README for the full pinout; uart0/pin 8 is dead on this board.
PING_RX_GPIO = 5


def _port_owner(port):
    """PIDs holding `port`, excluding ourselves. Empty list if none or unknown."""
    try:
        out = subprocess.run(
            ["fuser", port], capture_output=True, text=True, timeout=5
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    me = os.getpid()
    return [int(p) for p in out.split() if p.isdigit() and int(p) != me]


def _describe(pid):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as fh:
            return " ".join(fh.read().decode().split("\0")).strip() or f"pid {pid}"
    except OSError:
        return f"pid {pid}"


def _pin_is_driven_high(gpio):
    """True if something external holds `gpio` high against an internal pull-down.

    Returns None when pinctrl isn't available, so callers can stay quiet rather
    than reporting a fault they didn't actually measure.
    """
    try:
        subprocess.run(["pinctrl", "set", str(gpio), "ip", "pd"],
                       check=True, capture_output=True, timeout=5)
        out = subprocess.run(["pinctrl", "get", str(gpio)],
                             check=True, capture_output=True, text=True,
                             timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    finally:
        # ALWAYS put the uart mux back. On this Pi TXD2/RXD2 are alt2 — setting
        # these pins to a4 instead silently disconnects the UART from the header.
        subprocess.run(["pinctrl", "set", str(gpio), "a2"],
                       capture_output=True, timeout=5)
    return "| hi" in out


def check(port, fix_mux=True):
    """Return a list of human-readable problems with the link to `port`.

    Empty list means nothing obviously wrong — the sonar may still fail for
    other reasons, but not these two.
    """
    problems = []

    owners = _port_owner(port)
    if owners:
        who = ", ".join(_describe(p) for p in owners)
        problems.append(
            f"{port} is already open by another process ({who}).\n"
            f"    Only one process can read the sonar. Stop the server first:\n"
            f"        sudo systemctl stop drone-server\n"
            f"    ...or just watch the sonar in the UI, which the server feeds."
        )
        # The power probe below drives the pin, which would corrupt that
        # process's stream. Don't touch the header while someone else is reading.
        return problems

    if fix_mux:
        for gpio in (4, PING_RX_GPIO):
            subprocess.run(["pinctrl", "set", str(gpio), "a2"],
                           capture_output=True, timeout=5)

    driven = _pin_is_driven_high(PING_RX_GPIO)
    if driven is False:
        problems.append(
            f"The Ping appears UNPOWERED — GPIO{PING_RX_GPIO} (header pin 29) is\n"
            f"    floating, but a powered Ping idles its TX line HIGH.\n"
            f"    Check the red lead is seated in pin 4 and black in pin 6; they\n"
            f"    share those pins with the battery feed and unseat easily when\n"
            f"    you move the green/white leads. No UART setting fixes this."
        )

    return problems


def report(port, fix_mux=True):
    """Print any problems found. Returns True if the link looks usable."""
    problems = check(port, fix_mux=fix_mux)
    for p in problems:
        print(f"  !! {p}")
    return not problems
