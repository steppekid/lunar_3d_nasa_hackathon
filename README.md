# Lunar Landing Site Navigator

**NASA Space Apps Challenge 2026: "Lunar Landing Site Navigator".** An independent student project, not a NASA product.

> *If we land at this site on this date, when do we have sunlight for power and Earth in view to talk home, and how long until we lose each?*

You stand on the real LOLA terrain at a lunar south-pole candidate site, 2 m above the ground, and look around. The Sun and Earth are drawn at their true azimuth, elevation and angular size for any hour in 2027–2028, and the Earth shows its true phase. Scrub through time and you can watch the Sun slide behind a ridge and the Earth link drop. A HUD and a timeline show the numbers behind the view.

## What's in the app

| Feature | Where |
|---|---|
| South-pole map with the six Data Book sites; click to fly down | Landing screen |
| First-person view on LOLA terrain (12 km at 60 m around you, 600 m out to about 150 km, with the computed skyline beyond) | Surface view |
| Sun and Earth at their true positions and sizes; Earth lit from the true Sun direction, so its phase is correct | Surface view |
| Terrain lighting and shadows that follow the Sun (traced through the terrain grids, re-baked when the Sun moves) | Surface view |
| HUD: Sun elevation, % of the solar disc visible, power state; Earth elevation, margin over terrain, DTE link state; countdowns ("Sunlight lost in 3 d 4 h") | Left |
| Time scrubber, play/pause, speed (1 h/s to 3 days/s) | Bottom |
| Timeline strip for sunlight and Earth visibility over the mission window; click or drag to jump | Bottom |
| Sun and Earth sky paths over the mission, dimmed where blocked; computed-horizon overlay | Toggles, right |
| **Data Book centre vs. best point within 500 m**: the same site, a few hundred metres away | HUD toggle |
| Compare 2–4 sites over a mission window; best landing date; launch-slip tolerance | "Compare sites" |
| Validation against JPL Horizons, internal consistency checks, sources, limitations | "How do we know?" |
| "Enhanced visibility" fill light (labelled as a display aid); illustrative surface texture (labelled) | Toggles |

**30-second demo:** open the page → click *Connecting ridge* → press ▶ (1 day/s) → watch the Sun circle the horizon and drop behind the local slope, and the amber bar end in the timeline → switch the HUD to *Best within 500 m* → the longest night drops from 497 h to 122 h → open *Compare sites*.

## Quick start

### Just run the app (data already built)

The web app is fully static and reads only files in `web/data/`.

```bash
cd web
python -m http.server 8000
# open http://localhost:8000
```

Any static host works. **Vercel:** import the repo; `vercel.json` serves `web/`. **GitHub Pages:** push to `main`; `.github/workflows/pages.yml` publishes `web/` (enable Pages → Source: GitHub Actions). Deep links work, for example `#site=cr&v=best&land=2027-01-01T00:00&days=30&t=2027-01-15T06:00&panel=compare`.

### Rebuild the data (Python 3.11+)

```bash
python -m venv .venv
.venv/Scripts/activate          # Windows (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
python pipeline/download.py     # ~160 MB: LOLA DEM + label, DE440 and lunar kernels
python pipeline/build.py        # ~4 min, all sites; writes web/data/
python -m pytest                # science tests (one test calls the Horizons API)
```

Options: `build.py --sites cr ps` builds selected sites, `--no-horizons` builds offline (skips validation), and `--no-best` skips the nearby-point search. Horizons responses are cached in `data/cache/`.

## How it works

```
pipeline/ (offline, Python)                         web/ (static, three.js)
 download.py  NASA PDS + NAIF files                  index.html, css/, js/
 lunar/dem.py        LDEM reader (label-driven)      main.js      app state, HUD, panels
 lunar/horizon.py    horizon mask ray-march          surface.js   first-person scene + shaders
 lunar/ephem.py      Skyfield, DE440, MOON_ME        overview.js  south-pole map + fly-down
 lunar/visibility.py disc fraction, Earth vis        timeline.js  two-lane strip
 lunar/terrain.py    ENU terrain grids               science.js   same algorithms as Python
 lunar/bestpoint.py  nearby best-lit point           data.js      loaders
 lunar/horizons_api.py  validation client
 build.py  ->  web/data/{index.json, overview.bin, sites/<id>/{meta.json, ephem.bin, near.bin, far.bin}}
```

* **Terrain.** We use LOLA `LDEM_80S_80M` (7600 × 7600, int16, 0.5 m/DN, heights relative to a 1737.4 km sphere, polar stereographic, Mean-Earth/Polar-Axis frame of DE421). Every value comes from the PDS label, which the reader checks with assertions. Orientation (0° E up, 90° E right) follows the text and inverse equations in `DSMAP_POLAR.CAT`. Its forward equation mirrors east and west, so we confirmed the orientation on the data: Shackleton's floor at 89.67° S, 129.78° E is −2788 m, while the mirrored point is +672 m. The test is `test_dem_orientation_shackleton`. All six Data Book coordinates also land exactly on an 80 m or 40 m grid node, which cross-checks the georeferencing.
* **Horizon mask.** For each 0.25° of azimuth we trace the ground along the great circle from the eye (ground + 2 m). We sample the DEM bilinearly every 40 m out to 300 km or the map edge, whichever comes first. The shortest ray at any site is 185 km. The elevation of each sample is `atan2((R+h)cosθ − r_obs, (R+h)sinθ)`, which is exact for a sphere and includes curvature.
* **Ephemeris.** We use Skyfield with `de440s.bsp`, `moon_pa_de440_200625.bpc` and frame `MOON_ME_DE440_ME421` from `moon_de440_250416.tf`. That frame is DE440 orientation aligned to the DE421 Mean-Earth frame, the same frame as LOLA and as Horizons' lunar sites. Positions are apparent (light time and aberration), with no refraction, sampled hourly from 2027-01-01 00:00 to 2028-12-31 23:00 UTC (17,544 samples). Skyfield keeps only the *last* BPC segment for a frame, and this kernel has two (1550–2426 and 2426–2650). `ephem.py` therefore selects the segment that covers our dates; without that, the code raises an error.
* **Visibility.** The Sun's state comes from the visible fraction of its true-size disc (radius from distance, 0.261°–0.272°), integrated in 64 vertical strips against the mask: *Generating* is ≥ 99.9% of the disc, *Partial* is above 0, *Dark* is 0. The Earth is *in view* when its centre is above the mask.
* **Rendering.** Terrain grids are pre-projected in the pipeline into the observer's local East-North-Up frame, with curvature built in. The near grid is ±12 km at 60 m (80 m DEM); the far grid is ±153.6 km at 600 m (from a 320 m block-averaged DEM). A curtain drawn from the computed mask at 245 km fills any gap, so the visible skyline matches the mask. Shadows are traced from every terrain grid node toward the Sun through both grids (96 steps, or 48 in low-power mode), with a soft edge from the true disc size. They are baked into a texture on the GPU only when the Sun moves (at most ~12 times a second), so looking around costs nothing extra. Photometry blends Lommel–Seeliger and Lambert and is for display only. All HUD numbers come from the mask.

## Validation (measured)

**Ephemeris vs JPL Horizons.** We checked 11 evaluated points × 36 times spread over 2027–2028 (minutes off the hourly grid) × Sun and Earth. The observer is `coord@301` at the same longitude, latitude and altitude; Horizons uses DE441 and its "MEAN_ME (high precision)" frame.

| | Max angular separation |
|---|---|
| Our engine vs Horizons (exact times) | **0.003–0.004″** (Sun and Earth, every point) |
| What the app displays (hourly linear interpolation) vs Horizons | Sun **≤ 0.16″**, Earth **≤ 0.47″** |

For scale, the solar disc is about 1900″ across, so interpolation adds far less error than anything else here. The per-point tables are in the app ("How do we know?") and in each `web/data/sites/<id>/meta.json` under `validation`.

**Internal consistency.**
* Rendered terrain skyline vs computed mask, per point: mean −0.03° to −0.14°, worst −0.63° (decimated far mesh is lower); never more than +0.12° higher. The curtain closes the low side.
* Browser vs pipeline solar-disc fraction (2,507 hourly samples per point, checked at three points): max |Δ| ≤ 1.0 × 10⁻⁴ of the disc, from float32 storage and 4-decimal mask rounding. The app recomputes this on every site load and shows it in the validation panel.

**Tests** (`python -m pytest`, 12 tests, all passing):
* Horizon mask on synthetic terrain with closed-form answers: bare-sphere dip (−0.0868° for a 2 m eye, tangent at 2.64 km), a 1500 m ring wall 40 km away, and a 4 km peak 120 km away (checks azimuth, distance, and the 1.98° curvature drop).
* Disc fraction: flat horizon at 0 / ±r, circular-segment area, and a vertical wall that cuts the disc in half.
* DEM orientation (Shackleton), and ephemeris vs Horizons with a tolerance of **2″**.

## Results over 2027–2028 (hourly, eye 2 m above ground)

| Site | Evaluated point | Offset | Slope (80 m) | Sunlit (any) | Earth in view | Sun + Earth | Longest night | Longest comms gap |
|---|---|---|---|---|---|---|---|---|
| Connecting ridge | Data Book centre | 0 m | 3.6° | 49.8% | 39.5% | 19.9% | 497 h | 414 h |
| Connecting ridge | best ≤ 500 m | 378 m | 1.0° | 90.8% | 54.3% | 49.4% | 122 h | 319 h |
| Shackleton rim | Data Book centre | 0 m | 32.1° | 11.3% | 0.0% | 0.0% | 4901 h | whole period |
| Nobile rim 1 | Data Book centre | 0 m | 16.6° | 31.9% | 35.4% | 12.2% | 512 h | 438 h |
| Nobile rim 1 | best ≤ 500 m | 483 m | 1.1° | 48.5% | 48.5% | 25.2% | 303 h | 357 h |
| Peak near Shackleton | Data Book centre | 0 m | 1.4° | 79.1% | 57.5% | 46.1% | 381 h | 299 h |
| Peak near Shackleton | best ≤ 500 m | 56 m | 1.4° | 88.7% | 57.1% | 53.6% | 137 h | 302 h |
| de Gerlache rim 1 | Data Book centre | 0 m | 3.9° | 70.0% | 57.7% | 37.8% | 404 h | 300 h |
| de Gerlache rim 1 | best ≤ 500 m | 486 m | 1.1° | 87.3% | 57.7% | 50.2% | 184 h | 301 h |
| Leibnitz beta plateau | Data Book centre | 0 m | 7.4° | 24.6% | 37.3% | 6.8% | 2805 h | 428 h |
| Leibnitz beta plateau | best ≤ 500 m | 433 m | 4.0° | 81.8% | 63.9% | 47.5% | 300 h | 258 h |

**Why two points per site.** The Data Book says its coordinates are *centres of region polygons* (Mazarico et al. 2011), not landing points. At 80 m resolution several of them sit on steep ground: Shackleton rim's is on a 32° inner wall, where the wall itself blocks the Sun and the Earth. So for each site we also search every DEM pixel within 500 m with slope ≤ 10° and keep the one sunlit for the largest share of the time. The 10° limit is **our assumption**: the Data Book uses "slope under 10 degrees" to define a *level traverse* (Fig. 7.3.2.7-1) and states no landing-slope requirement. Shackleton rim has no such pixel within 500 m. The contrast is the challenge's point that small changes in location change feasibility a great deal.

## Known limitations

* **80 m terrain.** Boulders, small craters and slopes shorter than about 160 m are not modelled. At several points the near horizon comes from the local slope a few hundred metres away, so results are sensitive to the exact spot and the DEM. Higher-resolution LOLA site DEMs exist (5 m/px, PGDA product 81, Barker et al. 2021) and would be the next step.
* **Not yet cross-checked against published illumination maps** (e.g. Mazarico et al. 2011; Barker et al. 2021, PGDA). The ephemeris and geometry are validated; the illumination statistics are not yet compared with an independent study.
* **Earth visibility uses the disc centre.** A half-hidden Earth may still support a link. Real DTE also needs antenna pointing, ground-station coverage and margin above terrain; this is geometry only.
* **Hourly sampling** for statistics, the timeline, best dates and slip tolerance (events shorter than an hour can be missed). Countdowns are refined by bisection to under a second.
* **Eye height fixed at 2 m.** Masts or arrays a few metres higher can see noticeably more Sun.
* **Rendering is a display.** Far terrain is decimated (600 m) with the computed skyline drawn behind it. Shadows are resolved per terrain grid node (60 m near, 600 m far), with no shadows from terrain beyond ~150 km on the rendered ground (the HUD includes them). Photometry is approximate, the surface texture is illustrative, and the "enhanced visibility" fill is a display aid.
* **Time span.** Data covers 2027-01-01 to 2028-12-31 only.
* **Performance not yet measured on real hardware.** All screenshots and checks so far used headless Edge with a software renderer (SwiftShader, about 2 fps at 1440×900, which says nothing about a GPU). Test on a typical integrated-GPU laptop before the demo. Levers: "Low-power shadows" (48 steps instead of 96), the pixel-ratio cap in `main.js` (1.5), and the far grid size in `build.py` (513²).

## Data sources

See [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md). In short: NASA PDS LOLA `LDEM_80S_80M`; NAIF DE440, lunar orientation and frame kernels; the JPL Horizons API; and the NASA *Lunar Surface Data Book* M2M-30044 (2025), Table A2.1-1.

---
Independent NASA Space Apps Challenge 2026 project. Not a NASA product; not for mission use.
