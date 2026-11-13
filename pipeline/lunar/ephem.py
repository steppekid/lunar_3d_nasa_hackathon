"""Sun and Earth topocentric positions from a point on the lunar surface.

DE440 (de440s.bsp) for positions, DE440 lunar orientation
(moon_pa_de440_200625.bpc) and the MOON_ME_DE440_ME421 frame from
moon_de440_250416.tf, via Skyfield. Positions are apparent (light-time and
aberration corrected); there is no atmosphere so no refraction.
"""
from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
from skyfield.api import Loader, PlanetaryConstants

from . import config

_loader = Loader(str(config.KERNELS), verbose=False)
_state: dict = {}


def _init():
    if _state:
        return _state
    ts = _loader.timescale(builtin=True)
    eph = _loader("de440s.bsp")
    pc = PlanetaryConstants()
    pc.read_text(_loader("moon_de440_250416.tf"))
    pc.read_text(_loader("pck00011.tpc"))
    pc.read_binary(_loader("moon_pa_de440_200625.bpc"))
    _state.update(ts=ts, eph=eph, pc=pc, frames={})
    return _state


def _frame_for(jd_min: float, jd_max: float):
    """Skyfield keeps only the last BPC segment per frame id; this kernel has
    two (1550-2426 and 2426-2650). Pick the one that covers our dates."""
    st = _init()
    pc = st["pc"]
    base_id = pc.variables["FRAME_MOON_PA_DE440"]
    segs = [s for s in pc._segment_list
            if s.body == base_id and s.initial_jd <= jd_min and jd_max <= s.final_jd]
    if not segs:
        raise ValueError("no lunar orientation segment covers the requested dates")
    key = id(segs[0])
    if key not in st["frames"]:
        integer = pc.variables[f"FRAME_{config.MOON_FRAME}"]
        st["frames"][key] = pc.build_frame(integer, _segment=segs[0])
    return st["frames"][key]


def timescale():
    return _init()["ts"]


def times_from_datetimes(dts):
    return timescale().from_datetimes(list(dts))


def hourly_grid(start=config.T_START, end=config.T_END, step_h=config.T_STEP_HOURS):
    t0 = datetime.fromisoformat(start.replace("Z", "+00:00"))
    t1 = datetime.fromisoformat(end.replace("Z", "+00:00"))
    n = int(round((t1 - t0).total_seconds() / 3600 / step_h)) + 1
    unix0 = t0.replace(tzinfo=timezone.utc).timestamp()
    unix = unix0 + np.arange(n) * step_h * 3600.0
    return unix


def times_from_unix(unix: np.ndarray):
    """UTC unix seconds -> Skyfield Time (via UTC calendar, leap-second aware)."""
    ts = timescale()
    jd_utc = np.asarray(unix, dtype=np.float64) / 86400.0 + 2440587.5
    whole = np.floor(jd_utc)
    frac = jd_utc - whole
    # ts.utc accepts (year, month, day, hour...) ; feed day as JD offset from J2000 epoch.
    # Using days from 2000-01-01 keeps leap-second handling inside Skyfield.
    day = whole - 2451544.5 + 1  # day 1 = 2000-01-01
    return ts.utc(2000, 1, day, frac * 24.0)


def sun_earth_altaz(lat: float, lon: float, height_m: float, unix: np.ndarray):
    """Apparent az/el (deg) and distance (km) of Sun and Earth.

    height_m: observer height above the 1737.4 km reference sphere
    (pck00011 Moon radii are 1737.4 km on all axes, matching LOLA).
    """
    st = _init()
    t = times_from_unix(unix)
    frame = _frame_for(float(t.tdb.min()), float(t.tdb.max()))
    place = st["eph"]["moon"] + st["pc"].build_latlon_degrees(frame, lat, lon, height_m)
    out = {}
    obs = place.at(t)
    for name in ("sun", "earth"):
        alt, az, dist = obs.observe(st["eph"][name]).apparent().altaz()
        out[name] = (az.degrees, alt.degrees, dist.km)
    return out


def angular_radius_deg(dist_km, radius_km):
    return np.degrees(np.arcsin(radius_km / np.asarray(dist_km)))
