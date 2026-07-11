#!/usr/bin/env python3
"""Bundle Trains_BP + Trains_RP into dist/TrainsRailway.mcaddon."""
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
os.makedirs(DIST, exist_ok=True)
OUT = os.path.join(DIST, "TrainsRailway.mcaddon")

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for pack in ("Trains_BP", "Trains_RP"):
        for dirpath, _, filenames in os.walk(os.path.join(ROOT, pack)):
            for fn in sorted(filenames):
                p = os.path.join(dirpath, fn)
                z.write(p, os.path.relpath(p, ROOT))

print("packaged", OUT)
