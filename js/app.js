import { reactive, ref, shallowRef, nextTick, watch, computed, onMounted } from '/lib/vue.min.js';
import { SerialConsole } from '/lib/console.js';
import { commandReference } from './commands.js';
import { firmwareClasses, hasVersions, roleValue, renderNotice, formatChangeLog, firmwareUrl } from './catalog.js';
import { Dfu, downloadFirmware, esp32Address, flashEsp32, flashNrf52, isMergedImage, pickFlashFile, releaseFlasher } from './flash.js';
import { CONSOLE_PATH, buildPath, parsePath, isSamePage } from './router.js';
import { serialAPI, serialSupported } from './serial.js';
import { isIframe, logoFile } from './site.js';

const WEB_SERIAL_UNSUPPORTED = "This browser can't flash. Use Chrome or Edge on a computer, or Chrome on Android.";

export function createSetup(config) {
  return function setup() {
    const consoleEditBox = ref();
    const consoleWindow = ref();
    const deviceFilterText = ref('');
    const deviceFilter = ref();
    // The filter sits at the top of the flasher column on desktop. Skip phones:
    // focusing there opens the keyboard over the instructions.
    onMounted(() => {
      // Focusing in onMounted does not stick; the v-else input is patched again on the next flush.
      nextTick(() => {
        if(window.matchMedia('(min-width: 1024px)').matches) {
          deviceFilter.value?.focus({ preventScroll: true });
        }
      });
    });
    // device tooltips embed large SVG pictures, so only the hovered one is rendered
    const hoveredDevice = shallowRef(null);
    const displayWelcomeBanner = ref(isIframe && !localStorage.getItem('welcomeBannerDismissed'));

    const snackbar = reactive({ text: '', class: '', icon: '' });

    const selected = reactive({
      device: null,
      firmware: null,
      version: null,
      firmwareClass: null,
      wipe: false,
    });

    const flashing = reactive({
      supported: serialSupported,
      instance: null,
      active: false,
      percent: 0,
      log: '',
      error: '',
      dfuComplete: false,
    });

    // nRF52 "Erase Flash": flashes a formatter firmware that wipes the external flash
    const eraser = reactive({ active: false, percent: 0 });

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
      writeLine(data) { flashing.log += data + '\n' },
    };

    // --- catalog views ---

    const fwValue = (firmware, key) => roleValue(config, firmware, key);
    const currentVersion = computed(() => selected.firmware?.version[selected.version] ?? null);
    const notice = computed(() => selected.firmware ? renderNotice(config, selected.device, selected.firmware) : '');

    const devices = computed(() => {
      const filter = deviceFilterText.value.toLowerCase();
      const sortDevices = (list) => list.toSorted((a, b) =>
        `${a.maker ?? ''}${a.name}`.localeCompare(`${b.maker ?? ''}${b.name}`)
      );
      const groups = {};
      for(const cls of Object.keys(firmwareClasses)) {
        const list = sortDevices(config.device.filter(d => d.class === cls && d.name.toLowerCase().includes(filter)));
        if(list.length > 0) groups[cls] = list;
      }
      return groups;
    });

    const deviceFirmwareByClass = computed(() => {
      if(!selected.device) return {};
      const groups = {};
      for(const fw of selected.device.firmware) {
        if(!hasVersions(fw)) continue;
        if(selected.firmwareClass && fw.class !== selected.firmwareClass) continue;
        (groups[fw.class || 'other'] ??= []).push(fw);
      }
      // known classes first, in their defined order
      const order = [...Object.keys(firmwareClasses), ...Object.keys(groups)];
      return Object.fromEntries([...new Set(order)].filter(cls => groups[cls]).map(cls => [cls, groups[cls]]));
    });

    const downloads = computed(() => {
      const { device } = selected;
      if(!currentVersion.value || currentVersion.value.customFile) return [];
      const files = currentVersion.value.files.map(file => ({ title: file.title, href: firmwareUrl(config, file) }));
      if(device.type === 'nrf52') {
        if(device.erase) {
          const eraseUf2 = device.erase.replace('.zip', '.uf2');
          files.push({ title: eraseUf2, href: `${config.staticPath}/${eraseUf2}` });
        }
        for(const bootloader of device.bootloader ?? []) {
          files.push({ title: bootloader, href: `${config.staticPath}/${bootloader}` });
        }
      }
      return files;
    });

    // --- navigation ---

    const selectFirmware = (firmware) => {
      selected.firmware = firmware;
      selected.version = firmware && Object.keys(firmware.version).find(v => firmware.version[v].files.length > 0);
    };

    const applySelection = ({ device, firmware, version, firmwareClass }) => {
      selected.device = device;
      selected.firmwareClass = firmwareClass;
      selectFirmware(firmware);
      if(version) selected.version = version;
    };

    const stepBack = () => {
      if(selected.firmware) {
        // custom files have no role screen to go back to
        if(currentVersion.value?.customFile) selected.device = null;
        selectFirmware(null);
        return;
      }
      selected.device = null;
      selected.firmwareClass = null;
    };

    const resetFlashing = async () => {
      await releaseFlasher(flashing.instance);
      Object.assign(flashing, { instance: null, active: false, percent: 0, log: '', error: '', dfuComplete: false });
    };

    const retry = resetFlashing;
    const close = () => location.reload();

    // --- URL sync ---

    const currentPath = computed(() => {
      if(serialCon.opened) return CONSOLE_PATH;
      // a local file can't be linked to
      if(currentVersion.value?.customFile) return '/';
      return buildPath(config, selected);
    });

    // keeps ?config= and ?iframe= across navigation
    const setLocation = (path, replace) => history[replace ? 'replaceState' : 'pushState'](null, '', path + location.search);

    watch(currentPath, (path) => {
      if(location.pathname === path) return;
      setLocation(path, isSamePage(location.pathname, path));
    });

    // restores the selection from the URL, then normalizes the URL in place (e.g. adds the default version)
    const applyLocation = () => {
      applySelection(parsePath(config, location.pathname));
      setLocation(currentPath.value, true);
    };

    window.addEventListener('popstate', () => {
      if(serialCon.opened) closeSerialCon();
      flashing.active = false;
      flashing.log = '';
      flashing.error = '';
      applyLocation();
    });

    // GitHub Pages 404.html sends unknown paths back as /?redirect=/device/...
    const redirect = new URLSearchParams(location.search).get('redirect');
    if(redirect?.startsWith('/') && !redirect.startsWith('//')) {
      history.replaceState(null, '', redirect);
    }
    applyLocation();

    // --- serial console ---

    const openSerialGUI = () => {
      window.open('https://config.meshcore.io', 'meshcore_config', 'directories=no,titlebar=no,toolbar=no,location=no,status=no,menubar=no,scrollbars=no,resizable=no,width=1000,height=800');
    };

    const openSerialCon = async () => {
      const serialConsole = serialCon.instance = new SerialConsole(await serialAPI.requestPort());

      serialCon.content =
        '-------------------------------------------------------------------------\n' +
        'Welcome to MeshCore serial console.\n' +
        'Click on the cursor to get all supported commands.\n' +
        '-------------------------------------------------------------------------\n\n';

      serialConsole.onOutput = (text) => { serialCon.content += text };
      serialConsole.connect();
      serialCon.opened = true;
      await nextTick();
      consoleEditBox.value.focus();
    };

    const closeSerialCon = async () => {
      serialCon.opened = false;
      await serialCon.instance.disconnect();
    };

    const sendCommand = async (text) => {
      const consoleEl = consoleWindow.value;
      serialCon.edit = '';
      await serialCon.instance.sendCommand(text);
      setTimeout(() => consoleEl.scrollTop = consoleEl.scrollHeight, 100);
    };

    const showMessage = (text, icon = '', displayMs = 2000) => {
      Object.assign(snackbar, { class: 'active', text, icon });
      setTimeout(() => Object.assign(snackbar, { class: '', text: '', icon: '' }), displayMs);
    };

    const consoleMouseUp = () => {
      const selection = window.getSelection().toString();
      if(selection.length) {
        navigator.clipboard.writeText(selection);
        showMessage('text copied to clipboard');
      }
      consoleEditBox.value.focus();
    };

    // --- flashing ---

    const dfuMode = async () => {
      await Dfu.forceDfuMode(await serialAPI.requestPort({}));
      flashing.dfuComplete = true;
    };

    const customFirmwareLoad = (ev) => {
      const file = ev.target.files[0];
      selected.device = {
        name: 'Custom device',
        type: file.name.endsWith('.bin') ? 'esp32' : 'nrf52',
      };

      if(isMergedImage(file.name)) {
        alert(
          'You selected custom file that ends with "merged.bin". ' +
          'This will erase your flash! Proceed with caution. ' +
          'If you want just to update your firmware, please use non-merged bin.'
        );
        selected.wipe = true;
      }

      selected.firmware = {
        icon: 'unknown_document',
        title: file.name,
        version: {
          [file.name]: { customFile: true, files: [{ type: 'flash', file }] },
        },
      };
      selected.version = file.name;
    };

    const nrfErase = async () => {
      const { device } = selected;
      if(!(device.type === 'nrf52' && device.erase)) {
        console.error('nRF erase called for non-nrf device or device.erase is not defined');
        return;
      }

      let data;
      try {
        data = await downloadFirmware(device.erase, config);
      }
      catch(e) {
        alert(e.message);
        return;
      }

      const dfu = new Dfu(await serialAPI.requestPort({}));
      try {
        eraser.active = true;
        await flashNrf52(dfu, data, (progress) => { eraser.percent = progress });
        eraser.active = false;
        flashing.dfuComplete = false;
        setTimeout(() => alert('Device erase firmware has been flashed and flash has been erased.\nYou can flash MeshCore now.'), 200);
      }
      catch(e) {
        alert(`${e.message}\nDid you put the device into DFU mode before attempting erasing?`);
        eraser.active = false;
        eraser.percent = 0;
      }
    };

    const flashDevice = async () => {
      const esp32 = selected.device.type === 'esp32';
      const file = pickFlashFile(currentVersion.value.files, { esp32, wipe: selected.wipe });
      if(!file) {
        alert('Cannot find configuration for flash file! please report this to Discord.');
        return;
      }

      let data;
      try {
        data = file.file ?? await downloadFirmware(file.name, config);
      }
      catch(e) {
        alert(e.message);
        return;
      }

      const port = await serialAPI.requestPort({});
      const onProgress = (percent) => { flashing.percent = percent };
      flashing.active = true;

      try {
        if(esp32) {
          await flashEsp32(port, data, {
            address: esp32Address(file),
            eraseAll: selected.wipe,
            terminal: log,
            onProgress,
            onLoader: (loader) => { flashing.instance = loader },
          });
        }
        else {
          const dfu = flashing.instance = new Dfu(port);
          await flashNrf52(dfu, data, onProgress);
        }
      }
      catch(e) {
        flashing.error = e.message;
      }
    };

    return {
      config, logoFile, isIframe, commandReference, firmwareClasses, WEB_SERIAL_UNSUPPORTED,
      displayWelcomeBanner, dismissWelcomeBanner() {
        localStorage.setItem('welcomeBannerDismissed', '1');
        displayWelcomeBanner.value = false;
      },
      snackbar,
      selected, flashing, eraser, serialCon,
      deviceFilterText, deviceFilter, hoveredDevice, devices, deviceFirmwareByClass,
      currentVersion, notice, downloads, fwValue, formatChangeLog,
      selectFirmware, stepBack, retry, close,
      consoleEditBox, consoleWindow, consoleMouseUp, openSerialCon, closeSerialCon, sendCommand, openSerialGUI,
      dfuMode, nrfErase, flashDevice, customFirmwareLoad,
    };
  };
}
