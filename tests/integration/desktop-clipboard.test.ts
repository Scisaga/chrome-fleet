import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { FleetError } from '@chrome-fleet/contracts';
import { fixture, fixtureToken, eventually } from './helpers/fleet.js';
import { desktopClipboardModule } from '../../apps/control-plane/src/desktop-clipboard-client.js';

const origin = 'http://127.0.0.1:8080';
const contents = '合成剪贴板 · 中文与 emoji 🦊\nsecond line';
const expires = () => new Date(Date.now() + 60_000).toISOString();
type Fixture = Awaited<ReturnType<typeof fixture>>;
const endpoint = (pid: string) => `/profiles/${pid}/desktop/clipboard`;
async function login(f: Fixture, token: string) {
  const response = await f.request('POST', '/api/v1/session', { token }, '');
  const cookie = response.cookies.find(value => value.name === 'fleet_session')!;
  return { cookie: `fleet_session=${cookie.value}`, origin, 'x-csrf-token': response.json().data.csrfToken };
}
async function setup(f: Fixture) {
  const profile = await f.create();
  const owner = f.auth.issue(['automate', 'read'], [profile.id], expires());
  const opened = await f.request('POST', `/api/v1/profiles/${profile.id}/manual-sessions`, { explicitStart: true, durationSeconds: 60 }, owner.token);
  assert.equal(opened.statusCode, 201);
  return { profile, owner, binding: { sessionId: opened.json().data.id, version: 1 }, headers: await login(f, owner.token) };
}

test('desktop clipboard requires a current owning Web session, CSRF, automate/profile scope, same origin and exact session/version', async () => {
  const f = await fixture();
  try {
    const { profile, owner, binding, headers } = await setup(f);
    const foreign = await f.create();
    const body = { ...binding, action: 'write', text: contents };
    assert.equal((await f.request('POST', endpoint(profile.id), body, '')).statusCode, 401);
    assert.equal((await f.request('POST', endpoint(profile.id), body, owner.token)).json().code, 'WEB_SESSION_REQUIRED');
    for (const changed of [{ ...headers, 'x-csrf-token': '' }, { ...headers, 'x-csrf-token': 'wrong' }])
      assert.equal((await f.request('POST', endpoint(profile.id), body, '', changed)).json().code, 'CSRF_REJECTED');
    assert.equal((await f.request('POST', endpoint(profile.id), body, '', { cookie: headers.cookie, 'x-csrf-token': headers['x-csrf-token'] })).json().code, 'ORIGIN_REJECTED');
    assert.equal((await f.request('POST', endpoint(foreign.id), body, '', headers)).json().code, 'PROFILE_DENIED');
    for (const scopes of [['read'], ['manage']]) {
      const denied = f.auth.issue(scopes, [profile.id], expires());
      assert.equal((await f.request('POST', endpoint(profile.id), body, '', await login(f, denied.token))).json().code, 'SCOPE_DENIED');
    }
    const stranger = f.auth.issue(['automate'], [profile.id], expires());
    assert.equal((await f.request('POST', endpoint(profile.id), body, '', await login(f, stranger.token))).json().code, 'MANUAL_SESSION_EXPIRED');
    assert.equal((await f.request('POST', endpoint(profile.id), { ...body, version: 2 }, '', headers)).json().code, 'DESKTOP_CONTEXT_EXPIRED');
    assert.equal((await f.request('POST', endpoint(profile.id), { ...body, sessionId: 'manual_00000000-0000-4000-8000-000000000000' }, '', headers)).json().code, 'DESKTOP_CONTEXT_EXPIRED');
    const stored = f.service.profile(profile.id); stored.remoteDesktop.appliedVersion = 0; f.service.saveProfile(stored);
    assert.equal((await f.request('POST', endpoint(profile.id), body, '', headers)).json().code, 'DESKTOP_PASSWORD_PENDING');
    stored.remoteDesktop.appliedVersion = 1; stored.state = 'stopped'; f.service.saveProfile(stored);
    assert.equal((await f.request('POST', endpoint(profile.id), body, '', headers)).json().code, 'DESKTOP_UNAVAILABLE');
    stored.state = 'running'; f.service.saveProfile(stored);
    f.service.db.db.prepare('UPDATE leases SET expires_at=? WHERE profile_id=?').run(Date.now() - 1, profile.id);
    assert.equal((await f.request('POST', endpoint(profile.id), body, '', headers)).json().code, 'MANUAL_SESSION_EXPIRED');
  } finally { await f.close(); }
});

test('UTF-8 clipboard exchanges use the same manual fence without logging, caching, extra fields or persistent payloads', async () => {
  const f = await fixture();
  try {
    const { profile, binding, headers } = await setup(f);
    let clipboard = '';
    const calls: { path: string; token?: number; body: any }[] = [];
    const original = f.service.agent.bind(f.service);
    f.service.agent = async (p, path, body, token, timeout) => {
      if (path !== '/desktop/clipboard') return original(p, path, body, token, timeout);
      assert.equal(p.id, profile.id); assert.equal(token, f.service.db.lease(p.id).token);
      calls.push({ path, token, body });
      if (body.action === 'write') { clipboard = body.text; return { written: true, text: contents, password: 'forbidden-agent-extra' }; }
      return { text: clipboard, password: 'forbidden-agent-extra' };
    };
    const sent = await f.request('POST', endpoint(profile.id), { ...binding, action: 'write', text: contents }, '', { ...headers, 'idempotency-key': 'clipboard-must-not-cache' });
    assert.equal(sent.statusCode, 200); assert.deepEqual(sent.json().data, { written: true });
    const read = await f.request('POST', endpoint(profile.id), { ...binding, action: 'read' }, '', headers);
    assert.equal(read.statusCode, 200); assert.deepEqual(read.json().data, { text: contents });
    for (const response of [sent, read]) {
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.body.includes('forbidden-agent-extra'), false);
    }
    assert.deepEqual(calls.map(call => call.body), [{ action: 'write', text: contents }, { action: 'read' }]);
    assert.equal(JSON.stringify(f.service.db.db.prepare('SELECT value FROM records').all()).includes(contents), false);
    assert.equal(JSON.stringify(f.service.db.list('audit')).includes(contents), false);
    assert.equal(f.service.db.db.prepare('SELECT * FROM idempotency').all().length, 0);
    const openapi = (await f.request('GET', '/api/v1/openapi.json')).json();
    assert.equal(JSON.stringify(openapi).includes('/desktop/clipboard'), false);
    const module = await f.request('GET', `/profiles/${profile.id}/desktop/fleet-clipboard.js`, undefined, '', headers);
    assert.equal(module.statusCode, 200); assert.equal(module.body.includes(contents), false);
  } finally { await f.close(); }
});

test('clipboard bounds UTF-8 bytes in both directions and redacts all upstream failures', async () => {
  const f = await fixture();
  try {
    const { profile, binding, headers } = await setup(f);
    let mode = 'too-large', calls = 0;
    const original = f.service.agent.bind(f.service);
    f.service.agent = async (p, path, body, token, timeout) => {
      if (path !== '/desktop/clipboard') return original(p, path, body, token, timeout);
      calls++;
      if (mode === 'too-large') return { text: '中'.repeat(44_000) };
      if (mode === 'unconfirmed-write') return {};
      throw new FleetError('AGENT_ERROR', contents, 500, { text: contents });
    };
    for (const body of [
      { ...binding, action: 'write', text: '中'.repeat(44_000) },
      { ...binding, action: 'write', text: 'bad\0text' },
      { ...binding, action: 'read', text: contents },
      { ...binding, action: 'write', text: contents, fencingToken: 1 },
    ]) assert.equal((await f.request('POST', endpoint(profile.id), body, '', headers)).statusCode, 400);
    assert.equal(calls, 0);
    assert.equal((await f.request('POST', endpoint(profile.id), { ...binding, action: 'read' }, '', headers)).statusCode, 413);
    mode = 'error';
    const failed = await f.request('POST', endpoint(profile.id), { ...binding, action: 'read' }, '', headers);
    assert.equal(failed.statusCode, 503); assert.equal(failed.body.includes(contents), false);
    mode = 'unconfirmed-write';
    assert.equal((await f.request('POST', endpoint(profile.id), { ...binding, action: 'write', text: contents }, '', headers)).statusCode, 503);
  } finally { await f.close(); }
});

test('a clipboard response never releases text after owner revocation, manual-session replacement or password rotation', async () => {
  for (const change of ['credential', 'session', 'version'] as const) {
    const f = await fixture();
    try {
      const { profile, owner, binding, headers } = await setup(f);
      let entered = false; let release!: () => void;
      const original = f.service.agent.bind(f.service);
      f.service.agent = async (p, path, body, token, timeout) => {
        if (path !== '/desktop/clipboard') return original(p, path, body, token, timeout);
        entered = true; await new Promise<void>(resolve => { release = resolve; });
        return { text: contents };
      };
      const pending = f.request('POST', endpoint(profile.id), { ...binding, action: 'read' }, '', headers);
      await eventually(() => entered, 'clipboard read did not start');
      if (change === 'credential') {
        const credential = f.service.db.get<any>('credentials', owner.id); credential.revoked = true; f.service.db.set('credentials', owner.id, credential);
      } else if (change === 'session') await f.service.revokeDesktop(profile.id);
      else { const p = f.service.profile(profile.id); p.remoteDesktop.version++; p.remoteDesktop.appliedVersion = p.remoteDesktop.version; f.service.saveProfile(p); }
      release();
      const response = await pending;
      assert.ok([401,403,409].includes(response.statusCode));
      assert.equal(response.body.includes(contents), false);
    } finally { await f.close(); }
  }
});

function panelHarness() {
  const elements = new Map<string, any>();
  const observers: (() => void)[] = [];
  const pageEvents = new Map<string, () => void>();
  const requests: { path: string; init: any }[] = [];
  const dataset = { fleetDesktopState: 'connected' };
  let remote = contents, copies = 0;
  function element() {
    let id = '';
    const listeners = new Map<string, (event?: any) => any>();
    const e: any = { value: '', hidden: false, disabled: false, textContent: '', listeners,
      setAttribute() {}, appendChild() {}, append() {}, focus() {}, select() { e.selected = true; },
      addEventListener(name: string, listener: (event?: any) => any) { listeners.set(name, listener); },
      click() { return listeners.get('click')?.({ preventDefault() {}, stopImmediatePropagation() {} }); },
    };
    Object.defineProperty(e, 'id', { get: () => id, set: value => { id = value; elements.set(value, e); } });
    Object.defineProperty(e, 'innerHTML', { set: html => { for (const match of html.matchAll(/id="([^"]+)"/g)) { const child = element(); child.id = match[1]; } } });
    return e;
  }
  const ui: any = {};
  const sandbox = {
    UI: ui, TextEncoder, AbortController,
    document: {
      querySelector: () => ({ dataset: { profileId: 'cf_11111111-1111-4111-8111-111111111111', sessionId: 'manual_22222222-2222-4222-8222-222222222222', version: '1' } }),
      documentElement: { dataset }, head: element(), body: element(), createElement: element,
      getElementById: (id: string) => elements.get(id), execCommand: (command: string) => { assert.equal(command, 'copy'); copies++; return true; },
    },
    navigator: {},
    window: { isSecureContext: false, addEventListener: (name: string, fn: () => void) => pageEvents.set(name, fn) },
    MutationObserver: class { constructor(fn: () => void) { observers.push(fn); } observe() {} },
    fetch: async (path: string, init: any) => {
      requests.push({ path, init });
      if (path === '/api/v1/session') return { ok: true, json: async () => ({ data: { csrfToken: 'fixture-csrf' } }) };
      const body = JSON.parse(init.body);
      if (body.action === 'write') remote = body.text;
      return { ok: true, json: async () => ({ data: body.action === 'read' ? { text: remote } : { written: true } }) };
    },
  };
  runInNewContext(desktopClipboardModule.replace("import UI from './app/ui.js';", ''), sandbox);
  return { elements, ui, requests, pageEvents, dataset, observers, getCopies: () => copies };
}

test('clipboard panel uses explicit authenticated actions, supports HTTP copy fallback and clears text on close/disconnect', async () => {
  const h = panelHarness();
  assert.equal(h.requests.length, 0, 'no clipboard reads on initial load');
  await h.elements.get('fleet_clipboard_button').click();
  const text = h.elements.get('fleet_clipboard_text'); text.value = contents;
  await h.elements.get('fleet_clipboard_send').click();
  const write = h.requests.find(request => request.path.endsWith('/clipboard'))!;
  assert.equal(write.init.cache, 'no-store'); assert.equal(write.init.headers['X-CSRF-Token'], 'fixture-csrf');
  assert.equal(JSON.parse(write.init.body).text, contents);
  assert.match(h.elements.get('fleet_clipboard_status').textContent, /远程窗口按 Ctrl\+V/);
  text.value = '';
  await h.elements.get('fleet_clipboard_read').click(); assert.equal(text.value, contents);
  await h.elements.get('fleet_clipboard_copy').click(); assert.equal(h.getCopies(), 1); assert.equal(text.selected, true);
  const before = h.requests.length;
  h.ui.clipboardReceive({ detail: { text: 'must-not-store-untrusted-RFB-payload' } });
  assert.equal(text.value, contents); assert.equal(h.requests.length, before);
  await h.elements.get('fleet_clipboard_close').click(); assert.equal(text.value, '');
  await h.elements.get('fleet_clipboard_button').click(); text.value = contents;
  h.dataset.fleetDesktopState = 'disconnected'; h.observers[0](); assert.equal(text.value, '');
  assert.equal(h.elements.get('fleet_clipboard_send').disabled, true);
  h.pageEvents.get('pagehide')!(); assert.equal(text.value, '');
});
