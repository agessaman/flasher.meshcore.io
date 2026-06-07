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
 */

const DEFAULT_RELEASE_BASE =
  "https://github.com/agessaman/MeshCore/releases/download/observer-mqtt-latest";

// Only proxy firmware artifacts; never act as an open redirector/proxy.
const ALLOWED_FILENAME = /^[A-Za-z0-9._-]+\.(bin|uf2|hex|zip)$/;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
    }

    const filename = new URL(request.url).pathname.split("/").pop() || "";
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
