"""Reader for the LOLA polar stereographic DEM (LDEM_80S_80M).

Projection and scaling are parsed from the PDS3 label, not hard coded.
Map geometry follows DSMAP_POLAR.CAT (LOLA PDS catalog): spherical polar
stereographic, true at the pole, south: longitude 0 points up (toward line 0),
90 E points right (toward increasing sample). That orientation was confirmed
empirically against Shackleton crater, see tests/test_dem.py.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import config


def parse_pds3_label(path: Path) -> dict[str, str]:
    """Flat KEY = VALUE parse of a PDS3 label (enough for the keys we need)."""
    out: dict[str, str] = {}
    for line in Path(path).read_text(encoding="latin-1").splitlines():
        m = re.match(r"^\s*([A-Z_^0-9]+)\s*=\s*(.+?)\s*$", line)
        if m and m.group(1) not in out:
            out[m.group(1)] = m.group(2)
    return out


def _num(s: str) -> float:
    return float(re.match(r"^[-+0-9.eE]+", s.strip().strip("'\"")).group(0))


@dataclass
class Dem:
    dn: np.ndarray             # int16 (lines, samples)
    scaling: float             # metres per DN
    radius_m: float            # reference sphere (OFFSET / A_AXIS_RADIUS)
    scale_m: float             # metres per pixel
    line_off: float            # 0-based line of projection centre
    sample_off: float          # 0-based sample of projection centre

    @property
    def shape(self):
        return self.dn.shape

    # ---- projection -------------------------------------------------------
    def unit_to_map(self, ux, uy, uz):
        """Unit vector in MOON_ME -> stereographic map metres (X right, Y up).

        X = rho*sin(lon), Y = rho*cos(lon), rho = 2R tan(colat_from_S_pole/2).
        Using tan(a/2) = sin a / (1 + cos a) with cos a = -uz gives
        X = 2R*uy/(1 - uz), Y = 2R*ux/(1 - uz).
        """
        k = 2.0 * self.radius_m / (1.0 - uz)
        return k * uy, k * ux

    def map_to_pixel(self, X, Y):
        """Map metres -> fractional 0-based (line, sample) at pixel centres."""
        sample = X / self.scale_m + self.sample_off
        line = self.line_off - Y / self.scale_m
        return line, sample

    def latlon_to_pixel(self, lat_deg, lon_deg):
        ux, uy, uz = latlon_to_unit(lat_deg, lon_deg)
        return self.map_to_pixel(*self.unit_to_map(ux, uy, uz))

    # ---- sampling ---------------------------------------------------------
    def height_at_pixel(self, line, sample):
        """Bilinear height (m, relative to reference sphere). NaN outside map."""
        line = np.asarray(line, dtype=np.float64)
        sample = np.asarray(sample, dtype=np.float64)
        nl, ns = self.dn.shape
        l0 = np.floor(line).astype(np.int64)
        s0 = np.floor(sample).astype(np.int64)
        fl = line - l0
        fs = sample - s0
        ok = (l0 >= 0) & (s0 >= 0) & (l0 < nl - 1) & (s0 < ns - 1)
        l0c = np.clip(l0, 0, nl - 2)
        s0c = np.clip(s0, 0, ns - 2)
        d = self.dn
        h = ((d[l0c, s0c] * (1 - fs) + d[l0c, s0c + 1] * fs) * (1 - fl)
             + (d[l0c + 1, s0c] * (1 - fs) + d[l0c + 1, s0c + 1] * fs) * fl)
        h = h * self.scaling
        return np.where(ok, h, np.nan)

    def height_at_unit(self, ux, uy, uz):
        return self.height_at_pixel(*self.map_to_pixel(*self.unit_to_map(ux, uy, uz)))

    def height_at_latlon(self, lat_deg, lon_deg):
        return self.height_at_unit(*latlon_to_unit(lat_deg, lon_deg))


def latlon_to_unit(lat_deg, lon_deg):
    lat = np.radians(lat_deg)
    lon = np.radians(lon_deg)
    return np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)


def load_dem(img: Path = config.DEM_IMG, lbl: Path = config.DEM_LBL) -> Dem:
    lab = parse_pds3_label(lbl)
    lines = int(_num(lab["LINES"]))
    samples = int(_num(lab["LINE_SAMPLES"]))
    assert lab["SAMPLE_TYPE"].strip('"') == "LSB_INTEGER", lab["SAMPLE_TYPE"]
    assert int(_num(lab["SAMPLE_BITS"])) == 16
    assert "POLAR STEREOGRAPHIC" in lab["MAP_PROJECTION_TYPE"]
    assert _num(lab["CENTER_LATITUDE"]) == -90.0
    assert _num(lab["CENTER_LONGITUDE"]) == 0.0
    assert lab["POSITIVE_LONGITUDE_DIRECTION"].strip('"') == "EAST"
    assert _num(lab["MAP_PROJECTION_ROTATION"]) == 0.0
    a = _num(lab["A_AXIS_RADIUS"]) * 1000.0
    assert a == _num(lab["C_AXIS_RADIUS"]) * 1000.0 == _num(lab["OFFSET"])
    dn = np.fromfile(img, dtype="<i2")
    assert dn.size == lines * samples, f"IMG size {dn.size} != {lines}x{samples}"
    return Dem(
        dn=dn.reshape(lines, samples),
        scaling=_num(lab["SCALING_FACTOR"]),
        radius_m=a,
        scale_m=_num(lab["MAP_SCALE"]),
        # PDS *_PROJECTION_OFFSET is the 1-based pixel coordinate of the pole
        # minus one-half convention; for this 7600 px map it is 3799.5, i.e.
        # the pole sits on the corner shared by 0-based pixels 3799 and 3800,
        # consistent with DSMAP_POLAR.CAT  X = (I - N/2 - 0.5) * MAP_SCALE.
        line_off=_num(lab["LINE_PROJECTION_OFFSET"]),
        sample_off=_num(lab["SAMPLE_PROJECTION_OFFSET"]),
    )
