// Device/firmware catalog: static config (config*.json) merged with a release feed.
// The observer flasher uses config.releasesUrl (the firmware-proxy Worker).
// A catalog without that field keeps upstream's /releases?repo= proxy.
import { configName } from './site.js';
import { assetUrl, releaseAssetName } from './firmware-url.js';
import { fetchJson } from './util.js';

// Display order and headings of firmware groups on the "choose role" screen
export const firmwareClasses = {
  ripple: {
    title: 'Ripple Firmware',
    tooltip: 'Freemium firmware provided by <a class="inverse-link" target="_blank" href="https://buymeacoffee.com/ripplebiz">Ripple Radios</a>',
  },
  meshos: {
    title: 'MeshOS Firmware',
    tooltip: 'Freemium firmware provided by Andy Kirby',
  },
  community: {
    title: 'Community Firmware',
    tooltip: 'Open Source <a class="inverse-link" target="_blank" href="https://github.com/meshcore-dev/MeshCore">Community firmware</a>',
  },
  observer: {
    title: 'MQTT Observer Firmware',
    tooltip: 'Experimental MQTT Observer firmware — uplinks mesh traffic to MQTT brokers',
  },
};

// A firmware entry names its release source with a "github*" key, e.g. "github-zephcore": { type, files }
const releaseSourceKey = (firmware) => Object.keys(firmware).find(key => key.startsWith('github'));

// Builds firmware.version from releases: { [version]: { notes, files: [{ type, name, title }] } }
// `source.files` maps file type (flash, flash-wipe, flash-update, download) to a filename regex.
function matchReleaseFiles(releases, source, sourceKey) {
  const patterns = Object.entries(source.files).map(([type, re]) => [type, new RegExp(re)]);
  const versions = {};

  for(const [type, re] of patterns) {
    for(const release of releases) {
      if(release.type !== source.type) continue;
      const version = versions[release.version] ??= { notes: release.notes, files: [] };

      for(const file of release.files) {
        if(!re.test(file.name)) continue;
        version.files.push({ type, name: releaseAssetName(file.url, sourceKey), title: file.name });
      }
    }
  }

  for(const [name, version] of Object.entries(versions)) {
    if(version.files.length === 0) delete versions[name];
  }

  return versions;
}

export const hasVersions = (firmware) => Object.values(firmware.version ?? {}).some(v => v.files.length > 0);

async function loadConfig() {
  try {
    return await fetchJson(`/${configName}.json`);
  }
  catch(e) {
    // ?config= is for alternate catalogs (old-config.json). A stale name, including
    // retired ?config=config-beta links, falls back to the default instead of
    // leaving the page on a parse error.
    const requested = new URLSearchParams(location.search).get('config');
    if(!requested) throw e;
    console.warn(`${configName}.json unavailable; falling back to config.json`);
    const next = new URL(location.href);
    next.searchParams.delete('config');
    location.replace(next.toString());
    await new Promise(() => {});
  }
}

async function loadReleases(config, sourceKeys) {
  if(sourceKeys.length === 0) return {};
  try {
    if(config.releasesUrl) {
      const releases = await fetchJson(config.releasesUrl);
      return Object.fromEntries(sourceKeys.map(key => [key, releases]));
    }

    return Object.fromEntries(await Promise.all(
      sourceKeys.map(async key => [key, await fetchJson(`/releases?repo=${key}`)])
    ));
  }
  catch(e) {
    console.warn('release feed unavailable', e);
    return Object.fromEntries(sourceKeys.map(key => [key, []]));
  }
}

export async function loadCatalog() {
  const config = await loadConfig();
  const firmwares = config.device.flatMap(device => device.firmware);
  const sourceKeys = [...new Set(firmwares.map(releaseSourceKey).filter(Boolean))];
  const releases = await loadReleases(config, sourceKeys);

  for(const firmware of firmwares) {
    const key = releaseSourceKey(firmware);
    if(!key || !firmware[key]?.files) continue;
    firmware.version = matchReleaseFiles(releases[key] ?? [], firmware[key], key);
  }

  config.device = config.device.filter(device => device.firmware.some(hasVersions));

  return config;
}

// Firmware title/icon/tooltip fall back to its role's defaults
export const roleValue = (config, firmware, key) => firmware[key] ?? config.role[firmware.role]?.[key] ?? '';

// Notices may reference device fields, e.g. ${bootloader} (arrays use their first item)
export function renderNotice(config, device, firmware) {
  const notice = config.notice?.[firmware.notice] || firmware.notice || '';

  return notice.replaceAll(/\$\{(\w+)\}/g, (_, field) => {
    const value = device[field];
    return (Array.isArray(value) ? value[0] : value) || '';
  });
}

export function formatChangeLog(changelog) {
  return changelog
    .replace(/^Release notes:'/, '')
    .replace(/change log:\r?\n/i, '')
    .replaceAll(/^[-*] /mg, '')
    .replaceAll(/(?<!["'])(https?:\/\/[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*))/gi, `<a target="_blank" href="$1">$1</a>`)
    // skip numeric HTML entities such as &#9888; (the dev-channel warning sign)
    .replaceAll(/(?<!&)#(\d+)/gm,`<a target="_blank" href="https://github.com/meshcore-dev/MeshCore/pull/$1">#$1</a>`);
}

export const firmwareUrl = (config, file) => assetUrl(config.staticPath, file.name);
