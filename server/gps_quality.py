"""How good is the GPS fix, in one word and one number.

Pure stdlib on purpose. This module is imported by three things that must agree:

  * scripts/gps_survey.py — the hardware survey harness
  * server/drone_server.py — computes the grade once, server-side, and ships it
  * test_gps_quality.py    — offline, no hardware, no Pixhawk

They must agree because the whole point of the feature is trustworthiness. A
survey report that says "good" and a UI badge that says "fair" for the same fix
would be two definitions of the same word, in the one place where the operator
is being asked to believe a number. So the rubric lives here and nowhere else,
and the UI never re-derives it.

THE RUBRIC (top-down, first match wins):

    survey   fix >= 4 (DGPS/RTK), or 3D with >=10 sats, HDOP <= 1.2, <= 2.5 m
    good     3D with >= 8 sats, HDOP <= 2.0, <= 5.0 m
    fair     3D with >= 6 sats, HDOP <= 4.0, <= 10.0 m
    poor     any 2D/3D fix that fails the above
    none     no fix at all

Where the thresholds come from — these are not round numbers picked for looks:

  * 6 satellites is the floor because mav.parm sets AHRS_GPS_MINSATS 6. Below
    that the EKF will not use the GPS either, so grading it better than `poor`
    would be the console disagreeing with the vehicle it is describing.

  * HDOP 2.0 / 4.0 brackets EK3's own internal check (~2.5), which is enabled by
    EK3_GPS_CHECK 31. `good` sits comfortably inside it; `fair` straddles it.

  * 5 m and 2.5 m are set against the actual job: dropping a waypoint on a
    seagrass bed. 5 m is about a vehicle length — fine for "go over there".
    10 m can put the marker and the truth on opposite sides of a small bed,
    which is why that is where `fair` stops.

  * A 2D fix never grades above `poor` no matter how many satellites it has.
    Its horizontal error is coupled to an assumed altitude, so its reported
    accuracy is not a claim about anything we can use.

MISSING DATA NEVER PROMOTES. sats/hdop/acc may all be None — an older firmware,
a MAVLink1 link, a receiver that doesn't report accuracy. Every comparison below
treats None as failing, so a fix we know nothing about grades down, not up.
"""
import math

# MAV_GPS_FIX_TYPE. Labels are what the console shows, so they are short and
# upper-case rather than the enum's spelling.
FIX_NAMES = {
    0: "NO GPS",
    1: "NO FIX",
    2: "2D",
    3: "3D",
    4: "DGPS",
    5: "RTK FLOAT",
    6: "RTK FIXED",
    7: "STATIC",
    8: "PPP",
}

# Ordered worst to best. Index is the rank — see grade_rank().
GRADES = ("none", "poor", "fair", "good", "survey")
GRADE_RANK = {g: i for i, g in enumerate(GRADES)}

# User-equivalent range error, metres, 1-sigma. Only used to turn HDOP into a
# distance when the receiver does not report h_acc. 4 m is a conservative
# consumer-GNSS figure; the static-scatter run in scripts/gps_survey.py is what
# replaces this guess with a measured, receiver- and site-specific number.
UERE_M = 4.0

# eph/epv are UINT16 hundredths. UINT16_MAX is the protocol's "unknown", and 0
# means the field was never populated — both are absence, not a perfect DOP.
_DOP_UNKNOWN = 65535

# h_acc is UINT32 millimetres, and UINT32_MAX is its "unknown" — the same
# convention eph uses, one field wider. A receiver searching for satellites
# sends it constantly. Read literally it is an accuracy claim of 4,294 km, and
# the first survey run on real hardware duly reported "claimed mean ±2204527.8 m
# (reported)", which is not a measurement, it is a sentinel wearing one's
# clothes. Anything past _ACC_MAX_SANE_M gets the same treatment: no receiver
# that knows its position to within a kilometre is telling us anything we can
# use, so it is absence, and absence must fall through to the HDOP estimate
# rather than poison the mean.
ACC_UNKNOWN_MM = 0xFFFFFFFF
_ACC_MAX_SANE_M = 1000.0


def _at_least(value, limit):
    """value >= limit, with None failing rather than raising."""
    return value is not None and value >= limit


def _at_most(value, limit):
    """value <= limit, with None failing rather than raising."""
    return value is not None and value <= limit


def fix_name(fix_type):
    """Short label for a MAV_GPS_FIX_TYPE, including ones we've never seen."""
    if fix_type is None:
        return "—"
    return FIX_NAMES.get(fix_type, f"FIX {fix_type}")


def decode_hdop(eph):
    """GPS_RAW_INT.eph (hundredths) -> HDOP, or None if unknown."""
    if eph is None or eph == 0 or eph >= _DOP_UNKNOWN:
        return None
    return eph / 100.0


def decode_accuracy(h_acc_mm, eph):
    """Horizontal accuracy in metres, and where the number came from.

    Returns (metres, source) where source is "reported", "estimated" or None.

    h_acc is a MAVLink2 *extension* field on GPS_RAW_INT. On a MAVLink1 link the
    attribute is absent entirely (callers must use getattr, not msg.h_acc, or it
    raises), ArduPilot sends 0 when the driver has no estimate to give, and a
    receiver still searching sends UINT32_MAX. All three fall through to an HDOP
    estimate, which is a weaker claim — hence the source, which the UI says out
    loud. An estimated figure and a measured one are not the same statement and
    should not be read as if they were.
    """
    if h_acc_mm and h_acc_mm != ACC_UNKNOWN_MM:
        metres = h_acc_mm / 1000.0
        if metres <= _ACC_MAX_SANE_M:
            return metres, "reported"
    hdop = decode_hdop(eph)
    if hdop is not None:
        return hdop * UERE_M, "estimated"
    return None, None


def grade_fix(fix_type, sats, hdop, acc_m):
    """One of GRADES. See the module docstring for the thresholds and why."""
    if fix_type is None or fix_type < 2:
        return "none"
    # DGPS and both RTK modes are differentially corrected: they are better than
    # anything the sat/HDOP test can describe, so they short-circuit it.
    if fix_type >= 4:
        return "survey"
    if fix_type >= 3:
        if _at_least(sats, 10) and _at_most(hdop, 1.2) and _at_most(acc_m, 2.5):
            return "survey"
        if _at_least(sats, 8) and _at_most(hdop, 2.0) and _at_most(acc_m, 5.0):
            return "good"
        if _at_least(sats, 6) and _at_most(hdop, 4.0) and _at_most(acc_m, 10.0):
            return "fair"
    return "poor"


def grade_rank(grade):
    """Position in GRADES, or -1 for anything unrecognised."""
    return GRADE_RANK.get(grade, -1)


def describe_grade(grade, acc_m=None, sats=None):
    """One plain sentence an operator can act on. No jargon, no abbreviations.

    Shared with the console so the survey report and the UI say the same thing.
    """
    acc = f"±{acc_m:.1f} m" if acc_m is not None else "unknown accuracy"
    if grade == "survey":
        return f"Position is {acc} — good enough to survey from."
    if grade == "good":
        return f"Position good to {acc} — safe to route waypoints."
    if grade == "fair":
        return f"Position roughly right ({acc}) — waypoints may be off by a boat length."
    if grade == "poor":
        return "Position is not trustworthy — do not route from it."
    if sats:
        return f"No GPS fix. {sats} satellites visible, searching."
    return "No GPS fix."


# --- Empirical accuracy: what the receiver ACTUALLY did, not what it claimed ---


def metres_per_degree(lat_deg):
    """(metres per degree latitude, metres per degree longitude) at a latitude.

    Series expansion of the WGS-84 meridian/parallel arc lengths. A flat
    111_320 constant is off by ~0.5% in latitude and, far worse, ignores the
    cos(lat) term in longitude entirely — which at 60N would report a 2 m
    east-west scatter as 4 m. At the scale we care about (tens of metres about a
    mean) this is accurate to well under a centimetre.
    """
    phi = math.radians(lat_deg)
    m_lat = (111132.92
             - 559.82 * math.cos(2 * phi)
             + 1.175 * math.cos(4 * phi)
             - 0.0023 * math.cos(6 * phi))
    m_lon = (111412.84 * math.cos(phi)
             - 93.5 * math.cos(3 * phi)
             + 0.118 * math.cos(5 * phi))
    return m_lat, m_lon


def separation_m(a, b):
    """Distance in metres between two (lat, lon) points, for small separations.

    Equirectangular about the midpoint. Intended for scatter about a stationary
    vehicle, not for route legs — src/lib/route.js does the map's distances.
    """
    m_lat, m_lon = metres_per_degree((a[0] + b[0]) / 2.0)
    dy = (b[0] - a[0]) * m_lat
    dx = (b[1] - a[1]) * m_lon
    return math.hypot(dx, dy)


def mean_position(points):
    """Arithmetic mean (lat, lon), or None for an empty list."""
    if not points:
        return None
    n = float(len(points))
    return (sum(p[0] for p in points) / n, sum(p[1] for p in points) / n)


def radial_errors(points):
    """(mean_lat, mean_lon, [distance in metres from the mean, per point]).

    The mean is the best estimate of the true position available without a
    surveyed benchmark, so these are errors relative to it — which measures
    scatter, not absolute accuracy. Absolute bias shows up as drift instead
    (see scatter_summary), and the two fail differently: for a robot returning
    to a bed it surveyed last week, a slow 3 m wander is far worse than 3 m of
    zero-mean jitter, and a CEP figure alone hides exactly that.
    """
    centre = mean_position(points)
    if centre is None:
        return None, None, []
    return centre[0], centre[1], [separation_m(centre, p) for p in points]


def _percentile(sorted_values, fraction):
    """Linear-interpolated percentile of an already-sorted list."""
    if not sorted_values:
        return None
    if len(sorted_values) == 1:
        return sorted_values[0]
    pos = fraction * (len(sorted_values) - 1)
    low = int(math.floor(pos))
    high = min(low + 1, len(sorted_values) - 1)
    return sorted_values[low] + (sorted_values[high] - sorted_values[low]) * (pos - low)


def cep(errors):
    """Circular error probable and friends, from radial errors in metres.

    cep50 is the radius containing half the fixes, cep95 the radius containing
    95% of them. cep95 is the honest headline: it is roughly the worst case an
    operator will actually meet, where cep50 is the number a datasheet quotes.
    """
    if not errors:
        return {"n": 0, "cep50": None, "cep95": None, "max": None,
                "drms": None, "two_drms": None, "mean": None}
    ordered = sorted(errors)
    n = len(ordered)
    mean = sum(ordered) / n
    rms = math.sqrt(sum(e * e for e in ordered) / n)
    return {
        "n": n,
        "cep50": _percentile(ordered, 0.50),
        "cep95": _percentile(ordered, 0.95),
        "max": ordered[-1],
        "drms": rms,
        "two_drms": 2.0 * rms,
        "mean": mean,
    }


def _window_mean(samples, lo, hi):
    """Mean position of samples whose `t` falls in [lo, hi)."""
    return mean_position([(s["lat"], s["lon"]) for s in samples
                          if lo <= s.get("t", 0.0) < hi])


def scatter_summary(samples, window_s=60.0):
    """Full accuracy picture for a stationary run.

    `samples` are dicts with lat, lon, t (seconds from the start of the run) and
    optionally acc_m. Returns the CEP figures plus the two numbers this whole
    exercise exists to produce:

    `ratio` — measured cep95 over the receiver's own mean claimed accuracy. A
    receiver reporting 1-sigma horizontally should land around 1.7-2.5. Much
    above that and its h_acc is optimistic, which matters concretely: the
    accuracy circle the map draws is that claim, so an uncalibrated circle would
    be a picture of a lie. Scale it by this ratio if it comes out high.

    `drift_m` — how far the mean moved between the first and last window. Kept
    separate from scatter on purpose; see radial_errors.
    """
    usable = [s for s in samples if s.get("lat") is not None and s.get("lon") is not None]
    lat, lon, errors = radial_errors([(s["lat"], s["lon"]) for s in usable])
    out = cep(errors)
    out["mean_lat"] = lat
    out["mean_lon"] = lon

    claimed = [s["acc_m"] for s in usable if s.get("acc_m") is not None]
    out["claimed_mean"] = sum(claimed) / len(claimed) if claimed else None
    out["ratio"] = (out["cep95"] / out["claimed_mean"]
                    if out["claimed_mean"] and out["cep95"] is not None else None)

    out["drift_m"] = None
    if usable:
        span = max(s.get("t", 0.0) for s in usable)
        if span >= 2 * window_s:
            first = _window_mean(usable, 0.0, window_s)
            last = _window_mean(usable, span - window_s, span + 1.0)
            if first and last:
                out["drift_m"] = separation_m(first, last)
    return out


class TTFFTracker:
    """Time to first fix, at every tier that matters.

    "Time to first fix" is ambiguous on its own — a receiver can report a 2D fix
    in 20 seconds that is 40 m out, and a fix you cannot navigate on is not the
    number the operator waiting at the ramp cares about. So this records the
    FIRST crossing of each tier separately: any fix, 3D, and each grade.

    Crossings are monotonic and never overwritten. A fix that reaches `good` and
    then degrades to `poor` and climbs back has one `good` time, the first one —
    otherwise a flapping receiver would keep resetting its own score.
    """

    TIERS = ("any", "3d", "poor", "fair", "good", "survey")

    def __init__(self):
        self.marks = {tier: None for tier in self.TIERS}

    def _mark(self, tier, t):
        if self.marks[tier] is None:
            self.marks[tier] = t

    def feed(self, t, fix_type, grade):
        """Record one sample at t seconds since the start of the scenario."""
        if fix_type is not None and fix_type >= 2:
            self._mark("any", t)
        if fix_type is not None and fix_type >= 3:
            self._mark("3d", t)
        rank = grade_rank(grade)
        # Back-fill: reaching `good` means it passed through fair and poor, even
        # if no sample happened to land on them. Without this a receiver that
        # jumped straight to a strong fix between two samples would report no
        # time-to-fair at all, which reads as "never got there".
        for tier in ("poor", "fair", "good", "survey"):
            if rank >= grade_rank(tier):
                self._mark(tier, t)

    def get(self, tier):
        return self.marks.get(tier)
