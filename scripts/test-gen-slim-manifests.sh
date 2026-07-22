#!/usr/bin/env bash
# Verification gate for gen-slim-manifests.py (see the dual-mode rework).
#
# The committed v/*.json ARE real production output, so they double as the
# golden baseline:
#
#   1. --config  == committed v/   (legacy mode preserved byte-for-byte)
#   2. --bin-dir == committed v/   (new mode equivalent on the same asset set)
#
# Both inputs are reconstructed from the committed manifests themselves: a
# build-output dir with one empty <asset>.bin per manifest 'file' basename (the
# script only reads filenames) plus <env>.partsig from 'partSig'; and, for the
# legacy check, a synthetic config.json with static version/files entries —
# the real config.json switched to github release defs (feed migration), which
# legacy mode does not read.
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

# Reconstruct the build output + a synthetic legacy config from the committed
# manifests.
mkdir -p "$WORK/bin" "$WORK/partsig"
for f in v/*.json; do
  env=$(basename "$f" .json)
  touch "$WORK/bin/$(jq -r '.file' "$f" | sed 's|.*/||')"
  sig=$(jq -r '.partSig // empty' "$f")
  [ -n "$sig" ] && printf '%s\n' "$sig" > "$WORK/partsig/$env.partsig"
done
jq -s --arg static "$STATIC" '{
  staticPath: $static,
  device: [{ firmware: [{ version: { x: { files:
    [ .[] | { type: "flash-update", name: (.file | sub(".*/"; "")) } ]
  } } }] }]
}' v/*.json > "$WORK/legacy-config.json"

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

python3 scripts/gen-slim-manifests.py --config "$WORK/legacy-config.json" \
  --out-dir "$WORK/legacy" --base-version "$BASE" --build "$BUILD" \
  --partsig-dir "$WORK/partsig" >/dev/null
check "--config (legacy mode)" "$WORK/legacy"

python3 scripts/gen-slim-manifests.py --bin-dir "$WORK/bin" \
  --static-path "$STATIC" --out-dir "$WORK/bindir" \
  --base-version "$BASE" --build "$BUILD" \
  --partsig-dir "$WORK/partsig" >/dev/null
check "--bin-dir (new mode)  " "$WORK/bindir"

# Channel-tagged filenames (the dev channel inserts "-dev" between version and
# hash via build.sh's FILENAME_CHANNEL_TAG): env + hash must parse correctly.
mkdir -p "$WORK/tagbin"
touch "$WORK/tagbin/Foo_repeater_observer_mqtt-v1.16.0-dev-abcdef1.bin" \
      "$WORK/tagbin/Foo_repeater_observer_mqtt-v1.16.0-dev-abcdef1-merged.bin"
python3 scripts/gen-slim-manifests.py --bin-dir "$WORK/tagbin" \
  --static-path https://x.example --out-dir "$WORK/tagout" \
  --base-version v1.16.0 --build 3 >/dev/null
if jq -e '.hash == "abcdef1"' "$WORK/tagout/Foo_repeater_observer_mqtt.json" >/dev/null 2>&1 \
   && [ "$(ls "$WORK/tagout" | wc -l | tr -d ' ')" = "1" ]; then
  echo "PASS: channel-tagged filename (env + hash parsed, merged skipped)"
else
  echo "FAIL: channel-tagged filename handling"; fail=1
fi

# Build-number filenames: the per-base published build number is the 4th version
# component (v1.16.0.5), which build.sh now stamps into the asset name so the
# flasher dropdown shows the true build. env + hash must parse for both
# production (no channel tag) and the dev channel (build number + "-dev" tag),
# and each variant's -merged.bin must be skipped.
mkdir -p "$WORK/buildnumbin"
touch "$WORK/buildnumbin/Prod_repeater_observer_mqtt-v1.16.0.5-abcdef1.bin" \
      "$WORK/buildnumbin/Prod_repeater_observer_mqtt-v1.16.0.5-abcdef1-merged.bin" \
      "$WORK/buildnumbin/Dev_repeater_observer_mqtt-v1.16.0.5-dev-abcdef2.bin" \
      "$WORK/buildnumbin/Dev_repeater_observer_mqtt-v1.16.0.5-dev-abcdef2-merged.bin"
python3 scripts/gen-slim-manifests.py --bin-dir "$WORK/buildnumbin" \
  --static-path https://x.example --out-dir "$WORK/buildnumout" \
  --base-version v1.16.0 --build 5 >/dev/null
if jq -e '.hash == "abcdef1"' "$WORK/buildnumout/Prod_repeater_observer_mqtt.json" >/dev/null 2>&1 \
   && jq -e '.hash == "abcdef2"' "$WORK/buildnumout/Dev_repeater_observer_mqtt.json" >/dev/null 2>&1 \
   && [ "$(ls "$WORK/buildnumout" | wc -l | tr -d ' ')" = "2" ]; then
  echo "PASS: build-number filename (env + hash parsed, merged skipped)"
else
  echo "FAIL: build-number filename handling"; fail=1
fi

# Guard rails: the modes must stay mutually exclusive and correctly gated.
python3 scripts/gen-slim-manifests.py --config "$WORK/legacy-config.json" --static-path x \
  --out-dir "$WORK/x" --base-version v0 --build 0 2>/dev/null \
  && { echo "FAIL: --config accepted --static-path"; fail=1; } \
  || echo "PASS: --config rejects --static-path"
python3 scripts/gen-slim-manifests.py --bin-dir "$WORK/bin" \
  --out-dir "$WORK/x" --base-version v0 --build 0 2>/dev/null \
  && { echo "FAIL: --bin-dir accepted missing --static-path"; fail=1; } \
  || echo "PASS: --bin-dir requires --static-path"

exit $fail
