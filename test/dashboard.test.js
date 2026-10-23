import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { createSynchronizer } from '../src/whatsapp-sync.js';
import { openTrackedGroups } from '../src/tracked-groups.js';
import { createDashboardServer } from '../src/ui-server.js';
import { startDashboard } from '../src/dashboard.js';
import { runWhatsApp } from '../src/whatsapp.js';

const ids = ['123@g.us', '456@g.us'];
const logger = { info() {}, error() {} };
function aggregateFixture() {
  const values = new Map([[ids[0], 2], [ids[1], 3]]), writes = [], snapshots = [];
  let tracked = [...ids];
  const client = { getGroupSnapshot: async id => ({ isGroup: true, unreadCount: values.get(id) }) };
  const sync = createSynchronizer({ client, getGroupIds: () => [...tracked], logger,
    onSnapshot: value => snapshots.push(value),
    createGatherClient: () => ({ ping: async () => ({ capabilities: { counter: {} } }),
      counter: { set: async ({ count }) => { writes.push(count); return { status: 'dispatched' }; } } }) });
  return { sync, values, writes, snapshots, client, select: value => { tracked = value; } };
}
test('tracked groups aggregate unread counts, selection changes, and empty selection clears count', async () => {
  const f = aggregateFixture();
  await f.sync.cycle(); await f.sync.cycle();
  f.select([ids[1]]); await f.sync.cycle();
  f.values.set(ids[1], 0); await f.sync.cycle();
  f.select([]); await f.sync.cycle();
  f.select(ids); await f.sync.cycle();
  assert.deepEqual(f.writes, [5, 3, 0, 2]);
  assert.equal(f.snapshots.at(-1).total, 2);
});
test('one unknown, missing, or failed tracked group preserves the entire Gather total', async () => {
  const f = aggregateFixture(); await f.sync.cycle();
  f.values.set(ids[1], undefined); await f.sync.cycle();
  f.client.getGroupSnapshot = async () => undefined; await f.sync.cycle();
  f.client.getGroupSnapshot = async () => { throw Error('SECRET'); }; await f.sync.cycle();
  assert.deepEqual(f.writes, [5]);
  assert.equal(f.snapshots.at(-1).total, null);
});
test('selection changed during read discards an obsolete total', async () => {
  const f = aggregateFixture();
  f.client.getGroupSnapshot = async () => { f.select([]); return { isGroup: true, unreadCount: 3 }; };
  await f.sync.cycle(); assert.deepEqual(f.writes, []);
  await f.sync.cycle(); assert.deepEqual(f.writes, [0]);
});
test('aggregate overflow is unknown rather than an invalid Gather write', async () => {
  const f = aggregateFixture(); f.values.set(ids[0], Number.MAX_SAFE_INTEGER);
  await f.sync.cycle(); assert.deepEqual(f.writes, []);
});
test('selection changed during Gather capability check never publishes an obsolete total', async () => {
  let tracked = [...ids]; const writes = [];
  const sync = createSynchronizer({ client: { getGroupSnapshot: async () => ({ isGroup: true, unreadCount: 2 }) },
    getGroupIds: () => tracked, logger,
    createGatherClient: () => ({ ping: async () => { tracked = []; return { capabilities: { counter: {} } }; },
      counter: { set: async ({ count }) => { writes.push(count); return { status: 'dispatched' }; } } }) });
  await sync.cycle(); assert.deepEqual(writes, []);
  await sync.cycle(); assert.deepEqual(writes, [0]);
});
test('tracked selections start empty, persist, and reject malformed data', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gather-ui-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'tracked.json');
  const store = await openTrackedGroups({ filePath });
  assert.deepEqual(store.getIds(), []);
  await store.setIds(ids);
  assert.deepEqual((await openTrackedGroups({ filePath })).getIds(), ids);
  await store.setIds([]);
  assert.deepEqual((await openTrackedGroups({ filePath })).getIds(), []);
  await assert.rejects(store.setIds(['personal@c.us']));
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')).groupIds, []);
});
test('dashboard serves UI and protects tracked selection writes', async t => {
  let selected = [];
  const server = createDashboardServer({ getState: () => ({ phase: 'running', groups: [{ id: ids[0], name: '<script>private</script>' }], trackedIds: selected }),
    updateTracked: async groupIds => { selected = groupIds; }, refreshGroups: async () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await (await fetch(`${base}/api/state`)).json()).phase, 'running');
  const put = (origin, groupIds) => fetch(`${base}/api/tracked`, { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ groupIds }) });
  assert.equal((await put('https://example.com', ids)).status, 403);
  assert.equal((await put(base, ['unknown@g.us'])).status, 400);
  assert.equal((await put(base, [ids[0]])).status, 200);
  assert.deepEqual(selected, [ids[0]]);
  assert.equal((await put(base, [])).status, 200); assert.deepEqual(selected, []);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  const status = await new Promise((resolve, reject) => {
    http.get(`${base}/api/state`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(status, 403);
});

test('dashboard selection saves and immediately wakes the real runner without overlapping writes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gather-dashboard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new EventEmitter(), writes = [];
  let destroyed = 0;
  client.initialize = async () => { client.emit('authenticated'); client.emit('ready'); };
  client.destroy = async () => { destroyed++; };
  client.getGroups = async () => ids.map((id, i) => ({ id: { _serialized: id }, name: `Group ${i}` }));
  client.getGroupSnapshot = async id => ({ isGroup: true, unreadCount: id === ids[0] ? 2 : 3 });
  const filePath = path.join(directory, 'tracked.json');
  const tracked = await openTrackedGroups({ filePath }); await tracked.setIds([ids[0]]);
  const dashboard = await startDashboard({ env: {}, port: 0,
    filePath, logger,
    runner: options => runWhatsApp({ ...options, createClient: async () => client,
      createGatherClient: () => ({ ping: async () => ({ capabilities: { counter: {} } }), counter: { set: async ({ count }) => { writes.push(count); return { status: 'space_idle' }; } } }) }),
  });
  t.after(() => dashboard.close());
  async function waitForCount(expected) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await (await fetch(`${dashboard.url}/api/state`)).json();
      if (state.lastSyncedCount === expected && !state.selectionPending) return state;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('runner did not synchronize the new selection');
  }
  const initial = await (await fetch(`${dashboard.url}/api/state`)).json();
  assert.equal(initial.gatherConfigured, false); assert.deepEqual(writes, []);
  const configure = url => fetch(`${dashboard.url}/api/gather`, { method: 'PUT', headers: { Origin: dashboard.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, secret: 'whsec_TEST_ONLY_12345678901234567890' }) });
  assert.equal((await configure('https://api.v2.gather.town/test-one')).status, 200);
  await waitForCount(2);
  const response = await fetch(`${dashboard.url}/api/tracked`, { method: 'PUT', headers: { Origin: dashboard.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ groupIds: ids }) });
  assert.equal(response.status, 200);
  assert.equal((await waitForCount(5)).deliveryStatus, 'space_idle');
  assert.deepEqual(writes, [2, 5]);
  assert.equal((await configure('https://api.v2.gather.town/test-two')).status, 200);
  await waitForCount(5); assert.deepEqual(writes, [2, 5, 5]);
  await dashboard.close(); assert.equal(destroyed, 1);
});

async function pairingFixture(t, renderQr) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gather-pairing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let hooks;
  const dashboard = await startDashboard({ env: {}, port: 0, logger, filePath: path.join(directory, 'tracked.json'), renderQr,
    runner: options => { hooks = options; return new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true })); } });
  t.after(() => dashboard.close());
  return { dashboard, get hooks() { return hooks; }, state: async () => (await fetch(`${dashboard.url}/api/state`)).json(), qr: () => fetch(`${dashboard.url}/api/qr`) };
}

test('UI shutdown aborts the npm dashboard session and closes its HTTP server', { timeout: 10000 }, async t => {
  const f = await pairingFixture(t);
  const closed = once(f.dashboard.server, 'close');
  const response = await fetch(`${f.dashboard.url}/api/shutdown`, { method: 'POST', headers: { Origin: f.dashboard.url } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { stopped: true });
  await closed;
  assert.equal(f.hooks.signal.aborted, true);
  assert.equal(f.dashboard.server.listening, false);
  await assert.rejects(f.state());
});
test('pairing QR is served privately as an image, rotates, and clears after authentication', async t => {
  const f = await pairingFixture(t, async code => Buffer.from(`image-${code}`));
  assert.equal((await f.qr()).status, 404);
  await f.hooks.onQr('PRIVATE-FIRST');
  let state = await f.state();
  assert.equal(state.phase, 'pairing'); assert.equal(state.qrAvailable, true);
  assert.ok(!JSON.stringify(state).includes('PRIVATE-FIRST'));
  const response = await f.qr();
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(await response.text(), 'image-PRIVATE-FIRST');
  await f.hooks.onQr('PRIVATE-SECOND');
  assert.ok((await f.state()).qrVersion > state.qrVersion);
  assert.equal(await (await f.qr()).text(), 'image-PRIVATE-SECOND');
  f.hooks.onPhase('loading');
  assert.equal((await f.state()).qrAvailable, false);
  assert.equal((await f.qr()).status, 404);
  f.hooks.onPhase('ready'); assert.equal((await f.state()).phase, 'ready');
});
test('a slow QR render cannot restore an older QR or a code after authentication', async t => {
  const renders = [];
  const f = await pairingFixture(t, () => new Promise(resolve => renders.push(resolve)));
  const first = f.hooks.onQr('PRIVATE-FIRST');
  const second = f.hooks.onQr('PRIVATE-SECOND');
  renders[1](Buffer.from('new-image')); await second;
  renders[0](Buffer.from('old-image')); await first;
  assert.equal(await (await f.qr()).text(), 'new-image');
  const pending = f.hooks.onQr('PRIVATE-THIRD');
  f.hooks.onPhase('loading');
  renders[2](Buffer.from('late-image')); await pending;
  assert.equal((await f.qr()).status, 404);
});
test('unlinking a running session reconnects to pairing without changing tracked groups', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gather-relink-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let attempts = 0;
  const filePath = path.join(directory, 'tracked.json');
  const tracked = await openTrackedGroups({ filePath }); await tracked.setIds([ids[0]]);
  const dashboard = await startDashboard({ env: {}, port: 0, logger,
    filePath, reconnectDelayMs: 0, renderQr: async () => Buffer.from('new-pairing-image'),
    runner: async hooks => {
      attempts++;
      if (attempts === 1) { hooks.onPhase('ready'); throw Object.assign(Error('PRIVATE'), { code: 'disconnected' }); }
      await hooks.onQr('PRIVATE-RELINK');
      await new Promise(resolve => hooks.signal.addEventListener('abort', resolve, { once: true }));
    },
  });
  t.after(() => dashboard.close());
  let state;
  for (let attempt = 0; attempt < 100; attempt++) {
    state = await (await fetch(`${dashboard.url}/api/state`)).json();
    if (state.qrAvailable) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(attempts, 2); assert.equal(state.phase, 'pairing');
  assert.equal(state.whatsappReady, false); assert.deepEqual(state.trackedIds, [ids[0]]);
});
test('default pairing renderer produces a local PNG', async t => {
  const f = await pairingFixture(t);
  await f.hooks.onQr('TEST-ONLY-PAIRING');
  const response = await f.qr();
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});
test('repeated authentication failures before readiness stop after one reconnect', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gather-relink-limit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let attempts = 0;
  const dashboard = await startDashboard({ env: {}, port: 0, logger, filePath: path.join(directory, 'tracked.json'), reconnectDelayMs: 0,
    runner: async () => { attempts++; throw Object.assign(Error('PRIVATE'), { code: 'auth_failure' }); } });
  t.after(() => dashboard.close());
  await dashboard.done;
  const state = await (await fetch(`${dashboard.url}/api/state`)).json();
  assert.equal(attempts, 2); assert.equal(state.phase, 'stopped'); assert.equal(state.qrAvailable, false);
  assert.ok(!JSON.stringify(state).includes('PRIVATE'));
});
test('Gather configuration is accepted only after login, stays private, and can be cleared', async t => {
  const f = await pairingFixture(t);
  const settings = { url: 'https://api.v2.gather.town/test-object', secret: 'whsec_TEST_ONLY_12345678901234567890' };
  const configure = body => fetch(`${f.dashboard.url}/api/gather`, { method: 'PUT', headers: { Origin: f.dashboard.url, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await configure(settings)).status, 409);
  f.hooks.onPhase('ready');
  assert.equal(f.hooks.canSync(), false);
  assert.equal((await configure({ ...settings, secret: 'PRIVATE' })).status, 400);
  const response = await configure(settings); assert.equal(response.status, 200);
  const state = await response.json(); assert.equal(state.gatherConfigured, true);
  assert.ok(!JSON.stringify(state).includes(settings.secret)); assert.ok(!JSON.stringify(state).includes(settings.url));
  assert.equal(f.hooks.canSync(), true);
  f.hooks.onSyncError(Object.assign(Error('PRIVATE'), { code: 'invalid_secret' }));
  assert.equal(f.hooks.canSync(), false);
  assert.equal((await f.state()).whatsappReady, true);
  assert.ok(!JSON.stringify(await f.state()).includes('PRIVATE'));
  assert.equal((await configure(settings)).status, 200);
  const revision = f.hooks.getGatherRevision();
  const cleared = await fetch(`${f.dashboard.url}/api/gather`, { method: 'DELETE', headers: { Origin: f.dashboard.url } });
  assert.equal(cleared.status, 200); assert.equal(f.hooks.canSync(), false);
  assert.ok(f.hooks.getGatherRevision() > revision);
  assert.equal((await f.state()).whatsappReady, true);
});
