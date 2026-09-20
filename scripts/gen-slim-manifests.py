#!/usr/bin/env python3
"""Generate slim per-variant OTA manifests.

The observer firmware's `ota check` / `ota update` commands fetch a tiny
per-variant file (v/<env>.json, ~180 bytes) instead of the full ~40 KB
config.json. Keeping the body tiny is what lets `ota check` run with the MQTT
bridge still up on no-PSRAM boards (only the TLS handshake costs heap).

For each app-only (`flash-update`) binary we emit:

    {
      "baseVersion": "v1.16.0",
      "build": 5,
      "version": "v1.16.0.5",
      "hash": "454afec",
      "file": "https://observer-fw.gessaman.com/<env>-v1.16.0-454afec.bin",
      "partSig": "..."
    }

`<env>` is the PlatformIO env name = the asset-filename prefix = the firmware's
baked-in OTA_VARIANT, so the device fetches <base>/<env>.json.

Two source modes, mutually exclusive:

`--bin-dir` (preferred) walks the build output directory and emits one manifest
per app-only `*.bin` actually present. The manifests then describe what was
really built and published — a hand-maintained config cannot drift from them.

`--prune` (only with `--bin-dir`) additionally deletes manifests in `--out-dir`
that this run did not write. Without it the generator only ever adds: when an
env stops being built — e.g. `LilyGo_TLora_V2_1_1_6_*_observer_mqtt_`, disabled
by the trailing underscore that hides it from the workflow's env-discovery
grep — its manifest stayed behind pointing at a release asset that later got
pruned, so any node still on that build asked OTA to fetch a 404.
A failed env cannot cause a wrong prune: build.sh is `set -e` over an unguarded
`pio run`, so it aborts the shard, the job fails and the release job (`needs:
build`) never runs. The residual risk is the quieter one — build.sh's
`cp .pio/build/$1/firmware.bin out/ || true` means a `pio` that exits 0 without
emitting a binary drops that env from out/ silently. So the prune is capped
(`--prune-limit`, default 4): retiring an env is a rare, deliberate, one-or-two
-env act, while a build that silently lost envs blows past the cap and fails the
run instead of deleting the OTA manifests of boards that are still shipping.

`--config` (legacy) derives the set from config.json's static
`version[].files[]` entries, taking the download host from its `staticPath`.
Kept so existing workflow invocations keep working unchanged; output is
byte-identical to the pre-dual-mode script.

Usage:
    # Preferred — from the build output:
    gen-slim-manifests.py --bin-dir out --out-dir v --prune \
        --static-path https://observer-fw.gessaman.com \
        --base-version v1.16.0 --build 5 --partsig-dir out

    # Legacy — from the web-flasher config.json:
    gen-slim-manifests.py --config config.json --out-dir v \
        --base-version v1.16.0 --build 5
"""
import argparse
import json
import re
import sys
from pathlib import Path

# "<env>-v<MAJOR.MINOR.PATCH>[.<BUILD>][-<channel-tag>]-<hash>.bin"  (app-only
# flash-update asset). The optional 4th ".<BUILD>" component is the per-base
# published build number that build.sh stamps into the filename (so the flasher
# dropdown shows the true build); production builds before this change carry
# none, so it stays optional. The optional lowercase channel tag ("-dev") is
# what the dev channel inserts via build.sh's FILENAME_CHANNEL_TAG; production
# names carry none. A "-merged.bin" cannot match: the hash class excludes '-'
# and non-hex letters.
ASSET_RE = re.compile(r"^(?P<env>.+)-v\d+\.\d+\.\d+(?:\.\d+)?(?:-[a-z]+)?-(?P<hash>[0-9a-f]{7,40})\.bin$")


def assets_from_config(config_path):
    """(static_path, [(asset-name, env, hash)]) from config.json's static entries."""
    cfg = json.loads(Path(config_path).read_text())
    static_path = cfg["staticPath"].rstrip("/")
    assets = []
    for dev in cfg.get("device", []):
        for fw in dev.get("firmware", []):
            for ver in fw.get("version", {}).values():
                for f in ver.get("files", []):
                    if f.get("type") != "flash-update":
                        continue  # app-only binary only; never -merged
                    name = f.get("name", "")
                    m = ASSET_RE.match(name)
                    if not m:
                        print(f"WARNING: unrecognized asset name, skipped: {name}", file=sys.stderr)
                        continue
                    assets.append((name, m.group("env"), m.group("hash")))
    return static_path, assets


def assets_from_bin_dir(bin_dir):
    """[(asset-name, env, hash)] for each app-only *.bin in the build output."""
    assets = []
    for p in sorted(Path(bin_dir).glob("*.bin")):
        if p.name.endswith("-merged.bin"):
            continue  # wipe/first-flash image; OTA fetches the app-only binary
        m = ASSET_RE.match(p.name)
        if not m:
            print(f"WARNING: unrecognized asset name, skipped: {p.name}", file=sys.stderr)
            continue
        assets.append((p.name, m.group("env"), m.group("hash")))
    return assets


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--config", help="path to config.json (legacy source)")
    src.add_argument("--bin-dir", help="build output directory of published *.bin assets")
    ap.add_argument("--static-path",
                    help="download host prefix for 'file' URLs (required with --bin-dir; "
                         "--config mode takes it from config.json's staticPath)")
    ap.add_argument("--out-dir", required=True, help="directory for v/<env>.json files")
    ap.add_argument("--base-version", required=True, help="MeshCore base version, e.g. v1.16.0")
    ap.add_argument("--build", required=True, type=int, help="published build number N")
    ap.add_argument("--partsig-dir", default=None,
                    help="directory of <env>.partsig files (partition-table signatures from build.sh)")
    ap.add_argument("--prune", action="store_true",
                    help="delete <out-dir>/*.json not written by this run (requires --bin-dir, "
                         "where the build output is the authoritative env list)")
    ap.add_argument("--prune-limit", type=int, default=4,
                    help="fail instead of pruning if more than N manifests would be deleted "
                         "(default 4); a large prune means a broken build, not a retirement")
    args = ap.parse_args()

    if args.bin_dir:
        if not args.static_path:
            ap.error("--bin-dir requires --static-path")
        static_path = args.static_path.rstrip("/")
        assets = assets_from_bin_dir(args.bin_dir)
        empty_msg = f"ERROR: no app-only *.bin assets found in {args.bin_dir}/"
    else:
        if args.static_path:
            ap.error("--static-path is only valid with --bin-dir "
                     "(--config mode uses config.json's staticPath)")
        if args.prune:
            ap.error("--prune is only valid with --bin-dir "
                     "(--config mode's env list comes from a hand-maintained file, "
                     "so absence there does not mean an env stopped being built)")
        static_path, assets = assets_from_config(args.config)
        empty_msg = "ERROR: no flash-update assets found in config.json"

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    partsig_dir = Path(args.partsig_dir) if args.partsig_dir else None

    written = 0
    for name, env, asset_hash in assets:
        slim = {
            "baseVersion": args.base_version,
            "build": args.build,
            "version": f"{args.base_version}.{args.build}",
            "hash": asset_hash,
            "file": f"{static_path}/{name}",
        }
        # Partition-table signature for the OTA compatibility check. The
        # firmware compares this to its flashed table and refuses only on
        # a real mismatch — replacing the old blanket partitionChange flag
        # (which is left in config.json purely as a web-flasher first-flash
        # hint and is no longer used to gate OTA).
        if partsig_dir:
            pf = partsig_dir / f"{env}.partsig"
            if pf.is_file():
                slim["partSig"] = pf.read_text().strip()
            else:
                print(f"WARNING: no partsig for {env}", file=sys.stderr)
        (out_dir / f"{env}.json").write_text(json.dumps(slim, indent=2) + "\n")
        written += 1

    print(f"wrote {written} slim manifest(s) to {out_dir}/")
    if written == 0:
        # Guard the prune below: an empty asset list means a broken invocation,
        # not that every env was retired, and pruning on it would wipe the channel.
        print(empty_msg, file=sys.stderr)
        return 1

    if args.prune:
        keep = {f"{env}.json" for _, env, _ in assets}
        stale = [p for p in sorted(out_dir.glob("*.json")) if p.name not in keep]
        # Decide on the whole set before deleting any of it, so tripping the cap
        # leaves the directory untouched rather than half-pruned.
        if len(stale) > args.prune_limit:
            print(f"ERROR: {len(stale)} manifests in {out_dir}/ have no binary in "
                  f"{args.bin_dir}/, over --prune-limit={args.prune_limit}. That is a "
                  f"build that lost envs, not a retirement; refusing to prune.",
                  file=sys.stderr)
            for p in stale:
                print(f"  would have pruned: {p.name}", file=sys.stderr)
            return 1
        for p in stale:
            p.unlink()
            print(f"pruned stale manifest (env no longer built): {p.name}")
        print(f"pruned {len(stale)} stale manifest(s) from {out_dir}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
