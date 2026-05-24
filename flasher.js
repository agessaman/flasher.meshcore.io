import "/lib/beer.min.js";
import { createApp, reactive, ref, nextTick, watch, computed } from "/lib/vue.min.js";
import { Dfu } from "/lib/dfu.js";
import { ESPLoader, Transport, HardReset } from "/lib/esp32.js";
import { SerialConsole } from '/lib/console.js';

const searchParams = new URLSearchParams(location.search);
const configName = searchParams.get('config')?.replaceAll(/[^a-z_-]/g, '') ?? 'config';
const configRes = await fetch(`/${configName}.json`);
const config = await configRes.json();

let github = [];
try {
  const githubRes = await fetch('/releases');
  if (githubRes.ok) github = await githubRes.json();
} catch (e) {}

const commandReference  = {
  // --- General ---
  'time ': 'Set time {epoch-secs}',
  'erase': 'Erase filesystem',
  'advert': 'Send Advertisment packet',
  'reboot': 'Reboot device',
  'clock': 'Display current time',
  'password ': 'Set new password',
  'log': 'Ouput log',
  'log start': 'Start packet logging to file system',
  'log stop': 'Stop packet logging to file system',
  'log erase': 'Erase the packet logs from file system',
  'ver': 'Show device version',

  // --- Radio & Device ---
  'set freq ': 'Set frequency {MHz}',
  'set af ': 'Set Air-time factor',
  'set tx ': 'Set Tx power {dBm}',
  'set repeat ': 'Set repeater mode {on|off}',
  'set advert.interval ': 'Set advert rebroadcast interval {minutes}',
  'set guest.password ': 'Set guest password',
  'set name ': 'Set device name (also sets MQTT origin)',
  'set lat ': 'Set advertisement map latitude',
  'set lon ': 'Set advertisement map longitude',
  'set prv.key ': 'Restore private key for identity migration {64-hex-char-key}',
  'get freq': 'Get frequency (MHz)',
  'get af': 'Get Air-time factor',
  'get tx': 'Get Tx power (dBm)',
  'get repeat': 'Get repeater mode',
  'get advert.interval': 'Get advert rebroadcast interval (minutes)',
  'get name': 'Get device name',
  'get lat': 'Get advertisement map latitude',
  'get lon': 'Get advertisement map longitude',
  'get public.key': 'Get device public key',

  // --- MQTT shared ---
  'get mqtt.origin': 'Get MQTT origin name',
  'set mqtt.origin ': 'Set MQTT origin name',
  'get mqtt.iata': 'Get IATA code',
  'set mqtt.iata ': 'Set IATA code (auto-uppercased)',
  'get mqtt.status': 'Get MQTT connection status per slot',
  'get mqtt.presets': 'List available MQTT presets',
  'get mqtt.presets ': 'List MQTT presets from index {start}',
  'get mqtt.packets': 'Get packet message setting (on/off)',
  'set mqtt.packets ': 'Enable/disable packet messages {on|off}',
  'get mqtt.raw': 'Get raw message setting (on/off)',
  'set mqtt.raw ': 'Enable/disable raw messages {on|off}',
  'get mqtt.rx': 'Get RX packet uplinking setting (on/off)',
  'set mqtt.rx ': 'Enable/disable RX packet uplinking {on|off}',
  'get mqtt.tx': 'Get TX packet uplinking setting (on/off/advert)',
  'set mqtt.tx ': 'Set TX packet uplinking {on|off|advert}',
  'get mqtt.interval': 'Get status publish interval (minutes)',
  'set mqtt.interval ': 'Set status publish interval {1-60 minutes}',
  'get mqtt.owner': 'Get owner public key',
  'set mqtt.owner ': 'Set owner public key {64-hex-char-key}',
  'get mqtt.email': 'Get owner email address',
  'set mqtt.email ': 'Set owner email address',

  // --- MQTT slot 1 ---
  'get mqtt1.preset': 'Get slot 1 preset name',
  'set mqtt1.preset ': 'Set slot 1 preset {analyzer-us|analyzer-eu|meshmapper|meshrank|waev|meshomatic|cascadiamesh|tennmesh|nashmesh|chimesh|meshat.se|eastidahomesh|coloradomesh|custom|none}',
  'get mqtt1.server': 'Get slot 1 server hostname',
  'set mqtt1.server ': 'Set slot 1 custom server hostname',
  'get mqtt1.port': 'Get slot 1 server port',
  'set mqtt1.port ': 'Set slot 1 custom server port {1-65535}',
  'get mqtt1.username': 'Get slot 1 username',
  'set mqtt1.username ': 'Set slot 1 custom username',
  'get mqtt1.password': 'Get slot 1 password',
  'set mqtt1.password ': 'Set slot 1 custom password',
  'get mqtt1.token': 'Get slot 1 per-slot token',
  'set mqtt1.token ': 'Set slot 1 token (required for meshrank preset)',
  'get mqtt1.topic': 'Get slot 1 custom topic template',
  'set mqtt1.topic ': 'Set slot 1 custom topic template e.g. {iata}/{device}/{type}',
  'get mqtt1.audience': 'Get slot 1 JWT audience',
  'set mqtt1.audience ': 'Set slot 1 JWT audience (enables Ed25519 auth; omit value to clear)',

  // --- MQTT slot 2 ---
  'get mqtt2.preset': 'Get slot 2 preset name',
  'set mqtt2.preset ': 'Set slot 2 preset {analyzer-us|analyzer-eu|meshmapper|meshrank|waev|meshomatic|cascadiamesh|tennmesh|nashmesh|chimesh|meshat.se|eastidahomesh|coloradomesh|custom|none}',
  'get mqtt2.server': 'Get slot 2 server hostname',
  'set mqtt2.server ': 'Set slot 2 custom server hostname',
  'get mqtt2.port': 'Get slot 2 server port',
  'set mqtt2.port ': 'Set slot 2 custom server port {1-65535}',
  'get mqtt2.username': 'Get slot 2 username',
  'set mqtt2.username ': 'Set slot 2 custom username',
  'get mqtt2.password': 'Get slot 2 password',
  'set mqtt2.password ': 'Set slot 2 custom password',
  'get mqtt2.token': 'Get slot 2 per-slot token',
  'set mqtt2.token ': 'Set slot 2 token (required for meshrank preset)',
  'get mqtt2.topic': 'Get slot 2 custom topic template',
  'set mqtt2.topic ': 'Set slot 2 custom topic template e.g. {iata}/{device}/{type}',
  'get mqtt2.audience': 'Get slot 2 JWT audience',
  'set mqtt2.audience ': 'Set slot 2 JWT audience (enables Ed25519 auth; omit value to clear)',

  // --- MQTT slot 3 ---
  'get mqtt3.preset': 'Get slot 3 preset name',
  'set mqtt3.preset ': 'Set slot 3 preset {analyzer-us|analyzer-eu|meshmapper|meshrank|waev|meshomatic|cascadiamesh|tennmesh|nashmesh|chimesh|meshat.se|eastidahomesh|coloradomesh|custom|none}',
  'get mqtt3.server': 'Get slot 3 server hostname',
  'set mqtt3.server ': 'Set slot 3 custom server hostname',
  'get mqtt3.port': 'Get slot 3 server port',
  'set mqtt3.port ': 'Set slot 3 custom server port {1-65535}',
  'get mqtt3.username': 'Get slot 3 username',
  'set mqtt3.username ': 'Set slot 3 custom username',
  'get mqtt3.password': 'Get slot 3 password',
  'set mqtt3.password ': 'Set slot 3 custom password',
  'get mqtt3.token': 'Get slot 3 per-slot token',
  'set mqtt3.token ': 'Set slot 3 token (required for meshrank preset)',
  'get mqtt3.topic': 'Get slot 3 custom topic template',
  'set mqtt3.topic ': 'Set slot 3 custom topic template e.g. {iata}/{device}/{type}',
  'get mqtt3.audience': 'Get slot 3 JWT audience',
  'set mqtt3.audience ': 'Set slot 3 JWT audience (enables Ed25519 auth; omit value to clear)',

  // --- MQTT slot 4 ---
  'get mqtt4.preset': 'Get slot 4 preset name',
  'set mqtt4.preset ': 'Set slot 4 preset {analyzer-us|analyzer-eu|meshmapper|meshrank|waev|meshomatic|cascadiamesh|tennmesh|nashmesh|chimesh|meshat.se|eastidahomesh|coloradomesh|custom|none}',
  'get mqtt4.server': 'Get slot 4 server hostname',
  'set mqtt4.server ': 'Set slot 4 custom server hostname',
  'get mqtt4.port': 'Get slot 4 server port',
  'set mqtt4.port ': 'Set slot 4 custom server port {1-65535}',
  'get mqtt4.username': 'Get slot 4 username',
  'set mqtt4.username ': 'Set slot 4 custom username',
  'get mqtt4.password': 'Get slot 4 password',
  'set mqtt4.password ': 'Set slot 4 custom password',
  'get mqtt4.token': 'Get slot 4 per-slot token',
  'set mqtt4.token ': 'Set slot 4 token (required for meshrank preset)',
  'get mqtt4.topic': 'Get slot 4 custom topic template',
  'set mqtt4.topic ': 'Set slot 4 custom topic template e.g. {iata}/{device}/{type}',
  'get mqtt4.audience': 'Get slot 4 JWT audience',
  'set mqtt4.audience ': 'Set slot 4 JWT audience (enables Ed25519 auth; omit value to clear)',

  // --- MQTT slot 5 ---
  'get mqtt5.preset': 'Get slot 5 preset name',
  'set mqtt5.preset ': 'Set slot 5 preset {analyzer-us|analyzer-eu|meshmapper|meshrank|waev|meshomatic|cascadiamesh|tennmesh|nashmesh|chimesh|meshat.se|eastidahomesh|coloradomesh|custom|none}',
  'get mqtt5.server': 'Get slot 5 server hostname',
  'set mqtt5.server ': 'Set slot 5 custom server hostname',
  'get mqtt5.port': 'Get slot 5 server port',
  'set mqtt5.port ': 'Set slot 5 custom server port {1-65535}',
  'get mqtt5.username': 'Get slot 5 username',
  'set mqtt5.username ': 'Set slot 5 custom username',
  'get mqtt5.password': 'Get slot 5 password',
  'set mqtt5.password ': 'Set slot 5 custom password',
  'get mqtt5.token': 'Get slot 5 per-slot token',
  'set mqtt5.token ': 'Set slot 5 token (required for meshrank preset)',
  'get mqtt5.topic': 'Get slot 5 custom topic template',
  'set mqtt5.topic ': 'Set slot 5 custom topic template e.g. {iata}/{device}/{type}',
  'get mqtt5.audience': 'Get slot 5 JWT audience',
  'set mqtt5.audience ': 'Set slot 5 JWT audience (enables Ed25519 auth; omit value to clear)',

  // --- MQTT slot 6 ---
  'get mqtt6.preset': 'Get slot 6 preset name',
  'set mqtt6.preset ': 'Set slot 6 preset {analyzer-us|analyzer-eu|meshmapper|meshrank|waev|meshomatic|cascadiamesh|tennmesh|nashmesh|chimesh|meshat.se|eastidahomesh|coloradomesh|custom|none}',
  'get mqtt6.server': 'Get slot 6 server hostname',
  'set mqtt6.server ': 'Set slot 6 custom server hostname',
  'get mqtt6.port': 'Get slot 6 server port',
  'set mqtt6.port ': 'Set slot 6 custom server port {1-65535}',
  'get mqtt6.username': 'Get slot 6 username',
  'set mqtt6.username ': 'Set slot 6 custom username',
  'get mqtt6.password': 'Get slot 6 password',
  'set mqtt6.password ': 'Set slot 6 custom password',
  'get mqtt6.token': 'Get slot 6 per-slot token',
  'set mqtt6.token ': 'Set slot 6 token (required for meshrank preset)',
  'get mqtt6.topic': 'Get slot 6 custom topic template',
  'set mqtt6.topic ': 'Set slot 6 custom topic template e.g. {iata}/{device}/{type}',
  'get mqtt6.audience': 'Get slot 6 JWT audience',
  'set mqtt6.audience ': 'Set slot 6 JWT audience (enables Ed25519 auth; omit value to clear)',

  // --- WiFi ---
  'get wifi.ssid': 'Get WiFi SSID',
  'set wifi.ssid ': 'Set WiFi SSID (spaces allowed, no quotes)',
  'get wifi.pwd': 'Get WiFi password',
  'set wifi.pwd ': 'Set WiFi password (spaces allowed; use trailing space only for open networks)',
  'get wifi.status': 'Get WiFi connection status, IP, RSSI, and uptime',
  'get wifi.powersave': 'Get WiFi power save mode (none/min/max)',
  'set wifi.powersave ': 'Set WiFi power save mode {none|min|max}',

  // --- Timezone ---
  'get timezone': 'Get timezone string e.g. America/Los_Angeles',
  'set timezone ': 'Set timezone {IANA string|abbreviation|UTC offset}',
  'get timezone.offset': 'Get timezone offset in hours',
  'set timezone.offset ': 'Set timezone offset in hours {-12 to +14}',

  // --- Bridge ---
  'get bridge.source': 'Get packet source (rx/tx)',
  'set bridge.source ': 'Set packet source {rx|tx}',
  'get bridge.enabled': 'Get bridge enabled status (on/off)',
  'set bridge.enabled ': 'Enable/disable bridge {on|off}',

  // --- SNMP ---
  'get snmp': 'Get SNMP agent status (on/off)',
  'set snmp ': 'Enable/disable SNMP agent {on|off} (restart required)',
  'get snmp.community': 'Get SNMP community string',
  'set snmp.community ': 'Set SNMP community string (restart required)',
};

async function delay(milis) {
  return await new Promise((resolve) => setTimeout(resolve, milis));
}

function toSlug(text) {
  return String(text).toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-|-$/g, '');
}

function getGithubReleases(roleType, files) {
  const versions = {};
  for(const [fileType, matchRE] of Object.entries(files)) {
    for(const versionType of github) {
      if(versionType.type !== roleType) { continue }
      const version = versions[versionType.version] ??= {
        notes: versionType.notes,
        files: []
      };
      for(const file of versionType.files) {
        if(!new RegExp(matchRE).test(file.name)) { continue }
        version.files.push({
          type: fileType,
          name: file.url,
          title: file.name,
        })
      }
    }
  }

  return versions;
}

function addGithubFiles() {
  for(const device of config.device) {
    for(const firmware of device.firmware) {
      const gDef = firmware.github;
      if(!gDef?.files) { continue }
      firmware.version = getGithubReleases(gDef.type, gDef.files);

      // clean versions without files
      for(const [verName, verValue] of Object.entries(firmware.version)) {
        if(verValue.files.length === 0) delete firmware.version[verName]
      }
    }
  }

  config.device = config.device.filter(device => device.firmware.some(firmware => Object.keys(firmware.version).length > 0 ));

  return config;
}

async function digestMessage(message) {
  const msgUint8 = new TextEncoder().encode(message); // encode as (utf-8) Uint8Array
  const hashBuffer = await window.crypto.subtle.digest("SHA-256", msgUint8); // hash the message
  const hashArray = Array.from(new Uint8Array(hashBuffer)); // convert buffer to byte array

  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(""); // convert bytes to hex string

  return hashHex;
}

async function blobToBinaryString(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binString = '';

  for (let i = 0; i < bytes.length; i++) {
    binString += String.fromCharCode(bytes[i]);
  }

  return binString;
}

console.log(addGithubFiles());

function setup() {
  const consoleEditBox = ref();
  const consoleWindow = ref();

  const deviceFilterText = ref('');

  const snackbar = reactive({
    text: '',
    class: '',
    icon: '',
  });

  const selected = reactive({
    device: null,
    firmware: null,
    version: null,
    wipe: false,
    espFlashAddress: 0x10000,
    nrfEraserFlashingPercent: 0,
    nrfEraserFlashing: false,
    port: null,
  });

  const getRoleFwValue = (firmware, key) => {
    const role = config.role[firmware.role] ?? {};

    return firmware[key] ?? role[key] ?? '';
  }

  const getSelFwValue = (key) => {
    const fwVersion = selected.firmware.version[selected.version];

    return fwVersion ? fwVersion[key] || '' : '';
  }

  const getNotice = (selected) => {
    let notice = config.notice[selected.firmware.notice] || selected.firmware.notice || '';

    if(notice) {
      notice = notice.replaceAll(/\$\{(\w+)\}/g, (_, varName) => selected.device[varName] || '');
    }

    return notice;
  }

  const formatChangeLog = (changelog) => {
    return changelog
      .replace(/change log:\r?\n/i, '')
      .replace(/^[-*] /mg, '')
      .replace(/#(\d+)$/gm, `<a target="_blank" href="https://github.com/meshcore-dev/MeshCore/pull/$1">#$1</a>`)
//      .split(/\r?\n/)
//      .map(l => `* ${l}`)
//      .join('\n')
  }

  const flashing = reactive({
    supported: 'Serial' in window || 'serial' in window.navigator,
    instance: null,
    locked: false,
    percent: 0,
    log: '',
    error: '',
    dfuComplete: false,
  });

  const serialCon = reactive({
    instance: null,
    opened: false,
    content: '',
    edit: '',
  });

  window.app = { selected, flashing, serialCon };

  const log = {
    clean() { flashing.log = '' },
    write(data) { flashing.log += data },
    writeLine(data) { flashing.log += data + '\n' }
  };

  const retry = async() => {
    flashing.active = false;
    flashing.log = '';
    flashing.error = '';
    flashing.dfuComplete = false;
    flashing.percent = 0;
    if(flashing.instance instanceof ESPLoader) {
      await flashing.instance?.hr.reset();
      await flashing.instance?.transport?.disconnect();
    }
  }

  const close = () => {
    location.reload()
  }

  const getFirmwarePath = (file) => {
    return file.name.startsWith('/') ? file.name : `${config.staticPath}/${file.name}`;
  }

  const firmwareHasData = (firmware) => {
    const firstVersion = Object.keys(firmware.version)[0];
    if(!firstVersion) return false;

    return firmware.version[firstVersion].files.length > 0;
  }

  // --- URL Routing ---
  // NOTE: the server must serve index.html for all paths (catch-all / try_files).

  const deviceToSlug = (device) => toSlug([device.class, device.name].join('-'));

  const firmwareToSlug = (firmware) => {
    const title = getRoleFwValue(firmware, 'title');
    const subTitle = getRoleFwValue(firmware, 'subTitle');
    return toSlug(subTitle ? `${title}-${subTitle}` : title);
  };

  let initializingFromUrl = false;

  const buildUrl = () => {
    if (serialCon.opened) return '/console';
    if (!selected.device) return '/';
    let path = '/' + deviceToSlug(selected.device) + '/';
    if (!selected.firmware) return path;
    path += firmwareToSlug(selected.firmware) + '/';
    if (selected.version) path += toSlug(selected.version);
    return path;
  };

  const updateUrl = (replace = false) => {
    if (initializingFromUrl) return;
    const path = buildUrl();
    if (window.location.pathname !== path) {
      replace ? history.replaceState(null, '', path) : history.pushState(null, '', path);
    }
  };

  const applyUrlPath = (path) => {
    initializingFromUrl = true;
    const segments = path.replace(/^\/|\/$/g, '').split('/').filter(Boolean);

    if (segments.length === 0 || segments[0] === 'console') {
      nextTick(() => { initializingFromUrl = false; });
      return;
    }

    const [deviceSlug, roleSlug, versionSlug] = segments;
    const matchingDevices = config.device.filter(d => deviceToSlug(d) === deviceSlug);
    if (matchingDevices.length === 0) {
      nextTick(() => { initializingFromUrl = false; });
      return;
    }

    // When multiple devices share the same slug, use the firmware slug to pick the right one
    let device, firmware;
    if (roleSlug && matchingDevices.length > 1) {
      for (const d of matchingDevices) {
        const f = d.firmware.find(f => firmwareToSlug(f) === roleSlug && firmwareHasData(f));
        if (f) { device = d; firmware = f; break; }
      }
    }
    if (!device) device = matchingDevices[0];
    selected.device = device;

    if (!roleSlug) {
      nextTick(() => { initializingFromUrl = false; });
      return;
    }

    if (!firmware) firmware = device.firmware.find(f => firmwareToSlug(f) === roleSlug && firmwareHasData(f));
    if (!firmware) {
      nextTick(() => { initializingFromUrl = false; });
      return;
    }
    selected.firmware = firmware;

    // Use nextTick so the firmware watcher sets the default version first,
    // then we override it with the version from the URL.
    nextTick(() => {
      if (versionSlug) {
        const versionName = Object.keys(firmware.version).find(v => toSlug(v) === versionSlug);
        if (versionName) selected.version = versionName;
      }
      initializingFromUrl = false;
    });
  };

  const stepBack = () => {
    if(selected.device && selected.firmware) {
      if(selected.firmware.version[selected.version].customFile) {
        selected.firmware = null;
        selected.device = null;
        return
      }

      selected.firmware = null;
      return;
    }

    if(selected.device) {
      selected.device = null;
    }
  }

  const flasherCleanup = async () => {
    flashing.active = false;
    flashing.log = '';
    flashing.error = '';
    flashing.dfuComplete = false;
    flashing.percent = 0;
    selected.firmware = null;
    selected.version = null;
    selected.wipe = false;
    selected.device = null;
    selected.nrfEraserFlashingPercent = 0;
    selected.nrfEraserFlashing = false;
    if(flashing.instance instanceof ESPLoader) {
      await flashing.instance?.hr.reset();
      await flashing.instance?.transport?.disconnect();
    }
    else if(flashing.instance instanceof Dfu) {
      try {
        flashing.instance.port.close()
      }
      catch(e) {
        console.error(e);
      }
    }
    flashing.instance = null;
  }

  const openSerialGUI = () => {
    window.open('https://config.meshcore.dev','meshcore_config','directories=no,titlebar=no,toolbar=no,location=no,status=no,menubar=no,scrollbars=no,resizable=no,width=1000,height=800');
  }

  const openSerialCon = async() => {
    const port = selected.port = await navigator.serial.requestPort();
    const serialConsole = serialCon.instance = new SerialConsole(port);

    serialCon.content =  '-------------------------------------------------------------------------\n';
    serialCon.content += 'Welcome to MeshCore serial console.\n'
    serialCon.content += 'Click on the cursor to get all supported commands.\n';
    serialCon.content += '-------------------------------------------------------------------------\n\n';

    serialConsole.onOutput = (text) => {
      serialCon.content += text;
    };
    serialConsole.connect();
    serialCon.opened = true;
    await nextTick();

    consoleEditBox.value.focus();
  }

  const closeSerialCon = async() => {
    serialCon.opened = false;
    await serialCon.instance.disconnect();
  }

  const sendCommand = async(text) => {
    const consoleEl = consoleWindow.value;
    serialCon.edit = '';
    await serialCon.instance.sendCommand(text);
    setTimeout(() => consoleEl.scrollTop = consoleEl.scrollHeight, 100);
  }

  const dfuMode = async() => {
    await Dfu.forceDfuMode(await navigator.serial.requestPort({}))
    flashing.dfuComplete = true;
  }

  const customFirmwareLoad = async(ev) => {
    const firmwareFile = ev.target.files[0];
    const type = firmwareFile.name.endsWith('.bin') ? 'esp32' : 'nrf52';
      selected.device = {
      name: 'Custom device',
      type,
    };
    if(firmwareFile.name.endsWith('-merged.bin')) {
      alert(
        'You selected custom file that ends with "merged.bin".'+
        'This will erase your flash! Proceed with caution.'+
        'If you want just to update your firmware, please use non-merged bin.'
      );

      selected.wipe = true;
      selected.espFlashAddress = 0;
    }

    selected.firmware = {
      icon: 'unknown_document',
      title: firmwareFile.name,
      version: {},
    }
    selected.version = firmwareFile.name;
    selected.firmware.version[selected.version] = {
      customFile: true,
      files: [{ type: 'flash', file: firmwareFile }]
    }
  }

  const espReset = async(t) => {
    await t.setRTS(true);
    await delay(100)
    await t.setRTS(false);
  }

  const nrfErase = async() => {
    if(!(selected.device.type === 'nrf52' && selected.device.erase)) {
      console.error('nRF erase called for non-nrf device or device.erase is not defined')
      return;
    }

    const url = `${config.staticPath}/${selected.device.erase}`;

    console.log('downloading: ' + url);
    const resp = await fetch(url);
    if(resp.status !== 200) {
      alert(`Could not download the firmware file from the server, reported: HTTP ${resp.status}.\nPlease try again.`)
      return;
    }
    const flashData = await resp.blob();

    const port = selected.port = await navigator.serial.requestPort({});
    const dfu = new Dfu(port);

    try {
      selected.nrfEraserFlashing = true;
      await dfu.dfuUpdate(flashData, async (progress) => {
        selected.nrfEraserFlashingPercent = progress;
        if(progress === 100 && selected.nrfEraserFlashing) {
          selected.nrfEraserFlashing = false;
          selected.dfuComplete = false;
          setTimeout(() => {
            alert('Device erase firmware has been flashed and flash has been erased.\nYou can flash MeshCore now.');
          }, 200);
        }
      }, 60000);

    }
    catch(e) {
      alert(`nRF flashing erase firmware failed: ${e}.\nDid you put the device into DFU mode before attempting erasing?`);
      selected.nrfEraserFlashing = false;
      selected.nrfEraserFlashingPercent = 0;
      return;
    }
  }

  const canFlash = (device) => {
    return device.type !== 'noflash'
  }

  const flashDevice = async() => {
    const device = selected.device;
    const firmware = selected.firmware.version[selected.version];

    const flashFiles = firmware.files.filter(f => f.type.startsWith('flash'));
    if(!flashFiles[0]) {
      alert('Cannot find configuration for flash file! please report this to Discord.')
      flasherCleanup();
      return;
    }

    let flashData;
    if(flashFiles[0].file) {
      flashData = flashFiles[0].file;
    } else {
      let flashFile;
      if(device.type === 'esp32') {
        flashFile = flashFiles.find(f => f.type === (selected.wipe ? 'flash-wipe' : 'flash-update'));
        if(selected.wipe) selected.espFlashAddress = 0x00000;
      }
      else {
        flashFile = flashFiles[0];
      }
      console.log({flashFiles, flashFile});

      const url = getFirmwarePath(flashFile);
      console.log('downloading: ' + url);
      const resp = await fetch(url);
      if(resp.status !== 200) {
        alert(`Could not download the firmware file from the server, reported: HTTP ${resp.status}.\nPlease try again.`)
        return;
      }

      flashData = await resp.blob();
    }

    const port = selected.port = await navigator.serial.requestPort({});

    if(device.type === 'esp32') {
      let esploader;
      let transport;

      const flashOptions = {
        terminal: log,
        compress: true,
        eraseAll: selected.wipe,
        flashSize: 'keep',
        flashMode: 'keep',
        flashFreq: 'keep',
        baudrate: 115200,
        romBaudrate: 115200,
        enableTracing: false,
        fileArray: [{
          data: await blobToBinaryString(flashData),
   	  address: selected.espFlashAddress
        }],
        reportProgress: async (_, written, total) => {
          flashing.percent = (written / total) * 100;
        },
      };

      try {
        flashing.active = true;
        transport = new Transport(port, true);
        flashOptions.transport = transport;
        flashing.instance = esploader = new ESPLoader(flashOptions);
        esploader.hr = new HardReset(transport);
        await esploader.main();
        await esploader.flashId();
      }
      catch(e) {
        console.error(e);
        flashing.error = `Failed to initialize. Did you place the device into firmware download mode? Detail: ${e}`;
        esploader = null;
        return;
      }

      try {
        await esploader.writeFlash(flashOptions);
        await delay(100);
        await esploader.after('hard_reset');
        await delay(100);
        await espReset(transport);
        await transport.disconnect();
      }
      catch(e) {
        console.error(e);
        flashing.error = `ESP32 flashing failed: ${e}`;
        await espReset(transport);
        await transport.disconnect();
        return;
      }
    }
    else if(device.type === 'nrf52') {
      const dfu = flashing.instance = new Dfu(port);

      flashing.active = true;

      try {
        await dfu.dfuUpdate(flashData, async (progress) => {
          flashing.percent = progress;
        }, 60000);

      }
      catch(e) {
        console.error(e);
        flashing.error = `nRF flashing failed: ${e}. Please reset the device and try again.`;
        return;
      }
    }
  };

  const devices = computed(() => {
    const classes = ['ripple', 'meshos', 'community', 'observer'];
    const deviceGroups = {};

    let index = 0;
    for(const cls of classes) {
      const devices = config.device.toSorted(
	(a, b) => (index + a.maker + a.name).localeCompare(index + b.maker + b.name)
      ).filter(
        d => d.class === cls && (deviceFilterText.value == '' || d.name.toLowerCase().includes(deviceFilterText.value?.toLowerCase()))
      )
      if(devices.length > 0) deviceGroups[cls] = devices;
    }

    return deviceGroups;
  });

  const showMessage = (text, icon, displayMs) => {
    snackbar.class = 'active';
    snackbar.text = text;
    snackbar.icon = icon || '';

    setTimeout(() => {
      snackbar.icon = '';
      snackbar.text = '';
      snackbar.class = '';
    }, displayMs || 2000);
  }

  const consoleMouseUp = (ev) => {
    if(window.getSelection().toString().length) {
      navigator.clipboard.writeText(window.getSelection().toString())
      showMessage('text copied to clipboard');
    }
    consoleEditBox.value.focus();
  }

  watch(() => selected.firmware, (firmware) => {
    if(firmware == null) return;
    selected.version = Object.keys(firmware.version)[0];
  });

  watch(() => selected.device, updateUrl);
  watch(() => selected.firmware, updateUrl);
  watch(() => selected.version, () => updateUrl(true));  // replace: version is a refinement, not a new nav step
  watch(() => serialCon.opened, updateUrl);

  window.addEventListener('popstate', () => {
    if (serialCon.opened) closeSerialCon();
    flashing.active = false;
    flashing.log = '';
    flashing.error = '';
    selected.firmware = null;
    selected.version = null;
    selected.device = null;
    applyUrlPath(window.location.pathname);
  });

  const getInitialPath = () => {
    const params = new URLSearchParams(window.location.search);
    const redirectPath = params.get('redirect');
    if (!redirectPath || !redirectPath.startsWith('/')) return window.location.pathname;

    history.replaceState(null, '', redirectPath);
    return redirectPath;
  };

  applyUrlPath(getInitialPath());

  return {
    snackbar,
    consoleEditBox, consoleWindow, consoleMouseUp,
    config, devices, selected, flashing, deviceFilterText,
    flashDevice, flasherCleanup, dfuMode,
    serialCon, closeSerialCon, openSerialCon,
    sendCommand, openSerialGUI,
    retry, close, commandReference,
    stepBack,
    customFirmwareLoad, getFirmwarePath,
    getSelFwValue, getRoleFwValue, getNotice, formatChangeLog,
    firmwareHasData,
    canFlash, nrfErase
  }
}

createApp({ setup }).mount('#app');
