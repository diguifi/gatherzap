import { access } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { desktopPaths } from './paths.js';

const smokeTest = process.argv.includes('--smoke-test');
const paths = desktopPaths();
const shutdown = new AbortController();
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
let dashboard;
let stopping;
async function stop() {
  stopping ??= (async () => {
    shutdown.abort();
    await dashboard?.close();
    input.close();
    process.stdin.destroy();
  })();
  return stopping;
}
const input = createInterface({ input: process.stdin, terminal: false });
input.on('line', command => { if (command === 'shutdown') void stop(); });
input.on('close', () => { if (!stopping) void stop(); });
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });

try {
  if (!smokeTest) {
    try { await access(paths.browser); }
    catch { throw Object.assign(Error('packaged browser is missing'), { code: 'browser_missing' }); }
    process.env.PUPPETEER_EXECUTABLE_PATH = paths.browser;
  }
  const { startDashboard } = await import('../src/dashboard.js');
  dashboard = await startDashboard({
    onShutdown: () => { send({ event: 'shutdown' }); void stop(); },
    env: { ...process.env, WHATSAPP_AUTH_PATH: paths.auth }, filePath: paths.tracked, signal: shutdown.signal,
    logger: { info() {}, error() { send({ event: 'status', code: 'connection_error' }); } },
    ...(smokeTest ? { runner: async ({ signal, onPhase }) => {
      onPhase('ready');
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    } } : {}),
  });
  if (!shutdown.signal.aborted) send({ event: 'ready', url: dashboard.url, runtimeVersion: process.version });
  else await dashboard.close();
} catch (error) {
  const code = ['EADDRINUSE', 'browser_missing'].includes(error?.code) ? error.code : 'startup_failed';
  send({ event: 'error', code });
  process.exitCode = 1;
  await stop();
}
