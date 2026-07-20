/**
 * MeshCore Observer firmware CORS proxy (Cloudflare Worker).
 *
 * The web flasher reads firmware via fetch() for WebSerial flashing, so the
 * bytes must come from a CORS-enabled origin. GitHub release-asset downloads
 * 302-redirect to objects.githubusercontent.com and send no
 * Access-Control-Allow-Origin header, so a cross-origin fetch() is blocked.
 *
 * This Worker proxies a request for /<filename> to the rolling GitHub release
 * and re-serves the bytes with permissive CORS. The flasher builds URLs as
 * `${staticPath}/${filename}` (see flasher.js getFirmwarePath), so only the
 * last path segment matters — the Worker can be mounted at a subdomain root
 * (observer-fw.gessaman.com/*) or any subpath (files.gessaman.com/observer/*).
 *
 * RELEASE_BASE is configurable via a wrangler [vars] entry so the repo/tag can
 * change without editing code.
 *
 * GET /releases additionally serves the flasher's release feed: one entry per
 * (channel x role), synthesized from the GitHub releases named in the
 * RELEASE_FEED [vars] entry. The flasher's per-firmware Version dropdown is
 * driven by this feed (config.releasesUrl -> here); channel order in
 * RELEASE_FEED is the dropdown order, so the stable channel MUST be first
 * (flasher.js picks the first version key as the default selection).
 */

const DEFAULT_RELEASE_BASE =
  "https://github.com/agessaman/MeshCore/releases/download/observer-mqtt-latest";

// Version label parsed from asset filenames ("<env>-v1.16.0-<hash>[-merged].bin").
// No label lives in configuration: a hardcoded label goes stale silently at
// every version bump, and the assets already carry the truth.
const VERSION_RE = /-(v\d+\.\d+\.\d+(?:\.\d+)?)-[0-9a-f]{7,8}(?:-merged)?\.bin$/;

// Feed `type` must match the `github.type` values used in the flasher's
// config.json; the role is derived from the env name embedded in the filename.
const ROLE_TYPES = [
  ["observer-repeater", "_repeater_"],
  ["observer-room-server", "_room_server_"],
];

async function buildReleasesFeed(env) {
  let channels = [];
  try {
    channels = JSON.parse(env.RELEASE_FEED || "[]");
  } catch (e) { /* malformed vars -> empty feed, never a 5xx */ }

  const feed = [];
  for (const ch of channels) {
    // A failing channel is skipped rather than failing the feed, so a GitHub
    // API blip on the dev tag cannot empty the stable device list (and vice
    // versa). Whatever channels succeed are returned, order preserved.
    try {
      const resp = await fetch(
        `https://api.github.com/repos/agessaman/MeshCore/releases/tags/${ch.tag}`,
        {
          headers: { "User-Agent": "meshcore-firmware-proxy" },
          cf: { cacheEverything: true, cacheTtl: 300 },
        },
      );
      if (!resp.ok) continue;
      const rel = await resp.json();
      const assets = rel.assets || [];

      // Label = version parsed from the first matching asset + channel suffix.
      // No match -> skip the channel entirely; never emit a guessed label.
      let label = null;
      for (const a of assets) {
        const m = VERSION_RE.exec(a.name);
        if (m) { label = m[1] + (ch.suffix || ""); break; }
      }
      if (!label) continue;

      for (const [type, token] of ROLE_TYPES) {
        const files = assets
          .filter((a) => a.name.includes(token))
          .map((a) => ({ name: a.name, url: `${ch.proxy}/${a.name}` }));
        if (files.length) {
          feed.push({ type, version: label, notes: rel.body || "", files });
        }
      }
    } catch (e) { /* skip channel */ }
  }
  return feed;
}

// Only proxy firmware artifacts; never act as an open redirector/proxy.
const ALLOWED_FILENAME = /^[A-Za-z0-9._-]+\.(bin|uf2|hex|zip)$/;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/releases" || url.pathname.endsWith("/releases")) {
      // Cache the whole feed for 5 min: the unauthenticated GitHub API allows
      // 60 req/hr/IP, and every flasher page load hits this route once the
      // config carries github defs.
      const cacheKey = new Request(`${url.origin}/releases`);
      const cached = await caches.default.match(cacheKey);
      if (cached) return cached;

      const feed = await buildReleasesFeed(env);
      const headers = new Headers(CORS_HEADERS);
      headers.set("Content-Type", "application/json");
      headers.set("Cache-Control", "public, max-age=300");
      const resp = new Response(JSON.stringify(feed), { status: 200, headers });
      ctx.waitUntil(caches.default.put(cacheKey, resp.clone()));
      return resp;
    }

    const filename = url.pathname.split("/").pop() || "";
    if (!ALLOWED_FILENAME.test(filename)) {
      return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
    }

    const base = (env && env.RELEASE_BASE) || DEFAULT_RELEASE_BASE;
    const upstream = `${base}/${filename}`;

    // fetch() follows the 302 to the signed asset URL automatically.
    // Filenames are content-addressed (they embed the git short hash), so the
    // bytes for a given name never change — safe to cache hard.
    const resp = await fetch(upstream, {
      method: request.method,
      redirect: "follow",
      cf: { cacheEverything: true, cacheTtl: 86400 },
    });

    if (!resp.ok) {
      return new Response(`Upstream returned ${resp.status}`, {
        status: resp.status === 404 ? 404 : 502,
        headers: CORS_HEADERS,
      });
    }

    const headers = new Headers(CORS_HEADERS);
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Cache-Control", "public, max-age=86400, immutable");
    const len = resp.headers.get("Content-Length");
    if (len) headers.set("Content-Length", len);

    return new Response(request.method === "HEAD" ? null : resp.body, {
      status: 200,
      headers,
    });
  },
};
