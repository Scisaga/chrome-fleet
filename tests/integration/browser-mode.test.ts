import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FleetError } from '@chrome-fleet/contracts';
import { fixture, fixtureToken, eventually } from './helpers/fleet.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const expires = () => new Date(Date.now() + 60_000).toISOString();
async function vnc(f: Fixture) {
  const response = await f.request('POST', '/api/v1/profiles', { name: '纯人工合成实例', vncPassword: 'fixture1' });
  assert.equal(response.statusCode, 201); return response.json().data;
}
async function done(f: Fixture, id: string) {
  await f.service.tick();
  await eventually(() => !['queued','running'].includes(f.service.job(id).status), 'mode job did not finish');
  await eventually(() => f.service.active.size === 0, 'mode worker did not release');
  return f.service.job(id);
}
async function setMode(f: Fixture, pid: string, browserMode: string) {
  const response = await f.request('PUT', `/api/v1/profiles/${pid}/browser-mode`, { browserMode });
  assert.equal(response.statusCode, 202); return done(f, response.json().data.jobId);
}

test('new profiles default to persistent VNC while legacy profiles remain automation and native start never probes cookies', async () => {
  const f = await fixture();
  try {
    const p = await vnc(f); assert.equal(p.browserMode, 'vnc');
    const legacy = await f.create(); const stored = f.service.profile(legacy.id); delete stored.browserMode; f.service.saveProfile(stored);
    assert.equal(f.service.publicProfile(stored).browserMode, 'automation');
    const paths: string[] = []; const original = f.service.agent.bind(f.service);
    f.service.agent = async (profile, path, body, token, timeout) => { paths.push(path); return original(profile, path, body, token, timeout); };
    const opened = await f.request('POST', `/api/v1/profiles/${p.id}/manual-sessions`, { explicitStart: true });
    assert.equal(opened.statusCode, 201, opened.body);
    assert.equal(paths.includes('/cookies/export'), false);
    assert.ok(paths.includes('/health') && paths.includes('/fence'));
    const config = JSON.parse(await readFile(join(f.root, 'profiles', p.id, 'secrets/config.json'), 'utf8'));
    assert.equal(config.browserMode, 'vnc');
    await f.service.reconcile();
    assert.equal(f.service.profile(p.id).browserMode, 'vnc');
    assert.equal(f.service.profile(p.id).state, 'running');
  } finally { await f.close(); }
});

test('VNC rejects Playwright work before persisting a queue entry and keeps lifecycle and file snapshots available', async () => {
  const f = await fixture();
  try {
    const p = await vnc(f);
    for (const kind of ['automation','proxy_test','cookies_export','cookies_import','storage-state_export','storage-state_import']) {
      assert.throws(() => f.service.submit(kind, p.id, {}, 'bootstrap'), (error: any) => error.code === 'VNC_MODE_UNSUPPORTED');
    }
    assert.equal(f.service.db.list('jobs').length, 0);
    for (const [path, body] of [[`/api/v1/profiles/${p.id}/proxy/test`, {}], ['/api/v1/jobs', { profileId: p.id, steps: [{ action: 'pages' }] }]] as const) {
      assert.equal((await f.request('POST', path, body)).json().code, 'VNC_MODE_UNSUPPORTED');
    }
    await assert.rejects(f.service.agent(f.service.profile(p.id), '/cookies/export', {}), (error: any) => error.code === 'VNC_MODE_UNSUPPORTED');
    const start = f.service.submit('start', p.id, {}, 'bootstrap'); assert.equal((await done(f, start.id)).status, 'succeeded');
    const snapshot = f.service.submit('snapshot', p.id, {}, 'bootstrap'); assert.equal((await done(f, snapshot.id)).status, 'succeeded');
    assert.equal(f.service.profile(p.id).browserMode, 'vnc');
  } finally { await f.close(); }
});

test('mode switch owns one lifecycle, closes its desktop, encrypts a stopped recovery point and keeps image/keyring/proxy state', async () => {
  const f = await fixture();
  try {
    const p = await f.create();
    const configured = f.service.profile(p.id);
    configured.proxy = f.service.storeProxy(configured, { scheme: 'http', host: 'proxy.example.test', port: 3128, username: 'fixture-proxy-user', password: 'fixture-proxy-secret' });
    f.service.saveProfile(configured);
    await f.request('POST', `/api/v1/profiles/${p.id}/manual-sessions`, { explicitStart: true });
    const before = f.service.profile(p.id);
    const proof = 'synthetic-state-before-native-switch';
    await writeFile(join(f.root, 'profiles', p.id, 'state/chrome/mode-proof'), proof);
    const job = await setMode(f, p.id, 'vnc');
    assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
    const after = f.service.profile(p.id);
    assert.equal(after.browserMode, 'vnc'); assert.equal(after.state, 'running');
    for (const key of ['image','imageDigest','keyringSecretRef','vncSecretRef','agentTokenRef']) assert.equal(after[key], before[key]);
    assert.equal(await readFile(join(f.root, 'profiles', p.id, 'state/chrome/mode-proof'), 'utf8'), proof);
    assert.equal(f.service.db.list<any>('manual-sessions')[0].closed, true);
    assert.equal(f.service.db.list('snapshots').length, 1);
    assert.equal((await readFile(join(f.root, 'backups', after.lastSnapshotId))).includes(Buffer.from(proof)), false);
    assert.equal(f.service.db.get('browser-mode-transitions', p.id), undefined);
    assert.equal(JSON.stringify(job.result).includes(before.keyringSecretRef), false);
    assert.equal(JSON.stringify(job.result).includes(before.proxy.secretRef), false);
    assert.equal(JSON.stringify(job.result).includes('fixture-proxy-secret'), false);
    assert.equal((await setMode(f, p.id, 'automation')).status, 'succeeded');
    assert.equal(f.service.profile(p.id).browserMode, 'automation');
  } finally { await f.close(); }
});

test('mode permissions protect foreign manual owners, Web CSRF, profile boundaries and revoked queued principals', async () => {
  const f = await fixture();
  try {
    const p = await f.create();
    const owner = f.auth.issue(['manage','automate'], [p.id], expires());
    const other = f.auth.issue(['manage','automate'], [p.id], expires());
    const manager = f.auth.issue(['manage'], [p.id], expires());
    await f.request('POST', `/api/v1/profiles/${p.id}/manual-sessions`, { explicitStart: true }, owner.token);
    const path = `/api/v1/profiles/${p.id}/browser-mode`;
    assert.equal((await f.request('PUT', path, { browserMode: 'vnc' }, other.token)).json().code, 'SESSION_DENIED');
    assert.equal((await f.request('PUT', path, { browserMode: 'vnc' }, manager.token)).json().code, 'SCOPE_DENIED');
    const outside = f.auth.issue(['admin'], ['cf_00000000-0000-4000-8000-000000000000'], expires());
    assert.equal((await f.request('PUT', path, { browserMode: 'vnc' }, outside.token)).json().code, 'PROFILE_DENIED');
    const login = await f.request('POST', '/api/v1/session', { token: owner.token }, '');
    const cookie = login.cookies.find(value => value.name === 'fleet_session')!;
    const headers = { cookie: `fleet_session=${cookie.value}`, origin: 'http://127.0.0.1:8080' };
    assert.equal((await f.request('PUT', path, { browserMode: 'vnc' }, '', headers)).json().code, 'CSRF_REJECTED');
    const queued = await f.request('PUT', path, { browserMode: 'vnc' }, owner.token);
    assert.equal(queued.statusCode, 202);
    const credential = f.service.db.get<any>('credentials', owner.id); credential.revoked = true; f.service.db.set('credentials', owner.id, credential);
    const result = await done(f, queued.json().data.jobId);
    assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'SCOPE_DENIED');
    assert.equal(f.service.profile(p.id).browserMode, 'automation'); assert.equal(f.service.db.list('snapshots').length, 0);
  } finally { await f.close(); }
});

test('a failed native switch never forces shutdown, replaces state or rolls back to an older snapshot', async () => {
  const f = await fixture();
  try {
    const p = await f.create(); await f.service.ensureStart(p.id, true);
    const stopOptions: any[] = [];
    const originalRunner = f.service.runner.call.bind(f.service.runner);
    f.service.runner.call = async (path, body, method, timeout) => {
      if (path.endsWith('/stop')) stopOptions.push(body);
      return originalRunner(path, body, method, timeout);
    };
    const originalSnapshot = f.service.snapshot.bind(f.service);
    f.service.snapshot = async () => { throw new FleetError('SNAPSHOT_FAILED', 'synthetic backup failure'); };
    const failed = await setMode(f, p.id, 'vnc');
    assert.equal(failed.status, 'failed'); assert.equal(f.service.profile(p.id).state, 'stopped');
    assert.equal(f.service.profile(p.id).browserMode, 'automation'); assert.equal(f.starts.get(p.id), 1);
    f.service.snapshot = originalSnapshot;
    const originalAgent = f.service.agent.bind(f.service);
    f.service.agent = async (profile, path, body, token, timeout) => {
      if (path === '/health' && profile.browserMode === 'vnc') throw new FleetError('BROWSER_MODE_MISMATCH', 'synthetic unavailable native mode');
      return originalAgent(profile, path, body, token, timeout);
    };
    // Fail before the health retry loop rather than waiting ninety seconds.
    const originalStart = f.service.ensureStart.bind(f.service);
    f.service.ensureStart = async (pid, explicit, token) => {
      if (f.service.profile(pid).browserMode === 'vnc') throw new FleetError('BROWSER_MODE_MISMATCH', 'synthetic native start failure');
      return originalStart(pid, explicit, token);
    };
    const next = await setMode(f, p.id, 'vnc');
    assert.equal(next.status, 'failed');
    const current = f.service.profile(p.id); assert.equal(current.browserMode, 'vnc'); assert.equal(current.state, 'stopped'); assert.equal(current.autoWakePaused, true);
    assert.equal(f.service.db.get<any>('browser-mode-transitions', p.id).phase, 'failed');
    assert.equal(f.service.db.list('restore-journals').length, 0);
    assert.ok(stopOptions.length > 0);
    assert.ok(stopOptions.every(options => options.force !== true), 'mode-switch failures never force Chrome termination');
  } finally { await f.close(); }
});

test('interrupted mode-switch reconciliation preserves later human state and persistent VNC mode without replay', async () => {
  const f = await fixture();
  try {
    const p = await vnc(f);
    await f.service.ensureStart(p.id, true);
    const proofPath = join(f.root, 'profiles', p.id, 'state/chrome/new-login-proof');
    await writeFile(proofPath, 'synthetic-new-human-state');
    f.service.db.set('browser-mode-transitions', p.id, { profileId: p.id, phase: 'starting', from: 'automation', to: 'vnc', snapshotId: 'never-auto-restore-this' });
    const job = f.service.submit('browser_mode', p.id, { browserMode: 'vnc' }, 'bootstrap');
    job.status = 'running'; f.service.saveJob(job);
    await f.service.reconcile();
    assert.equal(f.service.profile(p.id).browserMode, 'vnc'); assert.equal(f.service.profile(p.id).state, 'stopped');
    assert.equal(f.service.profile(p.id).autoWakePaused, true);
    assert.equal(f.service.job(job.id).status, 'outcome_unknown');
    assert.equal(await readFile(proofPath, 'utf8'), 'synthetic-new-human-state');
    assert.equal(f.service.db.get<any>('browser-mode-transitions', p.id).phase, 'interrupted');
  } finally { await f.close(); }
});

test('Google login and confirmation stay manual while preserving the active desktop', async () => {
  const f = await fixture();
  try {
    const p = await vnc(f);
    const file = join(f.root, 'accounts.tsv');
    await writeFile(file, 'selected@example.test\tfixture-private-password\trecovery@example.test\nother@example.test\tfixture-other-password\trecovery@example.test');
    f.service.google.importFile(file);
    const [selected, other] = f.service.google.list();
    const refs = f.service.db.list<any>('google-accounts').map(account => account.credentialsRef);
    const originalGet = f.service.vault.get.bind(f.service.vault);
    f.service.vault.get = (ref: string) => { assert.equal(refs.includes(ref), false, 'native Google flow must never read catalog credentials'); return originalGet(ref); };
    const originalAgent = f.service.agent.bind(f.service); let googleCalls = 0;
    f.service.agent = async (profile, path, body, token, timeout) => { if (path.startsWith('/accounts/')) { googleCalls++; throw new Error('native flow must not access browser pages'); } return originalAgent(profile, path, body, token, timeout); };
    assert.equal((await f.request('PUT', `/api/v1/profiles/${p.id}/google-binding`, { accountId: selected.id })).statusCode, 200);
    const opened = await f.request('POST', `/api/v1/profiles/${p.id}/google-login`, { accountId: selected.id });
    assert.equal(opened.statusCode, 201); assert.equal(opened.json().data.googleLogin.browserMode, 'vnc'); assert.equal(opened.json().data.googleLogin.autofill, undefined);
    await f.service.tick();
    assert.equal((await f.request('POST', `/api/v1/profiles/${p.id}/google-login/check`, {})).statusCode, 410);
    const path = `/api/v1/profiles/${p.id}/google-login/confirm`;
    assert.equal((await f.request('POST', path, { accountId: other.id })).json().code, 'ACCOUNT_MISMATCH');
    const manager = f.auth.issue(['manage','automate'], [p.id], expires());
    assert.equal((await f.request('POST', path, { accountId: selected.id }, manager.token)).json().code, 'SCOPE_DENIED');
    const stranger = f.auth.issue(['admin'], [p.id], expires());
    assert.equal((await f.request('POST', path, { accountId: selected.id }, stranger.token)).statusCode, 200);
    assert.equal(f.service.db.get<any>('manual-sessions', opened.json().data.id).closed, false, 'confirmation must preserve the desktop');
    const login = await f.request('POST', '/api/v1/session', { token: fixtureToken }, '');
    const cookie = login.cookies.find(value => value.name === 'fleet_session')!;
    const headers = { cookie: `fleet_session=${cookie.value}`, origin: 'http://127.0.0.1:8080' };
    assert.equal((await f.request('POST', path, { accountId: selected.id }, '', headers)).json().code, 'CSRF_REJECTED');
    const outside = f.auth.issue(['admin'], ['cf_00000000-0000-4000-8000-000000000000'], expires());
    assert.equal((await f.request('POST', path, { accountId: selected.id }, outside.token)).json().code, 'PROFILE_DENIED');
    const confirmed = await f.request('POST', path, { accountId: selected.id });
    assert.equal(confirmed.statusCode, 200); assert.equal(confirmed.json().data.status, 'bound'); assert.equal(confirmed.json().data.verificationSource, 'manual_confirmation');
    assert.equal(confirmed.json().data.takeoverJobId, undefined);
    assert.equal(f.service.db.list<any>('jobs').filter(job => job.kind === 'browser_mode').length, 0);
    const record = f.service.db.list<any>('accounts')[0];
    assert.equal(record.authState, 'manually_confirmed'); assert.equal(record.bindingSource, 'manual_confirmation'); assert.equal(record.expectedIdentity, selected.email);
    assert.equal(record.lastCheckedAt, null);
    assert.equal(googleCalls, 0);
    assert.equal(JSON.stringify([opened.json(), confirmed.json(), f.service.db.list('audit')]).includes('fixture-private-password'), false);
    await f.request('POST', path, { accountId: selected.id }); assert.equal(f.service.db.list('accounts').length, 1);
    await f.service.revokeDesktop(p.id);
    assert.equal((await f.request('POST', path, { accountId: selected.id })).statusCode, 200);
  } finally { await f.close(); }
});

test('pure VNC never receives automatic idle shutdown or a Playwright-dependent image update', async () => {
  const f = await fixture();
  try {
    const p = await vnc(f); await f.service.ensureStart(p.id, true);
    const current = f.service.profile(p.id); current.lastActivityAt = '1970-01-01T00:00:00Z'; current.idleTimeoutMinutes = 1; f.service.saveProfile(current);
    await f.service.tick(); assert.equal(f.service.db.list('jobs').length, 0);
    f.service.db.set('versions', 'fixture-vnc-update', { id: 'fixture-vnc-update', version: '144.0.7559.0', image: 'chrome-fleet/browser:new', imageDigest: 'sha256:'+'b'.repeat(64), distribution: 'google', validated: true });
    const result = await f.service.applyUpdate({ versionId: 'fixture-vnc-update' });
    assert.equal(result.profiles[0].phase, 'deferred'); assert.equal(result.profiles[0].reason, 'VNC_MODE_UNSUPPORTED');
    assert.equal(f.service.profile(p.id).browserMode, 'vnc'); assert.equal(f.service.profile(p.id).state, 'running'); assert.equal(f.service.db.list('snapshots').length, 0);
  } finally { await f.close(); }
});
