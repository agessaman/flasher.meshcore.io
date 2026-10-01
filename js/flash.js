// Flashing backends: esptool.js for ESP32, adafruit-nrfutil style serial DFU for nRF52
import { Dfu } from '/lib/dfu.js';
import { ESPLoader, Transport, HardReset } from '/lib/esp32.js';
import { configName } from './site.js';
import { assetUrl, findFreshFeedUrl, firmwareHashFromConfig, withFirmwareHash } from './firmware-url.js';
import { blobToBinaryString, delay } from './util.js';

// ESP32 app partition; merged images (bootloader + partitions + app) start at 0
const ESP32_APP_ADDRESS = 0x10000;

async function fetchCurrentFirmwareHash() {
  try {
    const res = await fetch(`/${configName}.json?t=${Date.now()}`, { cache: 'no-store' });
    if(!res.ok) return null;
    return firmwareHashFromConfig(await res.text());
  }
  catch(e) {
    return null;
  }
}

// A tab left open across a rebuild holds a feed URL whose binary was already pruned.
async function refetchFeedUrl(releasesUrl, staleUrl) {
  try {
    if(!releasesUrl) return null;
    const res = await fetch(`${releasesUrl}?t=${Date.now()}`, { cache: 'no-store' });
    if(!res.ok) return null;
    return findFreshFeedUrl(await res.json(), staleUrl);
  }
  catch(e) {
    return null;
  }
}

// `name` is a feed URL, a root-relative upload, or a filename under staticPath.
// Absolute paths are local uploads and are not rewritten after a 404.
export async function downloadFirmware(name, config) {
  const toUrl = (asset) => assetUrl(config.staticPath, asset);
  console.log(`downloading: ${toUrl(name)}`);
  let res = await fetch(toUrl(name), { cache: 'no-store' });
  if(res.status === 404 && !String(name).startsWith('/')) {
    const fresh = /^https?:\/\//i.test(name)
      ? ((await refetchFeedUrl(config.releasesUrl, name)) ?? name)
      : withFirmwareHash(name, await fetchCurrentFirmwareHash());
    if(fresh !== name) {
      console.log(`firmware 404; retrying with current build: ${toUrl(fresh)}`);
      res = await fetch(toUrl(fresh), { cache: 'no-store' });
    }
  }
  if(!res.ok) {
    throw new Error(`Could not download the firmware file from the server, reported: HTTP ${res.status}.\nPlease try again.`);
  }

  return await res.blob();
}

export const isMergedImage = (filename) => /-merged\.bin$/.test(filename);

export function esp32Address(file) {
  return file.type === 'flash-wipe' || isMergedImage(file.title ?? file.file?.name ?? '') ? 0 : ESP32_APP_ADDRESS;
}

// Picks the file to flash from a version's files (custom uploads carry the File object itself)
export function pickFlashFile(files, { esp32, wipe }) {
  const flashFiles = files.filter(f => f.type.startsWith('flash'));
  if(esp32) {
    const preferred = flashFiles.find(f => f.type === (wipe ? 'flash-wipe' : 'flash-update'));
    if(preferred) return preferred;
  }

  return flashFiles[0];
}

async function pulseRts(transport) {
  await transport.setRTS(true);
  await delay(100);
  await transport.setRTS(false);
}

// onLoader receives the ESPLoader as soon as it exists, so the caller can release the port later
export async function flashEsp32(port, data, { address, eraseAll, terminal, onProgress, onLoader }) {
  const transport = new Transport(port, true);
  const options = {
    transport,
    terminal,
    compress: true,
    eraseAll,
    flashSize: 'keep',
    flashMode: 'keep',
    flashFreq: 'keep',
    baudrate: 115200,
    romBaudrate: 115200,
    enableTracing: false,
    fileArray: [{ data: await blobToBinaryString(data), address }],
    reportProgress: (_, written, total) => onProgress((written / total) * 100),
  };

  const loader = new ESPLoader(options);
  loader.hr = new HardReset(transport);
  onLoader?.(loader);

  try {
    await loader.main();
    await loader.flashId();
  }
  catch(e) {
    console.error(e);
    throw new Error(`Failed to initialize. Did you place the device into firmware download mode? Detail: ${e}`);
  }

  try {
    await loader.writeFlash(options);
    await delay(100);
    await loader.after('hard_reset');
    await delay(100);
  }
  catch(e) {
    console.error(e);
    throw new Error(`ESP32 flashing failed: ${e}`);
  }
  finally {
    await pulseRts(transport);
    await transport.disconnect();
  }
}

export async function flashNrf52(dfu, data, onProgress) {
  try {
    await dfu.dfuUpdate(data, onProgress);
  }
  catch(e) {
    console.error(e);
    throw new Error(`nRF flashing failed: ${e}. Please reset the device and try again.`);
  }
}

// Resets / closes whatever a previous flashing attempt left open
export async function releaseFlasher(instance) {
  try {
    if(instance instanceof ESPLoader) {
      await instance.hr.reset();
      await instance.transport.disconnect();
    }
    else if(instance instanceof Dfu) {
      await instance.port.close();
    }
  }
  catch(e) {
    console.error(e);
  }
}

export { Dfu };
