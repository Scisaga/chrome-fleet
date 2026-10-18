import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers/fleet.js";

const range = new URLSearchParams({ createdFrom: "2026-10-11T16:00:00.000Z", createdBefore: "2026-10-18T16:00:00.000Z" });
const makeJob = (id: string, profileId: string, createdAt: string, kind = "automation") => ({
  id, profileId, createdAt, kind, status: "succeeded", progress: 100, payload: { secret: "fixture-private-payload" }, principal: "fixture-private-principal", fencingToken: 123,
});

test("task pagination covers more than 100 jobs, uses inclusive/exclusive dates and survives inserts with tied timestamps", async () => {
  const f = await fixture();
  try {
    const p = await f.create();
    for (let i = 0; i < 135; i++) {
      const job = makeJob(`job_${String(i).padStart(4, "0")}`, p.id, "2026-10-12T01:00:00.000Z");
      f.service.db.set("jobs", job.id, job);
    }
    for (const [id, time] of [["job_start", "2026-10-11T16:00:00.000Z"], ["job_before", "2026-10-11T15:59:59.999Z"], ["job_end", "2026-10-18T16:00:00.000Z"]])
      f.service.db.set("jobs", id, makeJob(id, p.id, time));
    const first = await f.request("GET", `/api/v1/jobs?${range}&limit=30`);
    assert.equal(first.statusCode, 200);
    const page = first.json().data;
    assert.equal(page.total, 136); assert.equal(page.items.length, 30); assert.ok(page.nextCursor);
    assert.equal(page.items[0].id, "job_0134");
    assert.equal(first.body.includes("fixture-private"), false);
    assert.equal(first.body.includes("fencingToken"), false);
    f.service.db.set("jobs", "job_new", makeJob("job_new", p.id, "2026-10-18T01:00:00.000Z"));
    const seen = page.items.map((job: { id: string }) => job.id);
    let cursor = page.nextCursor;
    while (cursor) {
      const response = await f.request("GET", `/api/v1/jobs?${range}&limit=30&cursor=${encodeURIComponent(cursor)}`);
      assert.equal(response.statusCode, 200);
      const next = response.json().data;
      assert.equal(next.total, 137);
      seen.push(...next.items.map((job: { id: string }) => job.id)); cursor = next.nextCursor;
    }
    assert.equal(seen.length, 136); assert.equal(new Set(seen).size, 136);
    assert.ok(seen.includes("job_start")); assert.equal(seen.includes("job_new"), false);
    const offset = (await f.request("GET", `/api/v1/jobs?${range}&offset=1&limit=30`)).json().data;
    assert.equal(offset.items[0].id, "job_0134");
  } finally { await f.close(); }
});

test("density counts the full authorized range and zero buckets, with exact bin and midnight boundaries", async () => {
  const f = await fixture();
  try {
    const a = await f.create("visible"), b = await f.create("hidden");
    for (let i = 0; i < 135; i++) {
      const job = makeJob(`job_${i}`, a.id, "2026-10-11T16:00:00.000Z", i % 2 ? "start" : "automation");
      f.service.db.set("jobs", job.id, job);
    }
    for (const [id, pid, time, kind] of [
      ["job_edge", a.id, "2026-10-11T22:00:00.000Z", "stop"],
      ["job_last_ms", a.id, "2026-10-18T15:59:59.999Z", "stop"],
      ["job_hidden", b.id, "2026-10-12T01:00:00.000Z", "snapshot"],
      ["job_system", "system", "2026-10-12T01:00:00.000Z", "update_check"],
      ["job_end", a.id, "2026-10-18T16:00:00.000Z", "snapshot"],
    ]) f.service.db.set("jobs", id, makeJob(id, pid, time, kind));
    const token = f.auth.issue(["read"], [a.id], "2099-01-01T00:00:00.000Z").token;
    const response = await f.request("GET", `/api/v1/jobs/density?${range}&limit=1`, undefined, token);
    assert.equal(response.statusCode, 200);
    const data = response.json().data;
    assert.equal(data.total, 137); assert.equal(data.buckets.length, 168); assert.equal(data.intervalMs, 3_600_000);
    assert.equal(data.buckets[0].total, 135); assert.equal(data.buckets[6].counts.stop, 1);
    assert.equal(data.buckets[2].total, 0); assert.equal(data.buckets.at(-1).counts.stop, 1);
    assert.deepEqual(data.kinds, [{ kind: "automation", total: 68 }, { kind: "start", total: 67 }, { kind: "stop", total: 2 }]);
    assert.equal(data.buckets.reduce((sum: number, bucket: { total: number }) => sum + bucket.total, 0), data.total);
    assert.equal(response.body.includes("fixture-private"), false);
    const all = (await f.request("GET", `/api/v1/jobs/density?${range}`)).json().data;
    assert.equal(all.total, 139);
    for (const endpoint of ["/jobs", "/jobs/density"]) {
      const hidden = (await f.request("GET", `/api/v1${endpoint}?${range}&profileId=${b.id}`, undefined, token)).json().data;
      assert.equal(hidden.total, 0);
    }
    const emptyToken = f.auth.issue(["read"], [], "2099-01-01T00:00:00.000Z").token;
    assert.equal((await f.request("GET", `/api/v1/jobs/density?${range}`, undefined, emptyToken)).json().data.total, 0);
    const day = new URLSearchParams({ createdFrom: "2026-10-12T00:00:00+08:00", createdBefore: "2026-10-13T00:00:00+08:00" });
    const hourly = (await f.request("GET", `/api/v1/jobs/density?${day}&profileId=${a.id}`)).json().data;
    assert.equal(hourly.buckets.length, 24); assert.equal(hourly.buckets[0].total, 135); assert.equal(hourly.buckets[6].total, 1);
  } finally { await f.close(); }
});

test("bad dates and cursors fail explicitly and job endpoints require read scope", async () => {
  const f = await fixture();
  try {
    for (const path of ["/jobs?createdFrom=invalid", `/jobs?${range}&cursor=garbage`, `/jobs?${range}&cursor=e30&offset=1`, "/jobs?limit=101", "/jobs?createdFrom=2026-10-19T00:00:00Z&createdBefore=2026-10-18T00:00:00Z", "/jobs/density", "/jobs/density?createdFrom=2026-10-18T00:00:00Z"]) {
      assert.equal((await f.request("GET", `/api/v1${path}`)).statusCode, 400, path);
    }
    for (const endpoint of ["/jobs", "/jobs/density"]) {
      assert.equal((await f.request("GET", `/api/v1${endpoint}?${range}`, undefined, "")).statusCode, 401);
      const token = f.auth.issue(["manage"], ["*"], "2099-01-01T00:00:00.000Z").token;
      assert.equal((await f.request("GET", `/api/v1${endpoint}?${range}`, undefined, token)).statusCode, 403);
    }
  } finally { await f.close(); }
});
