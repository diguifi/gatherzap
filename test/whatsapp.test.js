import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import path from 'node:path';
import vm from 'node:vm';
import { readConfig, runWhatsApp, reportFailure } from '../src/whatsapp.js';
import { cancellable, createSynchronizer } from '../src/whatsapp-sync.js';
import { createWhatsAppClient, readChatSnapshot } from '../src/whatsapp-client.js';

const groupId = '123@g.us';
const config = { interval: 15000, authPath: path.resolve('external-session') };
const logger = { info() {}, error() {} };
const group = (unreadCount) => ({ isGroup: true, unreadCount });
function fixture(values = [0], statuses = ['dispatched']) {
  const writes = [], calls = [], signals = [];
  const sync = createSynchronizer({ getGroupIds: () => [groupId], logger,
    client: { async getGroupSnapshot(id) { calls.push(id); const v = values.shift(); if (v instanceof Error) throw v; return v; } },
    createGatherClient({ signal }) { signals.push(signal); return {
      async ping() { calls.push('ping'); return { capabilities: { counter: {} } }; },
      counter: { async set(payload) { writes.push(payload); const s = statuses.shift() ?? 'dispatched'; if (s instanceof Error) throw s; return { status: s }; } },
    }; },
  });
  return { sync, writes, calls, signals };
}
test('configuration and external persistent auth path', () => {
  const c = readConfig({}, { home: path.parse(process.cwd()).root, cwd: process.cwd() });
  assert.equal(c.interval, 30000);
  assert.ok(c.authPath.endsWith(path.join('.gather-object', 'whatsapp-auth')));
  for (const value of ['14999', 'NaN', 'Infinity', '15000.5', ''])
    assert.throws(() => readConfig({ WHATSAPP_POLL_INTERVAL_MS: value }));
  assert.throws(() => readConfig({ WHATSAPP_AUTH_PATH: '.' }));
  assert.throws(() => readConfig({ WHATSAPP_AUTH_PATH: process.cwd() }));
});
test('fresh absolute counts, initial zero, ping before write and accepted statuses', async () => {
  const f = fixture([0, 3, 3, 1, 0].map(group), ['dispatched', 'space_idle']);
  for (let i = 0; i < 5; i++) await f.sync.cycle();
  assert.deepEqual(f.writes, [0, 3, 1, 0].map(count => ({ count })));
  assert.ok(f.calls.indexOf('ping') >= 0); assert.equal(f.calls.filter(x => x === 'ping').length, 1);
  assert.equal(f.signals.length, 5); assert.notEqual(f.signals[0], f.signals[1]);
});
test('unknown counts and transient read failures retain state', async () => {
  const f = fixture([group(2), ...[undefined, null, -1, 1.2, '3', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(group), new Error('SECRET'), group(0)]);
  for (let i = 0; i < 11; i++) await f.sync.cycle();
  assert.deepEqual(f.writes, [{ count: 2 }, { count: 0 }]);
});
test('missing and non-group targets preserve the last Gather state', async () => {
  for (const value of [undefined, { isGroup: false }]) {
    const f = fixture([value]); await f.sync.cycle(); assert.equal(f.writes.length, 0);
  }
});
test('cache only accepted delivery; terminal errors propagate', async () => {
  for (const result of [new Error('SECRET'), 'unexpected']) {
    const f = fixture([group(4), group(4)], [result, 'space_idle']);
    await assert.rejects(f.sync.cycle()); await f.sync.cycle(); assert.equal(f.writes.length, 2);
  }
});
test('missing counter prevents any write', async () => {
  const sync = createSynchronizer({ getGroupIds: () => [groupId], logger, client: { getGroupSnapshot: async () => group(0) },
    createGatherClient: () => ({ ping: async () => ({ capabilities: {} }) }) });
  await assert.rejects(sync.cycle(), { code: 'missing_counter' });
});
function runnerFixture(overrides = {}) {
  const client = new EventEmitter(), controller = new AbortController(), events = [], logs = [];
  client.initialize = async () => { events.push('initialize'); client.emit('ready'); };
  client.destroy = async () => { events.push('destroy'); };
  client.getGroupSnapshot = async () => group(1);
  client.getGroups = async () => [{ isGroup: true, name: 'Team', id: { _serialized: '123@g.us' } }, { isGroup: false }];
  const options = { config, getGroupIds: () => [groupId], signal: controller.signal, createClient: async () => client,
    logger: { info: x => logs.push(x), error: x => logs.push(x) },
    createGatherClient: () => ({ ping: async () => ({ capabilities: { counter: {} } }), counter: { set: async () => { events.push('write'); return { status: 'dispatched' }; } } }),
    delay: async () => { events.push('delay'); controller.abort(); }, ...overrides };
  return { client, controller, events, logs, options };
}
test('ready gates writes; polling is awaited and cleanup runs once', async () => {
  const f = runnerFixture(); await runWhatsApp(f.options);
  assert.deepEqual(f.events, ['initialize', 'write', 'delay', 'destroy']);
  for (const event of ['ready', 'auth_failure', 'disconnected']) assert.equal(f.client.listenerCount(event), 0);
});
test('auth and disconnect stop startup with safe diagnostics', async () => {
  for (const event of ['auth_failure', 'disconnected']) {
    const f = runnerFixture(); f.client.initialize = async () => { f.client.emit(event, 'SECRET'); };
    await assert.rejects(runWhatsApp(f.options), { code: event });
    assert.equal(f.events.filter(x => x === 'destroy').length, 1); assert.ok(!JSON.stringify(f.logs).includes('SECRET'));
  }
});
test('startup and delivery failures always clean up', async () => {
  for (const phase of ['startup', 'delivery']) {
    const f = runnerFixture();
    if (phase === 'startup') f.client.initialize = async () => { throw Error('SECRET'); };
    else f.options.createGatherClient = () => ({ ping: async () => { throw Error('SECRET'); } });
    await assert.rejects(runWhatsApp(f.options)); assert.equal(f.events.filter(x => x === 'destroy').length, 1);
  }
});
test('abort during startup, read, and delay destroys client and prevents writes', async () => {
  for (const phase of ['startup', 'read', 'delay']) {
    const f = runnerFixture();
    if (phase === 'startup') f.client.initialize = () => { f.controller.abort(); return new Promise(() => {}); };
    if (phase === 'read') f.client.getGroupSnapshot = () => { f.controller.abort(); return new Promise(() => {}); };
    await runWhatsApp(f.options); assert.equal(f.events.filter(x => x === 'destroy').length, 1);
    if (phase !== 'delay') assert.ok(!f.events.includes('write'));
  }
});
test('adapter uses persistent LocalAuth, headless Chromium, and no disk web cache', async () => {
    let settings;
    class Client extends EventEmitter { constructor(value) { super(); settings = value; } }
    class LocalAuth { constructor(value) { this.options = value; } }
    await createWhatsAppClient({ authPath: config.authPath, Client, LocalAuth });
    assert.equal(settings.authStrategy.options.dataPath, config.authPath); assert.equal(settings.puppeteer.headless, true);
    assert.equal(settings.webVersionCache.type, 'none');
});
test('runtime disconnect cancels an in-flight delivery and never resets Gather', async () => {
  const f = runnerFixture();
  f.options.createGatherClient = ({ signal }) => ({
    ping: async () => ({ capabilities: { counter: {} } }),
    counter: { set: async () => { f.client.emit('disconnected', 'SECRET'); assert.ok(signal.aborted); return new Promise(() => {}); } },
  });
  await assert.rejects(runWhatsApp(f.options), { code: 'disconnected' });
  assert.equal(f.events.filter(x => x === 'destroy').length, 1);
});
test('no next read or wait until delivery finishes', async () => {
  const f = runnerFixture(); let finish; let reads = 0;
  f.client.getGroupSnapshot = async () => { reads++; return group(reads); };
  f.options.createGatherClient = () => ({ ping: async () => ({ capabilities: { counter: {} } }),
    counter: { set: () => new Promise(resolve => { finish = resolve; }) } });
  const running = runWhatsApp(f.options);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1); assert.ok(!f.events.includes('delay'));
  finish({ status: 'dispatched' }); await running;
  assert.equal(reads, 1);
});
test('failure reporting never logs arbitrary codes, messages, or client data', () => {
  const logs = [], safeLogger = { error: value => logs.push(value) };
  for (const code of ['SECRET', 'auth_failure', 'disconnected', 'network_error'])
    reportFailure({ code, message: 'SECRET', token: 'SECRET' }, safeLogger);
  assert.ok(!logs.join('').includes('SECRET')); assert.match(logs.join(''), /relink/i);
});
test('cancelled non-settling work immediately releases abort listeners', async () => {
  const controller = new AbortController();
  const pending = cancellable(() => new Promise(() => {}), controller.signal);
  controller.abort(); await assert.rejects(pending);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
test('adapter forwards shutdown signal to Chromium launch', async () => {
  let settings;
  class Client extends EventEmitter { constructor(value) { super(); settings = value; } }
  class LocalAuth {}
  const signal = new AbortController().signal;
  await createWhatsAppClient({ authPath: config.authPath, signal, Client, LocalAuth });
  assert.equal(settings.puppeteer.signal, signal);
});
test('each Gather operation has a bounded timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sync = createSynchronizer({ client: { getGroupSnapshot: async () => group(1) }, getGroupIds: () => [groupId], logger,
    createGatherClient: () => ({ ping: () => new Promise(() => {}) }) });
  const pending = sync.cycle();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(120000);
  await assert.rejects(pending, { code: 'gather_timeout' });
});
test('cleanup failure cannot replace the original startup failure', async () => {
  const f = runnerFixture();
  f.client.initialize = async () => { throw Object.assign(new Error('SECRET'), { code: 'auth_failure' }); };
  f.client.destroy = async () => { throw new Error('Protocol error: Target closed SECRET'); };
  await assert.rejects(runWhatsApp(f.options), { code: 'auth_failure' });
});
test('startup timeouts and page reloads have specific safe diagnoses', async () => {
  for (const [error, code] of [
    ['auth timeout', 'whatsapp_auth_timeout'],
    ['ready timeout', 'whatsapp_ready_timeout'],
    [new Error('Execution context was destroyed SECRET'), 'whatsapp_context_lost'],
    [new Error('SECRET'), 'whatsapp_startup_failed'],
  ]) {
    const f = runnerFixture(); f.client.initialize = async () => { throw error; };
    await assert.rejects(runWhatsApp(f.options), { code });
  }
});
test('shutdown tolerates Chromium already closed by launch cancellation', async () => {
  const f = runnerFixture();
  f.client.destroy = async () => { throw new Error('Protocol error: Target closed'); };
  await runWhatsApp(f.options);
});

function browserFixture(models) {
  const touched = [];
  const page = { async evaluate(fn, ...args) {
    const value = await vm.runInNewContext(`(${fn.toString()})(...args)`, {
      args,
      window: { require(name) {
        touched.push(name);
        assert.equal(name, 'WAWebCollections');
        return { Chat: { getModelsArray: () => models } };
      }, WWebJS: { getChats() { throw Error('broken upstream serializer'); }, getChatModel() { throw Error('broken upstream serializer'); } } },
    });
    return structuredClone(value);
  } };
  return { page, touched };
}
function rawChat(id, unreadCount = 0) {
  const chat = { id, formattedTitle: 'Team', unreadCount };
  for (const key of ['serialize', 'msgs', 'lastMessage', 'lastReceivedKey', 'groupMetadata', 'sendSeen'])
    Object.defineProperty(chat, key, { get() { throw Error(`must not access ${key}`); } });
  return chat;
}
test('group discovery bypasses chat serialization and message metadata', async () => {
  const chat = rawChat({ _serialized: '123@g.us' });
  Object.defineProperty(chat, 'unreadCount', { get() { throw Error('discovery needs no count'); } });
  const f = browserFixture([chat, rawChat({ _serialized: '456@lid' }), rawChat({ _serialized: '789@c.us' })]);
  assert.deepEqual(await readChatSnapshot(f.page), [{ isGroup: true, id: { _serialized: '123@g.us' }, name: 'Team' }]);
});
test('count snapshots are fresh, minimal, and tolerate changed ID representation', async () => {
  for (const id of [{ _serialized: '123@g.us' }, { $1: '123@g.us' }, { user: '123', server: 'g.us' }]) {
    const chat = rawChat(id, 4);
    Object.defineProperty(chat, 'formattedTitle', { get() { throw Error('polling needs no name'); } });
    const f = browserFixture([chat]);
    assert.deepEqual(await readChatSnapshot(f.page, '123@g.us'), { isGroup: true, unreadCount: 4 });
    chat.unreadCount = 0;
    assert.deepEqual(await readChatSnapshot(f.page, '123@g.us'), { isGroup: true, unreadCount: 0 });
  }
});
test('unknown counts stay unknown and missing snapshots stay missing', async () => {
  const f = browserFixture([rawChat({ _serialized: '123@g.us' }, -1)]);
  assert.deepEqual(await readChatSnapshot(f.page, '123@g.us'), { isGroup: true, unreadCount: -1 });
  assert.equal(await readChatSnapshot(f.page, '456@g.us'), undefined);
});
test('adapter exposes metadata-only discovery and snapshot operations', async () => {
  const f = browserFixture([rawChat({ _serialized: '123@g.us' }, 2)]);
  class Client extends EventEmitter { constructor() { super(); this.pupPage = f.page; } }
  class LocalAuth {}
  const client = await createWhatsAppClient({ authPath: config.authPath, Client, LocalAuth });
  assert.equal((await client.getGroups())[0].id._serialized, '123@g.us');
  assert.deepEqual(await client.getGroupSnapshot('123@g.us'), { isGroup: true, unreadCount: 2 });
});
test('runner and synchronizer use metadata-only adapter methods', async () => {
  const f = runnerFixture();
  let groups;
  f.options.beforeCycle = async client => { groups = await client.getGroups(); };
  f.client.getChats = async () => { throw Error('must bypass upstream serializer'); };
  await runWhatsApp(f.options);
  assert.equal(groups[0].id._serialized, groupId);
  const s = fixture([]);
  const sync = createSynchronizer({ getGroupIds: () => [groupId], logger,
    client: { getGroupSnapshot: async () => group(0), getChatById: async () => { throw Error('must bypass upstream serializer'); } },
    createGatherClient: () => ({ ping: async () => ({ capabilities: { counter: {} } }), counter: { set: async () => { s.writes.push({ count: 0 }); return { status: 'dispatched' }; } } }) });
  await sync.cycle(); assert.deepEqual(s.writes, [{ count: 0 }]);
});
test('runner forwards pairing QR events to the UI without logging the payload', async () => {
  const f = runnerFixture(); const codes = [], phases = [];
  f.options.onQr = async code => { codes.push(code); };
  f.options.onPhase = phase => phases.push(phase);
  f.client.initialize = async () => { f.client.emit('qr', 'PRIVATE-PAIRING'); f.client.emit('authenticated'); f.client.emit('ready'); };
  await runWhatsApp(f.options);
  assert.deepEqual(codes, ['PRIVATE-PAIRING']);
  assert.deepEqual(phases, ['pairing', 'loading', 'ready']);
  assert.equal(f.client.listenerCount('qr'), 0);
  assert.ok(!JSON.stringify(f.logs).includes('PRIVATE-PAIRING'));
});
