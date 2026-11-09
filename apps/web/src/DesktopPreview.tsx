import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Profile, ManualSession } from './api';
import { Icon } from './components';
import { remainingDesktopTime } from './desktop-workspace';
import { desktopFramePreviews } from './desktop-frame-previews';

export default function DesktopPreview({ profile, session, disabled, onOpen }: { profile: Profile; session?: ManualSession; disabled: boolean; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const image = useRef<string | undefined>(undefined);
  const [frame, setFrame] = useState<{ url: string; sampledAt: string }>();
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const vncFrame = useSyncExternalStore(desktopFramePreviews.subscribe, () => desktopFramePreviews.get(profile.id));
  const legacy = profile.state === 'running' && profile.health?.ready === true && profile.health.desktopPreviewAvailable !== true;
  useEffect(() => () => {
    if (image.current) URL.revokeObjectURL(image.current);
    image.current = undefined;
  }, [profile.id]);
  useEffect(() => {
    let disposed = false, visible = false, pending: AbortController | undefined;
    let nextSample = 0;
    const clear = () => {
      if (image.current) URL.revokeObjectURL(image.current);
      image.current = undefined;
      if (!disposed) setFrame(undefined);
    };
    if (profile.archived) { clear(); desktopFramePreviews.forget(profile.id); setLoading(false); }
    if (legacy) setLoading(false);
    const sample = async () => {
      if (disposed || !visible || document.visibilityState !== 'visible' || pending || profile.archived || profile.headless) return;
      if (legacy) return;
      const controller = new AbortController(); pending = controller;
      try {
        const response = await fetch(`/profiles/${encodeURIComponent(profile.id)}/desktop/preview`, {
          credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        });
        if ([401, 403].includes(response.status)) {
          clear(); desktopFramePreviews.forget(profile.id); setDenied(true);
          if (response.status === 401) window.dispatchEvent(new Event('fleet-session-expired'));
          return;
        }
        if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'image/png') return;
        const sampledAt = response.headers.get('x-fleet-preview-sampled-at');
        if (!sampledAt || !Number.isFinite(Date.parse(sampledAt))) return;
        const blob = await response.blob();
        if (disposed || controller.signal.aborted || blob.size > 1024 * 1024) return;
        const url = URL.createObjectURL(blob);
        const previous = image.current; image.current = url;
        setFrame({ url, sampledAt }); setDenied(false);
        if (previous) URL.revokeObjectURL(previous);
      } catch { /* Preserve the last successful frame while the service is unavailable. */ }
      finally {
        if (!disposed) setLoading(false);
        if (pending === controller) pending = undefined;
      }
    };
    const refresh = () => { nextSample = Date.now() + 5000; void sample(); };
    const observer = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      if (visible) refresh(); else pending?.abort();
    });
    if (ref.current) observer.observe(ref.current);
    const visibility = () => { if (document.visibilityState === 'visible') refresh(); else pending?.abort(); };
    const requested = (event: Event) => {
      if ((event as CustomEvent<string>).detail === profile.id) refresh();
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('fleet-preview-refresh', requested);
    const timer = setInterval(() => {
      if (!visible || document.visibilityState !== 'visible') return;
      setNow(Date.now());
      if (profile.state === 'running' && profile.health?.desktopPreviewAvailable === true && Date.now() >= nextSample) refresh();
    }, 1000);
    return () => {
      disposed = true; observer.disconnect(); clearInterval(timer); pending?.abort();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('fleet-preview-refresh', requested);
    };
  }, [profile.id, profile.state, profile.headless, profile.archived, profile.health?.desktopPreviewAvailable, legacy]);
  const preview = denied ? undefined : vncFrame && (!frame || Date.parse(vncFrame.sampledAt) > Date.parse(frame.sampledAt)) ? vncFrame : frame;
  const stopped = profile.state === 'stopped';
  const stale = preview && now - Date.parse(preview.sampledAt) > 15000;
  const label = stopped ? '已停止' : preview ? stale ? '画面较旧' : '最近画面' : legacy ? session ? '正在读取桌面画面' : '打开桌面后可预览' : loading ? '加载中' : '预览不可用';
  return <button ref={ref} className="desktop-preview" type="button" disabled={disabled || denied}
    onClick={onOpen} aria-label={`${stopped ? '启动并打开' : '打开'} ${profile.name} 的桌面`}
    data-preview-source={preview ? preview === vncFrame ? 'vnc' : 'agent' : undefined}
    data-preview-state={stopped ? 'stopped' : preview ? stale ? 'stale' : 'live' : legacy ? session ? 'loading' : 'legacy' : loading ? 'loading' : 'unavailable'}>
    {preview ? <img src={preview.url} alt={`${profile.name} 最近一次桌面画面`} /> : <span className="desktop-preview__empty"><Icon name="desktop" size={30} /><span>{denied ? '无桌面查看权限' : profile.headless ? '无头实例' : stopped ? '实例已停止' : legacy ? session ? '正在读取已有桌面…' : '旧镜像：打开桌面后可预览' : loading ? '正在读取桌面…' : '预览不可用'}</span></span>}
    {session && <span className="desktop-preview__lease">人工接管中 · 剩余 {remainingDesktopTime(session.expiresAt, now)}</span>}
    <span className="desktop-preview__status"><span className="small-dot" />{label}{preview && <time dateTime={preview.sampledAt}>更新于 {new Date(preview.sampledAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</time>}</span>
    <span className="desktop-preview__open"><Icon name="desktop" />{stopped ? '启动并打开' : '进入桌面'}</span>
  </button>;
}
