"""Search for the best-lit DEM pixel near a site that satisfies a slope limit.

The Data Book coordinates are centres of study-region polygons, not landing
points; at 80 m/px some fall on steep walls. This search answers "how much
better is it a few hundred metres away?" Settings (radius, slope limit) are
our assumptions, labelled as such in the app:
  * SLOPE_LIMIT_DEG = 10: the Data Book uses "slope under 10 degrees" to define
    a level traverse (Fig. 7.3.2.7-1); it is NOT a stated landing requirement.
  * RADIUS_M = 500.
"""
from __future__ import annotations

import numpy as np

from . import ephem, horizon, visibility
from .dem import Dem

RADIUS_M = 500.0
SLOPE_LIMIT_DEG = 10.0


def slope_deg(dem: Dem, line: int, sample: int) -> float:
    """Horn (1981) 3x3 slope on the DEM grid (map scale, metres)."""
    z = dem.dn[line - 1:line + 2, sample - 1:sample + 2].astype(np.float64) * dem.scaling
    s = dem.scale_m
    dzdx = ((z[0, 2] + 2 * z[1, 2] + z[2, 2]) - (z[0, 0] + 2 * z[1, 0] + z[2, 0])) / (8 * s)
    dzdy = ((z[2, 0] + 2 * z[2, 1] + z[2, 2]) - (z[0, 0] + 2 * z[0, 1] + z[0, 2])) / (8 * s)
    return float(np.degrees(np.arctan(np.hypot(dzdx, dzdy))))


def pixel_to_latlon(dem: Dem, line: float, sample: float):
    X = (sample - dem.sample_off) * dem.scale_m
    Y = (dem.line_off - line) * dem.scale_m
    r = np.hypot(X, Y)
    lon = np.degrees(np.arctan2(X, Y))
    lat = -90.0 + np.degrees(2 * np.arctan(0.5 * r / dem.radius_m))
    return float(lat), float(lon)


def find_best(dem: Dem, lat: float, lon: float, unix: np.ndarray,
              obs_h: float = 2.0, radius_m: float = RADIUS_M,
              slope_limit: float = SLOPE_LIMIT_DEG, log=print):
    l0, s0 = (float(v) for v in dem.latlon_to_pixel(lat, lon))
    rp = int(np.ceil(radius_m / dem.scale_m))
    u6 = unix[::6]
    cands = []
    for L in range(int(round(l0)) - rp, int(round(l0)) + rp + 1):
        for S in range(int(round(s0)) - rp, int(round(s0)) + rp + 1):
            off = np.hypot(L - l0, S - s0) * dem.scale_m
            if off > radius_m:
                continue
            sl = slope_deg(dem, L, S)
            if sl > slope_limit:
                continue
            cands.append((L, S, off, sl))
    if not cands:
        return None
    log(f"    {len(cands)} candidate pixels within {radius_m:.0f} m with slope <= {slope_limit} deg")
    best = None
    for L, S, off, sl in cands:
        la, lo = pixel_to_latlon(dem, L, S)
        hg = float(dem.height_at_latlon(la, lo))
        m = horizon.compute_mask(dem.height_at_unit, la, lo, hg, obs_above_ground_m=obs_h,
                                 az_step_deg=1.0, step_m=80.0)
        e = ephem.sun_earth_altaz(la, lo, hg + obs_h, u6)
        s_az, s_el, s_d = e["sun"]
        f = visibility.sun_fraction(s_az, s_el, ephem.angular_radius_deg(s_d, 695700.0),
                                    m.az_deg, m.el_deg, n=16)
        ev = visibility.earth_visible(*e["earth"][:2], m.az_deg, m.el_deg)
        score = ((f > 0).mean(), ((f > 0) & ev).mean())
        if best is None or score > best["score"]:
            best = {"lat": la, "lon": lo, "offset_m": off, "slope_deg": sl, "score": score,
                    "line": L, "sample": S}
    return best
