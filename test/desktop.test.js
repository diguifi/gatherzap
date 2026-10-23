import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopPaths } from '../desktop/paths.js';

test('desktop data persists separately from the extracted application', () => {
  const local = path.join(os.tmpdir(), 'desktop-user');
  const runtime = path.join(os.tmpdir(), 'desktop-runtime');
  const paths = desktopPaths({ localAppData: local, runtimeRoot: runtime });
  assert.equal(paths.root, path.join(local, 'gatherzap'));
  assert.equal(paths.tracked, path.join(local, 'gatherzap', 'data', 'tracked-groups.json'));
  assert.equal(paths.auth, path.join(local, 'gatherzap', 'whatsapp-auth'));
  assert.equal(paths.browser, path.join(runtime, 'browser', 'chrome.exe'));
});

test('desktop server announces readiness, serves the UI, and shuts down through its launcher pipe', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gatherzap-desktop-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../desktop/server.js', import.meta.url)), '--smoke-test'], {
    env: { ...process.env, GATHERZAP_DATA_ROOT: directory, UI_PORT: '0' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  t.after(async () => { if (child.exitCode === null) child.kill(); await rm(directory, { recursive: true, force: true }); });
  const exited = once(child, 'exit');
  let errors = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { errors += chunk; });
  const ready = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(Error('desktop server did not start')), 10000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
      output += chunk;
      for (const line of output.split('\n').slice(0, -1)) {
        let value; try { value = JSON.parse(line); } catch { continue; }
        if (value.event === 'ready') { clearTimeout(timeout); resolve(value); }
      }
    });
    child.once('exit', code => { clearTimeout(timeout); reject(Error(`desktop worker exited before readiness (${code})`)); });
  });
  assert.equal(ready.runtimeVersion, process.version);
  const page = await fetch(ready.url); assert.equal(page.status, 200); assert.match(await page.text(), /gatherzap/);
  const state = await (await fetch(`${ready.url}/api/state`)).json();
  assert.equal(state.whatsappReady, true); assert.equal(state.gatherConfigured, false);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'data', 'tracked-groups.json'), 'utf8')).groupIds, []);
  child.stdin.end('shutdown\n');
  const [code] = await exited; assert.equal(code, 0); assert.equal(errors, '');
});
