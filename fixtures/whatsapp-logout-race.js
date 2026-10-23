// Reproduce the installed library's async framenavigated logout handler without
// contacting WhatsApp, launching Chromium, or using a real LocalAuth directory.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createWhatsAppClient } from '../src/whatsapp-client.js';
import { runWhatsApp } from '../src/whatsapp.js';
import { startDashboard } from '../src/dashboard.js';

const clients = [];
let logoutFinished = false;
let replacementDuringCleanup = false;
class LocalAuth {
  setup(client) { this.client = client; }
  async beforeBrowserInitialized() {}
  async afterBrowserInitialized() {}
  async logout() {
    // Windows must release the profile before LocalAuth deletes it.
    await sleep(25);
    assert.equal(this.client.pupBrowser.isConnected(), false);
    logoutFinished = true;
  }
}
class Client extends EventEmitter {
  constructor(options) {
    super();
    this.authStrategy = options.authStrategy; this.authStrategy.setup(this);
    this.number = clients.length; this.destroyCalls = 0;
    if (this.number > 0 && !logoutFinished) replacementDuringCleanup = true;
    clients.push(this);
  }
  async initialize() {
    await this.authStrategy.beforeBrowserInitialized();
    this.pupPage = new EventEmitter();
    let connected = true;
    this.pupBrowser = { isConnected: () => connected, close: async () => { connected = false; } };
    await this.authStrategy.afterBrowserInitialized();
    await this.inject();
    this.pupPage.on('framenavigated', async frame => {
      if (frame.url().includes('post_logout=1')) {
        this.emit('disconnected', 'LOGOUT');
        await this.authStrategy.logout();
        await this.authStrategy.beforeBrowserInitialized();
        await this.authStrategy.afterBrowserInitialized();
      }
      await this.inject();
    });
    if (this.number === 0) this.emit('ready');
    else this.emit('qr', 'TEST-ONLY-RELINK-CODE');
  }
  async inject() {
    if (!this.pupBrowser.isConnected()) throw Error("Attempted to use detached Frame 'TEST-ONLY-FRAME'.");
  }
  async destroy() { this.destroyCalls++; await this.pupBrowser?.close(); }
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'gather-logout-race-'));
let dashboard;
try {
  dashboard = await startDashboard({ env: {}, port: 0, reconnectDelayMs: 0,
    logger: { info() {}, error() {} }, filePath: path.join(directory, 'tracked.json'),
    runner: options => runWhatsApp({ ...options,
      beforeCycle: async () => {},
      createClient: settings => createWhatsAppClient({ ...settings, Client, LocalAuth }),
    }),
  });
  for (let i = 0; i < 100 && !clients[0]?.pupPage?.listenerCount('framenavigated'); i++) await sleep(5);
  clients[0].pupPage.emit('framenavigated', { url: () => 'https://web.whatsapp.com/?post_logout=1' });
  let state;
  for (let i = 0; i < 200; i++) {
    state = await (await fetch(`${dashboard.url}/api/state`)).json();
    if (state.qrAvailable) break;
    await sleep(5);
  }
  assert.equal(state.phase, 'pairing'); assert.equal(state.qrAvailable, true);
  assert.equal(clients.length, 2); assert.equal(clients[0].destroyCalls, 1);
  assert.equal(clients[0].pupPage.listenerCount('framenavigated'), 0);
  await sleep(30); // The retired callback must not reject after reconnect succeeds.
  assert.equal(replacementDuringCleanup, false);
  console.log('Logout race regression passed; server remains alive and serves the replacement QR.');
} finally {
  await dashboard?.close();
  await rm(directory, { recursive: true, force: true });
}
