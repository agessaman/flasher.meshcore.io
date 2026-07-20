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

`--config` (legacy) derives the set from config.json's static
`version[].files[]` entries, taking the download host from its `staticPath`.
Kept so existing workflow invocations keep working unchanged; output is
byte-identical to the pre-dual-mode script.

Usage:
    # Preferred — from the build output:
    gen-slim-manifests.py --bin-dir out --out-dir v \
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

# "<env>-v<MAJOR.MINOR.PATCH>[-<channel-tag>]-<hash>.bin"  (app-only
# flash-update asset). The optional lowercase channel tag ("-dev") is what the
# dev channel inserts via build.sh's FILENAME_CHANNEL_TAG; production names
# carry none. A "-merged.bin" cannot match: the hash class excludes '-' and
# non-hex letters.
ASSET_RE = re.compile(r"^(?P<env>.+)-v\d+\.\d+\.\d+(?:-[a-z]+)?-(?P<hash>[0-9a-f]{7,40})\.bin$")


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
        print(empty_msg, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
