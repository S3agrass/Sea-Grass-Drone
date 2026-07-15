"""
Underwater image enhancement — detector preprocessing only.

Water absorbs long (red) wavelengths first and scatters light, so raw
underwater frames come out blue-green shifted and hazy. This module corrects
that just enough to help the object detector; it is applied per-frame *inside*
the detector process, before inference. It is deliberately NOT inserted into
the GStreamer pipeline the operator watches, so the live video path keeps its
low latency.

Algorithm (classical, CPU-cheap — ~1-3 ms for a 320x320 frame, negligible
next to ~100-300 ms of YOLOX inference on the Pi 5 CPU):

    1. Gray-world white balance — rescale each BGR channel so their means match,
       cancelling the water-column colour cast.
    2. CLAHE on the L channel in LAB space — contrast-limited adaptive histogram
       equalisation lifts contrast in murky/hazy water without touching colour
       (a/b channels untouched) and without over-amplifying noise.

Future option (deferred, not used here): a learned enhancer such as FUnIE-GAN
(https://github.com/xahidbuffon/FUnIE-GAN, MIT) gives higher perceptual quality
but a full conv-net forward pass per frame is far too heavy for the Pi 5 CPU,
which has no GPU/NPU to spare next to the detector. Swap it in behind `apply()`
only if an accelerator (Coral/Hailo) is added later.

License: implemented with OpenCV (Apache-2.0, >=4.5) + NumPy (BSD-3) only —
permissive, safe to ship in a closed product.
"""

import cv2
import numpy as np


def gray_world_white_balance(img):
    """Correct the blue-green underwater colour cast.

    Assumes the average of a scene is gray, so scales each channel so its mean
    matches the overall gray-world mean. This lifts the attenuated red channel
    back up relative to blue/green.
    """
    b, g, r = cv2.split(img.astype(np.float32))
    avg_b, avg_g, avg_r = b.mean(), g.mean(), r.mean()
    avg_gray = (avg_b + avg_g + avg_r) / 3.0

    # Guard against an all-black channel (mean 0) which would divide by zero.
    eps = 1e-6
    b = np.clip(b * (avg_gray / (avg_b + eps)), 0, 255)
    g = np.clip(g * (avg_gray / (avg_g + eps)), 0, 255)
    r = np.clip(r * (avg_gray / (avg_r + eps)), 0, 255)
    return cv2.merge([b, g, r]).astype(np.uint8)


def clahe_lab(img, clip_limit=2.0, tile_grid_size=(8, 8)):
    """Contrast-limited adaptive histogram equalisation on the L channel only.

    Operating in LAB and touching only lightness (L) boosts contrast in hazy
    water without distorting colour. The clip limit caps histogram bins so noise
    in dark regions is not blown up.
    """
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=clip_limit, tileGridSize=tile_grid_size)
    l = clahe.apply(l)
    return cv2.cvtColor(cv2.merge([l, a, b]), cv2.COLOR_LAB2BGR)


def apply(img):
    """Full underwater preprocessing pipeline: white balance then contrast.

    Args:
        img: BGR uint8 image (OpenCV convention).
    Returns:
        Enhanced BGR uint8 image, same shape.
    """
    return clahe_lab(gray_world_white_balance(img))
