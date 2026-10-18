/** Failure injection tests of real update orchestration; the HTTP Runner/Agent is synthetic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FleetError } from '@chrome-fleet/contracts';
import { FleetService } from '../../apps/control-plane/src/service.js';
import { fixture } from './helpers/fleet.js';

const oldImage = 'chrome-fleet/browser:old';
const newImage = 'chrome-fleet/browser:new';
const candidateId = 'google-144.0.7559.0';
function candidate(f: Awaited<ReturnType<typeof fixture>>, validated = true) {
  return f.service.db.set('versions', candidateId, { id: candidateId, distribution: 'google', version: '144.0.7559.0', image: newImage, imageDigest: 'sha256:' + 'b'.repeat(64), validated, applied: false });
}
async function runningOld(f: Awaited<ReturnType<typeof fixture>>, name = '更新合成实例') {
  const created = await f.create(name); const p = f.service.profile(created.id); p.image = oldImage; f.service.saveProfile(p);
  const owner = `fixture-start-${p.id}`; const token = f.service.db.acquire(p.id, owner)!;
  try { await f.service.ensureStart(p.id, true, token); } finally { f.service.db.release(p.id, owner, token); }
  const stateFile = join(f.root, 'profiles', p.id, 'state', 'chrome', 'fixture-state');
  await writeFile(stateFile, 'old-session-state');
  return { id: p.id, stateFile };
}

test('unvalidated update cannot change a profile or invoke Runner', async () => {
  const f = await fixture();
  try {
    const p = await f.create(); candidate(f, false);
    await assert.rejects(() => f.service.applyUpdate({ versionId: candidateId }), (error: any) => error.code === 'VERSION_NOT_VALIDATED');
    assert.equal(f.startImages.length, 0); assert.equal(f.service.profile(p.id).image, f.config.defaultImage); assert.equal(f.service.db.list('updates').length, 0);
  } finally { await f.close(); }
});
test('snapshot failure blocks replacement and leaves the old image/session untouched', async () => {
  const f = await fixture();
  try {
    const p = await runningOld(f); candidate(f);
    f.service.snapshot = async () => { throw new FleetError('BACKUP_UNAVAILABLE', '注入备份写入失败', 507); };
    const run = await f.service.applyUpdate({ versionId: candidateId });
    assert.equal(run.phase, 'failed'); assert.equal(run.profiles[0].phase, 'failed');
    assert.equal(f.service.profile(p.id).image, oldImage); assert.deepEqual(f.startImages, [oldImage]);
    assert.equal(await readFile(p.stateFile, 'utf8'), 'old-session-state'); assert.equal(f.service.db.get<any>('versions', candidateId).applied, false);
  } finally { await f.close(); }
});
test('new image Cookie health failure restores paired old image and pre-migration snapshot', async () => {
  const f = await fixture();
  try {
    const p = await runningOld(f); candidate(f); f.failCookieImages.add(newImage);
    f.setStartHook(async (pid, image) => { if (image === newImage) await writeFile(join(f.root, 'profiles', pid, 'state', 'chrome', 'fixture-state'), 'new-format-migrated-session'); });
    const run = await f.service.applyUpdate({ versionId: candidateId });
    assert.equal(run.phase, 'failed'); assert.equal(run.profiles[0].phase, 'rolled_back', JSON.stringify(run));
    assert.ok(run.profiles[0].snapshotId); assert.ok(run.profiles[0].restorePoint);
    assert.deepEqual(f.startImages, [oldImage, newImage, oldImage]);
    assert.equal(f.service.profile(p.id).image, oldImage); assert.equal(f.service.profile(p.id).state, 'running');
    assert.equal(await readFile(p.stateFile, 'utf8'), 'old-session-state'); assert.equal(f.service.db.get<any>('snapshots', run.profiles[0].snapshotId).image, oldImage);
  } finally { await f.close(); }
});
test('stopped profile records a pending image and snapshots before its next explicit start', async () => {
  const f = await fixture();
  try {
    const p = await f.create(); const stateFile = join(f.root, 'profiles', p.id, 'state', 'chrome', 'fixture-state'); await writeFile(stateFile, 'stopped-session-state'); candidate(f);
    const run = await f.service.applyUpdate({ versionId: candidateId });
    assert.equal(run.profiles[0].phase, 'pending'); assert.equal(f.startImages.length, 0);
    assert.equal(f.service.profile(p.id).state, 'stopped'); assert.equal(f.service.profile(p.id).pendingImage.image, newImage);
    const token = f.service.db.acquire(p.id, 'fixture-explicit-start')!;
    try { await f.service.ensureStart(p.id, true, token); } finally { f.service.db.release(p.id, 'fixture-explicit-start', token); }
    assert.deepEqual(f.startImages, [newImage]);
    const snapshots = f.service.db.list<any>('snapshots').filter(snapshot => snapshot.profileId === p.id); assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].image, f.config.defaultImage); assert.equal(f.service.profile(p.id).chromeVersion, '144.0.7559.0');
    assert.equal(await readFile(stateFile, 'utf8'), 'stopped-session-state');
  } finally { await f.close(); }
});
test('successful update rollback advances fencing before shutdown and restores its matching snapshot', async () => {
  const f = await fixture();
  try {
    const p = await runningOld(f); candidate(f);
    const run = await f.service.applyUpdate({ versionId: candidateId });
    assert.equal(run.phase, 'succeeded'); assert.equal(f.service.profile(p.id).image, newImage); assert.equal(f.service.profile(p.id).chromeVersion, '144.0.7559.0');
    await writeFile(p.stateFile, 'after-success-new-local-state');
    const rolledBack = await f.service.rollbackUpdate(run.id); assert.equal(rolledBack.phase, 'rolled_back');
    assert.equal(f.service.profile(p.id).image, oldImage); assert.equal(await readFile(p.stateFile, 'utf8'), 'old-session-state');
    assert.equal(f.service.profile(p.id).state, 'running');
  } finally { await f.close(); }
});
test('controller restart during replacement reconciles to the stored old image/snapshot pair', async () => {
  const f = await fixture(); let restarted: FleetService | undefined;
  try {
    const p = await runningOld(f); await f.service.stop(p.id, false);
    const token = f.service.db.acquire(p.id, 'fixture-interrupted-update')!; const snap = await f.service.snapshot(p.id, token); f.service.db.release(p.id, 'fixture-interrupted-update', token);
    const changed = f.service.profile(p.id); changed.image = newImage; changed.state = 'running'; f.service.saveProfile(changed); f.states.set(p.id, 'running'); await writeFile(p.stateFile, 'interrupted-new-format');
    f.service.db.acquire(p.id, 'update_interrupted_fixture', 3_600_000);
    f.service.db.set('updates', 'update_interrupted_fixture', { id: 'update_interrupted_fixture', targetImage: newImage, phase: 'applying', profiles: [{ profileId: p.id, phase: 'starting', snapshotId: snap.id, wasRunning: true, oldImage, restorePoint: snap.restorePoint }] });
    restarted = new FleetService(f.config); await restarted.reconcile();
    assert.equal(restarted.profile(p.id).image, oldImage); assert.equal(restarted.profile(p.id).state, 'stopped');
    assert.equal(await readFile(p.stateFile, 'utf8'), 'old-session-state');
    assert.equal(restarted.db.get<any>('updates', 'update_interrupted_fixture').profiles[0].phase, 'rolled_back');
    assert.equal(restarted.db.lease(p.id).owner, null, '确认旧浏览器已停止并恢复后应释放中断更新租约');
    assert.deepEqual(f.startImages, [oldImage]); // Reconciliation restores data without replaying browser actions.
  } finally { restarted?.db.close(); await f.close(); }
});
test('busy profile remains eligible for a later automatic apply after its lease is released', async () => {
  const f = await fixture();
  try {
    const p = await f.create(); candidate(f); const lease = f.service.db.acquire(p.id, 'fixture-manual-lease')!;
    const first = await f.service.applyUpdate({ versionId: candidateId }); assert.equal(first.profiles[0].phase, 'deferred'); assert.equal(f.startImages.length, 0);
    assert.notEqual(f.service.db.get<any>('versions', candidateId).applied, true, '所有目标都deferred时不能标记候选已应用');
    f.service.db.release(p.id, 'fixture-manual-lease', lease);
    const second = await f.service.applyUpdate({}); assert.equal(second.profiles[0].phase, 'pending'); assert.equal(f.service.profile(p.id).pendingImage.image, newImage);
  } finally { await f.close(); }
});
test('rollback failure preserves the pre-upgrade snapshot and marks the profile error', async () => {
  const f = await fixture();
  try {
    const p = await runningOld(f); candidate(f); f.failCookieImages.add(newImage);
    f.service.restore = async () => { throw new FleetError('RESTORE_FAILED', '注入恢复失败', 500); };
    const run = await f.service.applyUpdate({ versionId: candidateId }); assert.equal(run.phase, 'failed'); assert.equal(run.profiles[0].phase, 'rollback_failed');
    assert.equal(f.service.profile(p.id).state, 'error'); assert.ok(f.service.db.get('snapshots', run.profiles[0].snapshotId));
    const encrypted = await readFile(join(f.root, 'backups', run.profiles[0].snapshotId)); assert.equal(encrypted.subarray(0, 4).toString(), 'CF01');
  } finally { await f.close(); }
});
test('a healthy process reporting the wrong Chrome version fails verification and restores its pair', async () => {
  const f = await fixture();
  try {
    const p = await runningOld(f); candidate(f); f.healthVersions.set(newImage, '142.0.0.0');
    const run = await f.service.applyUpdate({ versionId: candidateId });
    assert.equal(run.phase, 'failed', '技术健康不能替代实际目标Chrome版本校验');
    assert.equal(run.profiles[0].phase, 'rolled_back'); assert.equal(f.service.profile(p.id).image, oldImage); assert.equal(await readFile(p.stateFile, 'utf8'), 'old-session-state');
  } finally { await f.close(); }
});
test('pending update validates its actual Chrome version before allowing an explicit start', async () => {
  const f = await fixture();
  try {
    const p = await f.create(); const file = join(f.root, 'profiles', p.id, 'state', 'chrome', 'fixture-state'); await writeFile(file, 'pre-pending-state'); candidate(f); f.healthVersions.set(newImage, '142.0.0.0');
    await f.service.applyUpdate({ versionId: candidateId }); const lease = f.service.db.acquire(p.id, 'fixture-pending-start')!;
    try { await assert.rejects(() => f.service.ensureStart(p.id, true, lease), (error: any) => error.code === 'VERSION_MISMATCH'); } finally { f.service.db.release(p.id, 'fixture-pending-start', lease); }
    assert.equal(f.service.profile(p.id).image, f.config.defaultImage); assert.equal(f.service.profile(p.id).state, 'stopped'); assert.equal(await readFile(file, 'utf8'), 'pre-pending-state');
  } finally { await f.close(); }
});
