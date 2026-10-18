import type { Profile } from "./api";

export const METRICS_STALE_AFTER_MS = 12_000;

function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function formatMemoryBytes(value?: number | null): string {
  if (!validNumber(value)) return "—";
  const unit = value >= 1024 ** 3 ? "GiB" : "MiB";
  const amount = value / (unit === "GiB" ? 1024 ** 3 : 1024 ** 2);
  return `${Number(amount.toFixed(1))} ${unit}`;
}

export function formatCpuPercent(value?: number | null): string {
  return validNumber(value) ? `${value.toFixed(1)}%` : "—";
}

export function resourceMetrics(profile: Pick<Profile, "state" | "metrics">, nowMs = Date.now()) {
  const metrics = profile.metrics;
  const common = { cpuLabel: "—", memoryLabel: "—", sampledAt: undefined as string | undefined };
  if (profile.state !== "running") return { ...common, status: "stopped" as const, cpuLabel: "未运行", memoryLabel: "未运行", caption: "启动后每 3 秒采样" };
  if (!metrics || metrics.available === undefined) return { ...common, status: "sampling" as const, cpuLabel: "采样中", memoryLabel: "采样中", caption: "等待首次采样 · 每 3 秒更新" };
  const sampledMs = metrics.sampledAt ? Date.parse(metrics.sampledAt) : NaN;
  const sampledAt = Number.isFinite(sampledMs) ? metrics.sampledAt : undefined;
  if (metrics.errorCode === "METRICS_STALE") return { ...common, sampledAt, status: "stale" as const, cpuLabel: "已过期", memoryLabel: "已过期", caption: "采样已过期 · 等待更新" };
  if (!metrics.available) return { ...common, sampledAt, status: "unavailable" as const, cpuLabel: "不可用", memoryLabel: "不可用", caption: "资源采样不可用 · 每 3 秒重试" };
  if (!Number.isFinite(sampledMs) || nowMs - sampledMs > METRICS_STALE_AFTER_MS || sampledMs - nowMs > 3_000) return { ...common, sampledAt, status: "stale" as const, cpuLabel: "已过期", memoryLabel: "已过期", caption: "采样已过期 · 等待更新" };
  const cpuLabel = validNumber(metrics.cpuPercent) ? formatCpuPercent(metrics.cpuPercent) : "采样中";
  const memory = formatMemoryBytes(metrics.memoryBytes);
  const memoryLabel = memory === "—" ? "采样中" : validNumber(metrics.memoryLimitBytes) && metrics.memoryLimitBytes > 0 ? `${memory} / ${formatMemoryBytes(metrics.memoryLimitBytes)}` : memory;
  const status = cpuLabel === "采样中" || memoryLabel === "采样中" ? "sampling" as const : "live" as const;
  return { status, cpuLabel, memoryLabel, sampledAt, caption: status === "live" ? "每 3 秒更新" : "采样中 · 每 3 秒更新" };
}
