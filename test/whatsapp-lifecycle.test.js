import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { manageWhatsAppLifecycle } from '../src/whatsapp-lifecycle.js';

test('logout callbacks cannot crash the server or race the replacement session', async () => {
  // Use Node's default fatal unhandled-rejection behavior, matching the reported crash.
  const run = promisify(execFile);
  const result = await run(process.execPath, [fileURLToPath(new URL('../fixtures/whatsapp-logout-race.js', import.meta.url))], { timeout: 15000 });
  assert.match(result.stdout, /server remains alive/);
  assert.equal(result.stderr, '');
});

function lifecycleClient() {
  const client = new EventEmitter();
  const calls = { destroy: 0, inject: 0, logout: 0 };
  client.pupPage = new EventEmitter();
  client.inject = async () => { calls.inject++; };
  client.destroy = async () => { calls.destroy++; };
  client.authStrategy = { afterBrowserInitialized: async () => {}, logout: async () => { calls.logout++; } };
  manageWhatsAppLifecycle(client);
  return { client, calls };
}
test('navigation failures are observed and forwarded as safe per-client lifecycle errors', async () => {
  for (const [message, expected] of [['PRIVATE', 'whatsapp_navigation_failed'], ["Attempted to use detached Frame 'PRIVATE'", 'disconnected']]) {
    const { client } = lifecycleClient();
    await client.authStrategy.afterBrowserInitialized();
    let error;
    client.on('lifecycle_error', value => { error = value; });
    client.pupPage.on('framenavigated', async () => { throw Error(message); });
    client.pupPage.emit('framenavigated', {});
    await client.waitForLifecycle();
    assert.equal(error.code, expected); assert.ok(!error.message.includes('PRIVATE'));
    await client.destroy();
  }
});
test('normal shutdown closes once, removes navigation listeners, and preserves LocalAuth', async () => {
  const { client, calls } = lifecycleClient();
  await client.authStrategy.afterBrowserInitialized();
  client.pupPage.on('framenavigated', async () => { await client.inject(); });
  client.pupPage.emit('framenavigated', {});
  await Promise.all([client.destroy(), client.destroy()]);
  await client.waitForLifecycle();
  assert.deepEqual(calls, { destroy: 1, inject: 0, logout: 0 });
  assert.equal(client.pupPage.listenerCount('framenavigated'), 0);
  await client.inject(); assert.equal(calls.inject, 0);
});
