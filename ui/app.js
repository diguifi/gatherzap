import { GATHER_STORAGE_KEY, readGatherSettings, saveGatherSettings } from './gather-storage.js';

const $ = id => document.getElementById(id);
let state;
let saving = false;
let apiError = '';
let fetching = false;
let selectionVersion = 0;
let configBusy = false;
let configVersion = 0;
let settingsAttempt = null;
let setupError = '';
let setupVisible = false;
let stopping = false;
let pollTimer;

function browserSettings() {
  try { return readGatherSettings(window.localStorage); } catch { return null; }
}

async function synchronizeBrowserSettings() {
  if (stopping || !state?.whatsappReady || configBusy) return;
  const settings = browserSettings();
  if (!settings) {
    settingsAttempt = null;
    if (state.gatherConfigured) {
      configBusy = true;
      try { state = await request('/api/gather', { method: 'DELETE' }); }
      catch { setupError = 'Could not pause Gather. Check that npm run ui is running.'; }
      finally { configBusy = false; }
    }
    return;
  }
  const attempt = `${state.instanceId}:${JSON.stringify(settings)}`;
  if (settingsAttempt === attempt) return;
  settingsAttempt = attempt;
  configBusy = true;
  try {
    state = await request('/api/gather', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
    setupError = '';
  } catch (error) { setupError = error.message; }
  finally { configBusy = false; }
}
const phaseLabels = { starting: 'Connecting to WhatsApp', pairing: 'Waiting for pairing', loading: 'Loading chats', ready: 'Preparing synchronization', running: 'Monitoring is running', waiting_counts: 'Waiting for unread counts', stopped: 'Monitoring stopped' };

async function request(url, options = {}) {
  if (stopping && url !== '/api/shutdown') throw new Error('gatherzap is stopping.');
  const response = await fetch(url, { cache: 'no-store', ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Could not complete the request.');
  return body;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function emptyList(container, title, detail, symbol) {
  const empty = element('div', 'empty');
  empty.append(element('span', 'empty-symbol', symbol), element('strong', '', title), element('p', '', detail));
  container.append(empty);
}

function row(group, tracked) {
  const card = element('div', 'group-card');
  const initials = group.name.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0] ?? '').join('').toUpperCase();
  const avatar = element('span', 'avatar', initials || '#');
  avatar.setAttribute('aria-hidden', 'true');
  avatar.dataset.tone = String([...group.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5);
  const copy = element('div', 'group-copy');
  copy.append(element('p', 'group-name', group.name), element('p', 'group-subtitle', group.unavailable ? 'Not available in WhatsApp' : 'WhatsApp group'));
  card.append(avatar, copy);
  if (tracked) {
    const count = state.counts[group.id];
    const known = Number.isSafeInteger(count) && count >= 0;
    const badge = element('span', 'unread-badge', known ? `${count} unread` : 'Pending');
    badge.dataset.unknown = String(!known);
    card.append(badge);
  }
  const button = element('button', 'row-action', tracked ? '×' : '+ Track');
  button.type = 'button'; button.disabled = saving;
  button.setAttribute('aria-label', `${tracked ? 'Stop tracking' : 'Track'} ${group.name}`);
  button.addEventListener('click', () => setTracked(group.id, !tracked));
  card.append(button);
  return card;
}

function renderLists() {
  if (!state || stopping) return;
  const query = $('search').value.trim().toLocaleLowerCase();
  const trackedIds = new Set(state.trackedIds);
  const groups = [...state.groups];
  for (const id of trackedIds) if (!groups.some(group => group.id === id)) groups.push({ id, name: `Saved group · ${id}`, unavailable: true });
  groups.sort((a, b) => a.name.localeCompare(b.name));
  const available = groups.filter(group => !trackedIds.has(group.id));
  const tracked = groups.filter(group => trackedIds.has(group.id));
  $('available-number').textContent = available.length;
  $('tracked-number').textContent = tracked.length;
  const active = document.activeElement;
  const activeLabel = active?.getAttribute('aria-label');
  for (const [container, values, isTracked] of [[$('available-list'), available, false], [$('tracked-list'), tracked, true]]) {
    container.replaceChildren();
    const visible = values.filter(group => group.name.toLocaleLowerCase().includes(query));
    for (const group of visible) container.append(row(group, isTracked));
    if (!visible.length) {
      if (query) emptyList(container, 'No matching groups', 'Try another name or clear your search.', '⌕');
      else if (isTracked) emptyList(container, 'A quieter inbox starts here', 'Track a group from the available list to add its unread messages to Gather.', '▤');
      else if (['starting', 'loading'].includes(state.phase)) emptyList(container, 'Connecting to WhatsApp', 'Your groups will appear when WhatsApp is ready. Check the terminal for pairing.', '◌');
      else emptyList(container, state.groups.length ? 'All groups are tracked' : 'No groups loaded yet', state.groups.length ? 'Remove a tracked group to move it back here.' : 'Use Refresh groups to check WhatsApp again.', '✓');
    }
  }
  if (activeLabel && active?.tagName === 'BUTTON') {
    const match = [...document.querySelectorAll('.row-action')].find(button => button.getAttribute('aria-label') === activeLabel);
    if (match) match.focus({ preventScroll: true });
  }
}

function render() {
  if (!state || stopping) return;
  $('connection').dataset.phase = state.phase;
  $('connection-label').textContent = phaseLabels[state.phase] || 'Connecting';
  const ready = state.whatsappReady ?? ['ready', 'running', 'waiting_counts'].includes(state.phase);
  $('pairing-screen').hidden = ready;
  $('dashboard-screen').hidden = true;
  $('gather-setup-screen').hidden = true;
  if (!ready) {
    const image = $('pairing-qr');
    const showQr = state.phase === 'pairing' && state.qrAvailable;
    image.hidden = !showQr;
    $('pairing-placeholder').hidden = showQr;
    if (showQr) {
      const source = `/api/qr?v=${state.qrVersion}`;
      if (image.getAttribute('src') !== source) image.src = source;
    } else image.removeAttribute('src');
    $('pairing-placeholder-label').textContent = state.phase === 'loading' ? 'Linked! Loading your chats…' : state.phase === 'stopped' ? 'Connection stopped' : 'Preparing your connection…';
    $('pairing-placeholder').dataset.stopped = String(state.phase === 'stopped');
    $('pairing-notice').textContent = apiError || state.message;
    $('pairing-notice').dataset.error = String(Boolean(apiError) || state.phase === 'stopped');
    return;
  }
  $('pairing-qr').removeAttribute('src');
  $('pairing-qr').hidden = true;
  const settings = browserSettings();
  if (!settings || !state.gatherConfigured || setupError) {
    $('gather-setup-screen').hidden = false;
    $('connection-label').textContent = 'Connect Gather to continue';
    if (!setupVisible) {
      $('gather-url').value = settings?.url ?? '';
      $('gather-secret').value = settings?.secret ?? '';
    }
    setupVisible = true;
    $('gather-save').disabled = configBusy;
    $('gather-setup-notice').textContent = setupError || state.gatherError || 'Both settings are available in your Smart Object’s webhook settings.';
    $('gather-setup-notice').dataset.error = String(Boolean(setupError || state.gatherError));
    return;
  }
  setupVisible = false;
  $('dashboard-screen').hidden = false;
  $('unread-total').textContent = state.lastSyncedCount ?? '—';
  $('tracked-summary').textContent = `${state.trackedIds.length} group${state.trackedIds.length === 1 ? '' : 's'} tracked`;
  $('summary-caption').textContent = state.selectionPending ? 'Updating your paper stack…' : state.phase === 'waiting_counts' ? 'Keeping the last synchronized count' : 'Combined unread count sent to Gather';
  $('sync-time').textContent = state.lastSyncedAt ? `Last update ${new Date(state.lastSyncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'No update yet';
  $('poll-interval').textContent = `Checks every ${state.intervalMs / 1000} seconds`;
  $('notice').textContent = apiError || state.message;
  $('notice').dataset.error = String(Boolean(apiError) || state.phase === 'stopped');
  renderLists();
}

async function setTracked(id, track) {
  if (saving || !state) return;
  selectionVersion++;
  saving = true; apiError = ''; renderLists();
  const groupIds = track ? [...state.trackedIds, id] : state.trackedIds.filter(value => value !== id);
  try { state = await request('/api/tracked', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupIds }) }); }
  catch (error) { apiError = error.message; }
  finally { saving = false; render(); }
}

async function refreshState() {
  if (stopping || saving || fetching || configBusy) return;
  fetching = true;
  const version = selectionVersion;
  const settingsVersion = configVersion;
  try {
    const next = await request('/api/state');
    if (!stopping && !saving && !configBusy && version === selectionVersion && settingsVersion === configVersion) {
      const changed = JSON.stringify(state) !== JSON.stringify(next);
      state = next; apiError = '';
      await synchronizeBrowserSettings();
      if (changed || setupVisible || !browserSettings() || $('notice').dataset.error === 'true') render();
    }
  } catch {
    if (stopping) return;
    apiError = 'Dashboard disconnected. Keep npm run ui running, then refresh this page.';
    $('notice').textContent = apiError; $('notice').dataset.error = 'true';
    $('connection-label').textContent = 'Dashboard disconnected'; $('connection').dataset.phase = 'stopped';
    $('pairing-notice').textContent = apiError;
    $('pairing-notice').dataset.error = 'true';
    $('gather-setup-notice').textContent = apiError;
    $('gather-setup-notice').dataset.error = 'true';
    $('pairing-qr').hidden = true; $('pairing-qr').removeAttribute('src');
  } finally { fetching = false; }
}

$('stop').addEventListener('click', async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(pollTimer);
  const workspace = document.querySelector('.workspace');
  workspace.inert = true;
  document.body.classList.add('stopped');
  $('shutdown-title').textContent = 'Stopping gatherzap…';
  $('shutdown-detail').textContent = 'Closing WhatsApp and synchronization.';
  $('shutdown-screen').hidden = false;
  $('shutdown-screen').focus();
  try {
    await request('/api/shutdown', { method: 'POST' });
    $('shutdown-title').textContent = 'gatherzap stopped';
    $('shutdown-detail').textContent = 'Run the executable to restart';
  } catch {
    stopping = false;
    workspace.inert = false;
    document.body.classList.remove('stopped');
    $('shutdown-screen').hidden = true;
    $('connection-label').textContent = 'Could not stop gatherzap. Try again.';
    $('stop').focus();
    pollTimer = setInterval(refreshState, 2000);
  }
});

$('search').addEventListener('input', renderLists);
$('refresh').addEventListener('click', async () => {
  $('refresh').disabled = true;
  try { state = await request('/api/refresh', { method: 'POST' }); apiError = ''; render(); }
  catch (error) { apiError = error.message; $('notice').textContent = apiError; }
  finally { $('refresh').disabled = false; }
});
$('gather-setup-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (configBusy) return;
  configVersion++;
  configBusy = true; setupError = '';
  $('gather-save').disabled = true;
  const settings = { url: $('gather-url').value.trim(), secret: $('gather-secret').value.trim() };
  try {
    state = await request('/api/gather', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
    try { saveGatherSettings(window.localStorage, settings); }
    catch {
      state = await request('/api/gather', { method: 'DELETE' });
      throw new Error('Could not save settings in this browser. Allow local storage and try again.');
    }
    settingsAttempt = `${state.instanceId}:${JSON.stringify(settings)}`;
    apiError = '';
  } catch (error) { setupError = error.message; }
  finally { configBusy = false; render(); }
});
function checkBrowserSettings() {
  configVersion++;
  if (state) render();
  void refreshState();
}
window.addEventListener('storage', event => { if (event.key === GATHER_STORAGE_KEY || event.key === null) checkBrowserSettings(); });
window.addEventListener('pageshow', checkBrowserSettings);
window.addEventListener('focus', checkBrowserSettings);
await refreshState();
if (!stopping) pollTimer = setInterval(refreshState, 2000);
