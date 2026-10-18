import assert from "node:assert/strict";
import test from "node:test";
import { HostMetricsSampler } from "../../apps/control-plane/src/host-metrics.js";
import { metricsMaxAgeMs } from "../../apps/control-plane/src/metrics.js";
import { fixture } from "./helpers/fleet.js";

const GiB = 1024 ** 3;
const stat = (values: number[], guest = 0, cores = 2) => `cpu ${values.join(" ")} ${guest} ${guest}\n` + Array.from({ length: cores }, (_, index) => `cpu${index} 0 0 0 0 0 0 0 0\n`).join("");
const meminfo = (available = 10 * GiB, total = 16 * GiB) => `MemTotal: ${total / 1024} kB\nMemFree: 524288 kB\nMemAvailable: ${available / 1024} kB\nCached: 9961472 kB\n`;
const initial = [100, 20, 80, 700, 50, 10, 20, 20];

test("host CPU uses interval deltas over all cores and memory uses available RAM rather than container limits or free RAM", async () => {
  let cpu = stat(initial, 1000);
  const sampler = new HostMetricsSampler(async file => file === "/proc/stat" ? cpu : meminfo());
  await sampler.refresh();
  assert.equal(sampler.snapshot().cpuPercent, null);
  assert.equal(sampler.snapshot().memoryBytes, 6 * GiB);
  assert.equal(sampler.snapshot().memoryTotalBytes, 16 * GiB);
  assert.equal(sampler.snapshot().memoryPercent, 37.5);
  cpu = stat([140, 20, 100, 820, 70, 10, 20, 20], 20000);
  await sampler.refresh();
  assert.equal(sampler.snapshot().scope, "host");
  assert.equal(sampler.snapshot().cpuPercent, 30, "guest CPU must not be counted again");
  assert.equal(sampler.snapshot().cpuCount, 2);
});

test("measured idle/full CPU remains zero/100 and counter resets or core changes require a new baseline", async () => {
  let cpu = stat([100, 0, 0, 900, 0, 0, 0, 0]);
  const sampler = new HostMetricsSampler(async file => file === "/proc/stat" ? cpu : meminfo(16 * GiB));
  await sampler.refresh();
  cpu = stat([100, 0, 0, 1000, 0, 0, 0, 0]); await sampler.refresh();
  assert.equal(sampler.snapshot().cpuPercent, 0);
  assert.equal(sampler.snapshot().memoryBytes, 0);
  cpu = stat([200, 0, 0, 1000, 0, 0, 0, 0]); await sampler.refresh();
  assert.equal(sampler.snapshot().cpuPercent, 100);
  await sampler.refresh(); assert.equal(sampler.snapshot().cpuPercent, null);
  cpu = stat([1, 0, 0, 9, 0, 0, 0, 0]); await sampler.refresh();
  assert.equal(sampler.snapshot().cpuPercent, null);
  cpu = stat([5, 0, 0, 15, 0, 0, 0, 0], 0, 3); await sampler.refresh();
  assert.equal(sampler.snapshot().cpuPercent, null);
});

test("failed or malformed host reads discard old live values, omit diagnostics, and reset CPU sampling", async () => {
  let invalid = "";
  const sampler = new HostMetricsSampler(async file => {
    if (invalid === "error") throw new Error("synthetic-sensitive-diagnostic");
    if (file === "/proc/stat") return invalid === "cpu" ? "cpu invalid\n" : stat(initial);
    return invalid === "memory" ? "MemTotal: 1000 kB\nMemFree: 100 kB\n" : meminfo();
  });
  for (const fault of ["error", "cpu", "memory"]) {
    invalid = ""; await sampler.refresh(); assert.equal(sampler.snapshot().available, true);
    invalid = fault; await sampler.refresh();
    assert.deepEqual(sampler.snapshot(), { scope: "host", available: false, errorCode: "METRICS_UNAVAILABLE" });
    invalid = ""; await sampler.refresh(); assert.equal(sampler.snapshot().cpuPercent, null);
  }
});

test("cached reads never resample, expire old values, or expose a mutable shared snapshot", async () => {
  let clock = Date.parse("2026-10-18T00:00:00.000Z"), reads = 0;
  const sampler = new HostMetricsSampler(async file => { reads++; return file === "/proc/stat" ? stat(initial) : meminfo(); }, () => clock);
  await sampler.refresh();
  const snapshot = sampler.snapshot(); snapshot.memoryBytes = -1;
  assert.equal(sampler.snapshot().memoryBytes, 6 * GiB);
  assert.equal(reads, 2);
  clock += metricsMaxAgeMs + 1;
  assert.equal(sampler.snapshot().errorCode, "METRICS_STALE");
  assert.equal(sampler.snapshot().cpuPercent, undefined);
  assert.equal(sampler.snapshot().memoryBytes, undefined);
  assert.equal(reads, 2);
});

test("host metrics endpoint requires read permission and reads cached data without touching Runner, Chrome, or records", async () => {
  const f = await fixture();
  try {
    let reads = 0;
    f.service.hostMetrics = new HostMetricsSampler(async file => { reads++; return file === "/proc/stat" ? stat(initial) : meminfo(); });
    f.service.runner.call = async () => { throw new Error("HOST_METRICS_MUST_NOT_CALL_RUNNER"); };
    assert.equal((await f.request("GET", "/api/v1/host-metrics", undefined, "")).statusCode, 401);
    const denied = f.auth.issue(["automate"], ["*"], new Date(Date.now() + 60000).toISOString());
    assert.equal((await f.request("GET", "/api/v1/host-metrics", undefined, denied.token)).statusCode, 403);
    await f.service.hostMetrics.refresh();
    assert.equal(reads, 2);
    const before = f.service.db.db.prepare("SELECT collection,id,value FROM records ORDER BY collection,id").all();
    for (let index = 0; index < 3; index++) {
      const response = await f.request("GET", "/api/v1/host-metrics");
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.json().data.memoryBytes, 6 * GiB);
    }
    assert.equal(reads, 2);
    assert.deepEqual(f.service.db.db.prepare("SELECT collection,id,value FROM records ORDER BY collection,id").all(), before);
    assert.equal(f.starts.size, 0);
  } finally { await f.close(); }
});

test("host sampling continues every three seconds while container sampling is pending and stops on close", async t => {
  const f = await fixture();
  try {
    t.mock.timers.enable({ apis: ["setInterval"] });
    let refreshes = 0;
    f.service.hostMetrics.refresh = async () => { refreshes++; };
    const pending: (() => void)[] = [];
    f.service.refreshMetrics = () => new Promise<void>(resolve => pending.push(resolve));
    f.service.tick = async () => undefined;
    f.service.startWorker(); assert.equal(refreshes, 1);
    t.mock.timers.tick(3000); assert.equal(refreshes, 2);
    t.mock.timers.tick(3000); assert.equal(refreshes, 3);
    f.service.close();
    t.mock.timers.tick(3000); assert.equal(refreshes, 3);
    pending.forEach(resolve => resolve());
  } finally { t.mock.timers.reset(); await f.close(); }
});
