#!/usr/bin/env python3
"""Build webconfig-demo.html — the portal page wired to the browser simulator.

/webconfig frames the REAL configuration page (webui/index.html, straight out of
the firmware repo) and runs it against lib/webconfig-sim.js, which intercepts
fetch() so nothing needs a device. This script does the wiring: it takes the
page verbatim and injects the simulator's <script> ahead of the page's own, so
boot() and everything after it hit the simulator instead of the network.

The page is NOT edited beyond that injection and a small style block for the
"simulator" badge. Keeping it verbatim is the point: what the docs show is what
the firmware serves, so the demo cannot quietly drift from the product the way
a folder of screenshots does.

    python3 scripts/build-webconfig-demo.py ../MeshCore/webui/index.html

Source defaults to $MESHCORE/webui/index.html, then ../MeshCore/webui/index.html.
Docs follow the release channel, so take it from a checkout of observer-firmware
(main) once the portal CLI has landed there; until then, from observer-firmware-dev.

Stdlib only.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
OUTPUT = os.path.join(ROOT, "webconfig-demo.html")

INJECT = '<script src="/lib/webconfig-sim.js"></script>\n'

# The badge, and room for it. Appended to the page's own <style> so the file
# stays a single self-contained document.
BADGE_CSS = """
/* --- added by scripts/build-webconfig-demo.py for /webconfig --- */
#sim-note{position:fixed;left:0;right:0;bottom:0;z-index:60;text-align:center;
  font-size:11px;letter-spacing:.02em;padding:5px 8px;background:#161d27;
  color:#7d8ea3;border-top:1px solid #232d3a;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
body{padding-bottom:112px}
"""


def find_source():
    if len(sys.argv) > 1:
        return sys.argv[1]
    for cand in (os.path.join(os.environ.get("MESHCORE", ""), "webui", "index.html"),
                 os.path.join(ROOT, "..", "MeshCore", "webui", "index.html")):
        if cand and os.path.isfile(cand):
            return cand
    sys.exit("usage: build-webconfig-demo.py <path/to/MeshCore/webui/index.html>")


def main():
    src = find_source()
    html = open(src, encoding="utf-8").read()

    if "</style>" not in html or "<script>" not in html:
        sys.exit("ERROR: %s does not look like the portal page" % src)
    if "webconfig-sim.js" in html:
        sys.exit("ERROR: %s already carries the simulator; use a clean copy" % src)

    # Badge styles onto the end of the page's own stylesheet.
    html = html.replace("</style>", BADGE_CSS + "</style>", 1)
    # Simulator ahead of the page's script, which is the last one in the file.
    cut = html.rindex("<script>")
    html = html[:cut] + INJECT + html[cut:]

    with open(OUTPUT, "w", encoding="utf-8") as f:
        f.write(html)
    print("%s\n  -> %s (%d bytes)" % (src, os.path.relpath(OUTPUT, ROOT), len(html)))
    print("  source page is used verbatim apart from the injected <script> and badge CSS")


if __name__ == "__main__":
    main()
