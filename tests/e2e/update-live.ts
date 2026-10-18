/**
 * Real same-Chrome-version image upgrade/rollback through FleetService + Runner.
 * Uses an isolated SQLite/Vault, real unique runtime directories, and no real accounts.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store, Vault } from '@chrome-fleet/core';
import { FleetService } from '../../apps/control-plane/src/service.js';
import type { Config } from '../../apps/control-plane/src/config.js';

if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('验收必须保留TLS校验；请使用 env -u NODE_TLS_REJECT_UNAUTHORIZED 运行');
const runtimeRoot = process.env.FLEET_DATA_ROOT ?? '/var/lib/chrome-fleet';
const runnerContainer = process.env.FLEET_TEST_RUNNER_CONTAINER ?? 'chrome-fleet-runner-1';
const oldImage = process.env.FLEET_TEST_OLD_IMAGE ?? 'sha256:e61e2a5aa454b890bca6179f36a14b41781a59b0403e542a6941be976ca9653d';
const temp = await mkdtemp(join(tmpdir(), 'cf-update-live-'));
const keyFile = join(temp, 'master.key');
await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
await writeFile(join(temp, 'fixture-runner-token'), randomBytes(32).toString('hex'), { mode: 0o600 });
let profileId: string | undefined;
let service: FleetService | undefined;
let cleaning = false; let interrupted = false;
const children = new Set<ReturnType<typeof spawn>>();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { interrupted = true; for (const child of children) child.kill('SIGTERM'); });
function command(command: string, args: string[], input?: string, timeoutMs = 180_000): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    if (interrupted && !cleaning) { reject(new Error('验收已中断，开始清理自己的临时实例')); return; }
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] }); children.add(child); let output = ''; let diagnostic = '';
    child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-2000); });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${command} 超时`)); }, timeoutMs);
    child.once('error', error => { children.delete(child); clearTimeout(timer); reject(error); });
    child.once('exit', code => { children.delete(child); clearTimeout(timer); if (code === 0) resolveCommand(output.trim()); else reject(new Error(`${command} 验收调用失败(${code})：${diagnostic.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')}`)); });
    child.stdin.end(input);
  });
}
async function imageInfo(image: string) { return JSON.parse(await command('docker', ['image', 'inspect', image]))[0]; }
async function runnerCall(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', timeoutMs = 300_000): Promise<any> {
  const source = `import {readFile} from 'node:fs/promises';
const token=(await readFile('/run/secrets/runner-token','utf8')).trim();
const body=${JSON.stringify(body ?? null)};
const r=await fetch('http://127.0.0.1:8091'+${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{authorization:'Bearer '+token,...(body===null?{}:{'content-type':'application/json'})},body:body===null?undefined:JSON.stringify(body),signal:AbortSignal.timeout(${timeoutMs})});
const result=await r.json();if(!r.ok){process.stderr.write(JSON.stringify({status:r.status,code:result.code??'RUNNER_ERROR',message:result.message??'受限Runner调用失败'}));process.exit(1);}process.stdout.write(JSON.stringify(result));`;
  const value = JSON.parse(await command('docker', ['exec', '-i', runnerContainer, 'node', '--input-type=module'], source, timeoutMs + 5000));
  const result = value.data ?? value;
  // Test-only reachability adapter. Preserve the actual Docker-assigned control IP.
  // Business logic, encrypted snapshots and directory replacement are unchanged.
  if (result.profileId && result.agentUrl) {
    const inspected = JSON.parse(await command('docker', ['inspect', result.profileId]))[0];
    const endpoint = inspected.NetworkSettings.Networks['chrome-fleet-control'];
    assert.ok(endpoint?.IPAddress, '真实Runner实例须接入批准的控制网络');
    result.agentUrl = `http://${endpoint.IPAddress}:8092`;
    result.desktopUrl = `http://${endpoint.IPAddress}:6080`;
  }
  return result;
}
async function assertProof(expected: string, label: string) {
  assert.ok(service && profileId);
  const owner = `fixture-proof-${randomBytes(8).toString('hex')}`;
  const token = service.db.acquire(profileId, owner)!; assert.ok(token);
  try {
    const p = service.profile(profileId); await service.agent(p, '/fence', { token });
    // Visit the controlled origin so Playwright includes persisted origin storage
    // in its export. The retained older image did not write the newer self-test
    // key-hash marker; the functional values below remain strict assertions.
    try { await service.agent(p, '/self-test', { mode: 'read', proof: expected }, token); } catch (error) { if ((error as { code?: string }).code !== 'BROWSER_OPERATION_FAILED') throw error; }
    const out = await service.agent(p, '/cookies/export', {}, token);
    assert.equal(out.document?.cookies?.find((cookie: { name: string }) => cookie.name === 'fleet-persistence-proof')?.value === expected, true, label);
    // Both retained image generations expose this export contract. The older
    // self-test endpoint predates the new key-hash marker, so do not invent it.
    const exported = await service.agent(p, '/storage-state/export', {}, token);
    const origin = exported.document?.state?.origins?.find((item: { origin: string }) => item.origin === 'https://fleet-validation.invalid');
    assert.equal(origin?.localStorage?.find((item: { name: string }) => item.name === 'fleet-proof')?.value === expected, true, `${label}：localStorage恢复值应一致`);
    const database = origin?.indexedDB?.find((item: { name: string }) => item.name === 'fleet-validation');
    const store = database?.stores?.find((item: { name: string }) => item.name === 'proofs');
    assert.equal(!!store && JSON.stringify(store.records).includes(expected), true, `${label}：IndexedDB实际记录应一致`);
  } finally { service.db.release(profileId, owner, token); }
}
try {
  assert.equal(process.getuid?.(), 0, '真实目录与UID验收需要Docker宿主root');
  const old = await imageInfo(oldImage); assert.equal(old.Config.Labels['chrome-fleet.browser'], 'true');
  console.log(`旧镜像：${old.Id}；Chrome ${old.Config.Labels['chrome-fleet.chrome.version']}`);
  const config: Config = { root: runtimeRoot, keyFile, bootstrapTokenFile: join(temp, 'unused-admin-token'), runnerTokenFile: join(temp, 'fixture-runner-token'), runnerUrl: 'http://127.0.0.1:8091', host: '127.0.0.1', port: 8080, publicUrl: 'http://127.0.0.1:8080', secureCookie: false, maxConcurrency: 1, defaultImage: old.Id, webRoot: join(temp, 'unused-web'), retentionDays: 1 };
  service = new FleetService(config);
  // Detach metadata immediately; the constructor has not created any profile/secret.
  service.db.close(); service.db = new Store(temp); service.vault = new Vault(temp, keyFile);
  service.db.set('settings', 'update-policy', { mode: 'manual', paused: true, checkIntervalHours: 24, maintenanceStart: '02:00', maintenanceEnd: '05:00', timezone: 'Asia/Shanghai' });
  service.runner.call = runnerCall;
  const created = await service.create({ name: '真实镜像升级回滚合成验收', browserMode: 'automation', startupPolicy: 'manual', idleTimeoutMinutes: 0, distribution: 'google', vncPassword: 'Fixture1' }); profileId = created.id;
  const startOwner = 'fixture-initial-start'; const startToken = service.db.acquire(profileId, startOwner)!;
  try { await service.ensureStart(profileId, true, startToken); } finally { service.db.release(profileId, startOwner, startToken); }
  assert.equal(service.profile(profileId).imageDigest, old.Id);
  const beforeProof = randomBytes(32).toString('hex');
  const proofOwner = 'fixture-initial-proof'; const proofToken = service.db.acquire(profileId, proofOwner)!;
  try { const p = service.profile(profileId); await service.agent(p, '/fence', { token: proofToken }); const written = await service.agent(p, '/self-test', { mode: 'write', proof: beforeProof }, proofToken); assert.equal(written.passed, true); } finally { service.db.release(profileId, proofOwner, proofToken); }
  console.log('PASS 旧真实镜像写入独立合成Cookie、localStorage、IndexedDB');
  console.log('开始官方候选检查、真实镜像准备与一次性隔离兼容验证……');
  const candidate = await service.checkVersions({ distribution: 'google', prepare: true });
  assert.equal(candidate.validated, true); assert.equal(candidate.version, old.Config.Labels['chrome-fleet.chrome.version'], '本用例只声明同Chrome版本的镜像升级');
  const target = await imageInfo(candidate.image); assert.equal(target.Id, candidate.imageDigest); assert.notEqual(target.Id, old.Id, '必须使用两个真实不同内容Id，不能伪造版本升级');
  console.log(`PASS 官方候选已真实准备/验证：${target.Id}；Chrome ${candidate.version}`);
  const updated = await service.applyUpdate({ versionId: candidate.id, profileIds: [profileId] });
  assert.equal(updated.phase, 'succeeded'); assert.equal(updated.profiles.length, 1); assert.equal(updated.profiles[0].phase, 'succeeded'); assert.ok(updated.profiles[0].snapshotId);
  assert.equal(service.profile(profileId).imageDigest, target.Id);
  const actual = JSON.parse(await command('docker', ['inspect', profileId]))[0]; assert.equal(actual.Image, target.Id);
  await assertProof(beforeProof, '升级后保留升级前合成会话');
  console.log('PASS 真正停机快照→替换新镜像→原Cookie/localStorage/IndexedDB保持');
  const afterProof = randomBytes(32).toString('hex'); const afterOwner = 'fixture-after-upgrade'; const afterToken = service.db.acquire(profileId, afterOwner)!;
  try { const p = service.profile(profileId); await service.agent(p, '/fence', { token: afterToken }); const changed = await service.agent(p, '/self-test', { mode: 'write', proof: afterProof }, afterToken); assert.equal(changed.passed, true); } finally { service.db.release(profileId, afterOwner, afterToken); }
  await assertProof(afterProof, '回滚前确实存在升级后新状态');
  const rollback = await service.rollbackUpdate(updated.id); assert.equal(rollback.phase, 'rolled_back'); assert.equal(rollback.profiles[0].phase, 'rolled_back');
  const restored = service.profile(profileId); assert.equal(restored.imageDigest, old.Id);
  const restoredContainer = JSON.parse(await command('docker', ['inspect', profileId]))[0]; assert.equal(restoredContainer.Image, old.Id);
  await assertProof(beforeProof, '旧镜像与升级前快照必须成对恢复，舍弃升级后状态');
  console.log('PASS 真实回滚恢复旧镜像内容Id与升级前完整profile/keyring快照，升级后新状态已舍弃');
  console.log(`验收范围：同一Chrome ${candidate.version}的两个实际镜像构建；未声明跨Chrome版本迁移或真实Google登录。`);
} finally {
  cleaning = true;
  let removed = !profileId;
  if (service && profileId) {
    try { await service.stop(profileId, false).catch(() => undefined); await runnerCall(`/profiles/${profileId}/stop`, {}); await runnerCall(`/profiles/${profileId}/container`, undefined, 'DELETE'); removed = true; } catch { process.stderr.write(`验收profile ${profileId}清理失败，请按唯一profile标签精确回收。\n`); }
    if (removed) await rm(join(runtimeRoot, 'profiles', profileId), { recursive: true, force: true });
    for (const snapshot of service.db.list<any>('snapshots').filter(value => value.profileId === profileId)) await rm(join(runtimeRoot, 'backups', snapshot.id), { force: true });
    for (const artifact of service.db.list<any>('artifacts').filter(value => value.profileId === profileId)) await rm(join(runtimeRoot, 'artifacts', artifact.id), { force: true });
    service.db.close();
  } else service?.db.close();
  await rm(temp, { recursive: true, force: true });
}
