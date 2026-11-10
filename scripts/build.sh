#!/usr/bin/env bash
# Build the static site into _site/ (used by `task build` and the Pages workflow).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-_site}"
VERSION="${BUILD_VERSION:-$(git rev-parse --short=8 HEAD 2>/dev/null || date +%s)}"
rm -rf "$OUT"
mkdir -p "$OUT"
cp -r index.html styles.css manifest.webmanifest sw.js .nojekyll js vendor icons "$OUT"/
# bust the service-worker cache on every deploy
sed -i.bak "s/__BUILD__/${VERSION}/" "$OUT/sw.js" && rm "$OUT/sw.js.bak"
sed -i.bak "s/__BUILD__/${VERSION}/" "$OUT/js/version.js" && rm "$OUT/js/version.js.bak"
echo "Built $OUT (version $VERSION)"
