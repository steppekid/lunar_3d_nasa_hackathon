"""Independent check against the JPL Horizons API (observer on the Moon).

Parameters per https://ssd-api.jpl.nasa.gov/doc/horizons.html and the
Horizons manual: CENTER='coord@301' with COORD_TYPE='GEODETIC' and
SITE_COORD='E-lon,lat,alt_km'. For the Moon Horizons uses the DE421 Mean-Earth
frame with east-positive longitude (confirmed in the response header
"Center geodetic ... {E-lon(deg),Lat(deg),Alt(km)}" and
"Center pole/equ : MEAN_ME (high precision)"). Quantity 4 = apparent az/el,
azimuth clockwise from north, elevation from the plane perpendicular to the
local zenith; APPARENT='AIRLESS' (no refraction).
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import requests

from . import config

API = "https://ssd.jpl.nasa.gov/api/horizons.api"
BODY_IDS = {"sun": "10", "earth": "399"}


def query_azel(body: str, lat: float, lon: float, alt_km: float, jd_utc: list[float]):
    params = {
        "format": "json",
        "COMMAND": f"'{BODY_IDS[body]}'",
        "OBJ_DATA": "'NO'",
        "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'OBSERVER'",
        "CENTER": "'coord@301'",
        "COORD_TYPE": "'GEODETIC'",
        "SITE_COORD": f"'{lon % 360.0:.6f},{lat:.6f},{alt_km:.6f}'",
        "TLIST": " ".join(f"'{jd:.9f}'" for jd in jd_utc),
        "TLIST_TYPE": "'JD'",
        "TIME_TYPE": "'UT'",
        "QUANTITIES": "'4'",
        "ANG_FORMAT": "'DEG'",
        "APPARENT": "'AIRLESS'",
        "CAL_FORMAT": "'JD'",
        "EXTRA_PREC": "'YES'",
        "CSV_FORMAT": "'YES'",
    }
    for attempt in range(4):
        r = requests.get(API, params=params, timeout=120)
        if r.status_code == 200:
            break
        time.sleep(3 * (attempt + 1))
    r.raise_for_status()
    payload = r.json()
    text = payload["result"]
    if "$$SOE" not in text:
        raise RuntimeError(f"Horizons error for {body}: {text[:2000]}")
    header = text.split("$$SOE")[0]
    if "MEAN_ME" not in header:
        raise RuntimeError("Horizons did not report the MEAN_ME lunar frame")
    rows = []
    for line in text.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        rows.append((float(parts[0]), float(parts[3]), float(parts[4])))
    meta = {
        "source": payload.get("signature", {}),
        "frame_line": next((l for l in header.splitlines() if l.startswith("Center pole/equ")), ""),
        "site_line": next((l for l in header.splitlines() if l.startswith("Center geodetic")), ""),
        "ephem_line": next((l for l in header.splitlines() if l.startswith("Target body name")), ""),
    }
    return rows, meta


def cached_query(body, site, alt_km, jd_utc, cache_dir: Path = config.CACHE / "horizons"):
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = f"{site['id']}_{body}_{len(jd_utc)}_{jd_utc[0]:.4f}_{jd_utc[-1]:.4f}_{alt_km:.4f}.json"
    f = cache_dir / key
    if f.exists():
        d = json.loads(f.read_text())
        return d["rows"], d["meta"]
    rows, meta = query_azel(body, site["lat"], site["lon"], alt_km, jd_utc)
    f.write_text(json.dumps({"rows": rows, "meta": meta}))
    return rows, meta
