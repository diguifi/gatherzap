export function failure(code) {
  return Object.assign(new Error(code), { code });
}

// Cancellation races also cover WhatsApp calls, which do not accept a signal.
export function cancellable(work, signal) {
  if (!signal) return Promise.resolve().then(work);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return work(); })
      .then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createSynchronizer({ client, getGroupIds, onSnapshot = () => {}, createGatherClient, signal, logger = console }) {
  let checked = false;
  let lastCount;
  async function operation(action) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(failure('gather_timeout')), 120_000);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      return await cancellable(() => action(createGatherClient({ signal: combined })), combined);
    } finally { clearTimeout(timer); }
  }
  return {
    async cycle() {
      signal?.throwIfAborted();
      const groupIds = [...new Set(getGroupIds())].sort();
      const counts = {};
      let count = 0;
      let unknown = false;
      for (const id of groupIds) {
        let chat;
        try { chat = await cancellable(() => client.getGroupSnapshot(id), signal); }
        catch (error) {
          signal?.throwIfAborted();
          logger.info('WhatsApp read failed; skipping this cycle.');
          unknown = true;
        }
        if (!chat || chat.isGroup !== true) {
          counts[id] = null;
          unknown = true;
          continue;
        }
        const value = chat.unreadCount;
        counts[id] = Number.isSafeInteger(value) && value >= 0 ? value : null;
        if (counts[id] === null) unknown = true;
        else count += value;
      }
      // Selections may change while WhatsApp is being read. Discard obsolete totals.
      if (JSON.stringify([...new Set(getGroupIds())].sort()) !== JSON.stringify(groupIds)) return;
      if (unknown || !Number.isSafeInteger(count)) {
        logger.info('WhatsApp unread count is unknown; retaining Gather state.');
        onSnapshot({ groupIds, counts, total: null, accepted: false });
        return;
      }
      if (count === lastCount) {
        onSnapshot({ groupIds, counts, total: count, accepted: true, changed: false });
        return;
      }
      if (!checked) {
        const state = await operation(object => object.ping());
        if (!state?.capabilities || !Object.hasOwn(state.capabilities, 'counter')) throw failure('missing_counter');
        checked = true;
      }
      signal?.throwIfAborted();
      const result = await operation(object => {
        if (JSON.stringify([...new Set(getGroupIds())].sort()) !== JSON.stringify(groupIds)) return { status: 'superseded' };
        return object.counter.set({ count });
      });
      if (result?.status === 'superseded') return;
      if (!['dispatched', 'space_idle'].includes(result?.status)) throw failure('unexpected_delivery');
      const firstSync = lastCount === undefined;
      lastCount = count;
      onSnapshot({ groupIds, counts, total: count, accepted: true, changed: true, deliveryStatus: result.status });
      if (firstSync) logger.info(`WhatsApp monitoring is running; initial unread count (${count}) synchronized with Gather.`);
    },
  };
}
