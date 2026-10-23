import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export function desktopPaths({ localAppData = process.env.LOCALAPPDATA,
  dataRoot = process.env.GATHERZAP_DATA_ROOT,
  runtimeRoot = fileURLToPath(new URL('..', import.meta.url)) } = {}) {
  const root = path.resolve(dataRoot ?? path.join(localAppData ?? path.join(os.homedir(), 'AppData', 'Local'), 'gatherzap'));
  return {
    root,
    tracked: path.join(root, 'data', 'tracked-groups.json'),
    auth: path.join(root, 'whatsapp-auth'),
    browser: path.join(runtimeRoot, 'browser', 'chrome.exe'),
  };
}
