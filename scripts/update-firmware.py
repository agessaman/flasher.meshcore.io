#!/usr/bin/env python3
"""Update config.json firmware filenames and changelog notes in place.

Usage:
    update-firmware.py <new-short-hash> [notes-file] [--config PATH]

--config selects which config file to rewrite, so a parallel release channel
(e.g. config-beta.json) can be published without touching production. Defaults
to this repo's config.json, so existing callers are unaffected.

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

DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "config.json"


def main():
    # Pull --config out of argv first so the positional arguments keep their
    # existing meaning for callers that don't pass it.
    argv = sys.argv[1:]
    config = DEFAULT_CONFIG
    if "--config" in argv:
        i = argv.index("--config")
        if i + 1 >= len(argv):
            sys.exit("--config requires a path")
        config = Path(argv[i + 1])
        del argv[i:i + 2]

    if len(argv) < 1:
        sys.exit("usage: update-firmware.py <new-short-hash> [notes-file] [--config PATH]")

    new_hash = argv[0]
    if not re.fullmatch(r"[0-9a-f]{7,40}", new_hash):
        sys.exit(f"hash must be 7-40 lowercase hex chars, got: {new_hash!r}")

    if not config.is_file():
        sys.exit(f"config not found: {config}")

    text = config.read_text()

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
    if len(argv) >= 2:
        notes = Path(argv[1]).read_text().strip()
        notes_json = json.dumps(notes)  # adds surrounding quotes + escaping
        text, n_notes = re.subn(
            r'"notes":\s*"(?:[^"\\]|\\.)*"',
            lambda _m: '"notes": ' + notes_json,
            text,
        )
        print(f"updated {n_notes} notes entrie(s)")

    # Validate before writing so a bad edit can never land.
    json.loads(text)

    config.write_text(text)
    print(f"wrote {config}")


if __name__ == "__main__":
    main()
