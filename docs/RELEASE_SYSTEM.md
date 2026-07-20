# Observer Firmware Release System

How firmware gets from a `git push` to a device — the web flasher, the release
channels, OTA updates, and every piece of infrastructure in between. Written
2026-07-20, immediately after the `/releases` feed migration; everything below
describes the system as it exists, with the configuration values in force.

Repos:

| Repo | Role |
|---|---|
| `agessaman/MeshCore` | firmware source + the two publish workflows |
| `agessaman/flasher.meshcore.io` | flasher SPA, OTA manifests, Cloudflare Workers, this doc |

---

## 1. The big picture

```
MeshCore branches                GitHub releases              Cloudflare Workers            Flasher SPA / devices
─────────────────                ───────────────              ──────────────────            ─────────────────────
observer-firmware      ──build──▶ observer-mqtt-latest      ─▶ observer-fw.gessaman.com   ─▶ downloads (stable)
observer-firmware-dev  ──build──▶ observer-mqtt-beta-latest ─▶ observer-fw-beta.gessaman  ─▶ downloads (dev)
                                        │
                                        └───── /releases (on observer-fw) ────────────────▶ Version dropdown
        │
        └─(release job commits to flasher repo)─▶ v/ , beta/v/  (slim OTA manifests) ─────▶ devices (`ota check`)
```

Two fully separated release channels:

| | Production (stable) | Dev/Beta |
|---|---|---|
| Branch | `observer-firmware` (renamed from `mqtt-bridge-implementation-flex`, 2026-07-20) | `observer-firmware-dev` |
| Workflow | `build-observer-firmwares.yml` | `build-observer-firmwares-beta.yml` |
| Release tag | `observer-mqtt-latest` | `observer-mqtt-beta-latest` |
| Download host (Worker) | `observer-fw.gessaman.com` | `observer-fw-beta.gessaman.com` |
| OTA manifest base | `observer.gessaman.com/v` | `observer.gessaman.com/beta/v` |
| Build counter | `observer-build-counter.json` | `observer-beta-build-counter.json` |
| Filename tag | none | `-dev` (`<env>-v1.16.0-dev-<hash>.bin`) |
| Embedded version tag | `-observer-` | `-observer-beta-dev-` |
| Dropdown label | `v1.16.0` (preselected) | `v1.16.0-dev` |

Three invariants hold the separation together:

1. **The channel IS the OTA manifest URL.** `OTA_MANIFEST_BASE` is baked into
   each binary at build time; a node only ever fetches manifests from its own
   channel, so it only ever updates within it. Switching channels requires a
   cable flash.
2. **Separate release tags are mandatory, not cosmetic** — asset pruning
   (`KEEP_BUILDS=2`) runs per tag; a shared tag would make each channel delete
   the other's binaries.
3. **Separate build counters** — the build number is embedded in firmware and
   drives the "N behind" comparison; sharing a counter would interleave the
   channels' numbering.

`FIRMWARE_VERSION` (the base, e.g. `v1.16.0`) MAY diverge between channels
(dev tracks upstream); base versions must stay **dot-only** — the on-device
parser truncates at the first `-`, so `v1.17.0-rc1` collapses to `v1.17.0`.
Use `v1.17.0.N`, never hyphenated pre-release tags.

---

## 2. Firmware side (MeshCore repo)

### 2.1 build.sh

`bash build.sh build-firmware <env>...` produces, per env, in `out/`:

- `<env>-<FIRMWARE_VERSION><FILENAME_CHANNEL_TAG>-<hash>.bin` — app-only
  ("flash-update")
- same + `-merged.bin` — full image ("flash-wipe" / Erase device)
- `<env>.partsig` — partition-table signature (drives the OTA
  partition-compatibility gate)

Environment inputs:

| Var | Effect | Unset ⇒ |
|---|---|---|
| `FIRMWARE_VERSION` | base version in filenames + embedded string | build fails (required) |
| `FIRMWARE_BUILD_NUMBER` | 4th version component in the *embedded* string only (`v1.16.0.5`); filenames never carry it | no 4th component (local builds) |
| `OTA_MANIFEST_BASE_URL` | baked as `OTA_MANIFEST_BASE` | default `https://observer.gessaman.com/v` |
| `OTA_CHANNEL_TAG` | embedded-version channel marker (`-observer-<tag>-`) | plain `-observer-` |
| `FILENAME_CHANNEL_TAG` | filename channel marker between version and hash; **lowercase letters only** (parsers accept exactly `(?:-[a-z]+)?`) | no tag (production) |

A plain `pio run` (not via build.sh) leaves `OTA_MANIFEST_BASE` undefined and
the firmware reports `ERR: OTA not configured (build via build.sh)` — this is
deliberate: local/dev builds must never be OTA-armed. **Never give
`OTA_MANIFEST_BASE` a default in a header**, and never re-add per-variant
`-D OTA_MANIFEST_BASE` lines to `platformio.ini` (SCons reorders `-U`/`-D`, so
overrides via `PLATFORMIO_BUILD_FLAGS` are unreliable — that's why the
injection lives in build.sh).

⚠ `build.sh` currently swallows `pio`'s exit code (trailing `elif` chain).
CI verifies builds by log content, not exit status. Check logs for `[FAILED]`.

### 2.2 The publish workflows

Both live in `.github/workflows/` and share the same three-job shape. They are
push-triggered on their branch, with `paths-ignore` for `.github/**`, `**.md`,
`docs/**`, and repo-meta files — so **workflow-only and docs-only commits do
not trigger builds** (docs/changelog sync is `sync-flasher-content.yml`'s job).
`workflow_dispatch` exists on both but the fork's default branch (`dev`, an
upstream mirror) doesn't carry these workflows, so GitHub only sometimes
surfaces dispatch; push is the operative trigger.

1. **enumerate** — discovers `*_observer_mqtt` envs by grepping
   `platformio.ini` + `variants/*/platformio.ini`, splits them into 14 shards,
   and computes the build number by fetching the channel's **live** counter
   JSON (same base ⇒ N=prev+1, new base ⇒ N=1). Read-only; the release job is
   the sole counter writer, so failed builds never burn a number.
2. **build** ×14 — PlatformIO toolchain cache, then `build.sh` per shard with
   `FIRMWARE_BUILD_NUMBER` stamped. The beta workflow additionally verifies
   the beta manifest URL is baked into each binary.
3. **release** — runs on a **shallow clone on purpose**: `git rev-parse
   --short HEAD` yields 7 chars shallow / 8 with history, and the asset
   filenames were minted by shallow build jobs. Steps:
   - collect shard artifacts into `out/`
   - `gh release create` (first time only; the rolling tag is never moved) +
     `gh release upload --clobber`
   - `gh release edit --notes-file firmware-notes.html` — the release body is
     what the `/releases` feed serves as the dropdown changelog. Beta prepends
     the dev-channel warning. Non-fatal on failure (stale notes beat a red
     build whose binaries are live). Beta wraps all `gh` calls in `gh_retry`
     (5 attempts, 10/20/40/80 s backoff) after a transient GitHub 503 killed
     an otherwise-green run.
   - prune assets to the `KEEP_BUILDS=2` newest hashes, extracted from the
     **end** of each filename (`[0-9a-f]{7,40}(-merged)?\.bin$` — channel-tag
     agnostic). Prune failures are warnings, never job failures.
   - check out the flasher repo (`FLASHER_DISPATCH_TOKEN` secret), run
     `gen-slim-manifests.py --bin-dir out --static-path "$STATIC_PATH" ...`,
     write the counter file, commit and push. The beta commit is **scoped**
     (`git add beta/v observer-beta-build-counter.json`) so it can never touch
     production files. Both workflows share a `concurrency: flasher-publish`
     group so they never push to the flasher repo concurrently.

Neither workflow writes `config.json` or `config-beta.json` — versions are
feed-driven (see §3.3).

⚠ **`gh run rerun` gotchas** (learned the hard way):
- `--failed` replays the workflow file from the run's *original* commit.
- A job-level rerun of `release` consumes **stale `enumerate` outputs** — the
  build number was computed at the run's original start. Rerunning an old
  run's release job after a newer run published will republish the older
  commit under a duplicate build number. After any out-of-order publish, rerun
  the NEWEST run's release job last; once real nodes are on a channel, prefer
  a fresh full run so the number recomputes.
- A branch **rename** emits a creation push event that **bypasses path
  filters** — renaming a branch that matches a publish trigger fires a full
  publish by itself.
- Never dispatch two workflows sharing a concurrency group back-to-back: only
  one *pending* run per group survives (`cancel-in-progress: false` protects
  only running jobs).

---

## 3. Flasher side (this repo)

### 3.1 Hosting

GitHub Pages, custom domain `observer.gessaman.com` (see `CNAME`), **proxied
through Cloudflare** (orange-cloud). Pages caches with `max-age=600`, so
changes take up to 10 minutes to propagate — and `index.html` pins
`flasher.js` with a cache-buster query (`/flasher.js?v=...`). **Bump that tag
on every flasher.js change**; without it a cached `index.html` can pair stale
JS with a newer `config.json` (this exact mismatch broke flashing once).
Never probe a fresh `?v=` URL before the Pages build reports `built` — the
CDN will cache the old content under the new key.

### 3.2 config.json

Hand-maintained **device inventory**; versions are not in it any more. Per
observer firmware entry:

```json
{
  "role": "repeater",
  "github": {
    "type": "observer-repeater",
    "files": {
      "flash-wipe":   "^Heltec_v3_repeater_observer_mqtt-v.*-merged\\.bin$",
      "flash-update": "^Heltec_v3_repeater_observer_mqtt-v.*-[0-9a-f]{7,8}\\.bin$"
    }
  }
}
```

- `type` is `observer-repeater` or `observer-room-server` and must match the
  feed (§3.3).
- Hash class is `{7,8}` — shallow clones abbreviate to 7, full history to 8.
- `flash-update` must never match `-merged.bin` (the hash class can't span
  `merged`, and the `$` anchor seals it).
- ⚠ `addGithubFiles()` deletes versions with no matching files **and then
  filters out empty devices** — a regex typo silently removes a board from the
  flasher with no error. After editing, diff the rendered device list **by
  name**, not by count.
- Top-level `releasesUrl` points the SPA at the feed:
  `https://observer-fw.gessaman.com/releases`. Required because Pages cannot
  serve a dynamic route and the fetch would otherwise go to the SPA origin.
- `notice` entries (partition-change warnings etc.) stay here; they are
  first-flash UI hints, independent of versions.
- `config-beta.json` is a frozen relic of the retired channel switcher; stale
  `?config=config-beta` links load it (or fall back to `config.json` if it's
  ever removed). Nothing regenerates it.

### 3.3 The /releases feed (Version dropdown)

`flasher.js` fetches `config.releasesUrl` **only if** some firmware carries a
`github` def, then `addGithubFiles()` replaces each such firmware's `version`
map with the feed's entries. The dropdown's default is the **first** version
key, so feed order decides the default.

The feed is served by the **production** firmware-proxy Worker
(`cloudflare-worker/src/firmware-proxy.js`, route `GET /releases`), one entry
per (channel × role):

```json
{ "type": "observer-repeater", "version": "v1.16.0-dev",
  "notes": "<html release body>", "files": [{ "name": "...", "url": "https://..." }] }
```

Configured by the `RELEASE_FEED` var in `cloudflare-worker/wrangler.toml`:

```toml
RELEASE_FEED = '[{"tag":"observer-mqtt-latest","suffix":"","proxy":"https://observer-fw.gessaman.com"},
                 {"tag":"observer-mqtt-beta-latest","suffix":"-dev","proxy":"https://observer-fw-beta.gessaman.com"}]'
```

- **Order matters: stable first** (it becomes the preselected version).
- **No labels or notes in vars** — the label is parsed from asset filenames
  (version capture + `suffix`), notes come from the release body. Nothing to
  update at a version bump; vars change only for tag renames / new channels.
- Assets are **deduped to the newest per env + variant** (key strips version,
  channel tag, and hash; newest by `created_at`) — the rolling release retains
  two hash generations and the SPA takes files in array order, so without
  dedupe it could flash the older build.
- Asset URLs route through each channel's own proxy host (CORS + caching
  identical to all other downloads).
- Whole-feed cache: 5 minutes (unauthenticated GitHub API is 60 req/hr/IP).
- A failing channel is skipped, never a 5xx — a GitHub blip on one tag cannot
  empty the other channel's device list.

### 3.4 Firmware download proxies

Two separate Workers (deliberately separate deployments, so a bad beta deploy
cannot break production downloads):

| Worker | Config | Host | Proxies |
|---|---|---|---|
| `meshcore-firmware-proxy` | `wrangler.toml` | `observer-fw.gessaman.com` | `observer-mqtt-latest` + serves `/releases` |
| `meshcore-firmware-proxy-beta` | `wrangler.beta.toml` | `observer-fw-beta.gessaman.com` | `observer-mqtt-beta-latest` |

`/<file>.bin` → GitHub release asset, re-served with permissive CORS (release
downloads redirect to a host that sends no CORS headers, and WebSerial
flashing needs `fetch()`). Filenames are content-addressed (embedded hash) so
responses cache hard (24 h, immutable). A strict filename allowlist prevents
open-proxy abuse.

Deploy: `cd cloudflare-worker && npx wrangler deploy [-c wrangler.beta.toml]`.
**Do not pre-create DNS records** — `custom_domain = true` makes Cloudflare
own the hostname; a hand-made record conflicts.

### 3.5 flasher.js URL handling (two builders — keep them in sync)

There are **two** places that turn a file entry into a URL, and both must
pass absolute URLs through untouched (feed entries carry absolute URLs in
`file.name`):

- `getFirmwarePath()` — Download links
- `fetchFirmwareFile()` — the **Flash!** path; also retries once on 404 by
  re-resolving the file through a fresh feed fetch (same env + variant + 
  channel host, any version/hash) — the stale-tab recovery for a tab left
  open across a rebuild

Missing the second one shipped a flash-breaking 404 once. If a third URL
builder ever appears, give it the same absolute-URL guard.

### 3.6 gen-slim-manifests.py + harness

Generates the slim per-env OTA manifests (§4) from the build output:
`--bin-dir out --static-path <host> --out-dir <dir> --base-version vX.Y.Z
--build N --partsig-dir out`. Legacy `--config` mode (static config entries)
is retained byte-for-byte for compatibility but nothing calls it in CI.

The filename parser accepts `<env>-v<X.Y.Z>[-<tag>]-<hash>[-merged].bin`;
env + hash capture is unaffected by the channel tag.

`scripts/test-gen-slim-manifests.sh` is the regression gate — run it from the
repo root after touching the script. It reconstructs build output *and* a
synthetic legacy config from the committed `v/*.json` and requires both modes
to reproduce them byte-for-byte, plus a channel-tag case and CLI guards.

---

## 4. OTA (device side)

Each device fetches `<OTA_MANIFEST_BASE>/<OTA_VARIANT>.json` — a slim manifest
(~200 bytes; small enough that `ota check` runs with the MQTT bridge up on
no-PSRAM boards):

```json
{
  "baseVersion": "v1.16.0",
  "build": 2,
  "version": "v1.16.0.2",
  "hash": "f509066",
  "file": "https://observer-fw-beta.gessaman.com/<env>-v1.16.0-dev-f509066.bin",
  "partSig": "1:2:9000:5000,..."
}
```

- Manifests are generated per publish from `out/` and committed to this repo
  (`v/`, `beta/v/`), served by Pages.
- **The manifest fetch is plain HTTP** — `ESP32Board.cpp` strips `https://`
  from the baked base to spare TLS heap. See §5 for the Cloudflare rule this
  requires. The firmware *download* (`file`) is HTTPS via the proxy Workers.
- Update decision: same base ⇒ compare build numbers ("N behind");
  different base ⇒ always an update; missing build numbers (local images) ⇒
  hash comparison (7- vs 8-char prefixes tolerated).
- `partSig` is compared against the device's flashed partition table; a real
  mismatch blocks OTA (cable flash required) — this replaced the old blanket
  `partitionChange` flag.
- Stale manifests are not auto-deleted: if an env stops being built, remove
  its `v/<env>.json` by hand (done for the never-shipped TLora entries).

---

## 5. Cloudflare zone configuration

`observer.gessaman.com` is proxied (orange-cloud). The zone redirects HTTP to
HTTPS via a redirect rule — which **must exempt every OTA manifest prefix**,
because devices fetch manifests over plain HTTP (§4) and treat a 301 as an
error (`ERR: manifest HTTP 301`):

```
(http.request.full_uri wildcard "http://*")
and (not starts_with(http.request.uri.path, "/v/"))
and (not starts_with(http.request.uri.path, "/beta/v/"))
```

⚠ This failure mode is **invisible to curl/browser testing** (everything else
uses HTTPS) — it only shows up on hardware. Any new channel's manifest prefix
must be added here (see §6.4).

The two firmware-proxy hostnames are Worker custom domains managed by
Cloudflare itself — no manual DNS records (§3.4).

---

## 6. Runbooks

### 6.1 Publish a build

Push to the channel branch. That's it — the workflow builds all envs, uploads
to the rolling release, refreshes the release body, prunes old assets, and
commits fresh OTA manifests + counter. Workflow-only / docs-only commits don't
trigger builds. The dropdown updates within ~5 min (feed cache); manifests
within ~10 min (Pages cache).

To verify a publish:

```sh
curl -s https://observer-fw.gessaman.com/releases | jq '[.[]|{type,version,files:(.files|length)}]'
curl -s https://observer.gessaman.com/v/Heltec_v3_repeater_observer_mqtt.json | jq .
curl -sI https://observer-fw.gessaman.com/<file-from-that-json> | head -1
curl -s -o /dev/null -w '%{http_code}\n' http://observer.gessaman.com/v/<env>.json   # must be 200, not 301
```

### 6.2 Bump the base version

Edit `FIRMWARE_VERSION` in the channel's workflow env block. Dot-only
(`v1.17.0`, never `v1.17.0-rc1`). Everything downstream is automatic: the
counter resets to build 1 for the new base, filenames and the dropdown label
follow the assets, and old-base assets age out via pruning (the feed's dedupe
never shows them).

### 6.3 Add a board

1. MeshCore: add the `*_observer_mqtt` env(s); enumerate discovers them by
   grep — no workflow edit.
2. This repo: add the device to `config.json` with a `github` def per role
   (§3.2 — copy an existing entry, swap the env name).
3. After the next publish, confirm the board appears **and no other board
   vanished** (silent-drop trap).

### 6.4 Add a release channel

Checklist (each item is load-bearing; the machinery generalises):

1. Branch + a copy of the beta workflow with its own: `RELEASE_TAG`,
   `COUNTER_URL`/`COUNTER_FILE`, `MANIFEST_DIR`, `OTA_MANIFEST_BASE_URL`,
   `OTA_CHANNEL_TAG`, `FILENAME_CHANNEL_TAG` (lowercase only), `STATIC_PATH`.
2. New proxy Worker config (copy `wrangler.beta.toml`; new `name`, hostname,
   `RELEASE_BASE`) → `npx wrangler deploy -c <file>`.
3. Add the channel to `RELEASE_FEED` in `wrangler.toml` (order = dropdown
   order; stable stays first) → redeploy the production Worker.
4. **Add the manifest prefix to the Cloudflare redirect-rule exemptions** (§5).
5. First publish, then verify per §6.1 — including the plain-HTTP manifest
   check, on hardware if at all possible.

### 6.5 Roll back

- **Bad binaries published:** push a revert commit to the branch — a new
  build with a new hash publishes over it. The release retains the previous
  hash generation (`KEEP_BUILDS=2`), so already-downloaded manifests keep
  working during the transition.
- **Feed/dropdown broken:** revert the flasher-side commit(s); with no
  `github` defs in `config.json` the SPA stops fetching the feed entirely.
  The `/releases` route can stay deployed — it is inert unless the config
  references it.
- **Worker broken:** `npx wrangler rollback` (or redeploy the previous
  commit). Production and beta proxies are independent deployments.

---

## 7. Trap index (all learned on this system, all verified)

| Trap | Consequence | Where handled |
|---|---|---|
| Silent failures are the house style | broken ≠ red: publishes stop, boards vanish, OTA dies — all quietly | every §6 runbook ends in explicit verification |
| `build.sh` swallows pio exit codes | "green" builds with missing envs | check logs for `[FAILED]` (§2.1) |
| Branch rename doesn't rewrite `branches:` filters | production publishing silently stops | dual-trigger transition procedure (used for the 2026-07-20 rename) |
| Branch rename fires a paths-filter-bypassing push event | surprise full publish | expect it (§2.2) |
| Job-level rerun reuses stale `enumerate` outputs | duplicate build numbers, out-of-order publishes | §2.2 rerun rules |
| Shared concurrency group + back-to-back dispatches | second dispatch cancels the first | §2.2 |
| `addGithubFiles()` drops boards on regex typos | board silently missing | diff device list by name (§3.2) |
| Two URL builders in flasher.js | Download works, Flash 404s | keep both absolute-URL-guarded (§3.5) |
| Stale `index.html` + fresh `config.json` | SPA/config mismatch breaks flashing | `?v=` cache-buster discipline (§3.1) |
| Rolling release retains 2 hash generations | flasher can pick the older build | worker dedupe (§3.3) |
| Devices fetch manifests over plain HTTP | `ERR: manifest HTTP 301`; invisible to curl/browser tests | Cloudflare exemptions (§5), hardware check (§6.4) |
| Non-dot base versions | `v1.17.0-rc1` parses as `v1.17.0` | dot-only rule (§1) |
| SCons `-U`/`-D` reordering | `PLATFORMIO_BUILD_FLAGS` can't override `-D` reliably | build.sh owns all channel `-D`s (§2.1) |
| Unauthenticated GitHub API limit (60/hr/IP) | feed rate-limited without caching | 5-min worker cache (§3.3) |
| Pages 10-min cache | "deployed" but not yet served | wait for `built` + curl before concluding anything |
