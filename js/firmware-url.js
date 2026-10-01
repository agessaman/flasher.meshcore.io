// Firmware asset URLs. Release-feed files are already absolute; catalog filenames are not.

export function isDirectAsset(name) {
  return /^https?:\/\//i.test(name) || name.startsWith('/');
}

export function assetUrl(staticPath, name) {
  return isDirectAsset(name) ? name : `${staticPath}/${name}`;
}

// Upstream's /releases proxy needs ?repo= to choose a source. Observer feed URLs are already final.
export function releaseAssetName(fileUrl, sourceKey) {
  return /^https?:\/\//i.test(fileUrl) ? fileUrl : `${fileUrl}?repo=${sourceKey}`;
}

export function firmwareHashFromConfig(text) {
  return text.match(/-v[0-9.]+-([0-9a-f]{7,40})(?:-merged)?\.bin/)?.[1] ?? null;
}

export function withFirmwareHash(name, hash) {
  return hash ? name.replace(/(-)[0-9a-f]{7,40}(-merged)?(\.bin)$/, `$1${hash}$2$3`) : name;
}

// Same env and wipe/update variant, ignoring version, channel tag, and build hash.
function assetShape(name) {
  return name.replace(/-v[0-9.]+(?:-[a-z]+)?-[0-9a-f]{7,40}((?:-merged)?\.bin)$/, '-*$1');
}

export function findFreshFeedUrl(feed, staleUrl) {
  const stale = new URL(staleUrl);
  const want = assetShape(stale.pathname.split('/').pop());
  for(const entry of feed) {
    for(const file of entry.files || []) {
      if(new URL(file.url).host === stale.host && assetShape(file.name) === want) return file.url;
    }
  }

  return null;
}
