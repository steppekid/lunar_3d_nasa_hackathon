"""Local frame geometry on a spherical Moon (radius R, MOON_ME frame)."""
from __future__ import annotations

import numpy as np


def enu_basis(lat_deg: float, lon_deg: float):
    """Unit vectors (east, north, up) in MOON_ME at a site."""
    lat, lon = np.radians(lat_deg), np.radians(lon_deg)
    up = np.array([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)])
    east = np.array([-np.sin(lon), np.cos(lon), 0.0])
    north = np.cross(up, east)
    return east, north, up


def great_circle_points(up, tangent, theta):
    """Unit vectors at angular distance theta (rad) along `tangent` from `up`.

    up, tangent: (3,) or (..., 3); theta broadcastable. Returns ux, uy, uz.
    """
    c, s = np.cos(theta), np.sin(theta)
    u = c[..., None] * up + s[..., None] * tangent
    return u[..., 0], u[..., 1], u[..., 2]


def elevation_angle(r_target, theta, r_obs):
    """Elevation (rad) of a point at radius r_target, angular distance theta
    from the observer at radius r_obs, measured from the observer's local
    horizontal plane (plane perpendicular to the radial direction).
    Exact on a sphere: includes the curvature drop."""
    return np.arctan2(r_target * np.cos(theta) - r_obs, r_target * np.sin(theta))
