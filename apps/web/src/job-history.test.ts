import assert from "node:assert/strict";
import test from "node:test";
import { jobHistoryQuery, jobRangeError, recentJobRange, mergeJobs } from "./job-history";

test("default seven calendar days use Shanghai midnight across month and UTC boundaries", () => {
  const range = recentJobRange(7, Date.parse("2026-02-28T16:30:00.000Z"));
  assert.deepEqual(range, { start: "2026-02-23", end: "2026-03-01" });
  const query = new URLSearchParams(jobHistoryQuery(range, "cf_test"));
  assert.equal(query.get("createdFrom"), "2026-02-22T16:00:00.000Z");
  assert.equal(query.get("createdBefore"), "2026-03-01T16:00:00.000Z");
  assert.equal(query.get("profileId"), "cf_test");
  assert.deepEqual(recentJobRange(1, Date.parse("2026-10-17T16:00:00.000Z")), { start: "2026-10-18", end: "2026-10-18" });
});

test("invalid and reversed dates cannot be committed to a filter", () => {
  for (const range of [{ start: "", end: "2026-10-18" }, { start: "2026-02-30", end: "2026-10-18" }, { start: "2026-10-19", end: "2026-10-18" }]) assert.ok(jobRangeError(range));
  assert.equal(jobRangeError({ start: "2026-10-18", end: "2026-10-18" }), "");
});

test("refresh merges statuses without discarding older pages or duplicating IDs", () => {
  const old = { id: "job_a", profileId: "cf_test", createdAt: "2026-10-17T01:00:00.000Z", status: "running" };
  const newer = { ...old, id: "job_b", createdAt: "2026-10-18T01:00:00.000Z" };
  const older = { ...old, id: "job_c", createdAt: "2026-10-16T01:00:00.000Z" };
  const result = mergeJobs([old, older], [newer, { ...old, status: "succeeded" }]);
  assert.deepEqual(result.map(job => job.id), ["job_b", "job_a", "job_c"]);
  assert.equal(result[1].status, "succeeded");
});
