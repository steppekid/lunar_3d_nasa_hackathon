"""Terrain grids in the observer's local East-North-Up frame.

Each grid node (E, N) is a point on the curved surface whose horizontal offset
from the observer is exactly (E, N); its U coordinate is the true height above
the observer's horizontal plane, so curvature is built in and the frontend can
draw vertices directly at (E, U, N) without any further projection.
"""
from __future__ import annotations

import numpy as np

from . import config
from .dem import Dem
from .geometry import enu_basis

NODATA = -32768


def block_mean(dn: np.ndarray, f: int) -> np.ndarray:
    n0 = (dn.shape[0] // f) * f
    n1 = (dn.shape[1] // f) * f
    return dn[:n0, :n1].reshape(n0 // f, f, n1 // f, f).astype(np.float32).mean(axis=(1, 3))


class CoarseDem(Dem):
    """A block-averaged copy of a Dem (for distant terrain and overview)."""

    @classmethod
    def from_dem(cls, dem: Dem, f: int):
        c = cls(dn=block_mean(dem.dn, f), scaling=dem.scaling, radius_m=dem.radius_m,
                scale_m=dem.scale_m * f,
                # pixel-centre registration: centre of 0-based coarse pixel j is
                # at fine coordinate j*f + (f-1)/2
                line_off=(dem.line_off - (f - 1) / 2) / f,
                sample_off=(dem.sample_off - (f - 1) / 2) / f)
        return c


def enu_grid(dem: Dem, lat: float, lon: float, r_obs: float, half_m: float, n: int):
    """Return U (n x n, metres, NaN outside data) for nodes E,N in
    linspace(-half, half, n). Row index = north (row 0 = south edge),
    column = east."""
    R = config.MOON_RADIUS_M
    east, north, up = enu_basis(lat, lon)
    ax = np.linspace(-half_m, half_m, n)
    E, N = np.meshgrid(ax, ax)          # E varies along columns, N along rows
    d = np.hypot(E, N)
    t = (np.divide(E, d, out=np.zeros_like(d), where=d > 0)[..., None] * east
         + np.divide(N, d, out=np.ones_like(d), where=d > 0)[..., None] * north)
    h = np.zeros_like(d)
    for _ in range(3):  # solve (R + h) sin(theta) = d
        theta = np.arcsin(np.clip(d / (R + np.nan_to_num(h, nan=0.0)), -1, 1))
        u = np.cos(theta)[..., None] * up + np.sin(theta)[..., None] * t
        h = dem.height_at_unit(u[..., 0], u[..., 1], u[..., 2])
    U = (R + h) * np.cos(theta) - r_obs
    return U


def quantize(U: np.ndarray, scale: float) -> np.ndarray:
    q = np.round(U / scale)
    if np.nanmax(np.abs(q)) >= 32767:
        raise ValueError("terrain grid exceeds int16 range for chosen scale")
    q = np.where(np.isfinite(q), q, NODATA)
    return q.astype("<i2")


def grid_sample(U: np.ndarray, half: float, E, N):
    """Bilinear sample of an ENU grid (as the GPU mesh interpolates it)."""
    n = U.shape[0]
    sp = 2 * half / (n - 1)
    c = (np.asarray(E) + half) / sp
    r = (np.asarray(N) + half) / sp
    ok = (c >= 0) & (r >= 0) & (c <= n - 1) & (r <= n - 1)
    c0 = np.clip(np.floor(c).astype(int), 0, n - 2)
    r0 = np.clip(np.floor(r).astype(int), 0, n - 2)
    fc, fr = np.clip(c - c0, 0, 1), np.clip(r - r0, 0, 1)
    v = ((U[r0, c0] * (1 - fc) + U[r0, c0 + 1] * fc) * (1 - fr)
         + (U[r0 + 1, c0] * (1 - fc) + U[r0 + 1, c0 + 1] * fc) * fr)
    return np.where(ok, v, np.nan)


def rendered_skyline(near, near_half, far, far_half, az_deg, step_m=40.0):
    """Skyline (deg) of the terrain as the frontend renders it: ray-march the
    near grid inside its extent and the far grid beyond. Used to check the
    rendered terrain against the computed horizon mask."""
    s = np.arange(step_m, far_half * np.sqrt(2), step_m)
    a = np.radians(az_deg)[:, None]
    E, N = s[None, :] * np.sin(a), s[None, :] * np.cos(a)
    inside = (np.abs(E) <= near_half) & (np.abs(N) <= near_half)
    U = np.where(inside, grid_sample(near, near_half, E, N), grid_sample(far, far_half, E, N))
    el = np.degrees(np.arctan2(U, s[None, :]))
    return np.nanmax(el, axis=1)
