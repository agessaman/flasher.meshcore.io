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

# --prune deletes manifests this run did not write (an env that stopped being
# built), keeps the ones it did, and leaves unrelated non-.json files alone.
mkdir -p "$WORK/prunebin" "$WORK/pruneout"
touch "$WORK/prunebin/Live_repeater_observer_mqtt-v1.16.0.7-abcdef1.bin"
printf '{"stale":true}\n' > "$WORK/pruneout/Retired_repeater_observer_mqtt.json"
printf '{"stale":true}\n' > "$WORK/pruneout/Live_repeater_observer_mqtt.json"
touch "$WORK/pruneout/README.txt"
python3 scripts/gen-slim-manifests.py --bin-dir "$WORK/prunebin" \
  --static-path https://x.example --out-dir "$WORK/pruneout" --prune \
  --base-version v1.16.0 --build 7 >/dev/null
if [ ! -e "$WORK/pruneout/Retired_repeater_observer_mqtt.json" ] \
   && jq -e '.hash == "abcdef1"' "$WORK/pruneout/Live_repeater_observer_mqtt.json" >/dev/null 2>&1 \
   && [ -e "$WORK/pruneout/README.txt" ]; then
  echo "PASS: --prune removes retired manifests, keeps live ones and non-.json"
else
  echo "FAIL: --prune behaviour"; ls -1 "$WORK/pruneout"; fail=1
fi

# Without --prune the generator must stay purely additive (the old behaviour
# every existing caller relies on).
mkdir -p "$WORK/nopruneout"
printf '{"stale":true}\n' > "$WORK/nopruneout/Retired_repeater_observer_mqtt.json"
python3 scripts/gen-slim-manifests.py --bin-dir "$WORK/prunebin" \
  --static-path https://x.example --out-dir "$WORK/nopruneout" \
  --base-version v1.16.0 --build 7 >/dev/null
if [ -e "$WORK/nopruneout/Retired_repeater_observer_mqtt.json" ]; then
  echo "PASS: without --prune the generator stays additive"
else
  echo "FAIL: generator pruned without --prune"; fail=1
fi

# An empty build output must fail BEFORE pruning — otherwise a broken
# invocation would wipe a whole channel's manifests.
mkdir -p "$WORK/emptybin" "$WORK/emptyout"
printf '{"live":true}\n' > "$WORK/emptyout/Live_repeater_observer_mqtt.json"
python3 scripts/gen-slim-manifests.py --bin-dir "$WORK/emptybin" \
  --static-path https://x.example --out-dir "$WORK/emptyout" --prune \
  --base-version v1.16.0 --build 7 >/dev/null 2>&1 \
  && { echo "FAIL: empty --bin-dir did not fail"; fail=1; } \
  || if [ -e "$WORK/emptyout/Live_repeater_observer_mqtt.json" ]; then
       echo "PASS: empty --bin-dir fails without pruning anything"
     else
       echo "FAIL: empty --bin-dir pruned the out-dir"; fail=1
     fi

# The prune cap: a build that lost envs must fail the run with the out-dir
# INTACT, rather than deleting the manifests of boards that are still shipping.
mkdir -p "$WORK/capbin" "$WORK/capout"
touch "$WORK/capbin/Live_repeater_observer_mqtt-v1.16.0.7-abcdef1.bin"
for n in A B C D E; do
  printf '{"live":true}\n' > "$WORK/capout/Lost${n}_repeater_observer_mqtt.json"
done
python3 scripts/gen-slim-manifests.py --bin-dir "$WORK/capbin" \
  --static-path https://x.example --out-dir "$WORK/capout" --prune \
  --base-version v1.16.0 --build 7 >/dev/null 2>&1 \
  && { echo "FAIL: prune cap did not trip on 5 > default limit 4"; fail=1; } \
  || if [ "$(ls "$WORK/capout"/Lost*.json | wc -l | tr -d ' ')" = "5" ]; then
       echo "PASS: prune cap fails the run and leaves the out-dir intact"
     else
       echo "FAIL: prune cap deleted files before failing"; fail=1
     fi
# Raising the limit lets the same prune through.
python3 scripts/gen-slim-manifests.py --bin-dir "$WORK/capbin" \
  --static-path https://x.example --out-dir "$WORK/capout" --prune --prune-limit 5 \
  --base-version v1.16.0 --build 7 >/dev/null
if [ -z "$(ls "$WORK/capout"/Lost*.json 2>/dev/null)" ]; then
  echo "PASS: --prune-limit raises the cap"
else
  echo "FAIL: --prune-limit did not raise the cap"; fail=1
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
python3 scripts/gen-slim-manifests.py --config "$WORK/legacy-config.json" --prune \
  --out-dir "$WORK/x" --base-version v0 --build 0 2>/dev/null \
  && { echo "FAIL: --config accepted --prune"; fail=1; } \
  || echo "PASS: --config rejects --prune"

exit $fail
