// Checks the observer catalog, URL scheme, and stale-firmware matching
// against the modules introduced by the upstream flasher split.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realFetch = globalThis.fetch.bind(globalThis);

globalThis.location = {
  host: 'observer.gessaman.com',
  search: '',
  href: 'https://observer.gessaman.com/',
  pathname: '/',
};
const { assetUrl, findFreshFeedUrl, firmwareHashFromConfig, releaseAssetName, withFirmwareHash } = await import('../js/firmware-url.js');
const { loadCatalog, firmwareUrl, hasVersions } = await import('../js/catalog.js');
const { buildPath, parsePath } = await import('../js/router.js');
const { commandReference } = await import('../js/commands.js');
assert.equal(typeof commandReference.ver, 'string');
assert.equal(typeof commandReference['set mqtt1.preset '], 'string');
assert.equal(typeof commandReference['set wifi.ssid '], 'string');
assert.equal(typeof commandReference['get bridge.source'], 'string');

const configText = await readFile(path.join(root, 'config.json'), 'utf8');
const config = JSON.parse(configText);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const releasesUrl = config.releasesUrl;
const feedRes = await realFetch(releasesUrl);
assert.equal(feedRes.ok, true, `release feed ${releasesUrl} returned ${feedRes.status}`);
const feed = await feedRes.json();
assert.ok(Array.isArray(feed) && feed.length > 0, 'release feed is empty');

globalThis.fetch = async (url) => {
  const target = String(url);
  if(target === '/config.json') return jsonResponse(config);
  if(target.startsWith(releasesUrl)) return jsonResponse(feed);
  throw new Error(`unexpected fetch ${target}`);
};

const catalog = await loadCatalog();
assert.ok(catalog.device.length > 0, 'catalog dropped every device');

const heltec = catalog.device.find(d => d.name === 'Heltec V3');
assert.ok(heltec, 'Heltec V3 missing from catalog');
const repeater = heltec.firmware.find(f => f.role === 'repeater');
assert.ok(hasVersions(repeater), 'Heltec V3 repeater has no versions');

const versionNames = Object.keys(repeater.version);
assert.ok(versionNames.length >= 1, 'no repeater versions');
assert.equal(versionNames[0].includes('-dev'), false, `stable channel should be the default, got ${versionNames[0]}`);

for(const version of Object.values(repeater.version)) {
  const wipe = version.files.find(f => f.type === 'flash-wipe');
  const update = version.files.find(f => f.type === 'flash-update');
  assert.ok(wipe && update, `missing wipe/update files in ${versionNames}`);
  assert.match(wipe.name, /^https:\/\//);
  assert.equal(wipe.name.includes('?repo='), false, 'absolute feed URLs must not gain ?repo=');
  assert.equal(firmwareUrl(catalog, wipe), wipe.name);
}

const pathFor = buildPath(catalog, {
  device: heltec,
  firmware: repeater,
  version: versionNames[0],
  firmwareClass: null,
});
assert.match(pathFor, /^\/observer-heltec-v3\/repeater\//);
const parsed = parsePath(catalog, pathFor);
assert.equal(parsed.device.name, 'Heltec V3');
assert.equal(parsed.firmware.role, 'repeater');
assert.equal(parsed.version, versionNames[0]);
assert.equal(parsed.firmwareClass, null);

const classless = {
  device: [{
    name: 'LilyGo T-Deck',
    firmware: [{
      role: 'repeater',
      class: 'ripple',
      title: 'Repeater',
      version: { 'v1': { files: [{ type: 'flash', name: 'a.bin' }] } },
    }],
  }],
  role: { repeater: { title: 'Repeater' } },
};
const filtered = parsePath(classless, '/ripple-lilygo-t-deck/repeater/v1');
assert.equal(filtered.firmwareClass, 'ripple');
assert.equal(filtered.device.name, 'LilyGo T-Deck');
assert.equal(filtered.version, 'v1');

assert.equal(releaseAssetName('https://observer-fw.example/a.bin', 'github'), 'https://observer-fw.example/a.bin');
assert.equal(releaseAssetName('/files/a.bin', 'github-zephcore'), '/files/a.bin?repo=github-zephcore');
assert.equal(assetUrl('https://static.example', 'app.bin'), 'https://static.example/app.bin');
assert.equal(assetUrl('https://static.example', 'https://cdn.example/app.bin'), 'https://cdn.example/app.bin');

const hashed = 'Heltec_v3_repeater_observer_mqtt-v1.17.1-aaaaaaa.bin';
assert.equal(withFirmwareHash(hashed, 'bbbbbbb'), 'Heltec_v3_repeater_observer_mqtt-v1.17.1-bbbbbbb.bin');
assert.equal(
  firmwareHashFromConfig(`"file": "${hashed}"`),
  'aaaaaaa',
);
const stale = 'https://observer-fw.example/Heltec_v3_repeater_observer_mqtt-v1.17.1-aaaaaaa.bin';
const fresh = findFreshFeedUrl([
  {
    files: [{
      name: 'Heltec_v3_repeater_observer_mqtt-v1.17.2-ccccccc.bin',
      url: 'https://observer-fw.example/Heltec_v3_repeater_observer_mqtt-v1.17.2-ccccccc.bin',
    }, {
      name: 'Heltec_v3_repeater_observer_mqtt-v1.17.2-ccccccc-merged.bin',
      url: 'https://other.example/merged.bin',
    }],
  },
], stale);
assert.equal(fresh, 'https://observer-fw.example/Heltec_v3_repeater_observer_mqtt-v1.17.2-ccccccc.bin');

const fallback = spawnSync(process.execPath, ['--input-type=module', '-e', `
  globalThis.location = {
    host: 'observer.gessaman.com',
    search: '?config=config-beta',
    href: 'https://observer.gessaman.com/?config=config-beta',
    pathname: '/',
  };
  let replaced = null;
  globalThis.location.replace = (url) => { replaced = url; };
  globalThis.fetch = async () => new Response('nope', { status: 404 });
  const { loadCatalog } = await import(${JSON.stringify(path.join(root, 'js/catalog.js'))});
  const pending = loadCatalog();
  await new Promise(r => setTimeout(r, 50));
  if(!replaced || replaced !== 'https://observer.gessaman.com/') {
    console.error('expected fallback navigation, got', replaced);
    process.exit(1);
  }
  pending.catch(() => {});
  process.exit(0);
`], { encoding: 'utf8' });
if(fallback.status !== 0) {
  console.error(fallback.stdout);
  console.error(fallback.stderr);
  throw new Error('stale ?config= fallback failed');
}

console.log(`ok: ${catalog.device.length} devices, Heltec V3 versions ${versionNames.join(', ')}`);
