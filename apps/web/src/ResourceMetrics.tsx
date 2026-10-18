import { useEffect, useState } from "react";
import type { Profile } from "./api";
import { Icon } from "./components";
import { resourceMetrics } from "./resource-metrics";
import "./resource-metrics.css";

export default function ResourceMetrics({ profile, detail = false }: { profile: Profile; detail?: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (profile.state !== "running") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 3_000);
    return () => window.clearInterval(timer);
  }, [profile.id, profile.state]);
  const value = resourceMetrics(profile, Math.max(now, Date.now()));
  const sampleTime = value.sampledAt ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Shanghai" }).format(new Date(value.sampledAt)) : undefined;
  return <section className={`resource-metrics ${detail ? "resource-metrics-detail" : "resource-metrics-card"}`} data-metrics-state={value.status} aria-label="容器资源使用">
    <div className="resource-metrics-values">
      <div className="resource-metric"><span title="单核满载为 100%，多核可超过 100%"><Icon name="cpu" size={15} />CPU</span><strong>{value.cpuLabel}</strong></div>
      <div className="resource-metric"><span title="工作集 / 容器上限，已扣除可回收文件缓存"><Icon name="memory" size={15} />内存</span><strong>{value.memoryLabel}</strong></div>
    </div>
    <p className="resource-metrics-caption">{value.caption}{sampleTime && <> · <time dateTime={value.sampledAt} title={value.sampledAt}>采样 {sampleTime}</time></>}</p>
    {detail && <p className="resource-metrics-note">CPU 以单核 100% 计，多核可超过 100%；内存显示工作集 / 容器上限，已扣除可回收文件缓存。</p>}
  </section>;
}
