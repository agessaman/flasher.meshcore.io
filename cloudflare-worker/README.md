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

## How it stays in sync

Nothing to maintain per release: the Worker forwards whatever filename the
flasher requests to the fixed `observer-mqtt-latest` tag, and filenames embed the
git short hash (so they're immutable and safely cacheable). The build pipeline
keeps publishing to that rolling tag exactly as before.
