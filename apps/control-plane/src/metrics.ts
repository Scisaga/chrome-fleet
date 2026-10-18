export const metricsIntervalMs = 3000;
export const metricsMaxAgeMs = 12000;
const errorCodes = new Set(['METRICS_NOT_SAMPLED', 'METRICS_UNAVAILABLE', 'METRICS_INVALID_RESPONSE', 'PROFILE_NOT_RUNNING', 'METRICS_STALE', 'RUNNER_UNAVAILABLE']);
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const timestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
export function unavailableMetrics(errorCode: string, sampledAt?: string) {
  return { available: false, ...(timestamp(sampledAt) ? { sampledAt } : {}), errorCode: errorCodes.has(errorCode) ? errorCode : 'METRICS_UNAVAILABLE' };
}
/** Pure read projection. Old/failed samples never retain live CPU or RAM fields. */
export function metricsView(profile: { state: string; metrics?: any; diskBytes?: number }, clock = Date.now()) {
  const raw = profile.metrics, sampledAt = timestamp(raw?.sampledAt);
  const disk = nonnegative(profile.diskBytes) ? { diskBytes: profile.diskBytes } : {};
  if (profile.state !== 'running') return { ...unavailableMetrics('PROFILE_NOT_RUNNING', sampledAt), ...disk };
  if (!raw || raw.available !== true) return { ...unavailableMetrics(raw?.errorCode || 'METRICS_NOT_SAMPLED', sampledAt), ...disk };
  if (!sampledAt || clock - Date.parse(sampledAt) > metricsMaxAgeMs || Date.parse(sampledAt) - clock > metricsMaxAgeMs)
    return { ...unavailableMetrics('METRICS_STALE', sampledAt), ...disk };
  if (!nonnegative(raw.memoryBytes) || !nonnegative(raw.memoryLimitBytes) || raw.memoryLimitBytes <= 0 ||
      !(raw.cpuPercent === null || nonnegative(raw.cpuPercent)))
    return { ...unavailableMetrics('METRICS_INVALID_RESPONSE', sampledAt), ...disk };
  return {
    available: true, sampledAt, cpuPercent: raw.cpuPercent,
    memoryBytes: raw.memoryBytes, memoryLimitBytes: raw.memoryLimitBytes,
    ...(nonnegative(raw.memoryUsageBytes) ? { memoryUsageBytes: raw.memoryUsageBytes } : {}),
    ...(nonnegative(raw.cpuUsageNs) ? { cpuUsageNs: raw.cpuUsageNs } : {}),
    ...(nonnegative(raw.pids) ? { pids: raw.pids } : {}), ...disk,
  };
}
