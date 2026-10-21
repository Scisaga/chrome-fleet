import { useEffect, useState } from "react";
import { api, message, type Profile } from "./api";
import { Button, Notice } from "./components";
import { GoogleAccountPicker, GoogleLoginProgress, GoogleMark } from "./GoogleLogin";
import { bindingProgress } from "./google-binding";
import { browserMode } from "./browser-mode";
import { AccountLoginCredentials } from "./AccountCredentials";

export default function VncGoogleBindingPanel({ profile, reload, notify, onLogin, onConfirm, onOpenDesktop, busy, confirming }: {
  profile: Profile;
  reload: () => Promise<void>;
  notify: (message: string, error?: boolean) => void;
  onLogin: (accountId?: string) => void;
  onConfirm: () => void;
  onOpenDesktop: () => void;
  busy: boolean;
  confirming: boolean;
}) {
  const binding = profile.googleBinding;
  const [editing, setEditing] = useState(false);
  const [accountId, setAccountId] = useState(binding?.accountId || "");
  const [saving, setSaving] = useState(false);
  useEffect(() => { setAccountId(binding?.accountId || ""); setEditing(false); }, [profile.id, binding?.accountId]);
  async function save() {
    if (!accountId || saving) return;
    setSaving(true);
    try {
      await api(`/profiles/${profile.id}/google-binding`, "PUT", { accountId });
      await reload();
      setEditing(false);
      notify("Google 账号绑定已保存。保存映射不会打开 Chrome，也不表示已登录；登录后请点击「确认已登录」。");
    } catch (error) { notify(message(error), true); }
    finally { setSaving(false); }
  }
  return (
    <section className="panel google-account-panel vnc-google-binding-panel">
      <div className="panel-heading vnc-google-binding-panel__heading">
        <div className="google-account-panel-title"><GoogleMark /><div><h2>Google 账号绑定与登录确认</h2><p>一个 Chrome 绑定一个 Google 账号，绑定和登录确认分别记录。</p></div></div>
        {binding && <Button onClick={() => setEditing((value) => !value)} disabled={saving || confirming}>换绑账号</Button>}
      </div>
      {binding && <>
        <GoogleLoginProgress value={bindingProgress(binding)} mode={browserMode(profile)} onConfirm={profile.archived ? undefined : onConfirm} confirmBusy={confirming} />
        <AccountLoginCredentials account={{ id: binding.accountId, email: binding.email }} notify={notify} />
        <div className="heading-actions vnc-google-binding-panel__actions">
          <Button className="google-login-button" disabled={busy || profile.headless || profile.archived} onClick={() => onLogin(binding.accountId)}><GoogleMark />Google 登录</Button>
          <Button disabled={busy || profile.headless || profile.archived} onClick={onOpenDesktop}>打开桌面</Button>
        </div>
      </>}
      {(!binding || editing) && <div className="google-binding-editor vnc-google-binding-panel__editor">
        <GoogleAccountPicker profileId={profile.id} value={accountId} onChange={setAccountId} mode={browserMode(profile)} />
        <Notice>{binding ? "换绑会清除原账号的人工登录确认。保存仅更改此 Chrome 的账号映射，不操作浏览器；请明确选择新的目录账号。" : "先选择目录账号并保存绑定。绑定不会登录或检测 Google，保存后可以打开桌面自行登录，也可以直接确认已经完成的登录。"}</Notice>
        <div className="form-actions">
          {binding && <Button onClick={() => { setAccountId(binding.accountId); setEditing(false); }}>取消换绑</Button>}
          <Button variant="primary" busy={saving} disabled={!accountId || (binding?.accountId === accountId)} onClick={() => void save()}>{binding ? "保存换绑" : "保存绑定"}</Button>
        </div>
      </div>}
      <p className="google-login-guidance">确认已登录只保存人工记录，浏览器模式和桌面会话保持不变。请在此实例的桌面中自行访问 https://accounts.google.com/ 完成登录。</p>
    </section>
  );
}
