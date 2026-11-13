"""Science tests. Run:  .venv/Scripts/python -m pytest pipeline/tests -q

Synthetic-terrain tests need no data. Tests marked `data` need the LOLA DEM
in data/raw; `network` tests call the JPL Horizons API.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lunar import config, horizon, visibility  # noqa: E402
from lunar.geometry import enu_basis  # noqa: E402

R = config.MOON_RADIUS_M


def _angle_from(u0, ux, uy, uz):
    return np.arccos(np.clip(u0[0] * ux + u0[1] * uy + u0[2] * uz, -1, 1))


# ---------------------------------------------------------------- horizon mask
def test_bare_sphere_dip():
    """Flat (h=0) Moon, eye 2 m up: horizon dip = -acos(R/(R+h))."""
    mask = horizon.compute_mask(lambda x, y, z: np.zeros_like(x), -89.0, 30.0, 0.0,
                                obs_above_ground_m=2.0, az_step_deg=5.0,
                                step_m=10.0, max_range_m=10_000.0)
    expected = -np.degrees(np.arccos(R / (R + 2.0)))
    assert np.allclose(mask.el_deg, expected, atol=2e-4), (mask.el_deg[:3], expected)
    # tangent point distance sqrt(2 R h) ~ 2.64 km
    assert np.allclose(mask.dist_m, np.sqrt(2 * R * 2.0), atol=20)


def test_ring_wall_known_elevation():
    """A 1500 m high, 2 km wide circular wall 40 km away in all directions."""
    lat, lon = -88.0, -60.0
    _, _, up = enu_basis(lat, lon)
    theta_w = 40_000.0 / R

    def h(ux, uy, uz):
        th = _angle_from(up, ux, uy, uz)
        return np.where(np.abs(th - theta_w) * R < 1000.0, 1500.0, 0.0)

    mask = horizon.compute_mask(h, lat, lon, 0.0, obs_above_ground_m=2.0,
                                az_step_deg=10.0, step_m=20.0, max_range_m=60_000.0)
    # highest elevation is at the near edge of the wall top (39 km)
    th = 39_000.0 / R
    expected = np.degrees(np.arctan2((R + 1500) * np.cos(th) - (R + 2), (R + 1500) * np.sin(th)))
    assert np.allclose(mask.el_deg, expected, atol=5e-3)
    assert np.allclose(mask.dist_m, 39_000.0, atol=25)


def test_single_peak_azimuth_and_curvature():
    """A 4 km cone 120 km due east. Only azimuths near 90 deg see it, and the
    elevation includes the curvature drop (~ -4.1 km at 120 km)."""
    lat, lon = -87.5, 10.0
    east, north, up = enu_basis(lat, lon)
    th_p = 120_000.0 / R
    peak = np.cos(th_p) * up + np.sin(th_p) * east

    def h(ux, uy, uz):
        d = _angle_from(peak, ux, uy, uz) * R
        return np.clip(4000.0 * (1 - d / 8000.0), 0, None)

    mask = horizon.compute_mask(h, lat, lon, 0.0, obs_above_ground_m=2.0,
                                az_step_deg=1.0, step_m=20.0, max_range_m=200_000.0)
    exp_peak = np.degrees(np.arctan2((R + 4000) * np.cos(th_p) - (R + 2), (R + 4000) * np.sin(th_p)))
    assert mask.el_deg[90] == pytest.approx(exp_peak, abs=2e-3)
    assert mask.dist_m[90] == pytest.approx(120_000.0, abs=50)
    # opposite direction: bare sphere
    assert mask.el_deg[270] == pytest.approx(-np.degrees(np.arccos(R / (R + 2))), abs=1e-3)
    # curvature matters: the drop d/(2R) is ~1.98 deg at 120 km
    assert exp_peak < np.degrees(np.arctan2(4000 - 2, 120_000)) - 1.9


# --------------------------------------------------------- solar disc fraction
@pytest.mark.parametrize("el,expected", [(0.0, 0.5), (0.3, 1.0), (-0.3, 0.0), (0.2665, 1.0)])
def test_sun_fraction_flat_mask(el, expected):
    az = np.arange(0, 360, 0.25)
    m = np.zeros_like(az)
    f = visibility.sun_fraction(100.0, el, 0.2665, az, m)
    assert float(f) == pytest.approx(expected, abs=2e-3)


def test_sun_fraction_segment_area():
    """Disc centre at el = r/2 above a flat mask: exact circular-segment area."""
    r = 0.27
    az = np.arange(0, 360, 0.25)
    f = visibility.sun_fraction(10.0, r / 2, r, az, np.zeros_like(az), n=512)
    d = r / 2  # the mask line lies a distance d below the disc centre
    seg_hidden = r * r * np.arccos(d / r) - d * np.sqrt(r * r - d * d)  # area below line
    expected = 1 - seg_hidden / (np.pi * r * r)
    assert float(f) == pytest.approx(expected, abs=2e-3)


def test_sun_fraction_vertical_edge():
    """Mask is a wall on the left half of the disc: half visible."""
    r = 0.27
    az = np.arange(0, 360, 0.001)   # fine mask so the 1-bin interpolation ramp is negligible
    m = np.where(az < 50.0, 10.0, -10.0)
    f = visibility.sun_fraction(50.0, 0.0, r, az, m, n=512)
    assert float(f) == pytest.approx(0.5, abs=0.01)


def test_runs():
    s, l = visibility.runs(np.array([0, 1, 1, 0, 1, 1, 1, 0], bool))
    assert s.tolist() == [1, 4] and l.tolist() == [2, 3]


# ------------------------------------------------------------- data-dependent
needs_dem = pytest.mark.skipif(not config.DEM_IMG.exists(), reason="LOLA DEM not downloaded")


@needs_dem
def test_dem_orientation_shackleton():
    """Shackleton's floor (~89.66 S, 130 E) is ~3 km below datum; the mirrored
    point (130 W) is on the high connecting ridge. Confirms 90 E = +sample."""
    from lunar.dem import load_dem
    d = load_dem()
    assert d.height_at_latlon(-89.67, 129.78) < -2500
    assert d.height_at_latlon(-89.67, -129.78) > 0


needs_kernels = pytest.mark.skipif(not (config.KERNELS / "de440s.bsp").exists(), reason="kernels missing")


@needs_kernels
@pytest.mark.network
def test_ephemeris_matches_horizons():
    """Skyfield (DE440 + MOON_ME_DE440_ME421) vs JPL Horizons (DE441, MEAN_ME)
    for Sun and Earth from the Connecting ridge site. Tolerance: 2 arcsec."""
    from lunar import ephem, horizons_api
    site = config.SITES[0]
    alt_m = 1945.3
    unix = np.array([1798761600.0, 1810000000.0, 1830000000.0, 1855000000.0])
    jd = list(unix / 86400 + 2440587.5)
    ours = ephem.sun_earth_altaz(site["lat"], site["lon"], alt_m, unix)
    for body in ("sun", "earth"):
        rows, meta = horizons_api.cached_query(body, site, alt_m / 1000, jd)
        hz = np.array(rows)
        az, el, _ = ours[body]
        daz = (((az - hz[:, 1]) + 180) % 360 - 180) * np.cos(np.radians(el))
        sep = np.hypot(daz, el - hz[:, 2]) * 3600
        assert sep.max() < 2.0, (body, sep)
