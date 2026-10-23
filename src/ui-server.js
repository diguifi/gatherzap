import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { validateGroupIds } from './tracked-groups.js';
import { validateGatherSettings } from './gather-settings.js';

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/gather-storage.js', ['gather-storage.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

export function createDashboardServer({ getState, updateTracked, refreshGroups, configureGather, clearGather, shutdown, getPairingQr = () => null }) {
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
    const port = server.address()?.port;
    const host = request.headers.host;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host) || request.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: 'This dashboard is available locally only.' });
    try {
      const url = new URL(request.url, `http://${host}`);
      if (request.method === 'GET' && files.has(url.pathname)) {
        const [name, type] = files.get(url.pathname);
        const content = await readFile(new URL(`../ui/${name}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': type }); response.end(content); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/state') return json(200, getState());
      if (request.method === 'GET' && url.pathname === '/api/qr') {
        const qr = getPairingQr();
        if (!qr) return json(404, { error: 'No pairing QR is currently available.' });
        response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(qr); return;
      }
      if (['PUT', 'POST', 'DELETE'].includes(request.method)) {
        if (request.headers.origin !== `http://${host}`) return json(403, { error: 'Open the dashboard locally before changing tracked groups.' });
        if (request.method === 'POST' && url.pathname === '/api/shutdown' && shutdown) {
          response.once('finish', shutdown);
          return json(200, { stopped: true });
        }
        if (request.method === 'DELETE' && url.pathname === '/api/gather' && clearGather) {
          await clearGather(); return json(200, getState());
        }
        if (request.method === 'PUT' && url.pathname === '/api/gather' && configureGather) {
          if (!getState().whatsappReady) return json(409, { error: 'Link WhatsApp before configuring Gather.' });
          if (!request.headers['content-type']?.startsWith('application/json')) return json(400, { error: 'Expected JSON.' });
          let body = '';
          for await (const chunk of request) {
            body += chunk;
            if (Buffer.byteLength(body) > 16384) return json(413, { error: 'Settings are too large.' });
          }
          let settings;
          try { settings = validateGatherSettings(JSON.parse(body)); }
          catch (error) { return json(400, { error: error.code === 'invalid_secret' ? 'Enter the complete Gather signing secret, starting with whsec_.' : 'Enter a valid HTTPS webhook URL and signing secret.' }); }
          await configureGather(settings); return json(200, getState());
        }
        if (request.method === 'POST' && url.pathname === '/api/refresh') { await refreshGroups(); return json(200, getState()); }
        if (request.method === 'PUT' && url.pathname === '/api/tracked') {
          if (!request.headers['content-type']?.startsWith('application/json')) return json(400, { error: 'Expected JSON.' });
          let body = '';
          for await (const chunk of request) {
            body += chunk;
            if (Buffer.byteLength(body) > 65536) return json(413, { error: 'Selection is too large.' });
          }
          let ids;
          try { ids = validateGroupIds(JSON.parse(body).groupIds); }
          catch { return json(400, { error: 'Choose valid group IDs from the list.' }); }
          const state = getState();
          const allowed = new Set([...state.groups.map(group => group.id), ...state.trackedIds]);
          if (ids.some(id => !allowed.has(id))) return json(400, { error: 'Refresh the group list before selecting this group.' });
          await updateTracked(ids); return json(200, getState());
        }
      }
      return json(404, { error: 'Not found.' });
    } catch { if (!response.headersSent) json(500, { error: 'The request failed. Your saved selections have been preserved.' }); else response.end(); }
  });
  return server;
}
