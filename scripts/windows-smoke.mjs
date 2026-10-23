import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const executable = path.join(root, 'dist', 'gatherzap.exe');
const binary = await readFile(executable);
const pe = binary.readUInt32LE(0x3c);
assert.equal(binary.readUInt32LE(pe), 0x4550, 'valid Windows PE');
assert.equal(binary.readUInt16LE(pe + 4), 0x8664, '64-bit Windows executable');
assert.equal(binary.readUInt16LE(pe + 24 + 68), 2, 'Windows GUI subsystem: no console');
const directory = await mkdtemp(path.join(root, '.build', 'exe-smoke-'));
const child = spawn(executable, ['--smoke-test-root', directory], { windowsHide: true,
  env: { ...process.env, DOTNET_BUNDLE_EXTRACT_BASE_DIR: path.join(root, '.build', 'dotnet-extract') }, stdio: 'ignore' });
const exited = once(child, 'exit');
const timeout = setTimeout(() => { child.kill(); }, 120000);
const [code] = await exited; clearTimeout(timeout);
let error;
try { error = await readFile(path.join(directory, 'smoke-error.txt'), 'utf8'); } catch {}
assert.equal(error, undefined, 'no launcher/server startup error');
assert.equal(code, 0, 'launcher exits cleanly after the smoke test');
const report = JSON.parse(await readFile(path.join(directory, 'smoke-report.json'), 'utf8'));
assert.equal(report.success, true); assert.equal(report.consoleWindow, false); assert.equal(report.workerWindow, 0);
assert.equal(report.browserIncluded, true); assert.equal(report.runtimeVersion, process.version);
await access(path.join(directory, 'data', 'tracked-groups.json'));
let orphan = false;
try { process.kill(report.workerId, 0); orphan = true; } catch {}
assert.equal(orphan, false, 'launcher shuts down its Node child');
// Opt-in live browser check: managed execution sandboxes can block Chrome's
// GPU/network subprocesses even when the same browser works on a normal desktop.
if (process.argv.includes('--browser')) {
const [runtimeId] = (await readdir(path.join(directory, 'runtime'))).filter(name => !name.startsWith('.'));
const runtime = path.join(directory, 'runtime', runtimeId);
const browserCheck = spawn(path.join(runtime, 'node.exe'), ['--input-type=module', '-e', `
  import puppeteer from './node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js';
  const browser = await puppeteer.launch({ executablePath: './browser/chrome.exe', headless: true,
    userDataDir: ${JSON.stringify(path.join(directory, 'browser-check'))}, timeout: 30000 });
  try {
    const page = await browser.newPage();
    await page.setContent('<title>gatherzap browser check</title>');
    if (await page.title() !== 'gatherzap browser check') throw Error('Browser verification failed');
  } finally { await browser.close(); }
`], { cwd: runtime, windowsHide: true, stdio: 'pipe' });
let browserErrors = '';
browserCheck.stderr.on('data', chunk => { browserErrors += chunk; });
const [browserCode] = await once(browserCheck, 'exit');
assert.equal(browserCode, 0, `bundled Chromium launches and renders: ${browserErrors}`);
}
console.log(`EXE smoke test passed: GUI subsystem, bundled runtime/browser, HTTP UI, hidden Node window, and clean shutdown (${Math.round((await stat(executable)).size / 1048576)} MiB).`);
console.log(`Report: ${path.join(directory, 'smoke-report.json')}`);
