import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { WebSocket, WebSocketServer } from 'ws';
import { desktopClientModule } from '../../apps/control-plane/src/desktop-client.js';
import { fixture, fixtureToken, eventually } from './helpers/fleet.js';

const origin = 'http://127.0.0.1:8080';
const expiresAt = () => new Date(Date.now() + 60_000).toISOString();
const path = (id: string) => `/profiles/${id}/desktop/credentials`;
async function browserLogin(f: Awaited<ReturnType<typeof fixture>>, token: string) {
  const login = await f.request('POST', '/api/v1/session', { token }, '');
  assert.equal(login.statusCode, 200);
  const cookie = login.cookies.find(cookie => cookie.name === 'fleet_session'); assert.ok(cookie);
  return { cookie: `fleet_session=${cookie.value}`, origin, 'x-csrf-token': login.json().data.csrfToken };
}
async function desktopUpstream() {
  const websocket = new WebSocketServer({ noServer: true });
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url?.endsWith('.html') ? 'text/html' : 'text/javascript');
    response.end(request.url?.endsWith('vnc.html')
      ? '<!doctype html><html><head><script type="module" src="app/ui.js"></script></head><body><div id="noVNC_container"></div></body></html>'
      : 'export default {};');
  });
  server.on('upgrade', (request, socket, head) => websocket.handleUpgrade(request, socket, head, client => {
    client.on('message', message => client.send(message));
  }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}`, async close() {
    for (const client of websocket.clients) client.terminate();
    websocket.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

test('desktop credentials require Web CSRF, automate/profile scope and the current owner session; HTML/module contain no password', async () => {
  const f = await fixture(); const upstream = await desktopUpstream();
  try {
    const profile = await f.create(); const other = await f.create();
    const owner = f.auth.issue(['automate', 'read'], [profile.id], expiresAt());
    const opened = await f.request('POST', `/api/v1/profiles/${profile.id}/manual-sessions`, { durationSeconds: 60 }, owner.token);
    assert.equal(opened.statusCode, 201, opened.body);
    const context = { sessionId: opened.json().data.id, version: 1 };
    const headers = await browserLogin(f, owner.token);
    const stored = f.service.profile(profile.id); stored.desktopUrl = upstream.url; f.service.saveProfile(stored);
    assert.equal((await f.request('POST', path(profile.id), context, '')).statusCode, 401);
    const native = await f.request('POST', path(profile.id), context, owner.token);
    assert.equal(native.statusCode, 403); assert.equal(native.json().code, 'WEB_SESSION_REQUIRED');
    for (const changed of [{ ...headers, 'x-csrf-token': '' }, { ...headers, 'x-csrf-token': 'wrong' }]) {
      const denied = await f.request('POST', path(profile.id), context, '', changed);
      assert.equal(denied.statusCode, 403); assert.equal(denied.json().code, 'CSRF_REJECTED');
    }
    const missingOrigin = { cookie: headers.cookie, 'x-csrf-token': headers['x-csrf-token'] };
    assert.equal((await f.request('POST', path(profile.id), context, '', missingOrigin)).statusCode, 403);
    assert.equal((await f.request('POST', path(other.id), context, '', headers)).json().code, 'PROFILE_DENIED');
    for (const scopes of [['read'], ['manage']]) {
      const restricted = f.auth.issue(scopes, [profile.id], expiresAt());
      assert.equal((await f.request('POST', path(profile.id), context, '', await browserLogin(f, restricted.token))).json().code, 'SCOPE_DENIED');
    }
    const stranger = f.auth.issue(['automate'], [profile.id], expiresAt());
    assert.equal((await f.request('POST', path(profile.id), context, '', await browserLogin(f, stranger.token))).json().code, 'MANUAL_SESSION_EXPIRED');
    assert.equal((await f.request('POST', `/api/v1/profiles/${profile.id}/remote-desktop/password/reveal`, {}, owner.token)).json().code, 'SCOPE_DENIED');
    const secret = await f.request('POST', path(profile.id), context, '', { ...headers, 'idempotency-key': 'fixture-desktop-credentials' });
    assert.equal(secret.statusCode, 200, secret.body);
    assert.deepEqual(secret.json().data, { password: 'fixture1', version: 1 });
    assert.equal(secret.headers['cache-control'], 'no-store');
    assert.equal((await f.request('POST', path(profile.id), context, '', headers)).statusCode, 200, '同一有效会话允许显式重新连接再次取密');
    const wrongVersion = await f.request('POST', path(profile.id), { ...context, version: 2 }, '', headers);
    assert.equal(wrongVersion.statusCode, 409); assert.equal(wrongVersion.json().code, 'DESKTOP_CONTEXT_EXPIRED');
    assert.equal((await f.request('POST', path(profile.id), { ...context, secretRef: stored.vncSecretRef }, '', headers)).statusCode, 400);
    const redirect = await f.request('GET', `/profiles/${profile.id}/desktop`, undefined, '', headers);
    assert.equal(redirect.statusCode, 302); assert.equal(String(redirect.headers.location).includes('password='), false);
    const html = await f.request('GET', `/profiles/${profile.id}/desktop/vnc.html`, undefined, '', headers);
    assert.equal(html.statusCode, 200);
    assert.ok(html.body.includes(`data-session-id="${context.sessionId}"`));
    assert.ok(html.body.indexOf('src="fleet-desktop.js"') < html.body.indexOf('src="app/ui.js"'));
    const module = await f.request('GET', `/profiles/${profile.id}/desktop/fleet-desktop.js`, undefined, '', headers);
    assert.equal(module.statusCode, 200);
    for (const body of [html.body, module.body]) {
      assert.equal(body.includes('fixture1'), false); assert.equal(body.includes(stored.vncSecretRef!), false);
    }
    const audit = f.service.db.list<any>('audit').filter(entry => entry.action === 'desktop_credentials');
    assert.equal(audit.length, 2);
    assert.ok(audit.every(entry => entry.principal === owner.id && entry.profileId === profile.id && entry.result === 'succeeded'));
    assert.equal(JSON.stringify(audit).includes('fixture1'), false);
    assert.equal(f.service.db.db.prepare('SELECT response FROM idempotency').all().length, 0);
    const spec = (await f.request('GET', '/api/v1/openapi.json')).json();
    assert.equal(JSON.stringify(spec).includes('/desktop/credentials'), false);
  } finally { await f.close(); await upstream.close(); }
});

test('desktop context rejects expired lease, unapplied passwords, stopped/purged profiles and a replacement manual session', async () => {
  const f = await fixture();
  try {
    const profile = await f.create();
    const opened = await f.request('POST', `/api/v1/profiles/${profile.id}/manual-sessions`, { durationSeconds: 60 });
    const context = { sessionId: opened.json().data.id, version: 1 };
    const headers = await browserLogin(f, fixtureToken);
    const stored = f.service.profile(profile.id);
    stored.remoteDesktop.appliedVersion = 0; f.service.saveProfile(stored);
    assert.equal((await f.request('POST', path(profile.id), context, '', headers)).json().code, 'DESKTOP_PASSWORD_PENDING');
    stored.remoteDesktop.appliedVersion = 1; stored.state = 'stopped'; f.service.saveProfile(stored);
    assert.equal((await f.request('POST', path(profile.id), context, '', headers)).json().code, 'DESKTOP_UNAVAILABLE');
    stored.state = 'running'; stored.purgedAt = new Date().toISOString(); f.service.saveProfile(stored);
    assert.equal((await f.request('POST', path(profile.id), context, '', headers)).json().code, 'DESKTOP_UNAVAILABLE');
    delete stored.purgedAt; f.service.saveProfile(stored);
    f.service.db.db.prepare('UPDATE leases SET expires_at=? WHERE profile_id=?').run(Date.now() - 1, profile.id);
    assert.equal((await f.request('POST', path(profile.id), context, '', headers)).json().code, 'MANUAL_SESSION_EXPIRED');
    await f.service.revokeDesktop(profile.id);
    const next = await f.request('POST', `/api/v1/profiles/${profile.id}/manual-sessions`, { durationSeconds: 60 });
    assert.equal(next.statusCode, 201, next.body);
    assert.notEqual(next.json().data.id, context.sessionId);
    assert.equal((await f.request('POST', path(profile.id), context, '', headers)).json().code, 'DESKTOP_CONTEXT_EXPIRED');
    const fresh = { sessionId: next.json().data.id, version: 1 };
    assert.equal((await f.request('POST', path(profile.id), fresh, '', headers)).statusCode, 200);
    const current = f.service.profile(profile.id); current.remoteDesktop.version = 2; current.remoteDesktop.appliedVersion = 2; f.service.saveProfile(current);
    assert.equal((await f.request('POST', path(profile.id), fresh, '', headers)).json().code, 'DESKTOP_CONTEXT_EXPIRED');
  } finally { await f.close(); }
});

test('desktop WebSocket binds both explicit and legacy connections to their original session/version and revokes credentials', async () => {
  const f = await fixture(); const upstream = await desktopUpstream(); const clients = new Set<WebSocket>();
  try {
    const profile = await f.create(); const owner = f.auth.issue(['automate'], [profile.id], expiresAt());
    const opened = await f.request('POST', `/api/v1/profiles/${profile.id}/manual-sessions`, { durationSeconds: 60 }, owner.token);
    const sessionId = opened.json().data.id;
    const headers = await browserLogin(f, owner.token);
    const stored = f.service.profile(profile.id); stored.desktopUrl = upstream.url; f.service.saveProfile(stored);
    await f.app.listen({ host: '127.0.0.1', port: 0 }); const address = f.app.server.address(); assert.ok(address && typeof address === 'object');
    const connect = (query = '') => new Promise<WebSocket>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${address.port}/profiles/${profile.id}/desktop/websockify${query}`, { headers: { host: '127.0.0.1:8080', origin, cookie: headers.cookie } });
      clients.add(client);
      const timer = setTimeout(() => { client.terminate(); reject(new Error('fixture websocket timeout')); }, 3000);
      client.once('open', () => { clearTimeout(timer); resolve(client); });
      client.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const bound = await connect(`?sessionId=${sessionId}&version=1`);
    const legacy = await connect();
    await assert.rejects(() => connect(`?sessionId=${sessionId}&version=2`));
    await f.service.revokeDesktop(profile.id);
    await eventually(() => bound.readyState === WebSocket.CLOSED && legacy.readyState === WebSocket.CLOSED, 'closed manual session must close bound and legacy sockets');
    const next = await f.request('POST', `/api/v1/profiles/${profile.id}/manual-sessions`, { durationSeconds: 60 }, owner.token);
    await assert.rejects(() => connect(`?sessionId=${sessionId}&version=1`));
    const current = await connect(`?sessionId=${next.json().data.id}&version=1`);
    await f.request('DELETE', `/api/v1/credentials/${owner.id}`);
    await eventually(() => current.readyState === WebSocket.CLOSED, 'credential revocation must close an established socket');
    assert.equal((await f.request('POST', path(profile.id), { sessionId: next.json().data.id, version: 1 }, '', headers)).statusCode, 401);
  } finally { for (const client of clients) client.terminate(); await f.close(); await upstream.close(); }
});

function clientHarness() {
  const profileId = 'cf_11111111-1111-4111-8111-111111111111';
  const sessionId = 'manual_22222222-2222-4222-8222-222222222222';
  const dataset: Record<string, string> = {};
  const pageEvents = new Map<string, () => void>();
  const requests: { path: string; init: any }[] = [];
  const connections: any[] = [];
  let status = 200;
  let fetches = 0;
  const ui: any = {
    getSetting: (_name: string, fallback: unknown) => fallback,
    showStatus() {}, updateVisualState() {}, openConnectPanel() {},
    connect(_event: unknown, password: string) {
      const listeners = new Map<string, ((event: any) => void)[]>();
      const rfb = {
        password, sends: 0,
        addEventListener(type: string, fn: (event: any) => void) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
        emit(type: string, extra: any = {}) { for (const fn of listeners.get(type) ?? []) fn({ target: rfb, ...extra }); },
        disconnect() { ui.disconnectFinished({ detail: { clean: true } }); },
        sendCredentials() { this.sends++; },
      };
      ui.rfb = rfb; connections.push(rfb);
    },
    disconnect() { this.rfb?.disconnect(); },
    disconnectFinished() { this.rfb = undefined; },
  };
  const sandbox = {
    UI: ui,
    document: { querySelector: () => ({ dataset: { profileId, sessionId, version: '1' } }), documentElement: { dataset } },
    window: { location: { hostname: '127.0.0.1', port: '8080', protocol: 'http:' }, addEventListener: (name: string, fn: () => void) => pageEvents.set(name, fn) },
    fetch: async (path: string, init: any) => {
      requests.push({ path, init });
      if (path === '/api/v1/session') return { ok: true, status: 200, json: async () => ({ data: { authenticated: true, csrfToken: 'fixture-csrf' } }) };
      fetches++;
      return { ok: status === 200, status, json: async () => ({ data: { password: 'fixture1', version: 1 } }) };
    },
    AbortController, clearTimeout,
  };
  runInNewContext(desktopClientModule.replace("import UI from './app/ui.js';", ''), sandbox);
  return { ui, dataset, requests, connections, pageEvents, profileId, sessionId, getFetches: () => fetches, setStatus: (value: number) => { status = value; } };
}

test('noVNC adapter preloads one credential per new RFB, permits explicit retries and fixes shared same-origin session-bound sockets', async () => {
  const f = clientHarness();
  assert.equal(f.ui.getSetting('host'), '127.0.0.1'); assert.equal(f.ui.getSetting('port'), '8080');
  assert.equal(f.ui.getSetting('shared'), true); assert.equal(f.ui.getSetting('reconnect'), false);
  assert.equal(f.ui.getSetting('path'), `profiles/${f.profileId}/desktop/websockify?sessionId=${f.sessionId}&version=1`);
  await f.ui.connect();
  assert.equal(f.getFetches(), 1); assert.equal(f.connections[0].password, 'fixture1');
  assert.equal(f.ui.reconnectPassword, null);
  f.connections[0].emit('connect'); assert.equal(f.dataset.fleetDesktopState, 'connected');
  await f.ui.connect(); assert.equal(f.getFetches(), 1, 'active RFB cannot automatically fetch a second credential');
  f.ui.disconnect(); assert.equal(f.dataset.fleetDesktopState, 'disconnected');
  await f.ui.connect(); assert.equal(f.getFetches(), 2, 'explicit retry creates a new RFB with fresh authorization');
  const post = f.requests.find(request => request.path.endsWith('/credentials'))!;
  assert.equal(post.init.method, 'POST'); assert.equal(post.init.cache, 'no-store');
  assert.equal(post.init.headers['X-CSRF-Token'], 'fixture-csrf');
  assert.deepEqual(JSON.parse(post.init.body), { sessionId: f.sessionId, version: 1 });
  assert.equal(JSON.stringify(f.dataset).includes('fixture1'), false);
  f.pageEvents.get('pagehide')!(); await f.ui.connect(); assert.equal(f.getFetches(), 2);
});

test('noVNC adapter stops credential loops after authentication/context failure but leaves network failure explicitly retryable', async () => {
  const expired = clientHarness(); expired.setStatus(409); await expired.ui.connect();
  assert.equal(expired.dataset.fleetDesktopState, 'expired'); assert.equal(expired.connections.length, 0);
  expired.setStatus(200); await expired.ui.connect(); assert.equal(expired.getFetches(), 1);
  const network = clientHarness(); network.setStatus(503); await network.ui.connect();
  assert.equal(network.dataset.fleetDesktopState, 'error');
  network.setStatus(200); await network.ui.connect(); assert.equal(network.getFetches(), 2);
  network.connections[0].emit('securityfailure');
  network.ui.disconnect(); await network.ui.connect(); assert.equal(network.getFetches(), 2);
  const repeated = clientHarness(); await repeated.ui.connect();
  await repeated.ui.credentials({ target: repeated.connections[0], detail: { types: ['password'] } });
  assert.equal(repeated.getFetches(), 1); assert.equal(repeated.connections[0].sends, 0, 'same RFB cannot retry a rejected initial password');
});
