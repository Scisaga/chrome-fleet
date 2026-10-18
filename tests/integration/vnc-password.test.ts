import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, fixtureToken } from './helpers/fleet.js';

const revealPath = (id: string) => `/api/v1/profiles/${id}/remote-desktop/password/reveal`;
const expiresAt = () => new Date(Date.now() + 60_000).toISOString();

test('authorized reveal reads generated and custom passwords without starting a stopped browser or exposing ordinary API secrets', async () => {
  const f = await fixture();
  try {
    const created = await f.request('POST', '/api/v1/profiles', { name: '生成密码' });
    assert.equal(created.statusCode, 201);
    const generated = created.json().data;
    const custom = await f.create('自设密码');
    const reader = f.auth.issue(['read'], ['*'], expiresAt());
    for (const [profile, expected] of [[generated, generated.oncePassword], [custom, 'fixture1']] as const) {
      const stored = f.service.profile(profile.id);
      const originalRef = stored.vncSecretRef;
      const originalActivity = stored.lastActivityAt;
      const response = await f.request('POST', revealPath(profile.id), {});
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().data, { password: expected, version: 1 });
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(f.service.profile(profile.id).state, 'stopped');
      assert.equal(f.service.profile(profile.id).vncSecretRef, originalRef);
      assert.equal(f.service.profile(profile.id).lastActivityAt, originalActivity);
      assert.equal(f.starts.size, 0);
      const encrypted = await readFile(join(f.root, 'vault', originalRef!));
      assert.equal(encrypted.includes(Buffer.from(expected)), false);
      for (const path of ['/api/v1/profiles', `/api/v1/profiles/${profile.id}`, `/api/v1/profiles/${profile.id}/remote-desktop`]) {
        const ordinary = await f.request('GET', path, undefined, reader.token);
        assert.equal(ordinary.statusCode, 200, ordinary.body);
        assert.equal(ordinary.body.includes(expected), false);
        assert.equal(ordinary.body.includes(originalRef!), false);
        assert.equal(ordinary.body.includes('vncSecretRef'), false);
      }
    }
    assert.equal(f.service.db.list<any>('audit').filter(event => event.action === 'vnc_password_reveal').length, 2);
  } finally { await f.close(); }
});

test('reveal enforces credentials, manage scope, profile boundaries and Web CSRF on every request', async () => {
  const f = await fixture();
  try {
    const a = await f.create('允许');
    const b = await f.create('禁止跨实例');
    const reader = f.auth.issue(['read'], [a.id], expiresAt());
    const manager = f.auth.issue(['manage'], [a.id], expiresAt());
    assert.equal((await f.request('POST', revealPath(a.id), {}, '')).statusCode, 401);
    const noScope = await f.request('POST', revealPath(a.id), {}, reader.token);
    assert.equal(noScope.statusCode, 403); assert.equal(noScope.json().code, 'SCOPE_DENIED');
    const crossProfile = await f.request('POST', revealPath(b.id), {}, manager.token);
    assert.equal(crossProfile.statusCode, 403); assert.equal(crossProfile.json().code, 'PROFILE_DENIED');
    assert.equal(f.service.db.list<any>('audit').filter(event => event.action === 'vnc_password_reveal').length, 0);
    const login = await f.request('POST', '/api/v1/session', { token: manager.token }, '');
    const cookie = login.cookies.find(cookie => cookie.name === 'fleet_session'); assert.ok(cookie);
    const headers = { cookie: `fleet_session=${cookie.value}`, origin: 'http://127.0.0.1:8080' };
    for (const csrf of [{}, { 'x-csrf-token': 'wrong-token' }]) {
      const denied = await f.request('POST', revealPath(a.id), {}, '', { ...headers, ...csrf });
      assert.equal(denied.statusCode, 403); assert.equal(denied.json().code, 'CSRF_REJECTED');
    }
    const validHeaders = { ...headers, 'x-csrf-token': login.json().data.csrfToken, 'idempotency-key': 'fixture-web-reveal' };
    assert.equal((await f.request('POST', revealPath(a.id), {}, '', validHeaders)).statusCode, 200);
    assert.equal((await f.request('POST', revealPath(b.id), {}, '', validHeaders)).statusCode, 403);
    assert.equal((await f.request('DELETE', `/api/v1/credentials/${manager.id}`)).statusCode, 200);
    assert.equal((await f.request('POST', revealPath(a.id), {}, '', validHeaders)).statusCode, 401);
    assert.equal(f.starts.size, 0);
  } finally { await f.close(); }
});

test('reusing a reveal key reads the rotated password, audits each view and persists no plaintext response', async () => {
  const f = await fixture();
  try {
    const profile = await f.create();
    const manager = f.auth.issue(['manage'], [profile.id], expiresAt());
    const headers = { 'idempotency-key': 'fixture-reveal-repeat' };
    const first = await f.request('POST', revealPath(profile.id), {}, manager.token, headers);
    assert.deepEqual(first.json().data, { password: 'fixture1', version: 1 });
    const rotated = await f.request('PUT', `/api/v1/profiles/${profile.id}/remote-desktop/password`, { password: 'newPass2' });
    assert.equal(rotated.statusCode, 200, rotated.body);
    const second = await f.request('POST', revealPath(profile.id), {}, manager.token, headers);
    assert.deepEqual(second.json().data, { password: 'newPass2', version: 2 });
    const third = await f.request('POST', revealPath(profile.id), { idempotencyKey: 'fixture-reveal-body-key' }, manager.token);
    assert.deepEqual(third.json().data, second.json().data);
    const events = f.service.db.list<any>('audit').filter(event => event.action === 'vnc_password_reveal');
    assert.equal(events.length, 3);
    for (const event of events) {
      assert.equal(event.principal, manager.id);
      assert.equal(event.profileId, profile.id);
      assert.equal(event.result, 'succeeded');
      assert.equal(event.reason, undefined);
    }
    const records = JSON.stringify(f.service.db.db.prepare('SELECT value FROM records').all());
    for (const password of ['fixture1', 'newPass2']) assert.equal(records.includes(password), false);
    const cache = f.service.db.db.prepare('SELECT response FROM idempotency').all();
    assert.equal(cache.length, 0, '查看响应不缓存到SQLite，即使客户端携带幂等键');
    assert.equal(f.starts.size, 0);
  } finally { await f.close(); }
});

test('purged, missing, corrupted and invalid secret records fail clearly without a cached disclosure or ref override', async () => {
  const f = await fixture();
  try {
    const profile = await f.create();
    const path = revealPath(profile.id);
    const headers = { 'idempotency-key': 'fixture-purge-reveal' };
    assert.equal((await f.request('POST', path, {}, fixtureToken, headers)).statusCode, 200);
    const override = await f.request('POST', path, { secretRef: f.service.profile(profile.id).vncSecretRef });
    assert.equal(override.statusCode, 400); assert.equal(override.json().code, 'INVALID_REQUEST');
    const stored = f.service.profile(profile.id);
    stored.purgedAt = new Date().toISOString(); f.service.saveProfile(stored);
    const purged = await f.request('POST', path, {}, fixtureToken, headers);
    assert.equal(purged.statusCode, 410); assert.equal(purged.json().code, 'PROFILE_PURGED');
    delete stored.purgedAt; const ref = stored.vncSecretRef!;
    delete stored.vncSecretRef; f.service.saveProfile(stored);
    const missingRef = await f.request('POST', path, {});
    assert.equal(missingRef.statusCode, 409); assert.equal(missingRef.json().code, 'VNC_PASSWORD_UNAVAILABLE');
    stored.vncSecretRef = ref; f.service.saveProfile(stored);
    await rm(join(f.root, 'vault', ref));
    assert.equal((await f.request('POST', path, {})).json().code, 'VNC_PASSWORD_UNAVAILABLE');
    await writeFile(join(f.root, 'vault', ref), 'fixture-corrupted-ciphertext');
    assert.equal((await f.request('POST', path, {})).json().code, 'VNC_PASSWORD_UNAVAILABLE');
    f.service.vault.put({ password: 'not-a-valid-string' }, ref);
    const invalid = await f.request('POST', path, {});
    assert.equal(invalid.statusCode, 409); assert.equal(invalid.json().code, 'VNC_PASSWORD_UNAVAILABLE');
    assert.equal(invalid.body.includes(ref), false);
    const failures = f.service.db.list<any>('audit').filter(event => event.action === 'vnc_password_reveal' && event.result === 'failed');
    assert.equal(failures.length, 5);
    assert.equal(f.starts.size, 0);
  } finally { await f.close(); }
});
