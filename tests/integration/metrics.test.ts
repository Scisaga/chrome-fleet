import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, eventually } from './helpers/fleet.js';
import { metricsMaxAgeMs } from '../../apps/control-plane/src/metrics.js';

const sample = (overrides: Record<string, unknown> = {}) => ({ available: true, sampledAt: new Date().toISOString(), cpuPercent: 25, memoryBytes: 700, memoryUsageBytes: 1000, memoryLimitBytes: 2000, pids: 5, ...overrides });
async function running(f: Awaited<ReturnType<typeof fixture>>) {
  const p = await f.create(); const current = f.service.profile(p.id); current.state = 'running'; f.service.saveProfile(current); return current;
}

test('fast metrics refresh uses bounded Runner reads only and preserves Chrome, activity, profile state and read-only GET behavior', async () => {
  const f = await fixture();
  try {
    const p = await running(f); const before = f.service.profile(p.id); let calls = 0;
    f.service.agent = async () => { throw new Error('metrics must never call Agent'); };
    f.service.ensureStart = async () => { throw new Error('metrics must never start Chrome'); };
    f.service.runner.call = async (path, body, method, timeout) => {
      calls++; assert.equal(path, `/profiles/${p.id}/status`); assert.equal(body, undefined); assert.equal(method, 'GET'); assert.equal(timeout, 2500);
      return { status: 'running', metrics: sample() };
    };
    await f.service.refreshMetrics();
    const current = f.service.profile(p.id); assert.equal(current.metrics.available, true); assert.equal(current.metrics.cpuPercent, 25);
    for (const key of ['state','browserMode','lastActivityAt','updatedAt','image','imageDigest']) assert.equal(current[key], before[key]);
    assert.equal(f.starts.size, 0);
    const list = await f.request('GET', '/api/v1/profiles'); const detail = await f.request('GET', `/api/v1/profiles/${p.id}`);
    assert.equal(list.json().data.items[0].metrics.memoryBytes, 700); assert.equal(detail.json().data.metrics.cpuPercent, 25);
    assert.equal(calls, 1, 'GETs must only project cached metrics');
  } finally { await f.close(); }
});

test('metrics refresh cannot overlap or write a pre-stop sample back after a lifecycle transition', async () => {
  const f = await fixture();
  try {
    const p = await running(f); let calls = 0, entered = false; let release!: () => void;
    f.service.runner.call = async () => { calls++; entered = true; await new Promise<void>(resolve => { release = resolve; }); return { status: 'running', metrics: sample() }; };
    const first = f.service.refreshMetrics(); await eventually(() => entered, 'sample request did not begin');
    await f.service.refreshMetrics(); assert.equal(calls, 1);
    const stopped = f.service.profile(p.id); stopped.state = 'stopped'; f.service.saveProfile(stopped);
    release(); await first;
    assert.equal(f.service.profile(p.id).state, 'stopped'); assert.equal(f.service.profile(p.id).metrics.available, false);
    assert.equal(f.service.profile(p.id).metrics.memoryBytes, undefined);
    await f.service.refreshMetrics(); assert.equal(calls, 1, 'stopped profiles require no Runner request');
    assert.equal((await f.request('GET', `/api/v1/profiles/${p.id}`)).json().data.metrics.cpuPercent, undefined);
  } finally { await f.close(); }
});

test('Runner failures, externally stopped containers and stale samples never expose old CPU or memory as live', async () => {
  const f = await fixture();
  try {
    const p = await running(f); let mode = 'ok';
    f.service.runner.call = async () => {
      if (mode === 'fail') throw new Error('synthetic-sensitive-runner-error');
      return { status: mode === 'stopped' ? 'stopped' : 'running', metrics: sample(mode === 'stale' ? { sampledAt: new Date(Date.now() - metricsMaxAgeMs - 1).toISOString() } : {}) };
    };
    await f.service.refreshMetrics(); assert.equal(f.service.publicProfile(f.service.profile(p.id)).metrics.available, true);
    mode = 'fail'; await f.service.refreshMetrics();
    let metrics = f.service.publicProfile(f.service.profile(p.id)).metrics;
    assert.equal(metrics.available, false); assert.equal(metrics.errorCode, 'RUNNER_UNAVAILABLE'); assert.equal(metrics.memoryBytes, undefined); assert.equal(JSON.stringify(metrics).includes('sensitive'), false);
    mode = 'stale'; await f.service.refreshMetrics(); metrics = f.service.publicProfile(f.service.profile(p.id)).metrics;
    assert.equal(metrics.errorCode, 'METRICS_STALE'); assert.equal(metrics.cpuPercent, undefined);
    mode = 'stopped'; await f.service.refreshMetrics(); metrics = f.service.publicProfile(f.service.profile(p.id)).metrics;
    assert.equal(metrics.errorCode, 'PROFILE_NOT_RUNNING'); assert.equal(metrics.memoryBytes, undefined);
    assert.equal(f.service.profile(p.id).state, 'running', 'sampling cannot change lifecycle state');
  } finally { await f.close(); }
});

test('slow housekeeping health completion cannot replace newer samples or concurrent profile edits', async () => {
  const f = await fixture();
  try {
    const p = await running(f); let entered = false; let release!: () => void;
    f.service.agent = async () => { entered = true; await new Promise<void>(resolve => { release = resolve; }); return { ready: true }; };
    f.service.runner.call = async path => path === '/network-policy/sync' ? { applied: true } : { status: 'running', metrics: sample({ cpuPercent: 175 }) };
    const housekeeping = f.service.housekeeping(); await eventually(() => entered, 'housekeeping did not reach health request');
    await f.service.refreshMetrics();
    const changed = f.service.profile(p.id); changed.name = 'concurrent metadata preserved'; f.service.saveProfile(changed);
    release(); await housekeeping;
    assert.equal(f.service.profile(p.id).metrics.cpuPercent, 175); assert.equal(f.service.profile(p.id).name, 'concurrent metadata preserved');
    assert.equal(f.service.profile(p.id).state, 'running');
  } finally { await f.close(); }
});

test('worker schedules an immediate sample and independent three-second refreshes and clears the timer on close', async t => {
  const f = await fixture();
  try {
    t.mock.timers.enable({ apis: ['setInterval'] });
    let refreshes = 0;
    f.service.refreshMetrics = async () => { refreshes++; };
    f.service.tick = async () => undefined;
    f.service.startWorker(); assert.equal(refreshes, 1);
    t.mock.timers.tick(2999); assert.equal(refreshes, 1);
    t.mock.timers.tick(1); assert.equal(refreshes, 2);
    t.mock.timers.tick(3000); assert.equal(refreshes, 3);
    f.service.close();
    t.mock.timers.tick(3000); assert.equal(refreshes, 3);
  } finally { t.mock.timers.reset(); await f.close(); }
});
