"""Sun disc fraction and Earth visibility against a horizon mask.

Sun: the disc (angular radius r, from distance) is cut into N vertical strips
in azimuth. In strip k at azimuth offset x the disc spans elevations
e +/- sqrt(r^2 - x^2); the part above the local mask elevation m(az + x/cos e)
is visible. Fraction = visible area / disc area. Same algorithm runs in the
browser (web/js/science.js) so HUD values match the precomputed series.

Earth: "in view" when its centre is above the mask (documented
simplification; a partly hidden Earth may still allow a link).
"""
from __future__ import annotations

import numpy as np

from .horizon import mask_lookup

N_STRIPS = 64

# Power status thresholds on the visible solar disc fraction.
FULL = 0.999      # >= -> "generating" (essentially the whole disc)
# 0 < f < FULL    -> "partial"
# f == 0          -> "dark"


def sun_fraction(az_deg, el_deg, radius_deg, mask_az, mask_el, n=N_STRIPS):
    az = np.asarray(az_deg, dtype=np.float64)[..., None]
    el = np.asarray(el_deg, dtype=np.float64)[..., None]
    r = np.asarray(radius_deg, dtype=np.float64)[..., None]
    # strip centres in units of r, equal widths across [-1, 1]
    xs = (np.arange(n) + 0.5) / n * 2.0 - 1.0
    x = xs * r
    half = np.sqrt(np.maximum(r * r - x * x, 0.0))
    cos_el = np.maximum(np.cos(np.radians(el)), 1e-6)
    m = mask_lookup(mask_az, mask_el, az + x / cos_el)
    lo = el - half
    hi = el + half
    vis = np.clip(hi - np.maximum(lo, m), 0.0, None)
    vis = np.minimum(vis, hi - lo)
    frac = vis.sum(axis=-1) / np.maximum((hi - lo).sum(axis=-1), 1e-12)
    # strips-by-midpoint underestimates total disc area slightly; normalising
    # by the same strip sum makes an unobstructed disc exactly 1.0
    return frac


def earth_visible(az_deg, el_deg, mask_az, mask_el):
    return np.asarray(el_deg) > mask_lookup(mask_az, mask_el, az_deg)


def sun_state(frac):
    """0 = dark, 1 = partial, 2 = generating."""
    f = np.asarray(frac)
    return np.where(f >= FULL, 2, np.where(f > 0.0, 1, 0)).astype(np.uint8)


def runs(mask_bool: np.ndarray):
    """(start_idx, length) of runs of True."""
    m = np.concatenate([[False], np.asarray(mask_bool, bool), [False]])
    d = np.diff(m.astype(np.int8))
    starts = np.where(d == 1)[0]
    ends = np.where(d == -1)[0]
    return starts, ends - starts
