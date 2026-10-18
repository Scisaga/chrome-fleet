import test from 'node:test';
import assert from 'node:assert/strict';
import { MetricsSampler, MetricsRequests } from './metrics.js';
const origin = Date.parse('2026-10-17T00:00:00Z');
const stats = (cpu: number, second: number, cache: Record<string, unknown> = {}) => ({
  read: new Date(origin + second * 1000).toISOString(), cpu_stats: { cpu_usage: { total_usage: cpu } },
  memory_stats: { usage: 1000, limit: 2000, stats: cache }, pids_stats: { current: 7 },
});

test('container CPU starts unknown, then reports wall-time deltas with one core at 100 percent including real zero', () => {
  let wall = 0n;
  const sampler = new MetricsSampler(() => wall);
  assert.equal(sampler.sample('p', 'container', 'boot1', stats(100, 0)).cpuPercent, null);
  wall = 1_000_000_000n;
  const busy = sampler.sample('p', 'container', 'boot1', stats(2_500_000_100, 1));
  assert.equal(busy.cpuPercent, 250); assert.equal(busy.available, true); assert.equal(busy.pids, 7);
  wall = 2_000_000_000n;
  assert.equal(sampler.sample('p', 'container', 'boot1', stats(2_500_000_100, 2)).cpuPercent, 0);
});

test('CPU samples reset on container replacement, same-container restart and counter reset; old responses never replace the baseline', () => {
  let wall = 0n;
  const sampler = new MetricsSampler(() => wall);
  sampler.sample('p', 'one', 'boot1', stats(100, 0));
  wall = 1_000_000_000n; assert.equal(sampler.sample('p', 'one', 'boot1', stats(200_000_100, 1)).cpuPercent, 20);
  wall = 2_000_000_000n; assert.equal(sampler.sample('p', 'one', 'boot1', stats(50, 0.5)).cpuPercent, null);
  wall = 3_000_000_000n; assert.equal(sampler.sample('p', 'one', 'boot1', stats(600_000_100, 3)).cpuPercent, 20);
  wall = 4_000_000_000n; assert.equal(sampler.sample('p', 'one', 'boot2', stats(900_000_100, 4)).cpuPercent, null);
  wall = 5_000_000_000n; assert.equal(sampler.sample('p', 'two', 'boot2', stats(100, 5)).cpuPercent, null);
  wall = 6_000_000_000n; assert.equal(sampler.sample('p', 'two', 'boot2', stats(10, 6)).cpuPercent, null);
  wall = 7_000_000_000n; assert.equal(sampler.sample('p', 'two', 'boot2', stats(10, 7)).cpuPercent, 0);
});

test('failed, stopped and malformed samples expose no old values and require a fresh CPU baseline', () => {
  let wall = 0n;
  const sampler = new MetricsSampler(() => wall, () => '2026-10-17T01:00:00.000Z');
  sampler.sample('p', 'one', 'boot', stats(100, 0));
  assert.deepEqual(sampler.unavailable('p'), { available: false, sampledAt: '2026-10-17T01:00:00.000Z', errorCode: 'METRICS_UNAVAILABLE' });
  wall = 1_000_000_000n; assert.equal(sampler.sample('p', 'one', 'boot', stats(200, 1)).cpuPercent, null);
  assert.equal(sampler.sample('p', 'one', 'boot', {}).errorCode, 'METRICS_INVALID_RESPONSE');
  wall = 2_000_000_000n; assert.equal(sampler.sample('p', 'one', 'boot', stats(300, 2)).cpuPercent, null);
  assert.equal(sampler.unavailable('p', 'PROFILE_NOT_RUNNING').cpuUsageNs, undefined);
});

test('memory matches Docker working-set accounting for cgroup v1/v2 and safely falls back for absent or invalid cache', () => {
  const sampler = new MetricsSampler();
  for (const [cache, expected] of [
    [{ total_inactive_file: 200, inactive_file: 300 }, 800],
    [{ inactive_file: 300 }, 700], [{}, 1000],
    [{ total_inactive_file: -1, inactive_file: -2 }, 1000],
    [{ total_inactive_file: 2000, inactive_file: NaN }, 1000],
    [{ total_inactive_file: 2000, inactive_file: 300 }, 700],
  ] as const) {
    const sample = sampler.sample('p', 'one', 'boot', stats(0, 0, cache));
    assert.equal(sample.memoryBytes, expected); assert.equal(sample.memoryUsageBytes, 1000); assert.equal(sample.memoryLimitBytes, 2000);
  }
});

test('sample time is Docker read time and duplicate read timestamps neither invent zero CPU nor advance the baseline', () => {
  let wall = 0n;
  const sampler = new MetricsSampler(() => wall, () => '2099-01-01T00:00:00Z');
  const first = sampler.sample('p', 'one', 'boot', stats(0, 0));
  assert.equal(first.sampledAt, new Date(origin).toISOString());
  wall = 1_000_000_000n; assert.equal(sampler.sample('p', 'one', 'boot', stats(0, 0)).cpuPercent, null);
  wall = 2_000_000_000n; assert.equal(sampler.sample('p', 'one', 'boot', stats(1_000_000_000, 2)).cpuPercent, 50);
});

test('late old-container samples cannot replace a new identity baseline and profile status work is coalesced', async () => {
  let wall = 0n;
  const sampler = new MetricsSampler(() => wall);
  sampler.sample('p', 'new', 'new-start', stats(0, 10));
  wall = 500_000_000n;
  const obsolete = sampler.sample('p', 'old', 'old-start', stats(900_000_000, 9));
  assert.equal(obsolete.available, false); assert.equal(obsolete.memoryBytes, undefined);
  wall = 1_000_000_000n;
  assert.equal(sampler.sample('p', 'new', 'new-start', stats(1_000_000_000, 11)).cpuPercent, 100);
  const requests = new MetricsRequests();
  let entered!: () => void, release!: () => void, calls = 0;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const first = requests.run('p', async () => { calls++; entered(); await new Promise<void>(resolve => { release = resolve; }); return 'first'; });
  await waiting;
  const overlapping = requests.run('p', async () => { calls++; return 'must-not-run'; });
  release(); assert.deepEqual(await Promise.all([first, overlapping]), ['first', 'first']); assert.equal(calls, 1);
  assert.equal(await requests.run('p', async () => 'next'), 'next');
  await assert.rejects(requests.run('p', async () => { throw new Error('sampling failed'); }), /sampling failed/);
  assert.equal(await requests.run('p', async () => 'after-failure'), 'after-failure');
});
