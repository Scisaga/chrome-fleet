import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, symlink, rename, mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createAuthSite } from '../fixtures/auth-site.js';
import { fixture, fixtureToken, eventually } from './helpers/fleet.js';

test('REST requires credentials, enforces scopes/profile boundaries and strips persisted secrets', async () => {
  const f = await fixture();
  try {
    const a = await f.create('A'); const b = await f.create('B');
    assert.equal((await f.request('GET', '/api/v1/profiles', undefined, '')).statusCode, 401);
    const reader = f.auth.issue(['read'], [a.id], new Date(Date.now() + 60_000).toISOString());
    const list = await f.request('GET', '/api/v1/profiles', undefined, reader.token); assert.equal(list.json().data.total, 1);
    assert.equal((await f.request('GET', `/api/v1/profiles/${b.id}`, undefined, reader.token)).statusCode, 403);
    assert.equal((await f.request('POST', `/api/v1/profiles/${a.id}/start`, {}, reader.token)).statusCode, 403);
    const detail = await f.request('GET', `/api/v1/profiles/${a.id}`); assert.equal(detail.body.includes('fixture1'), false);
    assert.equal(detail.body.includes('agentTokenRef'), false); assert.equal(detail.body.includes('keyringSecretRef'), false);
    const badOrigin = await f.request('GET', '/api/v1/profiles', undefined, fixtureToken, { origin: 'https://evil.invalid' }); assert.equal(badOrigin.statusCode, 403);
    const badHost = await f.request('GET', '/api/v1/profiles', undefined, fixtureToken, { host: 'evil.invalid' }); assert.equal(badHost.statusCode, 403);
  } finally { await f.close(); }
});
test('Idempotency-Key deduplicates profile creation, conflicts on new contents and scopes keys to identity', async () => {
  const f = await fixture();
  try {
    const body = { name: '幂等浏览器', vncPassword: 'fixture1' }; const headers = { 'idempotency-key': 'fixture-profile-create' };
    const first = await f.request('POST', '/api/v1/profiles', body, fixtureToken, headers);
    const second = await f.request('POST', '/api/v1/profiles', body, fixtureToken, headers);
    assert.equal(first.statusCode, 201); assert.equal(second.json().data.id, first.json().data.id);
    assert.equal(f.service.db.list('profiles').length, 1);
    const conflict = await f.request('POST', '/api/v1/profiles', { ...body, name: '另一个请求' }, fixtureToken, headers);
    assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().code, 'IDEMPOTENCY_CONFLICT');
    const another = f.auth.issue(['manage'], ['*'], new Date(Date.now() + 60_000).toISOString());
    const third = await f.request('POST', '/api/v1/profiles', body, another.token, headers); assert.equal(third.statusCode, 201); assert.notEqual(third.json().data.id, first.json().data.id);
  } finally { await f.close(); }
});
test('same-profile queue is serial, different profiles execute in parallel and starts are coalesced', async () => {
  const f = await fixture();
  try {
    const a = await f.create('A'); const b = await f.create('B'); f.setExecuteDelay(80);
    await Promise.all([f.service.ensureStart(a.id, true), f.service.ensureStart(a.id, true), f.service.ensureStart(a.id, true)]);
    assert.equal(f.starts.get(a.id), 1, '并发唤起应合并为一次Runner启动');
    const jobs = [a.id, a.id, b.id].map(pid => f.service.submit('automation', pid, { steps: [{ action: 'pages' }], timeoutMs: 1000 }, 'bootstrap'));
    await f.service.tick();
    await eventually(() => f.service.active.size === 0, '首批任务未结束');
    assert.equal(f.service.job(jobs[1].id).status, 'queued'); assert.equal(f.getMaxTotalExecuting(), 2);
    await f.service.tick(); await eventually(() => f.service.active.size === 0, '后续任务未结束');
    assert.ok(jobs.every(job => f.service.job(job.id).status === 'succeeded'));
    assert.equal(f.maxExecuting.get(a.id), 1); assert.equal(f.starts.get(a.id), 1); assert.equal(f.starts.get(b.id), 1);
  } finally { await f.close(); }
});
test('manual lease prevents automation until explicitly closed; manual policy prevents background wake', async () => {
  const f = await fixture();
  try {
    const p = await f.create();
    const opened = await f.request('POST', `/api/v1/profiles/${p.id}/manual-sessions`, { durationSeconds: 60 }); assert.equal(opened.statusCode, 201, opened.body);
    const job = f.service.submit('automation', p.id, { steps: [{ action: 'pages' }], timeoutMs: 1000 }, 'bootstrap');
    await f.service.tick(); assert.equal(f.service.job(job.id).status, 'queued'); assert.equal(f.executing.get(p.id), undefined);
    const closed = await f.request('DELETE', `/api/v1/manual-sessions/${opened.json().data.id}`); assert.equal(closed.statusCode, 200);
    await f.service.tick(); await eventually(() => f.service.active.size === 0, '接管结束后任务未结束'); assert.equal(f.service.job(job.id).status, 'succeeded');
    await f.service.stop(p.id, true); const blocked = f.service.submit('automation', p.id, { steps: [{ action: 'pages' }], timeoutMs: 1000 }, 'bootstrap');
    await f.service.tick(); await eventually(() => f.service.active.size === 0, '停止策略任务未结束');
    assert.equal(f.service.job(blocked.id).status, 'failed'); assert.equal((f.service.job(blocked.id).error as { code: string }).code, 'PROFILE_STOPPED');
  } finally { await f.close(); }
});
test('restart reconciliation records outcome_unknown and never replays in-flight actions', async () => {
  const f = await fixture();
  try {
    const p = await f.create(); const job = f.service.submit('automation', p.id, { steps: [{ action: 'click', locator: { css: '#submit' } }], timeoutMs: 1000 }, 'bootstrap');
    const token = f.service.db.acquire(p.id, job.id)!; job.status = 'running'; job.fencingToken = token; job.inFlightStep = 0; f.service.db.set('jobs', job.id, job);
    f.states.set(p.id, 'running');
    await f.service.reconcile(); const recovered = f.service.job(job.id);
    assert.equal(recovered.status, 'outcome_unknown'); assert.equal(f.states.get(p.id), 'stopped');
    await f.service.tick(); assert.equal(f.executing.get(p.id), undefined); assert.equal(f.service.db.lease(p.id).owner, null);
  } finally { await f.close(); }
});
test('artifacts encrypt at rest and require both profile permission and export scope on download', async () => {
  const f = await fixture();
  try {
    const a = await f.create('A'); const b = await f.create('B'); const plain = Buffer.from('{"cookies":[{"value":"fixture-cookie-secret"}]}');
    const meta = await f.service.artifact(a.id, 'cookies', plain, 'application/json');
    const encrypted = await readFile(join(f.root, 'artifacts', meta.id)); assert.equal(encrypted.includes(plain), false); assert.equal(encrypted.subarray(0, 4).toString(), 'CF01');
    assert.deepEqual(f.service.readArtifact(meta.id).data, plain);
    const readOnly = f.auth.issue(['read'], [a.id], new Date(Date.now() + 60_000).toISOString());
    assert.equal((await f.request('GET', `/api/v1/artifacts/${meta.id}/download`, undefined, readOnly.token)).statusCode, 403);
    const wrongProfile = f.auth.issue(['read', 'session:read'], [b.id], new Date(Date.now() + 60_000).toISOString());
    assert.equal((await f.request('GET', `/api/v1/artifacts/${meta.id}`, undefined, wrongProfile.token)).statusCode, 403);
    const allowed = f.auth.issue(['read', 'session:read'], [a.id], new Date(Date.now() + 60_000).toISOString());
    const downloaded = await f.request('GET', `/api/v1/artifacts/${meta.id}/download`, undefined, allowed.token); assert.equal(downloaded.statusCode, 200); assert.equal(downloaded.body, plain.toString());
  } finally { await f.close(); }
});
test('snapshot restores matching profile, keyring and image; unsafe symlinks are rejected', async () => {
  const f = await fixture();
  try {
    const p = await f.create(); const state = join(f.root, 'profiles', p.id, 'state');
    await writeFile(join(state, 'chrome', 'fixture-state'), 'before-upgrade'); await writeFile(join(state, 'keyrings', 'fixture.keyring'), 'synthetic-keyring');
    const original = f.service.profile(p.id); original.chromeVersion = '143.0.7499.40'; original.image = 'chrome-fleet/browser:old'; f.service.saveProfile(original);
    const token = f.service.db.acquire(p.id, 'fixture-snapshot')!;
    const snapshot = await f.service.snapshot(p.id, token); f.service.db.release(p.id, 'fixture-snapshot', token);
    await writeFile(join(state, 'chrome', 'fixture-state'), 'after-upgrade');
    const newer = f.service.profile(p.id); newer.image = 'chrome-fleet/browser:new'; newer.chromeVersion = '144.0.0.0'; f.service.saveProfile(newer);
    await f.service.restore(p.id, snapshot.id);
    assert.equal(await readFile(join(state, 'chrome', 'fixture-state'), 'utf8'), 'before-upgrade');
    assert.equal(await readFile(join(state, 'keyrings', 'fixture.keyring'), 'utf8'), 'synthetic-keyring');
    assert.equal(f.service.profile(p.id).image, 'chrome-fleet/browser:old'); assert.equal(f.service.profile(p.id).chromeVersion, '143.0.7499.40');
    const other = await f.create(); await assert.rejects(() => f.service.restore(other.id, snapshot.id), (e: any) => e.code === 'SNAPSHOT_NOT_FOUND');
    await symlink('/etc/passwd', join(state, 'chrome', 'unsafe-link'));
    await assert.rejects(() => f.service.snapshot(p.id, 100), (e: any) => e.code === 'UNSAFE_SNAPSHOT');
  } finally { await f.close(); }
});
test('controlled auth site supports server revocation, durable/session cookies and committed disconnect counter', async () => {
  const { server } = createAuthSite(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
  try {
    const login = await fetch(`${base}/login?identity=alice@example.test`, { method: 'POST' }); const cookies = login.headers.getSetCookie();
    assert.ok(cookies[0].includes('HttpOnly')); assert.ok(cookies[0].includes('Max-Age=86400')); assert.equal(cookies[1].includes('Max-Age'), false);
    const header = { cookie: cookies.map(c => c.split(';')[0]).join('; ') };
    assert.equal((await (await fetch(`${base}/identity`, { headers: header })).json()).identity, 'alice@example.test');
    await assert.rejects(() => fetch(`${base}/counter?disconnect=true`, { method: 'POST', headers: header }));
    assert.equal((await (await fetch(`${base}/counter`, { headers: header })).json()).count, 1);
    await fetch(`${base}/revoke?identity=alice@example.test`, { method: 'POST' }); assert.equal((await fetch(`${base}/identity`, { headers: header })).status, 401);
    const page = await (await fetch(`${base}/app`)).text(); assert.ok(page.includes('indexedDB.open')); assert.ok(page.includes('localStorage.setItem'));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('Web sessions require CSRF, credential revocation applies to existing sessions', async () => {
  const f = await fixture();
  try {
    const credential = f.auth.issue(['read', 'manage'], ['*'], new Date(Date.now() + 60_000).toISOString());
    const login = await f.request('POST', '/api/v1/session', { token: credential.token }, ''); assert.equal(login.statusCode, 200);
    const cookie = login.cookies.find(cookie => cookie.name === 'fleet_session'); assert.ok(cookie);
    const headers = { host: '127.0.0.1:8080', cookie: `fleet_session=${cookie.value}` };
    const blocked = await f.app.inject({ method: 'POST', url: '/api/v1/profiles', headers, payload: { name: '缺CSRF' } }); assert.equal(blocked.statusCode, 403); assert.equal(blocked.json().code, 'CSRF_REJECTED');
    const allowed = await f.app.inject({ method: 'POST', url: '/api/v1/profiles', headers: { ...headers, 'x-csrf-token': login.json().data.csrfToken }, payload: { name: '有效会话' } }); assert.equal(allowed.statusCode, 201);
    const revoked = await f.request('DELETE', `/api/v1/credentials/${credential.id}`); assert.equal(revoked.statusCode, 200);
    const after = await f.app.inject({ method: 'GET', url: '/api/v1/profiles', headers }); assert.equal(after.statusCode, 401);
  } finally { await f.close(); }
});
test('HTTP MCP shares REST scopes/profile restrictions and validates initialization credentials', async () => {
  const f = await fixture();
  try {
    const p = await f.create(); const other = await f.create();
    const credential = f.auth.issue(['read'], [p.id], new Date(Date.now() + 60_000).toISOString());
    const headers = { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' };
    const initialized = await f.request('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture-control', version: '1' } } }, credential.token, headers);
    assert.equal(initialized.statusCode, 200, initialized.body); assert.equal(initialized.json().result.protocolVersion, '2025-11-25');
    const denied = await f.request('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'profiles_get', arguments: { profileId: other.id } } }, credential.token, headers);
    assert.equal(denied.statusCode, 200); assert.equal(denied.json().result.isError, true); assert.equal(denied.json().result.structuredContent.error.code, 'PROFILE_DENIED');
    const cannotStart = await f.request('POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'profiles_start', arguments: { profileId: p.id } } }, credential.token, headers);
    assert.equal(cannotStart.json().result.structuredContent.error.code, 'SCOPE_DENIED');
    const invalid = await f.request('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }, 'invalid-fixture', headers); assert.equal(invalid.statusCode, 401);
  } finally { await f.close(); }
});
test('idempotent one-time secrets are not persisted as plaintext in SQLite response records', async () => {
  const f = await fixture();
  try {
    const created = await f.request('POST', '/api/v1/profiles', { name: '一次性密码保密' }, fixtureToken, { 'idempotency-key': 'fixture-once-secret' }); assert.equal(created.statusCode, 201);
    const oncePassword = created.json().data.oncePassword; assert.equal(typeof oncePassword, 'string');
    const rows = f.service.db.db.prepare('SELECT response FROM idempotency').all() as { response: string }[];
    assert.ok(rows.every(row => !row.response.includes(oncePassword)), '幂等响应不能明文持久化VNC一次性密码');
    const replay = await f.request('POST', '/api/v1/profiles', { name: '一次性密码保密' }, fixtureToken, { 'idempotency-key': 'fixture-once-secret' }); assert.equal(replay.statusCode, 201); assert.equal(replay.json().data.id, created.json().data.id);
  } finally { await f.close(); }
});
test('archive retains addressable session data, unarchive stays stopped and purge affects only target', async () => {
  const f = await fixture();
  try {
    const a = await f.create('归档A'); const b = await f.create('保留B');
    const markerA = join(f.root, 'profiles', a.id, 'state', 'chrome', 'preserved'); const markerB = join(f.root, 'profiles', b.id, 'state', 'chrome', 'preserved');
    await writeFile(markerA, 'session-A'); await writeFile(markerB, 'session-B');
    const archived = await f.request('DELETE', `/api/v1/profiles/${a.id}`); assert.equal(archived.statusCode, 202);
    await f.service.tick(); await eventually(() => f.service.active.size === 0, '归档任务未结束');
    const read = await f.request('GET', `/api/v1/profiles/${a.id}`); assert.equal(read.statusCode, 200); assert.equal(read.json().data.archived, true); assert.equal(await readFile(markerA, 'utf8'), 'session-A');
    const restored = await f.request('POST', `/api/v1/profiles/${a.id}/unarchive`, {}); assert.equal(restored.statusCode, 200); assert.equal(restored.json().data.state, 'stopped'); assert.equal(await readFile(markerA, 'utf8'), 'session-A');
    assert.equal((await f.request('POST', `/api/v1/profiles/${a.id}/purge`, { confirmation: a.id })).statusCode, 409);
    const second = await f.request('DELETE', `/api/v1/profiles/${a.id}`); assert.equal(second.statusCode, 202); await f.service.tick(); await eventually(() => f.service.active.size === 0, '再次归档未结束');
    assert.equal((await f.request('POST', `/api/v1/profiles/${a.id}/purge`, { confirmation: b.id })).statusCode, 400);
    const purged = await f.request('POST', `/api/v1/profiles/${a.id}/purge`, { confirmation: a.id }); assert.equal(purged.statusCode, 200); assert.ok(purged.json().data.purgedAt);
    await assert.rejects(() => readFile(markerA)); assert.equal(await readFile(markerB, 'utf8'), 'session-B');
  } finally { await f.close(); }
});
test('interrupted directory restore journal recovers the pre-operation state before reconciliation', async () => {
  const f = await fixture();
  try {
    const p = await f.create(); const base = join(f.root, 'profiles', p.id); const state = join(base, 'state');
    await writeFile(join(state, 'chrome', 'fixture-state'), 'before-interrupted-restore');
    await writeFile(join(state, 'keyrings', 'fixture-keyring'), 'original-keyring');
    await rename(state, `${state}.previous`); await mkdir(state); await mkdir(join(state, 'chrome')); await mkdir(join(state, 'keyrings'));
    await writeFile(join(state, 'chrome', 'fixture-state'), 'partially-installed-snapshot'); await mkdir(join(base, 'restore-staging'));
    f.service.db.set('restore-journals', p.id, { profileId: p.id, snapshotId: 'snapshot_interrupted_fixture', createdAt: new Date().toISOString() });
    await f.service.reconcile();
    assert.equal(await readFile(join(state, 'chrome', 'fixture-state'), 'utf8'), 'before-interrupted-restore');
    assert.equal(await readFile(join(state, 'keyrings', 'fixture-keyring'), 'utf8'), 'original-keyring');
    assert.equal(f.service.db.get('restore-journals', p.id), undefined); assert.equal(f.service.profile(p.id).state, 'stopped');
    await assert.rejects(() => access(`${state}.previous`)); await assert.rejects(() => access(join(base, 'restore-staging')));
  } finally { await f.close(); }
});
test('missing persistent keyring directory blocks startup instead of silently creating a blank session', async () => {
  const f = await fixture();
  try {
    const p = await f.create(); const keyrings = join(f.root, 'profiles', p.id, 'state', 'keyrings'); await rm(keyrings, { recursive: true });
    await assert.rejects(() => f.service.ensureStart(p.id, true), (error: any) => error.code === 'SESSION_DATA_MISSING');
    assert.equal(f.startImages.length, 0); await assert.rejects(() => access(keyrings));
    assert.equal(f.service.profile(p.id).state, 'error');
  } finally { await f.close(); }
});
