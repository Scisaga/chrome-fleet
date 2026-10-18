import { useState, type CSSProperties } from "react";
import { date } from "./api";
import { Button } from "./components";
import { jobColor, jobKind, jobRangeError, recentJobRange, type JobDateRange, type JobDensity } from "./job-history";
import "./job-history.css";

export default function JobTimeline({ range, onRangeChange, density, error, onRetry }: {
  range: JobDateRange;
  onRangeChange: (range: JobDateRange) => void;
  density?: JobDensity;
  error: string;
  onRetry: () => void;
}) {
  const [preset, setPreset] = useState("7");
  const [draft, setDraft] = useState(range);
  const [hovered, setHovered] = useState<number>();
  const [dateError, setDateError] = useState("");
  const changeDates = (next: JobDateRange) => {
    setDraft(next); setPreset("custom");
    const invalid = jobRangeError(next);
    setDateError(invalid);
    if (!invalid) { setHovered(undefined); onRangeChange(next); }
  };
  const buckets = density?.buckets || [];
  const max = Math.max(4, Math.ceil(Math.max(0, ...buckets.map(bucket => bucket.total)) / 4) * 4);
  const tickEvery = Math.max(1, Math.ceil(buckets.length / 7));
  const selected = hovered === undefined ? undefined : buckets[hovered];
  const interval = density ? "每小时" : "";
  const axisLabel = (value: string) => new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", ...(range.start === range.end ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : { month: "2-digit", day: "2-digit" }),
  }).format(new Date(value));
  return (
    <section className="panel job-timeline" aria-label="任务日期筛选与时间密度">
      <div className="job-range-controls">
        <label className="job-range-preset">
          <span>日期范围</span>
          <select aria-label="日期范围" value={preset} onChange={event => {
            const value = event.target.value;
            setPreset(value);
            if (value !== "custom") {
              const next = recentJobRange(Number(value));
              setDraft(next); setDateError(""); setHovered(undefined); onRangeChange(next);
            }
          }}>
            <option value="7">过去 7 天</option>
            <option value="30">过去 30 天</option>
            <option value="1">今天</option>
            <option value="custom">自定义范围</option>
          </select>
        </label>
        <div className="job-range-dates">
          <label><span>开始日期</span><input type="date" aria-label="开始日期" value={draft.start} max={draft.end || undefined} onChange={event => changeDates({ ...draft, start: event.target.value })} /></label>
          <span className="job-range-separator" aria-hidden="true">至</span>
          <label><span>结束日期</span><input type="date" aria-label="结束日期" value={draft.end} min={draft.start || undefined} onChange={event => changeDates({ ...draft, end: event.target.value })} /></label>
        </div>
        <span className="job-range-timezone">北京时间</span>
      </div>
      {dateError && <p className="form-error" role="alert">{dateError}</p>}
      <div className="job-timeline-heading">
        <div><h2>时间任务密度</h2><p>{interval ? `${interval}汇总 · 按任务类型分色` : "按任务创建时间汇总"}</p></div>
        {density && <span className="job-density-total">共 <strong>{density.total.toLocaleString("zh-CN")}</strong> 个任务</span>}
      </div>
      {error && <div className="job-density-error" role="alert"><span>统计加载失败：{error}</span><Button variant="ghost" onClick={onRetry}>重试统计</Button></div>}
      {!density ? !error && <div className="loading-inline job-density-loading" role="status"><span className="spinner" />正在统计任务密度…</div> : (
        <>
          <div className="job-density-chart" role="group" aria-label="时间任务密度图" onMouseLeave={() => setHovered(undefined)}>
            <div className="job-density-grid" aria-hidden="true">
              {[4, 3, 2, 1, 0].map(step => <div key={step} style={{ top: `${(4 - step) * 25}%` }}><span>{max * step / 4}</span></div>)}
            </div>
            <div className="job-density-columns" style={{ gridTemplateColumns: `repeat(${buckets.length}, minmax(0, 1fr))` }}>
              {buckets.map((bucket, index) => {
                const description = `${date(bucket.start)} 至 ${date(bucket.end)}，共 ${bucket.total} 个任务${density.kinds.filter(({ kind }) => bucket.counts[kind]).map(({ kind }) => `，${jobKind(kind)} ${bucket.counts[kind]} 个`).join("")}`;
                return <div key={bucket.start} className={`job-density-column${hovered === index ? " is-active" : ""}`} tabIndex={0} role="img" aria-label={description} data-total={bucket.total} onMouseEnter={() => setHovered(index)} onFocus={() => setHovered(index)} onBlur={() => setHovered(undefined)}>
                  <div className={`job-density-stack${bucket.total ? "" : " is-zero"}`} style={{ height: bucket.total ? `${bucket.total / max * 100}%` : 2 }}>
                    {density.kinds.filter(({ kind }) => bucket.counts[kind]).map(({ kind }) => <span key={kind} data-kind={kind} style={{ background: jobColor(kind), flexGrow: bucket.counts[kind] }} />)}
                  </div>
                  {index % tickEvery === 0 && <span className="job-density-tick" aria-hidden="true">{axisLabel(bucket.start)}</span>}
                </div>;
              })}
            </div>
            {density.total === 0 && <div className="job-density-empty">所选日期范围内暂无任务</div>}
            {selected && hovered !== undefined && <div className="job-density-tooltip" role="tooltip" style={{ "--tooltip-position": `${Math.min(82, Math.max(18, (hovered + 0.5) / buckets.length * 100))}%` } as CSSProperties}>
              <strong>{date(selected.start)} — {date(selected.end)}</strong>
              <span>共 {selected.total} 个任务</span>
              {density.kinds.filter(({ kind }) => selected.counts[kind]).map(({ kind }) => <div key={kind}><i style={{ background: jobColor(kind) }} /><span>{jobKind(kind)}</span><b>{selected.counts[kind]}</b></div>)}
            </div>}
          </div>
          {density.kinds.length > 0 && <ul className="job-density-legend" aria-label="任务类型图例">{density.kinds.map(({ kind, total }) => <li key={kind}><i style={{ background: jobColor(kind) }} /><span>{jobKind(kind)}</span><span className="muted">{total}</span></li>)}</ul>}
        </>
      )}
    </section>
  );
}
