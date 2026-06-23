#!/usr/bin/env python3
"""Generate slim per-variant OTA manifests from the web-flasher config.json.

The observer firmware's `ota check` / `ota update` commands fetch a tiny
per-variant file (v/<env>.json, ~180 bytes) instead of the full ~40 KB
config.json. Keeping the body tiny is what lets `ota check` run with the MQTT
bridge still up on no-PSRAM boards (only the TLS handshake costs heap).

config.json stays the single source of truth; these slim files are derived from
it. For each observer firmware's `flash-update` (app-only) binary we emit:

    {
      "baseVersion": "v1.16.0",
      "build": 5,
      "version": "v1.16.0.5",
      "hash": "454afec",
      "file": "https://observer-fw.gessaman.com/<env>-v1.16.0-454afec.bin",
      "partitionChange": false
    }

`<env>` is the PlatformIO env name = the asset-filename prefix = the firmware's
baked-in OTA_VARIANT, so the device fetches <base>/<env>.json.

Usage:
    gen-slim-manifests.py --config config.json --out-dir v \
        --base-version v1.16.0 --build 5
"""
import argparse
import json
import re
import sys
from pathlib import Path

# "<env>-v<MAJOR.MINOR.PATCH>-<hash>.bin"  (app-only flash-update asset).
ASSET_RE = re.compile(r"^(?P<env>.+)-v\d+\.\d+\.\d+-(?P<hash>[0-9a-f]{7,40})\.bin$")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", required=True, help="path to config.json")
    ap.add_argument("--out-dir", required=True, help="directory for v/<env>.json files")
    ap.add_argument("--base-version", required=True, help="MeshCore base version, e.g. v1.16.0")
    ap.add_argument("--build", required=True, type=int, help="published build number N")
    args = ap.parse_args()

    cfg = json.loads(Path(args.config).read_text())
    static_path = cfg["staticPath"].rstrip("/")
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    written = 0
    for dev in cfg.get("device", []):
        for fw in dev.get("firmware", []):
            partition_change = fw.get("notice") == "partition-change"
            for ver in fw.get("version", {}).values():
                for f in ver.get("files", []):
                    if f.get("type") != "flash-update":
                        continue  # app-only binary only; never -merged
                    name = f.get("name", "")
                    m = ASSET_RE.match(name)
                    if not m:
                        print(f"WARNING: unrecognized asset name, skipped: {name}", file=sys.stderr)
                        continue
                    env = m.group("env")
                    slim = {
                        "baseVersion": args.base_version,
                        "build": args.build,
                        "version": f"{args.base_version}.{args.build}",
                        "hash": m.group("hash"),
                        "file": f"{static_path}/{name}",
                        "partitionChange": partition_change,
                    }
                    (out_dir / f"{env}.json").write_text(json.dumps(slim, indent=2) + "\n")
                    written += 1

    print(f"wrote {written} slim manifest(s) to {out_dir}/")
    if written == 0:
        print("ERROR: no flash-update assets found in config.json", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
