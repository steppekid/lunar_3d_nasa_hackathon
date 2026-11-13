"""Offline pipeline: DEM + ephemeris -> static files for the web app.

    python pipeline/build.py                  # all sites
    python pipeline/build.py --sites cr       # one site
    python pipeline/build.py --no-horizons    # skip the network validation

Writes web/data/index.json, web/data/overview.bin and
web/data/sites/<id>/{meta.json, ephem.bin, near.bin, far.bin}.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lunar import bestpoint, config, ephem, horizon, terrain, visibility  # noqa: E402
from lunar.dem import load_dem  # noqa: E402

NEAR_HALF_M, NEAR_N, NEAR_Q = 12_000.0, 401, 0.25       # 60 m spacing, 0.25 m quantum
FAR_HALF_M, FAR_N, FAR_Q = 153_600.0, 513, 1.0          # 600 m spacing, 1 m quantum
FAR_BLOCK = 4                                           # far grid samples a 320 m block-mean DEM
OVERVIEW_BLOCK = 16                                     # 1280 m overview
VALIDATION_SAMPLES = 36

CHANNELS = ["sunAz", "sunEl", "sunR", "earthAz", "earthEl", "earthR", "sunFrac", "earthVis"]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def interp_like_app(unix_grid, series_az, series_el, unix_q):
    """Linear interpolation exactly as web/js/science.js does it (azimuth
    unwrapped across 0/360)."""
    x = (unix_q - unix_grid[0]) / 3600.0
    i0 = np.clip(np.floor(x).astype(int), 0, unix_grid.size - 2)
    f = x - i0
    a0, a1 = series_az[i0], series_az[i0 + 1]
    da = ((a1 - a0 + 540.0) % 360.0) - 180.0
    az = (a0 + f * da) % 360.0
    el = series_el[i0] * (1 - f) + series_el[i0 + 1] * f
    return az, el


def sep_arcsec(az1, el1, az2, el2):
    a1, e1, a2, e2 = map(np.radians, (az1, el1, az2, el2))
    v1 = np.stack([np.cos(e1) * np.sin(a1), np.cos(e1) * np.cos(a1), np.sin(e1)], -1)
    v2 = np.stack([np.cos(e2) * np.sin(a2), np.cos(e2) * np.cos(a2), np.sin(e2)], -1)
    c = np.clip((v1 * v2).sum(-1), -1, 1)
    return np.degrees(np.arccos(c)) * 3600.0


def validate_site(site, h_obs_m, unix_grid, series, use_network: bool):
    from lunar import horizons_api
    rng = np.random.default_rng(20270101)
    # spread over the full period, off the hourly grid (random minutes) so the
    # app's hourly interpolation error is included in the "as displayed" check
    base = np.linspace(unix_grid[0] + 3600, unix_grid[-1] - 7200, VALIDATION_SAMPLES)
    unix_q = np.round(base + rng.uniform(0, 3600, base.size))
    jd = unix_q / 86400.0 + 2440587.5
    direct = ephem.sun_earth_altaz(site["lat"], site["lon"], h_obs_m, unix_q)
    out = {"n": int(unix_q.size), "times_utc": [datetime.fromtimestamp(u, timezone.utc).isoformat().replace("+00:00", "Z") for u in unix_q]}
    if not use_network:
        out["status"] = "skipped (offline build)"
        return out
    for body in ("sun", "earth"):
        rows, meta = horizons_api.cached_query(body, site, h_obs_m / 1000.0, list(jd))
        hz = np.array(rows)
        if np.abs(hz[:, 0] - jd).max() > 1e-6:
            raise RuntimeError("Horizons returned different epochs than requested")
        az_d, el_d, _ = direct[body]
        az_a, el_a = interp_like_app(unix_grid, series[f"{body}Az"], series[f"{body}El"], unix_q)
        s_direct = sep_arcsec(az_d, el_d, hz[:, 1], hz[:, 2])
        s_app = sep_arcsec(az_a, el_a, hz[:, 1], hz[:, 2])
        out[body] = {
            "horizons_az": np.round(hz[:, 1], 6).tolist(),
            "horizons_el": np.round(hz[:, 2], 6).tolist(),
            "ours_az": np.round(az_d, 6).tolist(),
            "ours_el": np.round(el_d, 6).tolist(),
            "app_az": np.round(az_a, 6).tolist(),
            "app_el": np.round(el_a, 6).tolist(),
            "max_sep_arcsec_engine": float(s_direct.max()),
            "max_sep_arcsec_app": float(s_app.max()),
            "max_abs_del_arcsec_app": float(np.abs(el_a - hz[:, 2]).max() * 3600),
            "horizons_header": meta,
        }
    out["status"] = "ok"
    return out


def build_site(dem, coarse, site, unix, use_network, out_dir: Path):
    t0 = time.time()
    lat, lon = site["lat"], site["lon"]
    h_ground = float(dem.height_at_latlon(lat, lon))
    h_obs = h_ground + config.OBSERVER_HEIGHT_M
    r_obs = config.MOON_RADIUS_M + h_obs
    log(f"[{site['id']}] ground {h_ground:.1f} m")

    mask = horizon.compute_mask(dem.height_at_unit, lat, lon, h_ground)
    log(f"[{site['id']}] mask: el {mask.el_deg.min():.2f}..{mask.el_deg.max():.2f} deg, "
        f"defining dist max {mask.dist_m.max()/1000:.1f} km, min ray {mask.range_m.min()/1000:.1f} km")

    eph = ephem.sun_earth_altaz(lat, lon, h_obs, unix)
    s_az, s_el, s_d = eph["sun"]
    e_az, e_el, e_d = eph["earth"]
    s_r = ephem.angular_radius_deg(s_d, config.SUN_RADIUS_KM)
    e_r = ephem.angular_radius_deg(e_d, config.EARTH_RADIUS_KM)
    frac = visibility.sun_fraction(s_az, s_el, s_r, mask.az_deg, mask.el_deg)
    evis = visibility.earth_visible(e_az, e_el, mask.az_deg, mask.el_deg)
    series = dict(sunAz=s_az, sunEl=s_el, sunR=s_r, earthAz=e_az, earthEl=e_el,
                  earthR=e_r, sunFrac=frac, earthVis=evis.astype(np.float64))
    log(f"[{site['id']}] ephemeris done")

    near = terrain.enu_grid(dem, lat, lon, r_obs, NEAR_HALF_M, NEAR_N)
    far = terrain.enu_grid(coarse, lat, lon, r_obs, FAR_HALF_M, FAR_N)
    sky = np.concatenate([terrain.rendered_skyline(near, NEAR_HALF_M, far, FAR_HALF_M, a)
                          for a in np.array_split(mask.az_deg, 16)])
    diff = sky - mask.el_deg
    log(f"[{site['id']}] terrain grids; rendered-minus-mask el: "
        f"mean {diff.mean():+.3f}, min {diff.min():+.3f}, max {diff.max():+.3f} deg")

    val = validate_site(site, h_obs, unix, series, use_network)
    if val.get("status") == "ok":
        log(f"[{site['id']}] Horizons: sun max {val['sun']['max_sep_arcsec_app']:.2f}\" "
            f"earth max {val['earth']['max_sep_arcsec_app']:.2f}\" (as displayed)")

    st = visibility.sun_state(frac)
    lit = st > 0
    s_starts, s_len = visibility.runs(~lit)
    e_starts, e_len = visibility.runs(~evis)
    summary = {
        "pct_sunlit_any": float(lit.mean() * 100),
        "pct_full_sun": float((st == 2).mean() * 100),
        "pct_earth": float(evis.mean() * 100),
        "pct_both": float((lit & evis).mean() * 100),
        "longest_dark_h": int(s_len.max()) if s_len.size else 0,
        "longest_comms_gap_h": int(e_len.max()) if e_len.size else 0,
    }

    d = out_dir / site["id"]
    d.mkdir(parents=True, exist_ok=True)
    np.stack([series[c].astype(np.float32) for c in CHANNELS]).astype("<f4").tofile(d / "ephem.bin")
    terrain.quantize(near, NEAR_Q).tofile(d / "near.bin")
    terrain.quantize(far, FAR_Q).tofile(d / "far.bin")
    meta = {
        **site,
        "site_source": config.SITE_SOURCE,
        "mask_az_deg_note": "mask[i] is the horizon elevation at azimuth i*az_step_deg (clockwise from north)",
        "ground_height_m": round(h_ground, 2),
        "observer_height_m": config.OBSERVER_HEIGHT_M,
        "mask": {
            "az_step_deg": config.MASK_AZ_STEP_DEG,
            "el_deg": np.round(mask.el_deg, 4).tolist(),
            "dist_km": np.round(mask.dist_m / 1000, 2).tolist(),
            "min_ray_km": round(float(mask.range_m.min()) / 1000, 1),
            "ray_step_m": config.MASK_RAY_STEP_M,
            "rendered_minus_mask_deg": {"mean": round(float(diff.mean()), 4),
                                        "min": round(float(diff.min()), 4),
                                        "max": round(float(diff.max()), 4)},
        },
        "terrain": {
            "near": {"file": "near.bin", "half_m": NEAR_HALF_M, "n": NEAR_N, "quantum_m": NEAR_Q},
            "far": {"file": "far.bin", "half_m": FAR_HALF_M, "n": FAR_N, "quantum_m": FAR_Q,
                    "dem_block": FAR_BLOCK},
            "nodata": terrain.NODATA,
            "layout": "int16 LE, row-major, row 0 = south edge (N=-half), col 0 = west edge (E=-half); value*quantum = U metres above observer horizontal plane (observer at U=0, 2 m above ground)",
        },
        "ephem": {"file": "ephem.bin", "channels": CHANNELS, "n": int(unix.size),
                  "t0_unix": float(unix[0]), "step_s": 3600.0,
                  "layout": "float32 LE, channel-major (all samples of channel 0, then channel 1, ...)"},
        "summary_full_period": summary,
        "validation": val,
    }
    (d / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    log(f"[{site['id']}] wrote {d} in {time.time() - t0:.1f}s  {summary}")
    return meta


def write_overview(dem, out: Path):
    c = terrain.block_mean(dem.dn, OVERVIEW_BLOCK) * dem.scaling
    c.round().astype("<i2").tofile(out / "overview.bin")
    return {"file": "overview.bin", "n": int(c.shape[0]), "pixel_m": dem.scale_m * OVERVIEW_BLOCK,
            "layout": "int16 LE heights (m, rel. 1737.4 km sphere), row 0 = top of polar stereographic map (toward 0 E), col 0 = left (toward 90 W)",
            "min_m": float(c.min()), "max_m": float(c.max())}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sites", nargs="*", default=[s["id"] for s in config.SITES])
    ap.add_argument("--no-horizons", action="store_true")
    ap.add_argument("--no-best", action="store_true", help="skip the nearby best-lit point search")
    args = ap.parse_args()

    config.WEB_DATA.mkdir(parents=True, exist_ok=True)
    out_sites = config.WEB_DATA / "sites"
    log("loading DEM")
    dem = load_dem()
    coarse = terrain.CoarseDem.from_dem(dem, FAR_BLOCK)
    unix = ephem.hourly_grid()
    log(f"time grid: {unix.size} hourly samples {config.T_START} .. {config.T_END}")

    index_path = config.WEB_DATA / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {"sites": []}
    by_id = {s["id"]: s for s in index.get("sites", [])}
    for site in config.SITES:
        if site["id"] not in args.sites:
            continue
        variants = {}
        l, smp = (int(round(float(v))) for v in dem.latlon_to_pixel(site["lat"], site["lon"]))
        pt = {**site, "variant": "databook", "offset_m": 0.0,
              "slope_deg": round(bestpoint.slope_deg(dem, l, smp), 1)}
        variants["databook"] = build_site(dem, coarse, pt, unix, not args.no_horizons, out_sites)
        if not args.no_best:
            log(f"[{site['id']}] searching best-lit point within {bestpoint.RADIUS_M:.0f} m")
            b = bestpoint.find_best(dem, site["lat"], site["lon"], unix, log=log)
            if b is not None:
                bp = {**site, "id": site["id"] + "-best", "parent": site["id"], "variant": "best",
                      "lat": round(b["lat"], 6), "lon": round(b["lon"], 6),
                      "offset_m": round(b["offset_m"], 1), "slope_deg": round(b["slope_deg"], 1),
                      "search": {"radius_m": bestpoint.RADIUS_M, "slope_limit_deg": bestpoint.SLOPE_LIMIT_DEG,
                                 "criterion": "max % of time with any sunlight, tie-break % sun+Earth"}}
                variants["best"] = build_site(dem, coarse, bp, unix, not args.no_horizons, out_sites)
        entry = {**site, "variants": {}}
        for k, meta in variants.items():
            val = meta["validation"]
            entry["variants"][k] = {
                "dir": meta["id"], "lat": meta["lat"], "lon": meta["lon"],
                "offset_m": meta["offset_m"], "slope_deg": meta["slope_deg"],
                "ground_height_m": meta["ground_height_m"],
                "summary_full_period": meta["summary_full_period"],
                "validation_max_arcsec": None if val.get("status") != "ok" else {
                    "sun": round(val["sun"]["max_sep_arcsec_app"], 3),
                    "earth": round(val["earth"]["max_sep_arcsec_app"], 3)},
            }
        by_id[site["id"]] = entry
    index = {
        "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "period": {"start": config.T_START, "end": config.T_END, "step_h": config.T_STEP_HOURS},
        "sites": [by_id[s["id"]] for s in config.SITES if s["id"] in by_id],
        "overview": write_overview(dem, config.WEB_DATA),
        "dem": {"product": "LRO LOLA LDEM_80S_80M (PDS LRO-L-LOLA-4-GDR-V1.0, V2.0)",
                "url": config.DEM_URL},
        "ephemeris": {"spk": "DE440 (de440s.bsp)", "orientation": "moon_pa_de440_200625.bpc",
                      "frame": config.MOON_FRAME, "engine": "Skyfield"},
    }
    index_path.write_text(json.dumps(index, indent=1))
    log("done")


if __name__ == "__main__":
    main()
