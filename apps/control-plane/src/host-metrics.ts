import { readFile } from "node:fs/promises";
import { metricsMaxAgeMs } from "./metrics.js";

export interface HostMetrics {
  scope: "host";
  available: boolean;
  sampledAt?: string;
  cpuPercent?: number | null;
  cpuCount?: number;
  memoryBytes?: number;
  memoryTotalBytes?: number;
  memoryPercent?: number;
  errorCode?: string;
}

type ProcFile = "/proc/stat" | "/proc/meminfo";
type CpuSample = { total: number; idle: number; count: number };

function cpuSample(text: string): CpuSample {
  const values = text.match(/^cpu\s+(.+)$/m)?.[1].trim().split(/\s+/).slice(0, 8).map(Number);
  if (!values || values.length !== 8 || values.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error();
  // guest/guest_nice are already included in user/nice; do not count them twice.
  const total = values.reduce((sum, value) => sum + value, 0);
  const idle = values[3] + values[4];
  const count = text.match(/^cpu\d+\s/gm)?.length || 0;
  if (!Number.isSafeInteger(total) || total <= 0 || count === 0) throw new Error();
  return { total, idle, count };
}

function memorySample(text: string) {
  const total = Number(text.match(/^MemTotal:\s+(\d+)\s+kB\s*$/m)?.[1]) * 1024;
  const available = Number(text.match(/^MemAvailable:\s+(\d+)\s+kB\s*$/m)?.[1]) * 1024;
  if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(available) || available < 0 || available > total) throw new Error();
  const used = total - available;
  return { memoryBytes: used, memoryTotalBytes: total, memoryPercent: used / total * 100 };
}

/** Host-wide Linux counters, independent of container quotas and browser state. */
export class HostMetricsSampler {
  private previous?: CpuSample;
  private current: HostMetrics = { scope: "host", available: false, errorCode: "METRICS_NOT_SAMPLED" };
  private pending?: Promise<void>;

  constructor(
    private reader: (file: ProcFile) => Promise<string> = file => readFile(file, "utf8"),
    private clock: () => number = Date.now,
  ) {}

  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.sample().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async sample() {
    try {
      const [stat, meminfo] = await Promise.all([this.reader("/proc/stat"), this.reader("/proc/meminfo")]);
      const cpu = cpuSample(stat), memory = memorySample(meminfo);
      let cpuPercent: number | null = null;
      if (this.previous && this.previous.count === cpu.count) {
        const total = cpu.total - this.previous.total, idle = cpu.idle - this.previous.idle;
        if (total > 0 && idle >= 0 && idle <= total) cpuPercent = (total - idle) / total * 100;
      }
      this.previous = cpu;
      this.current = { scope: "host", available: true, sampledAt: new Date(this.clock()).toISOString(), cpuPercent, cpuCount: cpu.count, ...memory };
    } catch {
      this.previous = undefined;
      this.current = { scope: "host", available: false, errorCode: "METRICS_UNAVAILABLE" };
    }
  }

  snapshot(): HostMetrics {
    if (this.current.available) {
      const age = this.clock() - Date.parse(this.current.sampledAt!);
      if (age > metricsMaxAgeMs || age < -3000)
        return { scope: "host", available: false, sampledAt: this.current.sampledAt, errorCode: "METRICS_STALE" };
    }
    return { ...this.current };
  }
}
