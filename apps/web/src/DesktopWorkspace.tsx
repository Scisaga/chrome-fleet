import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ManualSession, Profile } from './api';
import { Button, Icon } from './components';
import { desktopStateLabels, remainingDesktopTime, retainDesktopConnections, type DesktopState } from './desktop-workspace';
import { desktopFramePreviews, thumbnailFromCanvas } from './desktop-frame-previews';

interface Props {
  sessions: ManualSession[]; profiles: Profile[]; activeId?: string; expanded: boolean;
  onSelect: (id: string) => void; onMinimize: () => void; onEnd: (id: string) => void;
  onExternal: (session: ManualSession) => void; onCollapseSidebar: () => void;
  loginProgress?: ReactNode;
}
export default function DesktopWorkspace(props: Props) {
  const { sessions, profiles, activeId, expanded, onSelect, onMinimize, onEnd, onExternal, onCollapseSidebar, loginProgress } = props;
  const [mounted, setMounted] = useState<string[]>([]);
  const [states, setStates] = useState<Record<string, DesktopState>>({});
  const [now, setNow] = useState(Date.now());
  const [fullscreen, setFullscreen] = useState(false);
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const host = useRef<HTMLElement>(null);
  const active = sessions.find(session => session.id === activeId);
  const ids = sessions.map(session => session.id).join(',');
  const runningIds = sessions.filter(session => {
    const profile = profiles.find(profile => profile.id === session.profileId);
    return !profile || (profile.state === 'running' && !profile.archived);
  }).map(session => session.id).join(',');
  const legacyIds = sessions.filter(session => {
    const profile = profiles.find(profile => profile.id === session.profileId);
    return profile?.state === 'running' && !profile.archived && !profile.headless && profile.health?.ready === true && profile.health.desktopPreviewAvailable !== true;
  }).map(session => session.id).join(',');
  useEffect(() => {
    const available = runningIds.split(',').filter(Boolean);
    setMounted(current => {
      const retained = current.filter(id => available.includes(id));
      if (activeId && expanded) return retainDesktopConnections(retained, activeId, available);
      // Restore existing leases read-only so legacy images can show previews without a restart.
      return retained.length ? retained : legacyIds.split(',').filter(Boolean).slice(-3);
    });
    setStates(current => Object.fromEntries(Object.entries(current).filter(([id]) => ids.split(',').includes(id))));
  }, [activeId, expanded, ids, runningIds, legacyIds]);
  const send = (id: string, action: string, enabled?: boolean) => {
    const session = sessions.find(session => session.id === id);
    if (session) frames.current.get(id)?.contentWindow?.postMessage({ type: 'fleet-desktop-command', action, active: enabled, profileId: session.profileId, sessionId: id }, window.location.origin);
  };
  useEffect(() => {
    for (const id of mounted) send(id, 'activate', expanded && id === activeId);
  }, [mounted, expanded, activeId]);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== 'fleet-desktop-state') return;
      const session = sessions.find(session => session.id === event.data.sessionId && session.profileId === event.data.profileId);
      if (!session || frames.current.get(session.id)?.contentWindow !== event.source) return;
      if (!Object.hasOwn(desktopStateLabels, event.data.state)) return;
      setStates(current => ({ ...current, [session.id]: event.data.state }));
      send(session.id, 'activate', expanded && session.id === activeId);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [sessions, expanded, activeId]);
  useEffect(() => {
    let disposed = false;
    const generation = desktopFramePreviews.generation;
    const pending = new Set<string>();
    const sample = async (id: string) => {
      if (disposed || document.visibilityState !== 'visible' || pending.has(id) || states[id] !== 'connected') return;
      const session = sessions.find(session => session.id === id);
      const profile = profiles.find(profile => profile.id === session?.profileId);
      if (!session || !profile || profile.state !== 'running' || profile.archived || profile.headless || profile.health?.desktopPreviewAvailable === true || Date.parse(session.expiresAt) <= Date.now()) return;
      const frame = frames.current.get(id);
      try {
        const canvas = frame?.contentDocument?.querySelector<HTMLCanvasElement>('#noVNC_container canvas, canvas');
        if (!canvas) return;
        pending.add(id);
        const sampledAt = new Date().toISOString();
        const blob = await thumbnailFromCanvas(canvas);
        if (!disposed && blob && generation === desktopFramePreviews.generation && frames.current.get(id) === frame && frame?.contentDocument === canvas.ownerDocument)
          desktopFramePreviews.put(profile.id, blob, sampledAt);
      } catch { /* A disconnected or navigated iframe has no usable framebuffer. */ }
      finally { pending.delete(id); }
    };
    const refresh = () => { for (const id of mounted) void sample(id); };
    refresh();
    const ready = setTimeout(refresh, 300);
    const timer = setInterval(refresh, 5000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('fleet-preview-refresh', refresh);
    return () => {
      disposed = true; clearTimeout(ready); clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('fleet-preview-refresh', refresh);
    };
  }, [mounted, states, ids, runningIds, legacyIds, expanded]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const changed = () => setFullscreen(Boolean(host.current && document.fullscreenElement === host.current));
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  useEffect(() => {
    if (!expanded && host.current && document.fullscreenElement === host.current) void document.exitFullscreen().catch(() => {});
  }, [expanded]);
  if (!sessions.length) return null;
  const state = active ? states[active.id] || 'connecting' : undefined;
  return <section ref={host} className={`desktop-workspace ${expanded ? 'is-expanded' : 'is-minimized'}`} aria-label="远程桌面工作区">
    <div className="desktop-workspace__bar">
      <div className="desktop-workspace__tabs" role="tablist" aria-label="已打开的桌面">
        {sessions.map(session => {
          const name = profiles.find(profile => profile.id === session.profileId)?.name || '浏览器';
          return <button key={session.id} type="button" role="tab" aria-selected={expanded && session.id === activeId}
            className={session.id === activeId ? 'is-current' : ''} onClick={() => onSelect(session.id)} title={`${name} · 剩余 ${remainingDesktopTime(session.expiresAt, now)}`}>
            <Icon name="desktop" size={16} /><span>{name}</span><i className={`desktop-connection-dot ${mounted.includes(session.id) ? states[session.id] || 'connecting' : 'parked'}`} />
          </button>;
        })}
      </div>
      {active && <div className="desktop-workspace__actions">
        <span className="desktop-workspace__status" role="status">{mounted.includes(active.id) ? desktopStateLabels[state!] : '已收起'} · 剩余 {remainingDesktopTime(active.expiresAt, now)}</span>
        {expanded && <>
          <Button onClick={onCollapseSidebar} icon="menu" title="折叠或展开导航" aria-label="折叠或展开导航" />
          <Button onClick={() => send(active.id, 'clipboard')} icon="copy" disabled={state !== 'connected'}>剪贴板</Button>
          {(state === 'error' || state === 'disconnected') && <Button onClick={() => send(active.id, 'reconnect')} icon="refresh">重新连接</Button>}
          <Button onClick={onMinimize} icon="grid">缩回卡片</Button>
          {document.fullscreenEnabled && <Button onClick={() => void (fullscreen ? document.exitFullscreen() : host.current?.requestFullscreen())?.catch(() => {})} icon="desktop">{fullscreen ? '退出全屏' : '全屏'}</Button>}
        </>}
        <details className="desktop-workspace__more"><summary>更多 <Icon name="chevron" size={14} /></summary><div>
          <button type="button" onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); onExternal(active); }}>在新窗口打开 <Icon name="external" size={14} /></button>
          <button type="button" onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); onEnd(active.id); }}>结束人工接管 <Icon name="stop" size={14} /></button>
        </div></details>
      </div>}
    </div>
    {expanded && loginProgress && <div className="desktop-workspace__login">{loginProgress}</div>}
    <div className="desktop-workspace__screens" hidden={!expanded}>
      {sessions.filter(session => mounted.includes(session.id)).map(session => {
        const id = session.id;
        return <iframe key={id} ref={element => { if (element) frames.current.set(id, element); else frames.current.delete(id); }}
          title="Chrome 实例远程桌面" data-session-id={id} src={session.desktopPath} referrerPolicy="no-referrer"
          hidden={id !== activeId || !expanded} tabIndex={id === activeId && expanded ? 0 : -1}
          onLoad={() => send(id, 'activate', expanded && id === activeId)} />;
      })}
      {active && !mounted.includes(active.id) && <div className="desktop-workspace__empty"><Icon name="desktop" size={36} /><p>桌面暂不可用，请检查实例运行状态。</p><Button onClick={onMinimize}>返回实例</Button></div>}
    </div>
  </section>;
}
