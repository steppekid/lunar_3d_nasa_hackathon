"""Shared constants, paths and the candidate site list.

Every number here is traceable to a source; see docs/ATTRIBUTION.md.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_RAW = ROOT / "data" / "raw"
KERNELS = ROOT / "data" / "kernels"
CACHE = ROOT / "data" / "cache"
WEB_DATA = ROOT / "web" / "data"

# --- Terrain: LOLA LDEM_80S_80M (values read from ldem_80s_80m.lbl, PDS3 label) ---
DEM_IMG = DATA_RAW / "ldem_80s_80m.img"
DEM_LBL = DATA_RAW / "ldem_80s_80m.lbl"
DEM_URL = ("https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/"
           "lrolol_1xxx/data/lola_gdr/polar/img/ldem_80s_80m.img")
DEM_LBL_URL = DEM_URL.replace(".img", ".lbl")

# Mean lunar radius; also the LOLA reference sphere (label: OFFSET = 1737400 m,
# A/B/C_AXIS_RADIUS = 1737.4 km) and the IAU/pck00011 Moon radius.
MOON_RADIUS_M = 1737400.0

OBSERVER_HEIGHT_M = 2.0

# --- Ephemeris kernels (NAIF generic_kernels) ---
KERNEL_FILES = {
    "de440s.bsp": "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp",
    "moon_pa_de440_200625.bpc": "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/moon_pa_de440_200625.bpc",
    "moon_de440_250416.tf": "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/satellites/moon_de440_250416.tf",
    "pck00011.tpc": "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc",
}
# DE440 lunar orientation expressed in a Mean-Earth frame aligned with DE421 ME,
# which is the frame of the LOLA products and of Horizons' lunar site coordinates.
MOON_FRAME = "MOON_ME_DE440_ME421"

# Radii used for angular size. Sun: IAU 2015 nominal solar radius.
# Earth: IUGG mean radius. (Earth's flattening changes its angular size by <0.2%.)
SUN_RADIUS_KM = 695700.0
EARTH_RADIUS_KM = 6371.0

# --- Time grid ---
T_START = "2027-01-01T00:00:00Z"
T_END = "2028-12-31T23:00:00Z"   # inclusive
T_STEP_HOURS = 1

# --- Horizon mask ---
MASK_AZ_STEP_DEG = 0.25
MASK_RAY_STEP_M = 40.0            # half a DEM pixel
MASK_MAX_RANGE_M = 300_000.0      # rays stop earlier at the DEM edge

# --- Candidate sites ---
# Source: NASA M2M-30044 "Moon to Mars Lunar Surface Data Book", Baseline,
# 18 Mar 2025, Table A2.1-1 "Lunar South Pole Features" (p. 75),
# https://ntrs.nasa.gov/citations/20250002845 . The Data Book states the
# coordinates are centre points of region polygons from Mazarico et al. (2011),
# generated from the PGDA South Pole LOLA DEMs and accurate to 5-10 m.
# Latitude planetocentric, longitude east, MOON_ME (DE421) frame.
SITES = [
    {"id": "cr",  "ref": "Site01", "name": "Connecting ridge",      "lat": -89.4632, "lon": -137.4900},
    {"id": "sr",  "ref": "Site04", "name": "Shackleton rim",        "lat": -89.7668, "lon": -171.8700},
    {"id": "nr1", "ref": "Site06", "name": "Nobile rim 1",          "lat": -85.4381, "lon":   37.36667},
    {"id": "ps",  "ref": "Site07", "name": "Peak near Shackleton",  "lat": -88.8110, "lon":  123.6901},
    {"id": "dg",  "ref": "Site11", "name": "de Gerlache rim 1",     "lat": -88.6834, "lon":  -67.9321},
    {"id": "lbp", "ref": "Site20", "name": "Leibnitz beta plateau", "lat": -85.4266, "lon":   31.74276},
]
SITE_SOURCE = ("NASA M2M-30044 Lunar Surface Data Book (Baseline, 2025-03-18), "
               "Table A2.1-1, p.75")
