# Firmware CORS proxy

The web flasher reads firmware with `fetch()` (for WebSerial flashing), so the
bytes must come from a CORS-enabled origin. GitHub release-asset downloads
302-redirect to `objects.githubusercontent.com` and send **no**
`Access-Control-Allow-Origin` header, so a cross-origin `fetch()` from
`observer.gessaman.com` is blocked. (Direct download still works because a
browser *navigation* isn't subject to CORS.)

This Cloudflare Worker proxies `/<filename>` to the rolling GitHub release and
re-serves the bytes with permissive CORS.

## Deploy

Wrangler ships via npm (the Homebrew formula was disabled in 2025 — don't use
brew). It's pinned here as a dev dependency, so:

```sh
cd cloudflare-worker
npm install            # installs wrangler locally
npx wrangler login     # one-time Cloudflare auth
npm run deploy         # = npx wrangler deploy
```

## Route + staticPath

`wrangler.toml` is set up for the custom domain **`observer-fw.gessaman.com`**, and
`config.json` `staticPath` already points there. To use it:

1. In Cloudflare DNS for `gessaman.com`, the custom-domain route auto-creates the
   `observer-fw` record on deploy (or add it yourself).
2. `wrangler deploy`.
3. Confirm: `curl -I https://observer-fw.gessaman.com/<any-current-firmware>.bin` returns
   `200` with `access-control-allow-origin: *`.

If you prefer a different location, edit `routes` in `wrangler.toml` and set
`config.json` `staticPath` to match (see the alternatives commented there).

## Beta channel

`wrangler.beta.toml` deploys a second, independent Worker
(`meshcore-firmware-proxy-beta`) on **`observer-fw-beta.gessaman.com`**, proxying
the `observer-mqtt-beta-latest` release tag. Same source file; only the hostname
and `RELEASE_BASE` differ.

```bash
npx wrangler deploy -c wrangler.beta.toml
```

No DNS record to create by hand: `custom_domain = true` has Cloudflare create and
manage the `observer-fw-beta` hostname on deploy (a proxied CNAME owned by
Workers), the same way `observer-fw` was set up. Pre-creating an A/AAAA/CNAME for
that name conflicts with the managed record and can fail the deploy. The only
requirement is that `gessaman.com` is in the same Cloudflare account as the
Worker.

Confirm after deploying (once the beta channel has published a build):

```bash
curl -I https://observer-fw-beta.gessaman.com/<a-beta-firmware>.bin
# expect 200 + access-control-allow-origin: *
```

It is a separate Worker rather than an extra route on the production one so the
two deployments share nothing — a bad beta deploy cannot break firmware
downloads for the production fleet.

These three values must agree, or beta nodes fetch the wrong binaries:

| Value | Set in |
|---|---|
| `observer-fw-beta.gessaman.com` | `wrangler.beta.toml` route, and `STATIC_PATH` in the beta workflow |
| `observer-mqtt-beta-latest` | `RELEASE_BASE` here, and `RELEASE_TAG` in the beta workflow |
| `https://observer.gessaman.com/beta/v` | `OTA_MANIFEST_BASE_URL` in the beta workflow, and this repo's `beta/v/` directory |

The beta workflow lives in the MeshCore repo at
`.github/workflows/build-observer-firmwares-beta.yml`.

## How it stays in sync

Nothing to maintain per release: the Worker forwards whatever filename the
flasher requests to the fixed `observer-mqtt-latest` tag, and filenames embed the
git short hash (so they're immutable and safely cacheable). The build pipeline
keeps publishing to that rolling tag exactly as before.
