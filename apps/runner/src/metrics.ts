export interface ContainerMetrics {
  available: boolean;
  sampledAt: string;
  cpuPercent?: number | null;
  cpuUsageNs?: number;
  memoryBytes?: number;
  memoryUsageBytes?: number;
  memoryLimitBytes?: number;
  pids?: number;
  errorCode?: 'METRICS_UNAVAILABLE' | 'METRICS_INVALID_RESPONSE' | 'PROFILE_NOT_RUNNING' | 'METRICS_STALE';
}
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** One core is 100%. Container identity prevents deltas crossing a restart. */
export class MetricsSampler {
  private previous = new Map<string, { identity: string; cpu: number; wall: bigint; read: number }>();
  constructor(private clock = () => process.hrtime.bigint(), private timestamp = () => new Date().toISOString()) {}
  unavailable(profileId: string, errorCode: NonNullable<ContainerMetrics['errorCode']> = 'METRICS_UNAVAILABLE'): ContainerMetrics {
    this.previous.delete(profileId);
    return { available: false, sampledAt: this.timestamp(), errorCode };
  }
  clear(profileId: string) { this.previous.delete(profileId); }
  sample(profileId: string, containerId: string, startedAt: string, stats: any): ContainerMetrics {
    const cpu = stats?.cpu_stats?.cpu_usage?.total_usage;
    const usage = stats?.memory_stats?.usage, limit = stats?.memory_stats?.limit;
    const read = typeof stats?.read === 'string' ? Date.parse(stats.read) : NaN;
    if (!nonnegative(cpu) || !nonnegative(usage) || !nonnegative(limit) || limit <= 0 || !containerId || !startedAt || !Number.isFinite(read))
      return this.unavailable(profileId, 'METRICS_INVALID_RESPONSE');
    const wall = this.clock(), identity = containerId + '\0' + startedAt;
    const previous = this.previous.get(profileId);
    if (previous && previous.identity !== identity && read <= previous.read)
      return { available: false, sampledAt: new Date(read).toISOString(), errorCode: 'METRICS_STALE' };
    let cpuPercent: number | null = null;
    if (previous?.identity === identity && read > previous.read && wall > previous.wall && cpu >= previous.cpu) {
      const percent = (cpu - previous.cpu) / Number(wall - previous.wall) * 100;
      if (Number.isFinite(percent)) cpuPercent = percent;
    }
    if (previous?.identity !== identity || read > previous.read)
      this.previous.set(profileId, { identity, cpu, wall, read });
    const cache = [stats.memory_stats?.stats?.total_inactive_file, stats.memory_stats?.stats?.inactive_file]
      .find(value => nonnegative(value) && value <= usage) ?? 0;
    return {
      available: true, sampledAt: new Date(read).toISOString(), cpuPercent, cpuUsageNs: cpu,
      memoryBytes: usage - cache, memoryUsageBytes: usage, memoryLimitBytes: limit,
      ...(nonnegative(stats?.pids_stats?.current) ? { pids: stats.pids_stats.current } : {}),
    };
  }
}

/** Coalesce a profile's full inspect+stats operation, including failures. */
export class MetricsRequests {
  private active = new Map<string, Promise<any>>();
  run<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    const active = this.active.get(profileId);
    if (active) return active;
    const request = Promise.resolve().then(operation).finally(() => {
      if (this.active.get(profileId) === request) this.active.delete(profileId);
    });
    this.active.set(profileId, request);
    return request;
  }
}
