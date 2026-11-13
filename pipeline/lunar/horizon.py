"""Horizon mask: maximum terrain elevation angle per azimuth.

For each azimuth we march along the great circle leaving the observer in that
direction, sample the DEM bilinearly every `step_m` of ground distance, and
take the maximum elevation angle of the terrain surface seen from the observer
(DEM height + observer height). Curvature is exact for a spherical Moon:
a point at angular distance theta and radius r has elevation
atan2(r cos(theta) - r_obs, r sin(theta)).

The height source is a callable taking unit vectors (ux, uy, uz) so the
algorithm can be tested on synthetic terrain with a known answer.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np

from . import config
from .geometry import enu_basis, elevation_angle, great_circle_points

HeightFn = Callable[[np.ndarray, np.ndarray, np.ndarray], np.ndarray]


@dataclass
class HorizonMask:
    az_deg: np.ndarray        # bin centres, clockwise from north
    el_deg: np.ndarray        # max terrain elevation angle
    dist_m: np.ndarray        # ground distance of the defining point
    range_m: np.ndarray       # how far each ray was actually marched
    obs_height_m: float       # observer height above reference sphere


def compute_mask(height_fn: HeightFn, lat: float, lon: float,
                 ground_h_m: float,
                 obs_above_ground_m: float = config.OBSERVER_HEIGHT_M,
                 az_step_deg: float = config.MASK_AZ_STEP_DEG,
                 step_m: float = config.MASK_RAY_STEP_M,
                 max_range_m: float = config.MASK_MAX_RANGE_M,
                 radius_m: float = config.MOON_RADIUS_M,
                 min_range_m: float | None = None,
                 chunk: int = 32) -> HorizonMask:
    east, north, up = enu_basis(lat, lon)
    r_obs = radius_m + ground_h_m + obs_above_ground_m
    az = np.arange(0.0, 360.0, az_step_deg)
    s = np.arange(min_range_m or step_m, max_range_m + step_m / 2, step_m)
    theta = s / radius_m

    el_out = np.full(az.size, -np.inf)
    d_out = np.zeros(az.size)
    rng_out = np.zeros(az.size)
    for i0 in range(0, az.size, chunk):
        a = np.radians(az[i0:i0 + chunk])
        tang = np.cos(a)[:, None] * north + np.sin(a)[:, None] * east     # (A,3)
        ux, uy, uz = great_circle_points(up[None, None, :], tang[:, None, :],
                                         np.broadcast_to(theta, (a.size, theta.size)))
        h = height_fn(ux, uy, uz)                                          # (A,S)
        valid = np.isfinite(h)
        # stop each ray at the first sample outside the data
        first_bad = np.where(valid.all(axis=1), s.size, np.argmin(valid, axis=1))
        el = elevation_angle(radius_m + np.nan_to_num(h, nan=-1e9), theta[None, :], r_obs)
        idx = np.arange(s.size)[None, :]
        el = np.where(idx < first_bad[:, None], el, -np.inf)
        k = np.argmax(el, axis=1)
        el_out[i0:i0 + chunk] = el[np.arange(a.size), k]
        d_out[i0:i0 + chunk] = s[k]
        rng_out[i0:i0 + chunk] = np.where(first_bad > 0, s[np.maximum(first_bad - 1, 0)], 0.0)

    # The geometric horizon of a bare sphere is below 0 deg; terrain normally
    # exceeds it within a few km so -inf never survives on real data.
    return HorizonMask(az, np.degrees(el_out), d_out, rng_out, r_obs - radius_m)


def mask_lookup(mask_az_deg: np.ndarray, mask_el_deg: np.ndarray, az_deg):
    """Linear interpolation of a periodic mask at arbitrary azimuths."""
    step = mask_az_deg[1] - mask_az_deg[0]
    x = (np.asarray(az_deg) % 360.0) / step
    i0 = np.floor(x).astype(int) % mask_el_deg.size
    i1 = (i0 + 1) % mask_el_deg.size
    f = x - np.floor(x)
    return mask_el_deg[i0] * (1 - f) + mask_el_deg[i1] * f
