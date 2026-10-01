// URL scheme: /[class-]<device>/<role>/<version>, plus /console
// A class prefix (e.g. /ripple-lilygo-t-deck/) limits the device's firmware list to that class.
// NOTE: the server must serve index.html for all unknown paths (catch-all / try_files).
import { firmwareClasses, hasVersions, roleValue } from './catalog.js';
import { toSlug } from './util.js';

export const CONSOLE_PATH = '/console';

function firmwareSlug(config, firmware) {
  const title = roleValue(config, firmware, 'title');
  const subTitle = roleValue(config, firmware, 'subTitle');

  return toSlug(subTitle ? `${title}-${subTitle}` : title);
}

// Observer device URLs keep the catalog class in the slug (/observer-heltec-v3/...).
export function deviceSlug(device) {
  return device.class ? toSlug(`${device.class}-${device.name}`) : toSlug(device.name);
}

export function buildPath(config, { device, firmware, version, firmwareClass }) {
  if(!device) return '/';
  let path = `/${firmwareClass ? `${firmwareClass}-` : ''}${deviceSlug(device)}/`;
  if(!firmware) return path;
  path += `${firmwareSlug(config, firmware)}/`;
  if(version) path += toSlug(version);

  return path;
}

// Returns as much of the selection as the path matches; unknown segments are ignored
export function parsePath(config, path) {
  const selection = { device: null, firmware: null, version: null, firmwareClass: null };
  const [deviceSlugPart, roleSlug, versionSlug] = path.split('/').filter(Boolean);
  if(!deviceSlugPart) return selection;

  // Match the full slug first. A device whose class is already in the slug
  // (/observer-heltec-v3/) must not also be treated as a firmware-class filter.
  let devices = config.device.filter(d => deviceSlug(d) === deviceSlugPart);
  if(devices.length === 0) {
    const firmwareClass = Object.keys(firmwareClasses).find(cls => deviceSlugPart.startsWith(`${cls}-`));
    if(firmwareClass) {
      const stripped = deviceSlugPart.slice(firmwareClass.length + 1);
      devices = config.device.filter(d => deviceSlug(d) === stripped || toSlug(d.name) === stripped);
      if(devices.length > 0) selection.firmwareClass = firmwareClass;
    }
  }
  if(devices.length === 0) return selection;

  // several devices may share a slug, the role picks the right one
  const findFirmware = (device) => device.firmware.find(f => hasVersions(f) && firmwareSlug(config, f) === roleSlug);
  const device = (roleSlug && devices.find(findFirmware)) || devices[0];
  selection.device = device;
  if(!roleSlug) return selection;

  const firmware = findFirmware(device);
  if(!firmware) return selection;
  selection.firmware = firmware;
  selection.version = Object.keys(firmware.version).find(v => toSlug(v) === versionSlug) ?? null;

  return selection;
}

// Version changes only refine the current page, so they replace the history entry instead of pushing
export function isSamePage(pathA, pathB) {
  const [deviceA, roleA] = pathA.split('/').filter(Boolean);
  const [deviceB, roleB] = pathB.split('/').filter(Boolean);

  return Boolean(roleA) && deviceA === deviceB && roleA === roleB;
}
