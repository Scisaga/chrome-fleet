// Documentation fixtures only. No service, account, or secret data is read.
export const fixedNow = "2026-10-18T01:12:00.000Z";
const hourMs = 3_600_000;
const firstDay = Date.parse("2026-10-12T00:00:00+08:00");

export function documentationJobs(profileId) {
  let seed = 20261018;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const hourly = [2, 1, 1, 0, 0, 1, 2, 5, 10, 18, 24, 20, 10, 16, 25, 29, 23, 15, 9, 6, 4, 3, 3, 2];
  const daily = [1, 1.12, 0.83, 1.19, 0.94, 0.32, 0.24];
  const now = Date.parse(fixedNow), records = [];
  const kinds = ["automation", "automation", "automation", "automation", "automation", "automation", "accounts_check", "accounts_check", "proxy_test", "start", "stop"];
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const start = firstDay + (day * 24 + hour) * hourMs;
      if (start >= now) continue;
      const count = Math.max(0, Math.round(hourly[hour] * daily[day] * (0.67 + random() * 0.66)));
      for (let slot = 0; slot < count; slot++) {
        const created = start + Math.floor((slot + 0.15 + random() * 0.6) / count * hourMs);
        const duration = 18_000 + Math.floor(random() * 112_000);
        if (created + duration >= now - 10 * 60_000) continue;
        const serial = records.length + 1;
        const kind = ((hour === 1 || hour === 22) && slot === 0) ? "snapshot" : kinds[Math.floor(random() * kinds.length)];
        const status = random() < 0.035 ? "failed" : random() < 0.015 ? "cancelled" : "succeeded";
        records.push({
          id: `job_${(Math.imul(serial, 2654435761) >>> 0).toString(16).padStart(8, "0")}_demo`,
          profileId: profileId([1, 1, 1, 4, 4, 3][Math.floor(random() * 6)]), kind,
          status, state: status, createdAt: new Date(created).toISOString(),
          finishedAt: new Date(created + duration).toISOString(),
          ...(kind === "automation" ? { steps: [{ action: "goto", url: "https://example.test" }, { action: "extractText", locator: { css: "h1" } }] } : {}),
          ...(status === "succeeded" ? { progress: 100, result: { text: "Example Domain" } } : {}),
          ...(status === "failed" ? { error: { code: "PAGE_TIMEOUT", message: "The example page did not respond in time." } } : {}),
        });
      }
    }
  }
  for (const [index, status] of ["running", "waiting_for_human"].entries()) {
    records.push({ id: `job_${index ? "b8d429f1" : "e52f61a3"}_demo`, profileId: profileId(index ? 4 : 1),
      kind: "automation", status, state: status, createdAt: new Date(now - (index ? 7 : 2) * 60_000).toISOString(),
      steps: [{ action: "goto", url: "https://example.test" }], progress: index ? 0 : 45,
      ...(index ? { reason: "Complete website verification in this instance's desktop, then resume the task." } : {}),
    });
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export function filterDocumentationJobs(jobs, params) {
  const from = params.has("createdFrom") ? Date.parse(params.get("createdFrom")) : -Infinity;
  const before = params.has("createdBefore") ? Date.parse(params.get("createdBefore")) : Infinity;
  return jobs.filter(job => (!params.has("profileId") || job.profileId === params.get("profileId"))
    && Date.parse(job.createdAt) >= from && Date.parse(job.createdAt) < before);
}

export function documentationDensity(jobs, params) {
  const from = Date.parse(params.get("createdFrom")), before = Date.parse(params.get("createdBefore"));
  if (!Number.isFinite(from) || !Number.isFinite(before) || before <= from || before - from > 90 * 24 * hourMs) throw new Error("Invalid documentation date range");
  const filtered = filterDocumentationJobs(jobs, params);
  const buckets = Array.from({ length: Math.ceil((before - from) / hourMs) }, (_, i) => ({
    start: new Date(from + i * hourMs).toISOString(), end: new Date(Math.min(before, from + (i + 1) * hourMs)).toISOString(), total: 0, counts: {},
  }));
  const totals = {};
  for (const job of filtered) {
    const bucket = buckets[Math.floor((Date.parse(job.createdAt) - from) / hourMs)];
    bucket.total++; bucket.counts[job.kind] = (bucket.counts[job.kind] || 0) + 1;
    totals[job.kind] = (totals[job.kind] || 0) + 1;
  }
  return { total: filtered.length, intervalMs: hourMs, buckets, kinds: Object.entries(totals).map(([kind, total]) => ({ kind, total })).sort((a, b) => b.total - a.total) };
}
