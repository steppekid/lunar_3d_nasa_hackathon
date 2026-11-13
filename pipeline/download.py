"""Download the input data (about 160 MB) into data/raw and data/kernels.

    python pipeline/download.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lunar import config  # noqa: E402

FILES = [
    (config.DEM_LBL_URL, config.DEM_LBL),
    (config.DEM_URL, config.DEM_IMG),
    *[(url, config.KERNELS / name) for name, url in config.KERNEL_FILES.items()],
]


def fetch(url: str, dest: Path):
    if dest.exists() and dest.stat().st_size > 0:
        print(f"ok   {dest.name} (already present)")
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        done = 0
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
                done += len(chunk)
                if total:
                    print(f"\r...  {dest.name} {done / total:6.1%}", end="", flush=True)
    tmp.replace(dest)
    print(f"\rget  {dest.name} ({done / 1e6:.1f} MB)       ")


if __name__ == "__main__":
    for url, dest in FILES:
        fetch(url, dest)
