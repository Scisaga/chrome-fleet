import assert from "node:assert/strict";
import test from "node:test";
import { METRICS_STALE_AFTER_MS, formatCpuPercent, formatMemoryBytes, resourceMetrics } from "./resource-metrics";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const now = Date.parse("2026-10-17T02:00:00.000Z");
type Input = Parameters<typeof resourceMetrics>[0];
const fresh = (changes: Input["metrics"] = {}): Input => ({
  state: "running",
  metrics: { available: true, sampledAt: new Date(now).toISOString(), cpuPercent: 200.5, memoryBytes: 512 * MiB, memoryLimitBytes: 2 * GiB, ...changes },
});

test("resource formatters preserve zero, readable binary units and CPU above one core", () => {
  assert.equal(formatMemoryBytes(0), "0 MiB");
  assert.equal(formatMemoryBytes(512 * MiB), "512 MiB");
  assert.equal(formatMemoryBytes(1.5 * GiB), "1.5 GiB");
  assert.equal(formatMemoryBytes(12.34 * MiB), "12.3 MiB");
  assert.equal(formatCpuPercent(0), "0.0%");
  assert.equal(formatCpuPercent(200.5), "200.5%");
  for (const invalid of [undefined, null, -1, NaN, Infinity, -Infinity]) {
    assert.equal(formatMemoryBytes(invalid), "—");
    assert.equal(formatCpuPercent(invalid), "—");
  }
});

test("every nonrunning state hides old measurements before interpreting availability or timestamps", () => {
  for (const state of ["stopped", "starting", "stopping", "error"]) {
    const result = resourceMetrics({ ...fresh({ available: false, errorCode: "METRICS_STALE" }), state }, now);
    assert.equal(result.status, "stopped");
    assert.equal(result.cpuLabel, "未运行");
    assert.equal(result.memoryLabel, "未运行");
    assert.equal(result.sampledAt, undefined);
  }
});

test("missing samples and legacy cumulative CPU fields cannot be presented as live measurements", () => {
  for (const profile of [{ state: "running" }, fresh({ available: undefined, cpuUsageNs: 9_000_000_000 })]) {
    const result = resourceMetrics(profile, now);
    assert.equal(result.status, "sampling");
    assert.equal(result.cpuLabel, "采样中");
    assert.equal(result.memoryLabel, "采样中");
    assert.equal(result.sampledAt, undefined);
  }
});

test("unavailable samples conceal retained numbers and backend stale errors retain the stale distinction", () => {
  const unavailable = resourceMetrics(fresh({ available: false, errorCode: "DOCKER_UNAVAILABLE" }), now);
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.cpuLabel, "不可用");
  assert.equal(unavailable.memoryLabel, "不可用");
  const stale = resourceMetrics(fresh({ available: false, errorCode: "METRICS_STALE" }), now);
  assert.equal(stale.status, "stale");
  assert.equal(stale.cpuLabel, "已过期");
  assert.equal(stale.memoryLabel, "已过期");
  assert.equal(stale.sampledAt, new Date(now).toISOString());
});

test("missing, invalid, expired and implausibly future timestamps never expose old values as live", () => {
  for (const sampledAt of [undefined, "invalid-date", new Date(now - METRICS_STALE_AFTER_MS - 1).toISOString(), new Date(now + 3001).toISOString()]) {
    const result = resourceMetrics(fresh({ sampledAt }), now);
    assert.equal(result.status, "stale");
    assert.equal(result.cpuLabel, "已过期");
    assert.equal(result.memoryLabel, "已过期");
  }
  for (const sampledAt of [new Date(now - METRICS_STALE_AFTER_MS).toISOString(), new Date(now + 3000).toISOString()]) {
    assert.equal(resourceMetrics(fresh({ sampledAt }), now).status, "live");
  }
});

test("fresh first-frame CPU absence or invalid values show sampling while preserving usable memory", () => {
  for (const cpuPercent of [undefined, null, -1, NaN, Infinity]) {
    const result = resourceMetrics(fresh({ cpuPercent }), now);
    assert.equal(result.status, "sampling");
    assert.equal(result.cpuLabel, "采样中");
    assert.equal(result.memoryLabel, "512 MiB / 2 GiB");
  }
});

test("missing or invalid memory cannot become a false zero even when CPU is usable", () => {
  for (const memoryBytes of [undefined, -1, NaN, Infinity]) {
    const result = resourceMetrics(fresh({ memoryBytes }), now);
    assert.equal(result.status, "sampling");
    assert.equal(result.cpuLabel, "200.5%");
    assert.equal(result.memoryLabel, "采样中");
  }
});

test("fresh measured zero is live and multicore CPU percentages are never clamped to 100", () => {
  const zero = resourceMetrics(fresh({ cpuPercent: 0, memoryBytes: 0 }), now);
  assert.equal(zero.status, "live");
  assert.equal(zero.cpuLabel, "0.0%");
  assert.equal(zero.memoryLabel, "0 MiB / 2 GiB");
  const multi = resourceMetrics(fresh(), now);
  assert.equal(multi.status, "live");
  assert.equal(multi.cpuLabel, "200.5%");
  assert.equal(multi.memoryLabel, "512 MiB / 2 GiB");
  assert.equal(multi.sampledAt, new Date(now).toISOString());
});

test("zero, absent or invalid limits omit the denominator without discarding a valid memory sample", () => {
  for (const memoryLimitBytes of [0, undefined, -1, NaN, Infinity]) {
    const result = resourceMetrics(fresh({ memoryBytes: 1.5 * GiB, memoryLimitBytes }), now);
    assert.equal(result.status, "live");
    assert.equal(result.memoryLabel, "1.5 GiB");
  }
});
