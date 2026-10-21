import { useEffect, useId, useState } from "react";
import { api, message, type Profile } from "./api";
import { browserMode, browserModeLabel, vncModeDescription, type BrowserMode } from "./browser-mode";
import { Button, Field, Icon, Notice } from "./components";

export default function BrowserModeSettings({ profile, reload, notify }: {
  profile: Profile;
  reload: () => Promise<void>;
  notify: (text: string, error?: boolean) => void;
}) {
  const current = browserMode(profile);
  const [selected, setSelected] = useState<BrowserMode>(current);
  const [busy, setBusy] = useState(false);
  const hintId = useId();
  useEffect(() => setSelected(current), [profile.id, current]);
  const locked = profile.archived || ["starting", "stopping", "updating"].includes(profile.state);
  async function change() {
    if (selected === current || busy || locked) return;
    setBusy(true);
    try {
      await api(`/profiles/${profile.id}/browser-mode`, "PUT", { browserMode: selected });
      notify("浏览器模式切换任务已提交。现有人工会话将结束，服务会正常停机、保存加密快照并重新启动实例。");
      await reload();
    } catch (error) { notify(message(error), true); }
    finally { setBusy(false); }
  }
  return (
    <section className="panel browser-mode-settings">
      <div className="panel-heading browser-mode-settings__heading"><div><h2>浏览器模式</h2><p>当前：{browserModeLabel(profile)}</p></div><Icon name="desktop" /></div>
      <div className="browser-mode-settings__controls">
        <Field label="浏览器模式">
          <select value={selected} aria-describedby={hintId} onChange={(event) => setSelected(event.target.value as BrowserMode)} disabled={busy || locked}>
            <option value="vnc">VNC · 普通 Chrome</option>
            <option value="automation">自动化模式 · 兼容网页任务</option>
          </select>
        </Field>
        <Button variant="primary" busy={busy} disabled={locked || selected === current} onClick={() => void change()}>
          {selected === current ? "当前模式" : selected === "vnc" ? "切换为 VNC 模式" : "切换为自动化模式"}
        </Button>
      </div>
      <p className="browser-mode-settings__hint" id={hintId}>切换会结束人工会话，正常关闭 Chrome、保存加密快照，并使用同一镜像重新启动。用户目录与账号映射会保留。</p>
      <Notice>{selected === "vnc" ? vncModeDescription : "自动化模式允许执行网页任务。Google 可能拒绝自动化浏览器中的重新登录；人工登录和验证请使用普通 Chrome（VNC 模式）。"}</Notice>
    </section>
  );
}
