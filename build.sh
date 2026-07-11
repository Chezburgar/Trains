#!/usr/bin/env bash
# Regenerate textures and package the .mcaddon
set -euo pipefail
cd "$(dirname "$0")"
python3 tools/gen_textures.py
python3 tools/package.py
