import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FleetError } from '@chrome-fleet/contracts';
import { fixture, eventually } from './helpers/fleet.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function setup(f: Fixture) {
  const path = join(f.root, 'takeover-accounts.tsv');
  await writeFile(path, 'login@example.test\tsynthetic-password\trecovery@example.test\nother@example.test\tother-password\trecovery@example.test');
  f.service.google.importFile(path);
  const accounts = f.service.google.list();
  const created = await f.request('POST', '/api/v1/profiles', { name: '人工登录后自动接管', vncPassword: 'fixture1' });
  const profile = created.json().data;
  assert.equal((await f.request('PUT', `/api/v1/profiles/${profile.id}/google-binding`, { accountId: accounts[0].id })).statusCode, 200);
  return { profile, accounts, confirm: () => f.request('POST', `/api/v1/profiles/${profile.id}/google-login/confirm`, { accountId: accounts[0].id }) };
}
async function done(f: Fixture, id: string) {
  await f.service.tick();
  await eventually(() => !['queued', 'running'].includes(f.service.job(id).status), 'takeover did not finish');
  await eventually(() => f.service.active.size === 0, 'takeover worker did not release');
  return f.service.job(id);
}

test('confirming a native Google login switches the same persistent profile to automation and enables work and idle shutdown', async () => {
  const f = await fixture();
  try {
    const { profile, accounts, confirm } = await setup(f);
    const opened = (await f.request('POST', `/api/v1/profiles/${profile.id}/google-login`, {})).json().data;
    const before = f.service.profile(profile.id);
    const proof = 'synthetic-latest-login-state';
    const path = join(f.root, 'profiles', profile.id, 'state/chrome/login-proof');
    await writeFile(path, proof);
    const response = await confirm(); assert.equal(response.statusCode, 200, response.body);
    const state = response.json().data; assert.ok(state.takeoverJobId);
    assert.equal(f.service.db.get<any>('manual-sessions', opened.id).closed, true);
    assert.equal(f.service.db.lease(profile.id)?.owner, null);
    const repeated = await confirm();
    assert.equal(repeated.json().data.takeoverJobId, state.takeoverJobId);
    assert.equal(repeated.json().data.lastConfirmedAt, state.lastConfirmedAt);
    assert.equal(f.service.db.list('jobs').length, 1);
    assert.equal((await f.request('POST', `/api/v1/profiles/${profile.id}/manual-sessions`, {})).json().code, 'PROFILE_BUSY');
    assert.equal((await done(f, state.takeoverJobId)).status, 'succeeded');
    const after = f.service.profile(profile.id);
    assert.equal(after.browserMode, 'automation'); assert.equal(after.state, 'running');
    for (const key of ['image', 'imageDigest', 'keyringSecretRef', 'vncSecretRef', 'agentTokenRef']) assert.equal(after[key], before[key]);
    assert.equal(await readFile(path, 'utf8'), proof);
    assert.equal(f.service.db.list('snapshots').length, 1);
    assert.equal((await readFile(join(f.root, 'backups', after.lastSnapshotId))).includes(Buffer.from(proof)), false);
    assert.equal(f.service.google.binding(profile.id)?.accountId, accounts[0].id);
    assert.equal(f.service.google.binding(profile.id)?.lastConfirmedAt, state.lastConfirmedAt);
    assert.equal((await confirm()).json().data.browserMode, 'automation');
    assert.equal(f.service.db.list('snapshots').length, 1, 'repeating confirmation must not restart automation');
    const automation = f.service.submit('automation', profile.id, { steps: [{ action: 'pages' }], timeoutMs: 60000 }, 'bootstrap');
    assert.equal((await done(f, automation.id)).status, 'succeeded');
    const idle = f.service.profile(profile.id); idle.lastActivityAt = '1970-01-01T00:00:00Z'; f.service.saveProfile(idle);
    await f.service.tick();
    const stop = f.service.db.list<any>('jobs').find(job => job.kind === 'stop'); assert.ok(stop);
    assert.equal((await done(f, stop.id)).status, 'succeeded');
    assert.equal(f.service.profile(profile.id).state, 'stopped');
  } finally { await f.close(); }
});

test('confirmation without a desktop starts takeover, while replacing the account cancels queued consent', async () => {
  const f = await fixture();
  try {
    const { profile, accounts, confirm } = await setup(f);
    const state = (await confirm()).json().data;
    assert.equal(f.starts.size, 0, 'confirmation only queues the lifecycle');
    await f.request('PUT', `/api/v1/profiles/${profile.id}/google-binding`, { accountId: accounts[1].id });
    assert.equal(f.service.job(state.takeoverJobId).status, 'cancelled');
    assert.equal(f.service.google.binding(profile.id)?.confirmationState, 'unconfirmed');
    await f.service.tick(); assert.equal(f.starts.size, 0);
    const confirmed = await f.request('POST', `/api/v1/profiles/${profile.id}/google-login/confirm`, { accountId: accounts[1].id });
    assert.equal((await done(f, confirmed.json().data.takeoverJobId)).status, 'succeeded');
    assert.equal(f.service.profile(profile.id).browserMode, 'automation');
  } finally { await f.close(); }
});

test('takeover rechecks authorization and fails without changing native mode when consent is revoked', async () => {
  const f = await fixture();
  try {
    const { profile, accounts } = await setup(f);
    const principal = f.auth.issue(['admin'], [profile.id]);
    const confirmed = await f.request('POST', `/api/v1/profiles/${profile.id}/google-login/confirm`, { accountId: accounts[0].id }, principal.token);
    const credential = f.service.db.get<any>('credentials', principal.id); credential.revoked = true; f.service.db.set('credentials', principal.id, credential);
    const result = await done(f, confirmed.json().data.takeoverJobId);
    assert.equal(result.status, 'failed'); assert.equal(result.error?.code, 'SCOPE_DENIED');
    assert.equal(f.service.profile(profile.id).browserMode, 'vnc'); assert.equal(f.starts.size, 0);
  } finally { await f.close(); }
});

test('failed takeover preserves login data and can be retried without force stopping Chrome', async () => {
  const f = await fixture();
  try {
    const { profile, confirm } = await setup(f);
    await f.service.ensureStart(profile.id, true);
    const path = join(f.root, 'profiles', profile.id, 'state/chrome/login-proof'); await writeFile(path, 'latest-login');
    const stops: any[] = []; const call = f.service.runner.call.bind(f.service.runner);
    f.service.runner.call = async (path, body, method, timeout) => { if (path.endsWith('/stop')) stops.push(body); return call(path, body, method, timeout); };
    const snapshot = f.service.snapshot.bind(f.service);
    f.service.snapshot = async () => { throw new FleetError('SNAPSHOT_FAILED', '合成备份失败'); };
    const state = (await confirm()).json().data;
    const failed = await done(f, state.takeoverJobId);
    assert.equal(failed.status, 'failed'); assert.equal(failed.error?.code, 'SNAPSHOT_FAILED');
    assert.equal(f.service.profile(profile.id).browserMode, 'vnc');
    assert.equal(await readFile(path, 'utf8'), 'latest-login'); assert.ok(stops.every(body => body.force !== true));
    f.service.snapshot = snapshot;
    const retry = (await confirm()).json().data; assert.notEqual(retry.takeoverJobId, state.takeoverJobId);
    assert.equal((await done(f, retry.takeoverJobId)).status, 'succeeded');
    assert.equal(f.service.profile(profile.id).browserMode, 'automation');
  } finally { await f.close(); }
});

test('a failed automation launch can retry confirmation even after the stored mode has changed', async () => {
  const f = await fixture();
  try {
    const { profile, confirm } = await setup(f);
    const start = f.service.ensureStart.bind(f.service);
    f.service.ensureStart = async () => { throw new FleetError('BROWSER_START_FAILED', '合成启动失败'); };
    const first = (await confirm()).json().data;
    assert.equal((await done(f, first.takeoverJobId)).status, 'failed');
    assert.equal(f.service.profile(profile.id).browserMode, 'automation');
    assert.equal(f.service.profile(profile.id).state, 'stopped');
    f.service.ensureStart = start;
    const retry = (await confirm()).json().data;
    assert.notEqual(retry.takeoverJobId, first.takeoverJobId);
    assert.equal((await done(f, retry.takeoverJobId)).status, 'succeeded');
    assert.equal(f.service.profile(profile.id).state, 'running');
  } finally { await f.close(); }
});
