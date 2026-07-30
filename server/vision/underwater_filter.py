"""
Underwater image enhancement — detector preprocessing only.

Water absorbs long (red) wavelengths first and scatters light, so raw
underwater frames come out blue-green shifted, hazy and low-contrast. This
module corrects that just enough to help the object detector; it is applied
per-frame *inside* the detector process, before inference. It is deliberately
NOT inserted into the GStreamer pipeline the operator watches, so the live video
path keeps its low latency — camera_stream.py has its own much cheaper
gamma/contrast boost for the human-visible feed (see CAM_UNDERWATER there).

Algorithm (classical, CPU-cheap — a few ms for a 320x320 frame, negligible
next to ~100-300 ms of YOLOX inference on the Pi 5 CPU):

    1. Shades-of-Gray white balance — rescale each BGR channel so their
       Minkowski-norm means match, cancelling the water-column colour cast.
    2. Dehaze (underwater dark channel prior) — estimates how much of each
       pixel is veiling backscatter rather than subject, and subtracts it.
       This is the step that cuts through murk; white balance alone does not.
    3. CLAHE on the L channel in LAB space — contrast-limited adaptive
       histogram equalisation lifts local contrast without touching colour
       (a/b channels untouched) and without over-amplifying noise.
    4. Unsharp mask — restores the edge definition that scattering softens.
       Small objects are what the detector struggles with most, and they are
       exactly what blur erases.

Every stage is tunable by env var and every stage can be switched off (see the
UW_* table below), because the right settings depend on the water: clear open
water wants little dehazing, a silty bay wants a lot.

Tuning workflow — run this file directly on a still from the dive and eyeball a
before/after strip, rather than guessing at settings mid-mission:

    python3 server/vision/underwater_filter.py frame.jpg -o compare.png
    UW_DEHAZE_STRENGTH=0.95 python3 server/vision/underwater_filter.py frame.jpg

Environment variables (all optional):
    UW_WB_NORM          Shades-of-Gray Minkowski norm     default: 6
                        1 = classic gray-world, 0 = skip white balance.
                        Higher weights bright pixels more, which is more robust
                        when one colour dominates the scene — and underwater one
                        always does, so plain gray-world (p=1) tends to
                        over-correct into a red cast.
    UW_DEHAZE           Apply dark-channel dehazing        default: 1
    UW_DEHAZE_STRENGTH  How much haze to remove, 0-1       default: 0.85
                        Toward 1 = more aggressive; too high crushes distant
                        detail into noise in genuinely turbid water.
    UW_DEHAZE_PATCH     Dark-channel patch size (px)       default: 15
    UW_CLAHE_CLIP       CLAHE clip limit, 0 = skip         default: 2.0
    UW_SHARPEN          Unsharp amount, 0 = skip           default: 0.6

Future option (deferred, not used here): a learned enhancer such as FUnIE-GAN
(https://github.com/xahidbuffon/FUnIE-GAN, MIT) gives higher perceptual quality
but a full conv-net forward pass per frame is far too heavy for the Pi 5 CPU,
which has no GPU/NPU to spare next to the detector. Swap it in behind `apply()`
only if an accelerator (Coral/Hailo) is added later.

License: implemented with OpenCV (Apache-2.0, >=4.5) + NumPy (BSD-3) only —
permissive, safe to ship in a closed product.
"""

import os
import sys

import cv2
import numpy as np


def _env_num(name, default, cast):
    """Read a numeric tuning knob, falling back to the default if it is junk.

    Unlike detector.py's near-identical helper this never exits. A malformed
    tuning value should cost you the tuning, not the dive — the detector is
    still useful on unenhanced frames, and this module runs inside its hot loop
    where there is nobody left to catch a raised exception.
    """
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return cast(raw)
    except (TypeError, ValueError):
        print(f"underwater_filter: {name}={raw!r} is not a number — using {default}",
              file=sys.stderr)
        return default


WB_NORM = _env_num("UW_WB_NORM", 6.0, float)
DEHAZE = os.environ.get("UW_DEHAZE", "1") not in ("0", "false", "False", "")
DEHAZE_STRENGTH = _env_num("UW_DEHAZE_STRENGTH", 0.85, float)
DEHAZE_PATCH = _env_num("UW_DEHAZE_PATCH", 15, int)
CLAHE_CLIP = _env_num("UW_CLAHE_CLIP", 2.0, float)
SHARPEN = _env_num("UW_SHARPEN", 0.6, float)

# Transmission floor. Where the estimated transmission goes to zero the dehaze
# division blows up, turning the haziest regions — the whole background, in bad
# water — into saturated noise. Clamping here is what keeps that bounded.
_T_MIN = 0.1


def white_balance(img, norm=None):
    """Correct the blue-green underwater colour cast (Shades-of-Gray).

    Generalises gray-world: instead of matching the channels' plain means it
    matches their Minkowski p-norms, so bright pixels — the ones carrying real
    surface colour rather than water column — dominate the estimate. p=1 is
    exactly gray-world; p=6 is the usual robust choice and what we default to.
    """
    p = WB_NORM if norm is None else norm
    if p <= 0:
        return img

    f = img.astype(np.float32)
    # Per-channel Minkowski mean: (mean(c**p))**(1/p).
    means = np.array([np.mean(np.power(f[:, :, c], p)) ** (1.0 / p)
                      for c in range(3)], dtype=np.float32)
    # Guard against an all-black channel (mean 0) which would divide by zero.
    means = np.maximum(means, 1e-6)
    gains = means.mean() / means
    return np.clip(f * gains, 0, 255).astype(np.uint8)


def _dark_channel(f, patch):
    """Per-pixel minimum over a local patch, using only the blue/green channels.

    The standard (atmospheric) dark channel prior mins over all three channels.
    Underwater the red channel is already near-zero everywhere from absorption,
    not from haze, so including it makes every pixel look maximally hazy and the
    transmission estimate collapses. Dropping red is the "underwater DCP"
    variant, and it is the difference between this working and not.

    Args:
        f: HxWx3 float32 BGR in 0-1.
    """
    gb = np.minimum(f[:, :, 0], f[:, :, 1])
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (patch, patch))
    return cv2.erode(gb, kernel)


def dehaze(img, strength=None, patch=None):
    """Subtract the veiling backscatter that makes murky water look like fog.

    Estimates the water's background light from the haziest pixels, infers a
    per-pixel transmission (how much of this pixel actually came from the
    subject), and inverts the haze model I = J*t + A*(1-t) for J.
    """
    omega = DEHAZE_STRENGTH if strength is None else strength
    k = max(3, int(DEHAZE_PATCH if patch is None else patch))
    if omega <= 0:
        return img

    f = img.astype(np.float32) / 255.0
    dark = _dark_channel(f, k)

    # Background light A: average the brightest 0.1% of the dark channel — those
    # are the pixels that are almost pure water column. Taking a small set
    # rather than the single brightest pixel keeps one specular glint or dead
    # white pixel from setting A for the whole frame.
    flat = dark.ravel()
    n = max(1, int(flat.size * 0.001))
    brightest = np.argpartition(flat, -n)[-n:]
    A = np.maximum(f.reshape(-1, 3)[brightest].mean(axis=0), 1e-3)

    # Transmission from the dark channel of the A-normalised image. omega < 1
    # leaves a little haze in deliberately — removing all of it looks unnatural
    # and strips the depth cue the operator uses to judge distance.
    t = 1.0 - omega * _dark_channel(f / A, k)
    # Box-blur the transmission map so it follows soft depth gradients instead
    # of the erode's blocky patch edges, which otherwise print as halos around
    # every object. The textbook fix is a guided filter, but cv2.ximgproc is not
    # in the stock OpenCV wheel and this is most of the benefit for none of the
    # dependency.
    t = cv2.blur(t, (k, k))
    t = np.clip(t, _T_MIN, 1.0)[:, :, None]

    out = (f - A) / t + A
    return np.clip(out * 255.0, 0, 255).astype(np.uint8)


def clahe_lab(img, clip_limit=None, tile_grid_size=(8, 8)):
    """Contrast-limited adaptive histogram equalisation on the L channel only.

    Operating in LAB and touching only lightness (L) boosts contrast in hazy
    water without distorting colour. The clip limit caps histogram bins so noise
    in dark regions is not blown up.
    """
    clip = CLAHE_CLIP if clip_limit is None else clip_limit
    if clip <= 0:
        return img

    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=clip, tileGridSize=tile_grid_size)
    l = clahe.apply(l)
    return cv2.cvtColor(cv2.merge([l, a, b]), cv2.COLOR_LAB2BGR)


def unsharp_mask(img, amount=None, sigma=1.0):
    """Re-crisp edges that scattering softened, by subtracting a blurred copy."""
    a = SHARPEN if amount is None else amount
    if a <= 0:
        return img
    blurred = cv2.GaussianBlur(img, (0, 0), sigma)
    return cv2.addWeighted(img, 1.0 + a, blurred, -a, 0)


def apply(img):
    """Full underwater preprocessing pipeline.

    White balance, then dehaze, then local contrast, then sharpen. The order is
    load-bearing: dehazing reads colour statistics, so it wants the cast already
    removed, and sharpening must come last or CLAHE amplifies its ringing.

    Args:
        img: BGR uint8 image (OpenCV convention).
    Returns:
        Enhanced BGR uint8 image, same shape.
    """
    out = white_balance(img)
    if DEHAZE:
        out = dehaze(out)
    out = clahe_lab(out)
    return unsharp_mask(out)


def _main(argv):
    """Tuning aid: enhance one image and show it beside the original."""
    args = [a for a in argv if not a.startswith("-")]
    if not args:
        print(__doc__.strip().split("\n\n")[0], file=sys.stderr)
        print("\nusage: underwater_filter.py IMAGE [-o OUT.png]", file=sys.stderr)
        return 2

    src = cv2.imread(args[0])
    if src is None:
        print(f"underwater_filter: could not read {args[0]}", file=sys.stderr)
        return 1

    out_path = argv[argv.index("-o") + 1] if "-o" in argv else None
    enhanced = apply(src)
    strip = np.hstack([src, enhanced])

    print(f"wb_norm={WB_NORM:g} dehaze={'on' if DEHAZE else 'off'}"
          f"({DEHAZE_STRENGTH:g}/{DEHAZE_PATCH}) clahe={CLAHE_CLIP:g} "
          f"sharpen={SHARPEN:g}", file=sys.stderr)

    if out_path:
        cv2.imwrite(out_path, strip)
        print(f"wrote {out_path} (original | enhanced)", file=sys.stderr)
        return 0

    # No output file asked for: show it, but a headless Pi has no display and
    # imshow would just abort, so fall back to writing next to the input.
    try:
        cv2.imshow("original | enhanced", strip)
        cv2.waitKey(0)
    except cv2.error:
        fallback = os.path.splitext(args[0])[0] + "_compare.png"
        cv2.imwrite(fallback, strip)
        print(f"no display — wrote {fallback} (original | enhanced)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
