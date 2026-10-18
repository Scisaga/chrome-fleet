import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FleetService } from '../../apps/control-plane/src/service.js';
import { fixture, fixtureToken } from './helpers/fleet.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const expires = () => new Date(Date.now() + 60_000).toISOString();
async function setup(f: Fixture) {
  const path = join(f.root, 'binding-fixture.tsv');
  await writeFile(path, 'first@example.test\tsynthetic-first-password\trecovery@example.test\nsecond@example.test\tsynthetic-second-password\trecovery@example.test');
  f.service.google.importFile(path);
  const response = await f.request('POST', '/api/v1/profiles', { name: '绑定合成实例', vncPassword: 'fixture1' });
  assert.equal(response.statusCode, 201);
  return { profile: response.json().data, accounts: f.service.google.list() };
}
const bindingPath = (pid: string) => `/api/v1/profiles/${pid}/google-binding`;
const confirmPath = (pid: string) => `/api/v1/profiles/${pid}/google-login/confirm`;
async function bind(f: Fixture, pid: string, accountId: string, token = fixtureToken) {
  const response = await f.request('PUT', bindingPath(pid), { accountId }, token);
  assert.equal(response.statusCode, 200, response.body); return response.json().data;
}

test('VNC binding stays metadata while confirmation persists one takeover job without inline browser access', async () => {
  const f = await fixture();
  try {
    const { profile, accounts } = await setup(f); const selected = accounts[0];
    f.service.agent = async () => { throw new Error('metadata must not call browser'); };
    f.service.ensureStart = async () => { throw new Error('metadata must not start Chrome'); };
    f.service.vault.get = () => { throw new Error('metadata must not decrypt Vault'); };
    const mapped = await bind(f, profile.id, selected.id);
    assert.deepEqual(mapped, { accountId: selected.id, email: selected.email, confirmationState: 'unconfirmed' });
    assert.equal(f.service.profile(profile.id).state, 'stopped');
    assert.equal(f.service.db.list('manual-sessions').length, 0); assert.equal(f.starts.size, 0);
    const confirmed = await f.request('POST', confirmPath(profile.id), { accountId: selected.id });
    assert.equal(confirmed.statusCode, 200); assert.equal(confirmed.json().data.verificationSource, 'manual_confirmation');
    assert.ok(confirmed.json().data.takeoverJobId);
    assert.equal(f.service.db.get<any>('jobs', confirmed.json().data.takeoverJobId).kind, 'browser_mode');
    const state = (await f.request('POST', `/api/v1/profiles/${profile.id}/google-login/check`, {})).json().data;
    assert.equal(state.status, 'bound'); assert.equal(state.lastConfirmedAt, confirmed.json().data.lastConfirmedAt);
    const visible = (await f.request('GET', `/api/v1/profiles/${profile.id}`)).json().data;
    assert.equal(visible.googleBinding.confirmationState, 'confirmed'); assert.equal(visible.googleBinding.lastConfirmedAt, state.lastConfirmedAt);
    const record = f.service.db.list<any>('accounts')[0];
    assert.equal(record.authState, 'manually_confirmed'); assert.equal(record.confirmedBy, 'bootstrap'); assert.equal(record.lastCheckedAt, null);
    const audit = f.service.db.list<any>('audit').find(event => event.action === 'google_account_manual_confirmation');
    assert.equal(audit.principal, 'bootstrap'); assert.equal(audit.profileId, profile.id);
    assert.equal(JSON.stringify([visible, audit]).includes('synthetic-first-password'), false);
    const restarted = new FleetService(f.config);
    try {
      restarted.vault.get = () => { throw new Error('metadata restart must not decrypt Vault'); };
      await restarted.reconcile();
      assert.deepEqual(restarted.publicProfile(restarted.profile(profile.id)).googleBinding, visible.googleBinding);
      assert.equal(restarted.profile(profile.id).state, 'stopped');
    } finally { restarted.close(); }
  } finally { await f.close(); }
});

test('same-account binding preserves confirmation, while explicit replacement clears it and leaves one Google mapping', async () => {
  const f = await fixture();
  try {
    const { profile, accounts: [first, second] } = await setup(f);
    await bind(f, profile.id, first.id);
    const confirmed = (await f.request('POST', confirmPath(profile.id), { accountId: first.id })).json().data;
    const recordId = f.service.db.list<any>('accounts')[0].id;
    const repeat = await bind(f, profile.id, first.id);
    assert.equal(repeat.confirmationState, 'confirmed'); assert.equal(repeat.lastConfirmedAt, confirmed.lastConfirmedAt);
    const replaced = await bind(f, profile.id, second.id);
    assert.deepEqual(replaced, { accountId: second.id, email: second.email, confirmationState: 'unconfirmed' });
    const rows = f.service.db.list<any>('accounts'); assert.equal(rows.length, 1); assert.equal(rows[0].id, recordId);
    assert.equal(rows[0].authState, 'unknown'); assert.equal(rows[0].lastConfirmedAt, undefined); assert.equal(rows[0].confirmedBy, undefined);
    assert.equal((await f.request('POST', confirmPath(profile.id), { accountId: first.id })).json().code, 'ACCOUNT_MISMATCH');
    assert.equal((await f.request('POST', confirmPath(profile.id), { accountId: second.id })).statusCode, 200);
  } finally { await f.close(); }
});

test('legacy unique catalog-matching records derive an unconfirmed binding and ambiguous records require explicit selection', async () => {
  const f = await fixture();
  try {
    const { profile, accounts: [first, second] } = await setup(f);
    f.service.db.set('accounts', 'account_legacy', { id: 'account_legacy', profileId: profile.id, provider: 'google', expectedIdentity: first.email.toUpperCase(), authState: 'authenticated', bindingSource: 'google_signed_in_identity', lastCheckedAt: '2026-01-01T00:00:00Z' });
    const previous = JSON.stringify(f.service.db.list('accounts'));
    assert.deepEqual(f.service.publicProfile(f.service.profile(profile.id)).googleBinding, { accountId: first.id, email: first.email, confirmationState: 'unconfirmed' });
    assert.equal(JSON.stringify(f.service.db.list('accounts')), previous, 'derivation must be read-only');
    f.service.db.set('accounts', 'account_other', { id: 'account_other', profileId: profile.id, provider: 'google', expectedIdentity: second.email });
    assert.equal(f.service.publicProfile(f.service.profile(profile.id)).googleBinding, undefined);
    assert.equal((await f.request('POST', `/api/v1/profiles/${profile.id}/google-login`, {})).json().code, 'GOOGLE_BINDING_REQUIRED');
    assert.equal(f.starts.size, 0);
    await bind(f, profile.id, second.id);
    assert.equal(f.service.db.list<any>('accounts').filter(account => account.profileId === profile.id && account.provider === 'google').length, 1);
    assert.equal(f.service.google.binding(profile.id)?.accountId, second.id);
  } finally { await f.close(); }
});

test('directory binding and confirmation enforce admin/profile scopes, Web CSRF, catalog identity and VNC boundaries', async () => {
  const f = await fixture();
  try {
    const { profile, accounts: [first] } = await setup(f);
    await bind(f, profile.id, first.id);
    for (const scopes of [['manage'], ['automate'], ['manage','automate']]) {
      const limited = f.auth.issue(scopes, [profile.id], expires());
      assert.equal((await f.request('PUT', bindingPath(profile.id), { accountId: first.id }, limited.token)).statusCode, 403);
      assert.equal((await f.request('POST', confirmPath(profile.id), { accountId: first.id }, limited.token)).statusCode, 403);
    }
    const outside = f.auth.issue(['admin'], ['cf_00000000-0000-4000-8000-000000000000'], expires());
    assert.equal((await f.request('PUT', bindingPath(profile.id), { accountId: first.id }, outside.token)).json().code, 'PROFILE_DENIED');
    const login = await f.request('POST', '/api/v1/session', { token: fixtureToken }, '');
    const cookie = login.cookies.find(value => value.name === 'fleet_session')!;
    const headers = { cookie: `fleet_session=${cookie.value}`, origin: 'http://127.0.0.1:8080' };
    for (const [method,path] of [['PUT',bindingPath(profile.id)],['POST',confirmPath(profile.id)]]) {
      assert.equal((await f.request(method,path,{accountId:first.id},'',headers)).json().code,'CSRF_REJECTED');
      assert.equal((await f.request(method,path,{accountId:first.id},'',{...headers,'x-csrf-token':'wrong'})).json().code,'CSRF_REJECTED');
    }
    const valid = { ...headers, 'x-csrf-token': login.json().data.csrfToken };
    assert.equal((await f.request('POST', confirmPath(profile.id), { accountId: first.id }, '', valid)).statusCode, 200);
    assert.equal((await f.request('PUT', bindingPath(profile.id), { accountId: 'google_'+'0'.repeat(24) })).statusCode, 404);
    assert.equal((await f.request('PUT', bindingPath(profile.id), { accountId: first.id, email: 'arbitrary@example.test' })).statusCode, 400);
    const automation = await f.create();
    assert.equal((await f.request('PUT', bindingPath(automation.id), { accountId: first.id })).json().code, 'BROWSER_MODE_REQUIRED');
    const revoked = f.auth.issue(['admin'], [profile.id], expires());
    const record = f.service.db.get<any>('credentials', revoked.id); record.revoked = true; f.service.db.set('credentials', record.id, record);
    assert.equal((await f.request('POST', confirmPath(profile.id), { accountId: first.id }, revoked.token)).statusCode, 401);
  } finally { await f.close(); }
});

test('VNC Google entry uses its binding and confirmation releases the owning session for takeover', async () => {
  const f = await fixture();
  try {
    const { profile, accounts: [first, second] } = await setup(f);
    const openPath = `/api/v1/profiles/${profile.id}/google-login`;
    assert.equal((await f.request('POST', openPath, {})).json().code, 'GOOGLE_BINDING_REQUIRED'); assert.equal(f.starts.size, 0);
    await bind(f, profile.id, first.id);
    assert.equal((await f.request('POST', openPath, { accountId: second.id })).json().code, 'ACCOUNT_MISMATCH'); assert.equal(f.starts.size, 0);
    const opened = await f.request('POST', openPath, {});
    assert.equal(opened.statusCode, 201); const session = opened.json().data;
    assert.equal(session.googleLogin.status, 'waiting');
    assert.equal(f.starts.get(profile.id), 1);
    await bind(f, profile.id, second.id);
    const own = f.service.db.get<any>('manual-sessions', session.id);
    assert.equal(own.googleLogin.expectedAccountId, second.id); assert.equal(own.googleLogin.status, 'waiting'); assert.equal(own.googleLogin.lastConfirmedAt, undefined);
    const otherAdmin = f.auth.issue(['admin'], [profile.id], expires());
    assert.equal((await f.request('POST', confirmPath(profile.id), { accountId: second.id }, otherAdmin.token)).statusCode, 200);
    assert.equal(f.service.db.get<any>('manual-sessions', session.id).closed, true);
    assert.equal(f.service.db.lease(profile.id)?.owner, null);
    assert.equal((await f.request('POST', openPath, {})).json().code, 'PROFILE_BUSY');
    const state = (await f.request('POST', `/api/v1/profiles/${profile.id}/google-login/check`, {})).json().data;
    assert.equal(state.status, 'bound'); assert.equal(state.expectedAccountId, second.id);
    await f.service.revokeDesktop(profile.id);
    assert.equal((await f.request('POST', `/api/v1/profiles/${profile.id}/google-login/check`, {})).json().data.status, 'bound');
  } finally { await f.close(); }
});

test('legacy Google account writes and create accountAlias cannot bypass catalog-only single binding or directory permissions', async () => {
  const f = await fixture();
  try {
    const { profile, accounts: [first, second] } = await setup(f);
    const path = `/api/v1/profiles/${profile.id}/accounts`;
    assert.equal((await f.request('POST', path, { provider: 'google', expectedIdentity: 'not-imported@example.test' })).statusCode, 404);
    const manager = f.auth.issue(['manage'], ['*'], expires());
    assert.equal((await f.request('POST', path, { provider: 'google', expectedIdentity: first.email }, manager.token)).statusCode, 403);
    assert.equal((await f.request('POST', '/api/v1/profiles', { name: 'not authorized', accountAlias: first.email }, manager.token)).statusCode, 403);
    const before = f.service.db.list('profiles').length;
    assert.equal((await f.request('POST', '/api/v1/profiles', { name: 'invalid mapping', accountAlias: 'not-imported@example.test' })).statusCode, 404);
    assert.equal(f.service.db.list('profiles').length, before, 'invalid alias must fail before creating a profile');
    assert.equal((await f.request('POST', path, { provider: 'GOOGLE', expectedIdentity: first.email })).statusCode, 201);
    await f.request('POST', confirmPath(profile.id), { accountId: first.id });
    assert.equal((await f.request('POST', path, { provider: 'google', expectedIdentity: second.email })).statusCode, 201);
    assert.equal(f.service.google.binding(profile.id)?.accountId, second.id); assert.equal(f.service.google.binding(profile.id)?.confirmationState, 'unconfirmed');
    assert.equal(f.service.db.list<any>('accounts').filter(account => account.profileId === profile.id && account.provider === 'google').length, 1);
    const created = await f.request('POST', '/api/v1/profiles', { name: '目录账号创建', accountAlias: first.email });
    assert.equal(created.statusCode, 201); assert.equal(created.json().data.googleBinding.accountId, first.id); assert.equal(created.json().data.googleBinding.confirmationState, 'unconfirmed');
    const compatible = await f.request('POST', '/api/v1/profiles', { name: '旧自动化兼容', browserMode: 'automation', accountAlias: 'arbitrary-existing-alias' });
    assert.equal(compatible.statusCode, 201); assert.equal(compatible.json().data.browserMode, 'automation');
  } finally { await f.close(); }
});

test('purged profiles stay out of every list page and count while unpurged archives remain available', async () => {
  const f = await fixture();
  try {
    const active = await f.create('kept active'); const archived = await f.create('kept archived'); const purged = await f.create('purged-only-match');
    const a = f.service.profile(archived.id); a.archived = true; f.service.saveProfile(a);
    const p = f.service.profile(purged.id); p.archived = true; p.purgedAt = new Date().toISOString(); f.service.saveProfile(p);
    const all = (await f.request('GET','/api/v1/profiles?includeArchived=true')).json().data;
    assert.equal(all.total,2); assert.deepEqual(all.items.map((item:any)=>item.id),[active.id,archived.id]);
    const second = (await f.request('GET','/api/v1/profiles?includeArchived=true&limit=1&offset=1')).json().data;
    assert.equal(second.total,2); assert.equal(second.items.length,1); assert.equal(second.items[0].id,archived.id);
    assert.equal((await f.request('GET','/api/v1/profiles?archived=true&search=purged-only-match')).json().data.total,0);
    const ordinary = (await f.request('GET','/api/v1/profiles')).json().data;
    assert.equal(ordinary.total,1); assert.equal(ordinary.items[0].id,active.id);
  } finally { await f.close(); }
});
