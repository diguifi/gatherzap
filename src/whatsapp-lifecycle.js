import { failure } from './whatsapp-sync.js';

// whatsapp-web.js registers an async framenavigated handler which its emitter
// does not await. On logout it emits disconnected, cleans LocalAuth, then calls
// inject again. Observe that work per client so destroying the browser cannot
// produce an unhandled rejection or overlap the next session's profile setup.
export function manageWhatsAppLifecycle(client, { signal } = {}) {
  let closing = false;
  let destruction;
  const tasks = new Set();
  const pages = new Map();
  const stopped = () => closing || signal?.aborted;

  function guardPage() {
    const page = client.pupPage;
    if (!page?.on || pages.has(page)) return;
    const originalOn = page.on;
    const handlers = new Set();
    function guardedOn(event, handler) {
      if (event !== 'framenavigated') return originalOn.call(this, event, handler);
      if (stopped()) return this;
      const guarded = (...args) => {
        if (stopped()) return;
        const task = Promise.resolve().then(() => {
          if (!stopped()) return handler.apply(page, args);
        }).catch(error => {
          if (stopped()) return;
          const message = typeof error === 'string' ? error : error?.message ?? '';
          const code = /detached Frame|Execution context was destroyed|Target closed|Session closed|Connection closed/i.test(message)
            ? 'disconnected' : 'whatsapp_navigation_failed';
          client.emit('lifecycle_error', failure(code));
        });
        tasks.add(task);
        void task.then(() => tasks.delete(task));
      };
      handlers.add(guarded);
      return originalOn.call(this, event, guarded);
    }
    pages.set(page, { handlers });
    page.on = guardedOn;
  }

  const originalInject = client.inject?.bind(client);
  if (originalInject) client.inject = async (...args) => {
    if (stopped()) return;
    try { return await originalInject(...args); }
    catch (error) { if (!stopped()) throw error; }
  };

  const originalDestroy = client.destroy?.bind(client);
  if (originalDestroy) client.destroy = () => {
    if (!destruction) {
      closing = true;
      for (const [page, { handlers }] of pages) {
        for (const handler of handlers) page.off('framenavigated', handler);
      }
      // Keep each page's registration guard while retiring: a late initialize
      // must not add another navigation callback to an already-closed page.
      destruction = Promise.resolve().then(() => originalDestroy());
      // Upstream also calls destroy() without awaiting it. Observe that promise
      // here; callers which await it still receive its original rejection.
      void destruction.catch(() => {});
    }
    return destruction;
  };

  const auth = client.authStrategy;
  if (auth) {
    const before = auth.beforeBrowserInitialized?.bind(auth);
    auth.beforeBrowserInitialized = async (...args) => {
      if (!stopped()) return before?.(...args);
    };
    const after = auth.afterBrowserInitialized?.bind(auth);
    auth.afterBrowserInitialized = async (...args) => {
      if (!stopped()) await after?.(...args);
      guardPage();
    };
    const logout = auth.logout?.bind(auth);
    if (logout) auth.logout = async (...args) => {
      // The library calls this only for an actual logout. Release Windows
      // profile locks before it removes the now-invalid LocalAuth session.
      try { await client.destroy(); }
      catch (error) { if (client.pupBrowser?.isConnected?.()) throw error; }
      return logout(...args);
    };
  }

  // Wait outside destroy(): a navigation handler may itself await destroy().
  // Waiting inside it would deadlock that handler against its own completion.
  client.waitForLifecycle = async () => {
    while (tasks.size) await Promise.all([...tasks]);
  };
  return client;
}
