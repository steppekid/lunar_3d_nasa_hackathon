# Data, software and asset attribution

All data are NASA/JPL products (US Government works, no copyright in the US) or openly licensed software. This project is an independent entry to the NASA Space Apps Challenge 2026. It is not a NASA product and is not endorsed by NASA.

## Data

| What | Used for | Source |
|---|---|---|
| LRO LOLA `LDEM_80S_80M` (IMG + LBL), PDS data set `LRO-L-LOLA-4-GDR-V1.0`, product V2.0, 2017 | Terrain mesh, horizon masks, overview map | NASA PDS Geosciences Node: https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/ldem_80s_80m.img (label: same path, `.lbl`) |
| LOLA polar projection catalog `DSMAP_POLAR.CAT` | Projection equations and orientation | https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/catalog/dsmap_polar.cat |
| JPL planetary ephemeris DE440 (`de440s.bsp`) | Sun, Earth and Moon positions | NAIF: https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp |
| DE440 lunar orientation (`moon_pa_de440_200625.bpc`) | Moon orientation (libration) | NAIF: https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/moon_pa_de440_200625.bpc |
| Lunar frame kernel (`moon_de440_250416.tf`), frame `MOON_ME_DE440_ME421` | Mean-Earth frame matching LOLA's DE421 ME frame | NAIF: https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/satellites/moon_de440_250416.tf |
| Planetary constants `pck00011.tpc` | Moon radius (1737.4 km) | NAIF: https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc |
| JPL Horizons API | Independent validation of Sun/Earth az/el | https://ssd.jpl.nasa.gov/api/horizons.api (docs: https://ssd-api.jpl.nasa.gov/doc/horizons.html) |
| Candidate site coordinates | Site list | NASA M2M-30044 *Moon to Mars Lunar Surface Data Book*, Baseline, 18 Mar 2025, Table A2.1-1 (p. 75). https://ntrs.nasa.gov/citations/20250002845 . Site names and numbers follow Mazarico et al. (2011), *Icarus* 211(2), doi:10.1016/j.icarus.2010.10.030 |

## Software

| Package | License | Use |
|---|---|---|
| three.js r170 (vendored in `web/vendor/three.module.js`, license in `web/vendor/THREE_LICENSE.txt`) | MIT | 3D rendering |
| Skyfield | MIT | Ephemeris computation |
| jplephem (Skyfield dependency) | MIT | Reading SPICE kernels |
| NumPy | BSD-3-Clause | Numerics |
| requests | Apache-2.0 | HTTP |
| pytest | MIT | Tests |

## Fonts

IBM Plex Sans Condensed and IBM Plex Mono (SIL Open Font License 1.1), loaded from Google Fonts. If the fonts fail to load, the page falls back to system fonts.

## Assets

No third-party images or textures are used. The Earth is a plain sphere lit from the true Sun direction. The fine surface texture on the near terrain is procedural noise, labelled in the app as illustrative and below the 80 m data resolution.
