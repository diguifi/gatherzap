export const GATHER_STORAGE_KEY = 'papertrail.gather';

export function readGatherSettings(storage) {
  try {
    const value = JSON.parse(storage.getItem(GATHER_STORAGE_KEY));
    if (typeof value?.url !== 'string' || !value.url.trim() || typeof value?.secret !== 'string' || !value.secret.trim()) return null;
    return { url: value.url.trim(), secret: value.secret.trim() };
  } catch { return null; }
}

export function saveGatherSettings(storage, settings) {
  storage.setItem(GATHER_STORAGE_KEY, JSON.stringify({ url: settings.url.trim(), secret: settings.secret.trim() }));
}
