import { useEffect, useState } from "react";
import { api, type HostMetrics } from "./api";
import { Icon } from "./components";
import { formatCpuPercent, formatMemoryBytes, METRICS_STALE_AFTER_MS } from "./resource-metrics";
import "./host-metrics.css";

export default function HostResourceMetrics() {
  const [metrics, setMetrics] = useState<HostMetrics>();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let active = true, fetching = false;
    const refresh = async () => {
      if (fetching || document.visibilityState !== "visible") return;
      fetching = true;
      try {
        const value = await api<HostMetrics>("/host-metrics");
        if (active) { setMetrics(value); setNow(Date.now()); }
      } catch {
        if (active) setMetrics({ scope: "host", available: false, errorCode: "METRICS_UNAVAILABLE" });
      } finally { fetching = false; }
    };
    const visible = () => { setNow(Date.now()); void refresh(); };
    void refresh();
    const timer = window.setInterval(visible, 3000);
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, []);

  const age = Math.max(now, Date.now()) - Date.parse(metrics?.sampledAt || "");
  const stale = metrics?.errorCode === "METRICS_STALE" || (metrics?.available && (!Number.isFinite(age) || age > METRICS_STALE_AFTER_MS || age < -3000));
  const live = metrics?.scope === "host" && metrics.available && !stale;
  const pending = !metrics || metrics.errorCode === "METRICS_NOT_SAMPLED";
  const fallback = pending ? "采样中" : stale ? "已过期" : "不可用";
  const cpuValid = live && typeof metrics.cpuPercent === "number" && Number.isFinite(metrics.cpuPercent) && metrics.cpuPercent >= 0 && metrics.cpuPercent <= 100;
  const memoryValid = live && typeof metrics.memoryBytes === "number" && Number.isFinite(metrics.memoryBytes) && metrics.memoryBytes >= 0 && typeof metrics.memoryTotalBytes === "number" && Number.isFinite(metrics.memoryTotalBytes) && metrics.memoryTotalBytes > 0 && metrics.memoryBytes <= metrics.memoryTotalBytes;
  const cpu = cpuValid ? formatCpuPercent(metrics.cpuPercent) : live ? "采样中" : fallback;
  const memory = memoryValid ? formatCpuPercent(metrics.memoryBytes! / metrics.memoryTotalBytes! * 100) : live ? "采样中" : fallback;
  const state = cpuValid && memoryValid ? "live" : live || pending ? "sampling" : stale ? "stale" : "unavailable";

  return <section className="host-metrics" aria-label="宿主机资源使用" data-host-metrics-state={state} title="宿主机整体 CPU 和内存占用，每 3 秒更新。">
    <div className="host-metrics-heading"><span>宿主机</span><small>每 3 秒更新</small></div>
    <div className="host-metric"><span><Icon name="cpu" size={15} />CPU</span><strong>{cpu}</strong></div>
    <div className="host-metric"><span><Icon name="memory" size={15} />内存</span><strong>{memory}</strong>{memoryValid && <small>{formatMemoryBytes(metrics.memoryBytes)} / {formatMemoryBytes(metrics.memoryTotalBytes)}</small>}</div>
  </section>;
}
