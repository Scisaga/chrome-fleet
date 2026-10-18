import { useCallback, useEffect, useRef, useState } from "react";
import { api, message, type Job } from "./api";
import { mergeJobs, type JobDensity, type JobPage } from "./job-history";

export function useJobHistory(query: string) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [density, setDensity] = useState<JobDensity>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const [moreError, setMoreError] = useState("");
  const [densityError, setDensityError] = useState("");
  const commands = useRef({ refresh: async () => {}, more: async () => {} });

  useEffect(() => {
    let active = true, waitingMore = false, initialized = false;
    let loaded: Job[] = [], cursor: string | null = null;
    let jobsRequest: Promise<void> | undefined, densityRequest: Promise<void> | undefined;
    setJobs([]); setTotal(0); setDensity(undefined); setError(""); setMoreError(""); setDensityError("");
    setLoading(true); setLoadingMore(false); setHasMore(false);

    const fetchPage = (next?: string | null) => api<JobPage>(`/jobs?${query}&limit=30${next ? `&cursor=${encodeURIComponent(next)}` : ""}`);
    const readJobs = (more = false): Promise<void> => {
      if (jobsRequest) return jobsRequest;
      if (!active || (more && !cursor)) return Promise.resolve();
      const initial = !initialized;
      if (more) setLoadingMore(true);
      else if (initial) setLoading(true);
      jobsRequest = (async () => {
        try {
          const page = await fetchPage(more ? cursor : undefined);
          let incoming = page.items;
          if (!more && loaded.length) {
            // Catch up across a burst of new tasks before merging the existing history.
            const known = new Set(loaded.map(job => job.id));
            let next = page.nextCursor;
            while (next && !incoming.some(job => known.has(job.id))) {
              if (!active) return;
              const gap = await fetchPage(next);
              incoming = incoming.concat(gap.items);
              next = gap.nextCursor;
            }
            const received = new Set(incoming.map(job => job.id));
            const pending = loaded.filter(job => !received.has(job.id) && ["queued", "running", "waiting_for_human"].includes(job.state || job.status || ""));
            const updates = await Promise.allSettled(pending.map(job => api<Job>(`/jobs/${encodeURIComponent(job.id)}`)));
            for (const update of updates) if (update.status === "fulfilled") incoming.push(update.value);
          }
          if (!active) return;
          if (more || initial) cursor = page.nextCursor || null;
          initialized = true;
          loaded = mergeJobs(loaded, incoming);
          setJobs(loaded); setTotal(page.total); setHasMore(Boolean(cursor)); setError("");
          if (more || initial) setMoreError("");
        } catch (error) {
          if (active) (more ? setMoreError : setError)(message(error));
        } finally {
          jobsRequest = undefined;
          if (active) { setLoading(false); setLoadingMore(false); }
        }
      })();
      return jobsRequest;
    };
    const readDensity = (): Promise<void> => {
      if (densityRequest) return densityRequest;
      densityRequest = (async () => {
        try {
          const result = await api<JobDensity>(`/jobs/density?${query}`);
          if (active) { setDensity(result); setDensityError(""); }
        } catch (error) { if (active) setDensityError(message(error)); }
        finally { densityRequest = undefined; }
      })();
      return densityRequest;
    };
    commands.current = {
      refresh: async () => { await Promise.all([readJobs(), readDensity()]); },
      more: async () => {
        if (waitingMore) return;
        waitingMore = true;
        try { await jobsRequest; if (active) await readJobs(true); }
        finally { waitingMore = false; }
      },
    };
    void commands.current.refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !jobsRequest && !waitingMore) void commands.current.refresh();
    }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [query]);

  const refresh = useCallback(() => commands.current.refresh(), []);
  const loadMore = useCallback(() => commands.current.more(), []);
  return { jobs, total, density, loading, loadingMore, hasMore, error, moreError, densityError, refresh, loadMore };
}
