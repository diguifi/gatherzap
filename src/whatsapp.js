import path from 'node:path';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { createWhatsAppClient } from './whatsapp-client.js';
import { cancellable, createSynchronizer, failure } from './whatsapp-sync.js';

export function readConfig(env = process.env, { home = os.homedir(), cwd = process.cwd() } = {}) {
  const interval = Number(env.WHATSAPP_POLL_INTERVAL_MS ?? 30000);
  if (!Number.isSafeInteger(interval) || interval < 15000 || interval > 2_147_483_647) throw failure('invalid_interval');
  const authPath = env.WHATSAPP_AUTH_PATH?.trim() ?? path.join(home, '.gather-object', 'whatsapp-auth');
  if (!path.isAbsolute(authPath)) throw failure('invalid_auth_path');
  const relative = path.relative(path.resolve(cwd), path.resolve(authPath));
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw failure('invalid_auth_path');
  return { interval, authPath: path.resolve(authPath) };
}

function diagnoseFailure(error, phase) {
  if (error?.code) return error;
  const message = typeof error === 'string' ? error : error?.message ?? '';
  let code;
  if (message === 'auth timeout') code = 'whatsapp_auth_timeout';
  else if (message === 'ready timeout') code = 'whatsapp_ready_timeout';
  else if (/detached Frame|Execution context was destroyed|Cannot find context with specified id/i.test(message)) code = 'whatsapp_context_lost';
  else if (/Target closed|Session closed|Connection closed|browser has disconnected/i.test(message)) code = 'whatsapp_browser_closed';
  else if (/browser is already running|ProcessSingleton|profile.*in use/i.test(message)) code = 'whatsapp_profile_in_use';
  else if (error?.name === 'TimeoutError') code = 'whatsapp_browser_timeout';
  else code = `whatsapp_${phase}_failed`;
  return Object.assign(failure(code), { cause: error });
}

export async function runWhatsApp({ config, signal, createClient = createWhatsAppClient,
  createGatherClient: gatherFactory, logger = console,
  getGroupIds, onSnapshot, onQr, beforeCycle = async () => {}, onPhase = () => {},
  canSync = () => true, getGatherRevision = () => 0, onSyncError,
  readyTimeoutMs = 120000,
  delay = (ms, signal) => sleep(ms, undefined, { signal }) }) {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let client;
  let ready;
  let onReady;
  let phase = 'startup';
  let failed = false;
  let readyTimer;
  let isReady = false;
  const onAuthenticated = () => {
    if (isReady || combined.aborted) return;
    logger.info('WhatsApp authenticated; waiting for readiness.'); onPhase('loading');
    readyTimer ??= setTimeout(() => controller.abort(failure('whatsapp_ready_timeout')), readyTimeoutMs);
  };
  const onAuth = () => controller.abort(failure('auth_failure'));
  const onDisconnect = () => controller.abort(failure('disconnected'));
  const onLifecycleError = error => controller.abort(error);
  const onPairing = code => {
    if (combined.aborted) return;
    onPhase('pairing');
    if (onQr) {
      Promise.resolve().then(() => onQr(code)).catch(() => controller.abort(failure('qr_render_failed')));
    }
  };
  try {
    combined.throwIfAborted();
    client = await createClient({ authPath: config.authPath, signal: combined });
    ready = new Promise(resolve => {
      onReady = () => { isReady = true; clearTimeout(readyTimer); resolve(); };
      client.once('ready', onReady);
    });
    client.on('auth_failure', onAuth);
    client.on('disconnected', onDisconnect);
    client.on('lifecycle_error', onLifecycleError);
    client.on('authenticated', onAuthenticated);
    client.on('qr', onPairing);
    await cancellable(() => client.initialize(), combined);
    await cancellable(() => ready, combined);
    onPhase('ready');
    phase = 'sync';
    let sync;
    let syncRevision;
    while (!combined.aborted) {
      await cancellable(() => beforeCycle(client), combined);
      if (canSync()) {
        const revision = getGatherRevision();
        if (!sync || syncRevision !== revision) {
          syncRevision = revision;
          sync = createSynchronizer({ client, getGroupIds,
            onSnapshot: snapshot => { if (canSync() && getGatherRevision() === revision) onSnapshot?.(snapshot); },
            createGatherClient: options => {
              if (!canSync() || getGatherRevision() !== revision) throw failure('gather_config_changed');
              return gatherFactory(options);
            }, signal: combined, logger });
        }
        try { await sync.cycle(); }
        catch (error) {
          combined.throwIfAborted();
          if (getGatherRevision() !== revision) continue;
          if (!onSyncError) throw error;
          await onSyncError(error);
        }
      }
      await cancellable(() => delay(config.interval, combined), combined);
    }
    if (controller.signal.aborted) throw controller.signal.reason;
  } catch (error) {
    if (!signal?.aborted) {
      failed = true;
      throw diagnoseFailure(error, phase);
    }
  } finally {
    clearTimeout(readyTimer);
    try {
      if (client) {
        client.removeListener('ready', onReady);
        client.removeListener('auth_failure', onAuth);
        client.removeListener('disconnected', onDisconnect);
        client.removeListener('lifecycle_error', onLifecycleError);
        client.removeListener('authenticated', onAuthenticated);
        client.removeAllListeners('qr');
        try { await client.destroy(); }
        catch (error) {
          // Launch cancellation can already have closed Chromium. Preserve the
          // primary error, and never turn a requested shutdown into a failure.
          if (!failed && !combined.aborted) throw diagnoseFailure(error, 'cleanup');
        }
        finally { await client.waitForLifecycle?.(); }
      }
    } finally { controller.abort(); }
  }
}

export function reportFailure(error, logger = console) {
  const hints = {
    invalid_interval: 'Set WHATSAPP_POLL_INTERVAL_MS to an integer from 15000 to 2147483647.',
    invalid_auth_path: 'Set WHATSAPP_AUTH_PATH to an absolute local path outside the checkout.',
    missing_counter: 'The live Gather object must support counter.',
    auth_failure: 'WhatsApp authentication failed. Relink the device and restart; see README.',
    disconnected: 'WhatsApp disconnected. Check Linked devices, relink if necessary, and restart.',
    gather_timeout: 'Gather exceeded the two-minute operation timeout.',
    unexpected_delivery: 'Gather returned an unaccepted delivery status.',
    invalid_url: 'Check the webhook URL in Gather setup.',
    invalid_secret: 'Check the signing secret in Gather setup.',
    token_revoked: 'Paste the replacement Gather secret in setup.',
    network_error: 'Gather delivery failed after SDK handling. Check the connection and restart.',
    rate_limited: 'Gather delivery remained rate limited. Wait before restarting.',
    not_found: 'Check the Gather URL and secret.',
    aborted: 'Gather operation was aborted.',
    whatsapp_auth_timeout: 'WhatsApp Web did not finish loading before authentication. Restart using the saved session.',
    whatsapp_ready_timeout: 'WhatsApp linked but its Web client did not become ready. Restart using the saved session.',
    whatsapp_context_lost: 'WhatsApp Web reloaded during an operation. Restart using the saved session.',
    whatsapp_browser_closed: 'The Chromium connection closed unexpectedly. Close other instances and restart.',
    whatsapp_profile_in_use: 'The saved browser profile is already in use. Stop other instances before restarting.',
    whatsapp_browser_timeout: 'A Chromium operation timed out. Check connectivity and restart using the saved session.',
    whatsapp_startup_failed: 'WhatsApp browser initialization failed before readiness. Restart using the saved session.',
    whatsapp_sync_failed: 'Synchronization failed after WhatsApp became ready. Check configuration and restart.',
    whatsapp_cleanup_failed: 'Chromium cleanup failed. Close any remaining integration browser before restarting.',
    qr_render_failed: 'Could not prepare the pairing QR code. Restart the dashboard to try again.',
    whatsapp_navigation_failed: 'WhatsApp navigation failed. Restart the connection using the saved session.',
    whatsapp_listener_failed: 'WhatsApp connection monitoring could not start. Restart using the saved session.',
  };
  const code = Object.hasOwn(hints, error?.code ?? '') ? error.code : 'operation_failed';
  logger.error(`WhatsApp sync stopped: ${code}. ${hints[code] ?? 'Check connectivity and configuration, then restart.'}`);
}

