#!/usr/bin/env bash
# Verification gate for gen-slim-manifests.py (see the dual-mode rework).
#
# The committed v/*.json ARE the previous script's real production output, so
# they double as the golden baseline:
#
#   1. NEW --config          == committed v/   (legacy mode preserved byte-for-byte)
#   2. NEW --bin-dir         == committed v/   (new mode equivalent on the same asset set)
#
# For (2) a build-output directory is reconstructed from the committed
# manifests themselves: one empty <asset>.bin per manifest 'file' basename
# (the script only reads filenames) plus <env>.partsig from 'partSig'.
#
# Run from the repo root:  bash scripts/test-gen-slim-manifests.sh
set -euo pipefail

cd "$(dirname "$0")/.."
[ -d v ] && [ -f config.json ] || { echo "run from a checkout with v/ and config.json"; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

BASE=$(jq -r '.baseVersion' v/*.json | sort -u)
BUILD=$(jq -r '.build' v/*.json | sort -u)
[ "$(wc -l <<<"$BASE")" -eq 1 ] && [ "$(wc -l <<<"$BUILD")" -eq 1 ] \
  || { echo "FAIL: committed v/ mixes baseVersion/build values"; exit 1; }
STATIC=$(jq -r '.staticPath' config.json)

# Reconstruct the build output from the committed manifests.
mkdir -p "$WORK/bin" "$WORK/partsig"
for f in v/*.json; do
  env=$(basename "$f" .json)
  touch "$WORK/bin/$(jq -r '.file' "$f" | sed 's|.*/||')"
  sig=$(jq -r '.partSig // empty' "$f")
  [ -n "$sig" ] && printf '%s\n' "$sig" > "$WORK/partsig/$env.partsig"
done

fail=0
check() { # label dir
  if diff -r "v" "$2" >/dev/null 2>&1; then
    echo "PASS: $1 == committed v/ ($(ls "$2" | wc -l | tr -d ' ') files)"
  else
    echo "FAIL: $1 differs from committed v/:"
    diff -r "v" "$2" | head -20
    fail=1
  fi
}

python3 scripts/gen-slim-manifests.py --config config.json \
  --out-dir "$WORK/legacy" --base-version "$BASE" --build "$BUILD" \
  --partsig-dir "$WORK/partsig" >/dev/null
check "--config (legacy mode)" "$WORK/legacy"

python3 scripts/gen-slim-manifests.py --bin-dir "$WORK/bin" \
  --static-path "$STATIC" --out-dir "$WORK/bindir" \
  --base-version "$BASE" --build "$BUILD" \
  --partsig-dir "$WORK/partsig" >/dev/null
check "--bin-dir (new mode)  " "$WORK/bindir"

# Guard rails: the modes must stay mutually exclusive and correctly gated.
python3 scripts/gen-slim-manifests.py --config config.json --static-path x \
  --out-dir "$WORK/x" --base-version v0 --build 0 2>/dev/null \
  && { echo "FAIL: --config accepted --static-path"; fail=1; } \
  || echo "PASS: --config rejects --static-path"
python3 scripts/gen-slim-manifests.py --bin-dir "$WORK/bin" \
  --out-dir "$WORK/x" --base-version v0 --build 0 2>/dev/null \
  && { echo "FAIL: --bin-dir accepted missing --static-path"; fail=1; } \
  || echo "PASS: --bin-dir requires --static-path"

exit $fail
