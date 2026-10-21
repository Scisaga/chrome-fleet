import type { Job } from "./api";

export interface JobDateRange { start: string; end: string }
export interface JobPage { items: Job[]; total: number; nextCursor: string | null }
export interface JobDensity {
  total: number;
  intervalMs: number;
  kinds: { kind: string; total: number }[];
  buckets: { start: string; end: string; total: number; counts: Record<string, number> }[];
}

const kindNames: Record<string, string> = {
  automation: "浏览器自动化", start: "启动实例", stop: "关闭实例", restart: "重启实例",
  archive: "归档实例", browser_mode: "切换浏览器模式", proxy_test: "代理出口测试",
  accounts_check: "历史账号检测（已移除）", cookies_export: "导出 Cookies", cookies_import: "导入 Cookies",
  "storage-state_export": "导出站点状态", "storage-state_import": "导入站点状态",
  snapshot: "完整会话快照", restore: "恢复完整快照", update_check: "检查浏览器更新",
  update_apply: "受控浏览器更新", update_rollback: "浏览器回滚",
};
const colors = ["#7764d8", "#46a99a", "#e4a24d", "#508bd5", "#c779a5", "#6479b4", "#c96d62", "#8aa84a", "#9b72bd", "#48a9bf", "#b99b32", "#d37b45", "#4e9a70", "#a1765b", "#bb6585", "#517f9d", "#9a8dcd"];
export const jobKind = (value = "automation") => Object.hasOwn(kindNames, value) ? kindNames[value] : value;
export function jobColor(kind: string) {
  const index = Object.keys(kindNames).indexOf(kind);
  if (index >= 0) return colors[index];
  let hash = 0;
  for (const character of kind) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 48% 54%)`;
}

export function recentJobRange(days = 7, time = Date.now()): JobDateRange {
  const end = new Date(time + 8 * 3_600_000).toISOString().slice(0, 10);
  const start = new Date(Date.parse(`${end}T00:00:00+08:00`) - (days - 1) * 86_400_000 + 8 * 3_600_000).toISOString().slice(0, 10);
  return { start, end };
}
export function jobRangeError(range: JobDateRange) {
  const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!validDate(range.start) || !validDate(range.end)) return "请选择完整的开始和结束日期。";
  return range.start > range.end ? "开始日期不能晚于结束日期。" : "";
}
export function jobHistoryQuery(range: JobDateRange, profileId?: string) {
  const before = Date.parse(`${range.end}T00:00:00+08:00`) + 86_400_000;
  const params = new URLSearchParams({
    createdFrom: new Date(`${range.start}T00:00:00+08:00`).toISOString(),
    createdBefore: new Date(before).toISOString(),
  });
  if (profileId) params.set("profileId", profileId);
  return params.toString();
}
export function mergeJobs(current: Job[], incoming: Job[]) {
  const byId = new Map(current.map(job => [job.id, job]));
  for (const job of incoming) byId.set(job.id, job);
  return [...byId.values()].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "") || b.id.localeCompare(a.id));
}
