// Per-host settings: the same flasher is served on flasher.meshcore.io and zephcore.meshcore.dev
const isZephcore = location.host === 'zephcore.meshcore.dev';
const searchParams = new URLSearchParams(location.search);

export const logoFile = isZephcore ? 'zephcore.svg' : 'meshcore.svg';

// ?config=name loads /name.json instead of the host's default catalog
export const configName = (searchParams.get('config') ?? '').replaceAll(/[^a-z_-]/g, '')
  || (isZephcore ? 'config-zephcore' : 'config');

export const isIframe = Boolean(searchParams.get('iframe'));
