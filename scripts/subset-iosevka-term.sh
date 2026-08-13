#!/usr/bin/env bash
# Regenerate src/web/fonts/iosevka-term-{regular,bold}.woff2 from an official
# Iosevka release. Only needed when bumping the font version or widening the
# glyph coverage — the woff2 artifacts are committed.
#
# Requires: gh, unzip, python3 with fontTools + brotli
#   python3 -m venv /tmp/iosevka-subset-venv
#   /tmp/iosevka-subset-venv/bin/pip install fonttools brotli
#
# Usage: scripts/subset-iosevka-term.sh <iosevka-version> [pyftsubset-path]
# Example: scripts/subset-iosevka-term.sh 34.8.0 /tmp/iosevka-subset-venv/bin/pyftsubset
set -euo pipefail

VERSION="${1:?usage: subset-iosevka-term.sh <version> [pyftsubset-path]}"
PYFTSUBSET="${2:-pyftsubset}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$REPO_ROOT/src/web/fonts"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# Unicode coverage: ASCII + Latin-1/Ext-A for the primary-font case (Android),
# then the symbol blocks terminals actually hit — punctuation (— … ·), arrows,
# math operators (≤ ≥ ≠), Misc Technical (⌘ ⏵ ⏻), box drawing, block elements
# (█ ░ ▒ ▓ progress bars), geometric shapes (▾ ▸), misc symbols, dingbats
# (✓ ✕), arrows-B, and the Powerline private-use range.
RANGES="U+0020-007E,U+00A0-00FF,U+0100-017F,U+2000-206F,U+2190-21FF,U+2200-22FF,U+2300-23FF,U+2500-257F,U+2580-259F,U+25A0-25FF,U+2600-26FF,U+2700-27BF,U+2B00-2BFF,U+E0A0-E0D7"

cd "$WORK_DIR"
gh release download "v$VERSION" -R be5invis/Iosevka -p "PkgWebFont-IosevkaTerm-$VERSION.zip"
unzip -q "PkgWebFont-IosevkaTerm-$VERSION.zip" "TTF/IosevkaTerm-Regular.ttf" "TTF/IosevkaTerm-Bold.ttf"

for weight in Regular Bold; do
  out="$OUT_DIR/iosevka-term-$(echo "$weight" | tr '[:upper:]' '[:lower:]').woff2"
  "$PYFTSUBSET" "TTF/IosevkaTerm-$weight.ttf" \
    --unicodes="$RANGES" \
    --flavor=woff2 \
    --no-hinting \
    --layout-features='' \
    --name-IDs='1,2,3,4,6,13,14' \
    --output-file="$out"
  echo "wrote $out ($(stat -c%s "$out" 2>/dev/null || stat -f%z "$out") bytes)"
done
