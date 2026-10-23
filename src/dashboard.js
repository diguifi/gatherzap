import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { openTrackedGroups } from './tracked-groups.js';
import { createDashboardServer } from './ui-server.js';
import { readConfig, runWhatsApp, reportFailure } from './whatsapp.js';
import { createGatherClient } from './gather.js';

export function createPollWake() {
  let pending = false;
  let release;
  return {
    wake() { if (release) release(); else pending = true; },
    delay(ms, signal) {
      if (signal.aborted) return Promise.reject(signal.reason);
      if (pending) { pending = false; return Promise.resolve(); }
      return new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          release = undefined;
          error ? reject(error) : resolve();
        };
        const abort = () => finish(signal.reason);
        const timer = setTimeout(() => finish(), ms);
        release = () => finish();
        signal.addEventListener('abort', abort, { once: true });
      });
    },
  };
}

export async function startDashboard({ env = process.env, signal, logger = console,
  filePath = path.resolve('.local/tracked-groups.json'), runner = runWhatsApp, port: requestedPort, reconnectDelayMs = 1500,
  renderQr = async code => (await import('qrcode')).default.toBuffer(code, { type: 'png', width: 320, margin: 4, errorCorrectionLevel: 'M' }) } = {}) {
  const config = readConfig(env);
  const port = requestedPort ?? Number(env.UI_PORT ?? 3210);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid UI_PORT.');
  const store = await openTrackedGroups({ filePath });
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const wake = createPollWake();
  const state = { phase: 'starting', groups: [], counts: {}, total: null, lastSyncedCount: null,
    lastSyncedAt: null, checkedAt: null, message: 'Connecting to WhatsApp. A pairing QR code will appear here if needed.',
    selectionPending: true, intervalMs: config.interval, deliveryStatus: null, qrAvailable: false, qrVersion: 0, whatsappReady: false,
    gatherConfigured: false, gatherError: null, instanceId: randomUUID() };
  let gatherSettings = null;
  let gatherRevision = 0;
  let gatherAbort = new AbortController();
  function replaceGatherSettings(settings) {
    if (!settings && !gatherSettings) return;
    if (settings && gatherSettings?.url === settings.url && gatherSettings?.secret === settings.secret) return;
    gatherRevision++;
    gatherAbort.abort();
    gatherAbort = new AbortController();
    gatherSettings = settings;
    state.gatherConfigured = Boolean(settings);
    state.gatherError = null;
    state.selectionPending = true;
    state.lastSyncedAt = null; state.lastSyncedCount = null;
    state.deliveryStatus = null;
    if (state.whatsappReady) {
      state.phase = 'ready';
      state.message = settings ? 'Gather settings received. Synchronizing…' : 'Enter your Gather webhook URL and secret to continue.';
    }
    wake.wake();
  }
  // Keep pairing material in memory and out of state JSON, logs, and session files.
  let qrImage = null;
  function clearQr() {
    state.qrVersion++;
    state.qrAvailable = false;
    qrImage = null;
  }
  let refreshNeeded = true;
  let lastRefresh = 0;
  const server = createDashboardServer({
    getState: () => ({ ...state, trackedIds: store.getIds() }),
    getPairingQr: () => state.phase === 'pairing' ? qrImage : null,
    configureGather: settings => replaceGatherSettings(settings),
    clearGather: () => replaceGatherSettings(null),
    updateTracked: async ids => {
      await store.setIds(ids);
      state.selectionPending = true;
      state.message = state.phase === 'stopped' ? 'Selection saved. Restart npm run ui to resume monitoring.' : 'Selection saved. Updating Gather…';
      wake.wake();
    },
    refreshGroups: async () => { refreshNeeded = true; wake.wake(); },
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  logger.info(`WhatsApp dashboard: ${url}`);
  let done;
  let closing;
  function close() {
    closing ??= (async () => {
      combined.removeEventListener('abort', onAbort);
      controller.abort();
      gatherAbort.abort(); gatherSettings = null;
      clearQr();
      await done;
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    })();
    return closing;
  }
  const onAbort = () => { void close(); };
  let reconnectAllowed = true;
  const runSession = () => runner({
    config, signal: combined, logger, getGroupIds: () => store.getIds(), delay: wake.delay,
    canSync: () => gatherSettings !== null,
    getGatherRevision: () => gatherRevision,
    createGatherClient: ({ signal }) => createGatherClient({ credentials: gatherSettings, signal: AbortSignal.any([signal, gatherAbort.signal]) }),
    onSyncError: error => {
      replaceGatherSettings(null);
      const hints = {
        invalid_secret: 'The Gather secret is invalid. Check it and try again.',
        invalid_url: 'The Gather webhook URL is invalid. Check it and try again.',
        not_found: 'Gather could not find this object. Check the URL and secret together.',
        token_revoked: 'The Gather secret was revoked. Paste the replacement secret.',
        missing_counter: 'This Gather object does not support a counter. Choose an inbox object.',
      };
      state.gatherError = hints[error?.code] ?? 'Could not connect to Gather. Check the URL and secret, then try again.';
      state.message = state.gatherError;
      logger.error(state.gatherError);
    },
    onPhase: phase => {
      clearQr();
      state.phase = phase;
      state.whatsappReady = phase === 'ready';
      if (phase === 'ready') reconnectAllowed = true;
      state.message = phase === 'pairing' ? 'Scan the QR code with WhatsApp on your phone.' : phase === 'ready' ? 'WhatsApp is ready. Loading groups and synchronizing Gather…' : 'WhatsApp authenticated. Loading your chats…';
    },
    onQr: async code => {
      if (combined.aborted || ['loading', 'ready', 'running', 'waiting_counts'].includes(state.phase)) return;
      clearQr();
      const version = state.qrVersion;
      state.phase = 'pairing';
      state.message = 'Scan the QR code with WhatsApp on your phone.';
      const image = await renderQr(code);
      if (combined.aborted || state.phase !== 'pairing' || version !== state.qrVersion) return;
      qrImage = image;
      state.qrAvailable = true;
    },
    beforeCycle: async client => {
      if (!refreshNeeded && Date.now() - lastRefresh < 60000) return;
      try {
        const groups = await client.getGroups();
        state.groups = groups.map(group => ({ id: group.id._serialized, name: String(group.name || 'Unnamed group') }));
        lastRefresh = Date.now(); refreshNeeded = false;
      } catch {
        // A temporary refresh failure must not clear saved selections.
        state.message = 'Could not refresh groups. Existing selections are preserved; try Refresh groups.';
        refreshNeeded = false;
      }
    },
    onSnapshot: snapshot => {
      if (JSON.stringify([...store.getIds()].sort()) !== JSON.stringify(snapshot.groupIds)) return;
      state.counts = snapshot.counts;
      state.total = snapshot.total;
      state.checkedAt = new Date().toISOString();
      state.phase = snapshot.accepted ? 'running' : 'waiting_counts';
      if (snapshot.accepted) {
        state.selectionPending = false;
        state.lastSyncedCount = snapshot.total;
        if (snapshot.changed) {
          state.lastSyncedAt = state.checkedAt;
          state.deliveryStatus = snapshot.deliveryStatus;
        }
        state.message = snapshot.groupIds.length ? 'Monitoring tracked groups. Changes sync automatically.' : 'No groups tracked. Gather’s unread count is set to zero.';
      } else state.message = 'A tracked group is unavailable or its count is unknown. Keeping the last Gather count.';
    },
  });
  done = Promise.resolve().then(async () => {
    while (!combined.aborted) {
      try { await runSession(); return; }
      catch (error) {
        clearQr();
        if (combined.aborted) return;
        if (reconnectAllowed && ['auth_failure', 'disconnected'].includes(error?.code)) {
          reconnectAllowed = false;
          state.phase = 'starting'; state.whatsappReady = false;
          state.groups = []; state.counts = {}; state.total = null;
          refreshNeeded = true;
          state.message = 'WhatsApp disconnected. Preparing a new connection and pairing code…';
          logger.info('WhatsApp disconnected; reconnecting. Saved tracked groups are preserved.');
          try { await sleep(reconnectDelayMs, undefined, { signal: combined }); }
          catch { return; }
          continue;
        }
        state.phase = 'stopped';
        reportFailure(error, { error(message) { state.message = message; logger.error(message); } });
        return;
      }
    }
  });
  combined.addEventListener('abort', onAbort, { once: true });
  if (combined.aborted) await close();
  return { server, url, close, done };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try { await startDashboard({ signal: shutdown.signal }); }
  catch { console.error('Dashboard startup failed. Check UI_PORT, local storage, and WhatsApp configuration.'); process.exitCode = 1; }
}
