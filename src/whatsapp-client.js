// The library's getChats/getChatById serialize complete chats, update group
// metadata, and can fetch the last message. That path also breaks on some recent
// WhatsApp Web models (upstream #201845). Project only the fields we need from
// the same live collection; never serialize chats or read message properties.
export function readChatSnapshot(page, groupId) {
  return page.evaluate(targetId => {
    const chats = window.require('WAWebCollections').Chat.getModelsArray();
    function serializedId(chat) {
      const id = chat.id;
      if (!id) return undefined;
      return id._serialized ?? id.$1 ??
        (id.user && id.server ? `${id.user}@${id.server}` : undefined);
    }
    const isGroupId = id => typeof id === 'string' && /^\d+(?:-\d+)?@g\.us$/.test(id);
    if (targetId !== undefined) {
      const chat = chats.find(value => serializedId(value) === targetId);
      if (!chat) return undefined;
      const isGroup = isGroupId(serializedId(chat));
      return { isGroup, unreadCount: isGroup ? chat.unreadCount : undefined };
    }
    return chats.flatMap(chat => {
      const id = serializedId(chat);
      if (!isGroupId(id)) return [];
      return [{ isGroup: true, id: { _serialized: id }, name: chat.formattedTitle ?? chat.name ?? '' }];
    });
  }, groupId);
}

// The upstream listener setup installs message/call hooks that this polling app
// never uses. A failure in any of those hooks prevents its ready event entirely.
// Register only connection state; group names/counts are read by our adapter.
export function useMetadataEvents(client, { signal } = {}) {
  client.attachEventListeners = async () => {
    try {
      signal?.throwIfAborted();
      const page = client.pupPage;
      const name = 'onGatherzapConnectionState';
      if (!await page.evaluate(name => typeof window[name] === 'function', name)) {
        await page.exposeFunction(name, state => {
          if (signal?.aborted) return;
          if (!['CONNECTED', 'OPENING', 'PAIRING', 'TIMEOUT'].includes(state)) client.emit('disconnected', state);
        });
      }
      await page.evaluate(() => {
        const socket = window.require('WAWebSocketModel').Socket;
        if (window.gatherzapConnectionListener) socket.off('change:state', window.gatherzapConnectionListener);
        window.gatherzapConnectionListener = (_, state) => window.onGatherzapConnectionState(state);
        socket.on('change:state', window.gatherzapConnectionListener);
        // Surface a disconnect that raced registration as well.
        window.onGatherzapConnectionState(socket.state);
      });
    } catch {
      if (!signal?.aborted) client.emit('lifecycle_error', failure('whatsapp_listener_failed'));
    }
  };
  return client;
}

export async function createWhatsAppClient({ authPath, signal, Client, LocalAuth } = {}) {
  if (!Client || !LocalAuth) {
    const library = (await import('whatsapp-web.js')).default;
    Client = library.Client;
    LocalAuth = library.LocalAuth;
  }
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: authPath }),
    puppeteer: { headless: true, signal, handleSIGINT: false, handleSIGTERM: false },
    webVersionCache: { type: 'none' },
  });
  manageWhatsAppLifecycle(client, { signal });
  useMetadataEvents(client, { signal });
  client.getGroups = () => readChatSnapshot(client.pupPage);
  client.getGroupSnapshot = groupId => readChatSnapshot(client.pupPage, groupId);
  return client;
}
import { manageWhatsAppLifecycle } from './whatsapp-lifecycle.js';
import { failure } from './whatsapp-sync.js';

