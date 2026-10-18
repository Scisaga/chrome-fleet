import { z } from "zod";
import type { Store } from "@chrome-fleet/core";
import { FleetError, type Job } from "@chrome-fleet/contracts";
import type { Principal } from "./auth.js";

const querySchema = z.object({
  profileId: z.string().max(128).optional(),
  createdFrom: z.iso.datetime({ offset: true }).optional(),
  createdBefore: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  cursor: z.string().max(1024).optional(),
});
const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.string().min(1).max(128) });
const created = "json_extract(value, '$.createdAt')";
const profile = "json_extract(value, '$.profileId')";

function filters(principal: Principal, input: unknown) {
  const query = querySchema.parse(input);
  const where = ["collection = 'jobs'"];
  const values: (string | number)[] = [];
  if (!principal.profiles.includes("*")) {
    where.push(principal.profiles.length ? `${profile} IN (${principal.profiles.map(() => "?").join(",")})` : "0");
    values.push(...principal.profiles);
  }
  if (query.profileId) { where.push(`${profile} = ?`); values.push(query.profileId); }
  if (query.createdFrom) { where.push(`${created} >= ?`); values.push(new Date(query.createdFrom).toISOString()); }
  if (query.createdBefore) { where.push(`${created} < ?`); values.push(new Date(query.createdBefore).toISOString()); }
  if (query.createdFrom && query.createdBefore && Date.parse(query.createdFrom) >= Date.parse(query.createdBefore))
    throw new FleetError("INVALID_DATE_RANGE", "开始时间必须早于结束时间");
  return { query, where: where.join(" AND "), values };
}

function encodeCursor(job: Pick<Job, "createdAt" | "id">) {
  return Buffer.from(JSON.stringify({ createdAt: job.createdAt, id: job.id })).toString("base64url");
}

export function jobPage(store: Store, principal: Principal, input: unknown) {
  const { query, where, values } = filters(principal, input);
  const total = Number((store.db.prepare(`SELECT COUNT(*) AS total FROM records WHERE ${where}`).get(...values) as { total: number }).total);
  let pageWhere = where;
  const pageValues = [...values];
  if (query.cursor) {
    if (query.offset) throw new FleetError("INVALID_CURSOR", "游标不能与 offset 同时使用");
    let cursor;
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString())); }
    catch { throw new FleetError("INVALID_CURSOR", "任务分页游标无效，请重新筛选"); }
    pageWhere += ` AND (${created} < ? OR (${created} = ? AND id < ?))`;
    pageValues.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const rows = store.db.prepare(`SELECT value FROM records WHERE ${pageWhere} ORDER BY ${created} DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...pageValues, query.limit + 1, query.offset) as { value: string }[];
  const jobs = rows.slice(0, query.limit).map(row => JSON.parse(row.value) as Job);
  return { jobs, total, limit: query.limit, offset: query.offset, nextCursor: rows.length > query.limit ? encodeCursor(jobs.at(-1)!) : null };
}

export function jobDensity(store: Store, principal: Principal, input: unknown) {
  const { query, where, values } = filters(principal, input);
  if (!query.createdFrom || !query.createdBefore)
    throw new FleetError("INVALID_DATE_RANGE", "请提供任务密度统计的开始和结束时间");
  const from = Date.parse(query.createdFrom), before = Date.parse(query.createdBefore);
  const span = before - from, intervalMs = 3_600_000;
  const buckets = Array.from({ length: Math.ceil(span / intervalMs) }, (_, index) => ({
    start: new Date(from + index * intervalMs).toISOString(),
    end: new Date(Math.min(before, from + (index + 1) * intervalMs)).toISOString(),
    total: 0, counts: Object.create(null) as Record<string, number>,
  }));
  const rows = store.db.prepare(`SELECT CAST((unixepoch(${created}, 'subsec') * 1000 - ?) / ? AS INTEGER) AS bucket, json_extract(value, '$.kind') AS kind, COUNT(*) AS count FROM records WHERE ${where} GROUP BY bucket, kind`)
    .all(from, intervalMs, ...values) as { bucket: number; kind: string; count: number }[];
  const totals: Record<string, number> = Object.create(null);
  let total = 0;
  for (const row of rows) {
    const bucket = buckets[row.bucket];
    if (!bucket) continue;
    const kind = row.kind || "automation";
    bucket.counts[kind] = (bucket.counts[kind] || 0) + row.count;
    bucket.total += row.count;
    totals[kind] = (totals[kind] || 0) + row.count;
    total += row.count;
  }
  return { total, intervalMs, kinds: Object.keys(totals).sort().map(kind => ({ kind, total: totals[kind] })), buckets };
}
