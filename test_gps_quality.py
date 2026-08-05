"""Tests for the GPS grading rubric and the accuracy maths.

Runs with no Pixhawk, no GPS and no sky: gps_quality is pure stdlib and does not
import drone_server, so there is no token to fake and nothing to mock.

Two things are being pinned here, and they fail in opposite directions:

  1. The rubric must not PROMOTE a fix it knows nothing about. Every threshold
     is tested from both sides, and every field is tested as None, because a
     missing satellite count silently reading as "good" would put a confident
     green badge on a fix nobody measured.

  2. The CEP maths must not FLATTER the receiver. It is checked against a
     distribution with a known answer (Rayleigh, from a seeded isotropic
     gaussian) rather than against itself, and the longitude scaling is checked
     at two latitudes — a cos(lat) term dropped from that conversion is the
     classic way this kind of code reports half the error it should.

    python3 test_gps_quality.py
"""
import math
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "server"))

import gps_quality as gq  # noqa: E402

FAILURES = []


def check(name, condition, detail=""):
    print(f"  [{'PASS' if condition else 'FAIL'}] {name}{'  — ' + detail if detail else ''}")
    if not condition:
        FAILURES.append(name)


def close(a, b, tol):
    return a is not None and b is not None and abs(a - b) <= tol


def test_grade_boundaries():
    """Every threshold from both sides. One tick past is a different grade."""
    print("\n=== Grade thresholds ===")
    g = gq.grade_fix

    check("3D at exactly the good thresholds is good",
          g(3, 8, 2.0, 5.0) == "good", g(3, 8, 2.0, 5.0))
    check("one satellite short drops to fair", g(3, 7, 2.0, 5.0) == "fair")
    check("HDOP one hundredth over drops to fair", g(3, 8, 2.01, 5.0) == "fair")
    check("a centimetre over the accuracy limit drops to fair",
          g(3, 8, 2.0, 5.01) == "fair")

    check("3D at exactly the survey thresholds is survey",
          g(3, 10, 1.2, 2.5) == "survey")
    check("one satellite short of survey is good", g(3, 9, 1.2, 2.5) == "good")

    check("3D at exactly the fair thresholds is fair", g(3, 6, 4.0, 10.0) == "fair")
    check("below AHRS_GPS_MINSATS is poor", g(3, 5, 1.0, 2.0) == "poor")
    check("HDOP past the fair limit is poor", g(3, 12, 4.01, 2.0) == "poor")

    check("no fix is none", g(1, 12, 0.8, 1.0) == "none")
    check("no GPS at all is none", g(0, None, None, None) == "none")
    check("fix_type None is none", g(None, 12, 0.8, 1.0) == "none")


def test_two_d_never_promotes():
    """A 2D fix is poor however good it looks.

    Its horizontal error is coupled to an assumed altitude, so a 2D fix
    reporting 12 satellites and 0.8 HDOP is not making a claim we can navigate
    on. Grading it `survey` because the numbers look pretty is exactly the
    failure this rubric exists to prevent.
    """
    print("\n=== 2D never grades above poor ===")
    check("2D with perfect sats/HDOP/accuracy is still poor",
          gq.grade_fix(2, 12, 0.7, 0.9) == "poor")
    check("the same numbers at 3D are survey",
          gq.grade_fix(3, 12, 0.7, 0.9) == "survey")


def test_differential_fixes_short_circuit():
    print("\n=== DGPS and RTK are survey on the fix type alone ===")
    check("DGPS with few satellites reported is survey", gq.grade_fix(4, 4, None, None) == "survey")
    check("RTK float is survey", gq.grade_fix(5, None, None, None) == "survey")
    check("RTK fixed is survey", gq.grade_fix(6, 4, 9.9, 99.0) == "survey")


def test_missing_data_never_promotes():
    """None is not a passing value. It is an absence, and absences grade down."""
    print("\n=== Missing fields never promote a grade ===")
    fair = gq.grade_rank("fair")
    check("unknown satellite count cannot reach good",
          gq.grade_rank(gq.grade_fix(3, None, 0.8, 1.0)) <= fair,
          gq.grade_fix(3, None, 0.8, 1.0))
    check("unknown HDOP cannot reach good",
          gq.grade_rank(gq.grade_fix(3, 12, None, 1.0)) <= fair,
          gq.grade_fix(3, 12, None, 1.0))
    check("unknown accuracy cannot reach good",
          gq.grade_rank(gq.grade_fix(3, 12, 0.8, None)) <= fair,
          gq.grade_fix(3, 12, 0.8, None))
    check("a 3D fix with nothing else known is poor, not none",
          gq.grade_fix(3, None, None, None) == "poor")


def test_grade_rank_ordering():
    print("\n=== Grade ranks are ordered and total ===")
    ranks = [gq.grade_rank(g) for g in gq.GRADES]
    check("GRADES is ordered worst to best", ranks == sorted(ranks), str(ranks))
    check("survey outranks good", gq.grade_rank("survey") > gq.grade_rank("good"))
    check("none is the floor", gq.grade_rank("none") == 0)
    check("an unrecognised grade ranks below none", gq.grade_rank("excellent") == -1)
    check("None ranks below none", gq.grade_rank(None) == -1)


def test_decode_accuracy():
    """Reported beats estimated, and the source is never silently lost."""
    print("\n=== Accuracy decode and its provenance ===")
    m, src = gq.decode_accuracy(2100, 90)
    check("h_acc in millimetres becomes metres", close(m, 2.1, 1e-9), str(m))
    check("a reported figure is labelled reported", src == "reported")

    m, src = gq.decode_accuracy(0, 90)
    check("h_acc of 0 falls back to HDOP", close(m, 0.9 * gq.UERE_M, 1e-9), str(m))
    check("the fallback is labelled estimated", src == "estimated")

    m, src = gq.decode_accuracy(None, 90)
    check("a missing h_acc field falls back to HDOP", close(m, 0.9 * gq.UERE_M, 1e-9))
    check("that fallback is labelled estimated too", src == "estimated")

    m, src = gq.decode_accuracy(0, 65535)
    check("unknown eph gives no accuracy at all", m is None and src is None,
          f"{m} {src}")
    m, src = gq.decode_accuracy(None, 0)
    check("eph of 0 is absence, not a perfect DOP", m is None and src is None)


def test_decode_hdop():
    print("\n=== HDOP decode ===")
    check("eph is hundredths", close(gq.decode_hdop(92), 0.92, 1e-9))
    check("UINT16_MAX is unknown", gq.decode_hdop(65535) is None)
    check("zero is unknown", gq.decode_hdop(0) is None)
    check("None is unknown", gq.decode_hdop(None) is None)


def test_metres_per_degree():
    """The cos(lat) term in longitude is where this silently breaks.

    A flat 111_320 m/degree in both axes reports an east-west scatter at 60N as
    twice its real size, which would make a bad fix look like a good one.
    """
    print("\n=== Degree-to-metre conversion at two latitudes ===")
    for lat in (37.8, 60.0):
        m_lat, m_lon = gq.metres_per_degree(lat)
        north = (lat + 10.0 / m_lat, -122.0)
        east = (lat, -122.0 + 10.0 / m_lon)
        check(f"10 m north at {lat}N measures 10 m",
              close(gq.separation_m((lat, -122.0), north), 10.0, 0.01),
              f"{gq.separation_m((lat, -122.0), north):.4f} m")
        check(f"10 m east at {lat}N measures 10 m",
              close(gq.separation_m((lat, -122.0), east), 10.0, 0.01),
              f"{gq.separation_m((lat, -122.0), east):.4f} m")

    check("a degree of longitude at 60N is about half one at the equator",
          close(gq.metres_per_degree(60.0)[1] / gq.metres_per_degree(0.0)[1], 0.5, 0.01))
    check("zero separation is zero", gq.separation_m((37.8, -122.0), (37.8, -122.0)) == 0.0)


def test_cep_against_a_known_distribution():
    """Checked against Rayleigh, not against itself.

    For an isotropic 2D gaussian with per-axis sigma, the radial error is
    Rayleigh distributed and the answers are closed-form: CEP50 = 1.1774 sigma,
    CEP95 = 2.4477 sigma, DRMS = 1.4142 sigma. If the percentile interpolation
    or the RMS is wrong, these miss.
    """
    print("\n=== CEP against a seeded gaussian cloud ===")
    sigma = 1.7
    rng = random.Random(1)
    errors = [math.hypot(rng.gauss(0.0, sigma), rng.gauss(0.0, sigma))
              for _ in range(20000)]
    out = gq.cep(errors)

    check("sample count is carried through", out["n"] == 20000)
    check("CEP50 matches 1.1774 sigma within 3%",
          close(out["cep50"], 1.1774 * sigma, 0.03 * 1.1774 * sigma),
          f"{out['cep50']:.3f} vs {1.1774 * sigma:.3f}")
    check("CEP95 matches 2.4477 sigma within 3%",
          close(out["cep95"], 2.4477 * sigma, 0.03 * 2.4477 * sigma),
          f"{out['cep95']:.3f} vs {2.4477 * sigma:.3f}")
    check("DRMS matches sqrt(2) sigma within 3%",
          close(out["drms"], math.sqrt(2) * sigma, 0.03 * math.sqrt(2) * sigma),
          f"{out['drms']:.3f} vs {math.sqrt(2) * sigma:.3f}")
    check("2DRMS is twice DRMS", close(out["two_drms"], 2 * out["drms"], 1e-9))
    check("CEP95 is at least CEP50", out["cep95"] >= out["cep50"])
    check("max is at least CEP95", out["max"] >= out["cep95"])


def test_cep_degenerate_inputs():
    """The zero-variance and single-sample cases, where percentiles divide."""
    print("\n=== CEP degenerate inputs ===")
    out = gq.cep([])
    check("empty input reports n=0 and no figures",
          out["n"] == 0 and out["cep50"] is None and out["drms"] is None)

    out = gq.cep([0.0] * 50)
    check("identical points give zero scatter, not a divide by zero",
          out["cep50"] == 0.0 and out["cep95"] == 0.0 and out["drms"] == 0.0)

    out = gq.cep([2.5])
    check("a single sample does not crash", out["n"] == 1)
    check("a single sample's percentiles are that sample",
          out["cep50"] == 2.5 and out["cep95"] == 2.5)


def test_radial_errors():
    print("\n=== Radial errors are measured from the mean ===")
    lat, lon, errs = gq.radial_errors([])
    check("empty input gives no centre and no errors",
          lat is None and lon is None and errs == [])

    m_lat, _ = gq.metres_per_degree(37.8)
    d = 10.0 / m_lat  # two points 10 m apart, north-south
    lat, lon, errs = gq.radial_errors([(37.8, -122.0), (37.8 + d, -122.0)])
    check("the centre is the midpoint", close(lat, 37.8 + d / 2, 1e-12))
    check("each point is half the separation from the mean",
          close(errs[0], 5.0, 0.01) and close(errs[1], 5.0, 0.01),
          f"{errs[0]:.4f}, {errs[1]:.4f}")

    # Not == 0.0: the mean of ten identical floats is not bit-exact, which
    # leaves a residual around a nanometre. Anything above a millimetre here
    # would be a real bug in the conversion.
    lat, lon, errs = gq.radial_errors([(37.8, -122.0)] * 10)
    check("a stationary cloud has no measurable radial error", max(errs) < 1e-3,
          f"max={max(errs):.3e} m")


def test_scatter_summary():
    """The claimed-vs-measured ratio and the drift figure.

    These are the two numbers the survey exists to produce, so they are built
    here from a cloud whose answer is known by construction.
    """
    print("\n=== Scatter summary: claimed vs measured, and drift ===")
    sigma = 2.0
    rng = random.Random(7)
    m_lat, m_lon = gq.metres_per_degree(37.8)
    samples = []
    for i in range(4000):
        t = i * 0.2  # 5 Hz, 800 s — long enough for the drift windows
        samples.append({
            "t": t,
            "lat": 37.8 + rng.gauss(0.0, sigma) / m_lat,
            "lon": -122.0 + rng.gauss(0.0, sigma) / m_lon,
            "acc_m": sigma,
        })
    out = gq.scatter_summary(samples)

    check("mean position lands on the true centre",
          close(out["mean_lat"], 37.8, 1e-5) and close(out["mean_lon"], -122.0, 1e-5),
          f"{out['mean_lat']:.7f}, {out['mean_lon']:.7f}")
    check("CEP95 is about 2.4477 sigma",
          close(out["cep95"], 2.4477 * sigma, 0.06 * 2.4477 * sigma),
          f"{out['cep95']:.3f}")
    check("claimed accuracy is averaged", close(out["claimed_mean"], sigma, 1e-9))
    check("a receiver reporting true 1-sigma lands in the healthy 1.7-2.5 band",
          1.7 <= out["ratio"] <= 2.5, f"ratio={out['ratio']:.3f}")
    check("a stationary cloud has near-zero drift", out["drift_m"] < 0.5,
          f"drift={out['drift_m']:.3f} m")

    # An optimistic receiver: same scatter, half the claimed accuracy. This is
    # the case that means the map's accuracy circle would be drawing a lie.
    for s in samples:
        s["acc_m"] = sigma / 2.0
    check("halving the claim doubles the ratio",
          gq.scatter_summary(samples)["ratio"] > 4.0,
          f"ratio={gq.scatter_summary(samples)['ratio']:.3f}")


def test_scatter_summary_detects_drift():
    """A slow wander with tight scatter — the failure CEP alone cannot see."""
    print("\n=== Drift is detected separately from scatter ===")
    m_lat, _ = gq.metres_per_degree(37.8)
    samples = [{"t": i * 0.2, "lat": 37.8 + (i * 0.2) * (5.0 / 800.0) / m_lat,
                "lon": -122.0, "acc_m": 1.0}
               for i in range(4000)]  # 5 m of pure drift over 800 s, no jitter
    out = gq.scatter_summary(samples)
    check("5 m of drift over the run is reported",
          close(out["drift_m"], 5.0 - 5.0 * (60.0 / 800.0), 0.3),
          f"drift={out['drift_m']:.3f} m")
    check("a short run reports no drift rather than a guess",
          gq.scatter_summary(samples[:100])["drift_m"] is None)


def test_ttff_tracker():
    print("\n=== Time to first fix, per tier ===")
    t = gq.TTFFTracker()
    check("nothing is marked before any sample", all(v is None for v in t.marks.values()))

    t.feed(10.0, 1, "none")
    check("a no-fix sample marks nothing", t.get("any") is None)

    t.feed(20.0, 2, "poor")
    check("a 2D fix marks any-fix", t.get("any") == 20.0)
    check("a 2D fix does not mark 3D", t.get("3d") is None)
    check("a 2D fix marks poor", t.get("poor") == 20.0)

    t.feed(30.0, 3, "good")
    check("3D is marked when it arrives", t.get("3d") == 30.0)
    check("reaching good back-fills fair", t.get("fair") == 30.0)
    check("good is marked", t.get("good") == 30.0)
    check("survey is not marked", t.get("survey") is None)
    check("the earlier poor crossing is not overwritten", t.get("poor") == 20.0)

    t.feed(40.0, 3, "poor")
    t.feed(50.0, 3, "good")
    check("a drop and re-climb keeps the FIRST good time", t.get("good") == 30.0,
          f"good={t.get('good')}")
    check("any-fix still reports its first crossing", t.get("any") == 20.0)


def test_describe_grade():
    """Operator-facing text. No abbreviations, and it always says something."""
    print("\n=== Plain-language descriptions ===")
    for grade in gq.GRADES:
        text = gq.describe_grade(grade, 2.1)
        check(f"{grade} has a description", bool(text) and text.endswith("."), text)
    check("no fix reports the satellite count when it has one",
          "3 satellites" in gq.describe_grade("none", None, sats=3))
    check("no fix without satellites still says something",
          gq.describe_grade("none", None) == "No GPS fix.")
    check("an unknown accuracy is not printed as a number",
          "unknown accuracy" in gq.describe_grade("good", None))


def test_fix_names():
    print("\n=== Fix type labels ===")
    check("3 is 3D", gq.fix_name(3) == "3D")
    check("6 is RTK fixed", gq.fix_name(6) == "RTK FIXED")
    check("an unknown fix type is labelled, not dropped", gq.fix_name(42) == "FIX 42")
    check("None gets a dash", gq.fix_name(None) == "—")


if __name__ == "__main__":
    test_grade_boundaries()
    test_two_d_never_promotes()
    test_differential_fixes_short_circuit()
    test_missing_data_never_promotes()
    test_grade_rank_ordering()
    test_decode_accuracy()
    test_decode_hdop()
    test_metres_per_degree()
    test_cep_against_a_known_distribution()
    test_cep_degenerate_inputs()
    test_radial_errors()
    test_scatter_summary()
    test_scatter_summary_detects_drift()
    test_ttff_tracker()
    test_describe_grade()
    test_fix_names()

    print()
    if FAILURES:
        raise SystemExit(f"FAILED: {', '.join(FAILURES)}")
    print("All GPS quality checks passed.")
