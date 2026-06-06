#!/usr/bin/env python3
"""Update config.json firmware filenames and changelog notes in place.

Usage:
    update-firmware.py <new-short-hash> [notes-file]

This rewrites two things via targeted regex replacement on the raw text
(not a full JSON reserialize), so the file's hand-formatting is preserved
and the diff stays minimal:

  1. The git short hash embedded in every observer firmware filename
     (both the "flash-update" .bin and the "flash-wipe" -merged.bin).
  2. Optionally, the per-version "notes" changelog, replaced with the
     contents of <notes-file> for every entry.

Only firmware filename hash tokens and "notes" values are touched. The
"notice" partition/filesystem warning banners are intentionally left
untouched (the "notes" anchor never matches "notice").
"""
import json
import re
import sys
from pathlib import Path

CONFIG = Path(__file__).resolve().parent.parent / "config.json"


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: update-firmware.py <new-short-hash> [notes-file]")

    new_hash = sys.argv[1]
    if not re.fullmatch(r"[0-9a-f]{7,40}", new_hash):
        sys.exit(f"hash must be 7-40 lowercase hex chars, got: {new_hash!r}")

    text = CONFIG.read_text()

    # 1. Swap the git short hash in every observer firmware filename.
    #    Anchored on _observer_mqtt-<version>-<hash>[.bin | -merged.bin].
    #    The lazy .+? spans the version (e.g. v1.16.0, no 7+ contiguous hex
    #    run) and (-merged)? covers both file variants for both roles.
    text, n_files = re.subn(
        r"(_observer_mqtt-.+?-)[0-9a-f]{7,40}(-merged)?\.bin",
        lambda m: f"{m.group(1)}{new_hash}{m.group(2) or ''}.bin",
        text,
    )
    if n_files == 0:
        sys.exit("no firmware filenames matched; refusing to write")
    print(f"updated {n_files} firmware filename(s) -> hash {new_hash}")

    # 2. Optionally refresh the changelog notes from a single source file.
    if len(sys.argv) >= 3:
        notes = Path(sys.argv[2]).read_text().strip()
        notes_json = json.dumps(notes)  # adds surrounding quotes + escaping
        text, n_notes = re.subn(
            r'"notes":\s*"(?:[^"\\]|\\.)*"',
            lambda _m: '"notes": ' + notes_json,
            text,
        )
        print(f"updated {n_notes} notes entrie(s)")

    # Validate before writing so a bad edit can never land.
    json.loads(text)

    CONFIG.write_text(text)
    print(f"wrote {CONFIG}")


if __name__ == "__main__":
    main()
