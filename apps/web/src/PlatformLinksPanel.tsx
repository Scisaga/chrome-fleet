import { useEffect, useState, type FormEvent } from "react";
import { api, message, safeDesktopPath, type ManualSession, type Platform, type PlatformAccount, type Profile } from "./api";
import { Button, Empty, Field, Modal, Notice } from "./components";
import { accountsChanged, PlatformAccountList } from "./PlatformAccounts";
import { loadPlatforms } from "./PlatformsPage";

export default function PlatformLinksPanel({ profile }: { profile: Profile }) {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [show, setShow] = useState(false);
  const [selectedPlatformId, setSelectedPlatformId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [loginError, setLoginError] = useState("");
  const [confirming, setConfirming] = useState<PlatformAccount>();
  useEffect(() => { if (show) void loadPlatforms().then(setPlatforms).catch(failure => setError(message(failure))); }, [show]);
  const linked = profile.platformAccounts || [];
  const available = platforms.filter(platform => !platform.builtin && platform.enabled && !linked.some(account => account.platformId === platform.id));
  async function link(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy("link"); setError("");
    const form = new FormData(event.currentTarget);
    try {
      await api(`/profiles/${profile.id}/platforms/${form.get("platformId")}`, "POST", { googleAccountId: profile.googleBinding?.accountId, confirmedGoogleSignup: form.has("confirmed") });
      setShow(false); accountsChanged();
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(""); }
  }
  async function unlink(platformId: string) {
    setBusy(platformId); setError("");
    try { await api(`/profiles/${profile.id}/platforms/${platformId}`, "DELETE"); accountsChanged(); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(""); }
  }
  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirming) return;
    const form = new FormData(event.currentTarget);
    setBusy("confirm"); setError("");
    try {
      await api(`/profiles/${profile.id}/platforms/${confirming.platformId}/confirm`, "POST", {
        identity: String(form.get("identity") || "").trim(), nickname: String(form.get("nickname") || "").trim(),
        confirmedLoggedIn: form.has("confirmedLoggedIn"),
      });
      setConfirming(undefined); accountsChanged();
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(""); }
  }
  async function openLogin(platformId: string) {
    const popup = window.open("about:blank", "_blank");
    if (popup) { popup.opener = null; popup.document.body.textContent = "正在准备平台登录桌面…"; }
    setBusy(platformId); setLoginError("");
    try {
      const session = await api<ManualSession & { message?: string }>(`/profiles/${profile.id}/platforms/${platformId}/login`, "POST", {});
      const path = safeDesktopPath(session.desktopPath);
      if (popup) popup.location.replace(path);
      window.dispatchEvent(new CustomEvent("fleet-platform-desktop", { detail: { ...session, profileId: profile.id, desktopPath: path, popup } }));
      accountsChanged();
    } catch (failure) { popup?.close(); setLoginError(message(failure)); }
    finally { setBusy(""); }
  }
  return <section className="panel platform-links-panel">
    <div className="panel-heading"><div><h2>关联平台</h2><p className="muted small">登记通过此 Google 首次登录创建的账户。在此实例桌面完成登录后，填写账号 ID 并人工确认。</p></div><Button icon="plus" disabled={!profile.googleBinding || profile.archived} onClick={() => { setError(""); setLoginError(""); setSelectedPlatformId(""); setShow(true); }}>登记关联平台</Button></div>
    {!profile.googleBinding && <Notice>请先绑定 Google 目录账号。</Notice>}
    {error && !show && !confirming && <p className="error" role="alert">{error}</p>}
    {loginError && !show && <p className="error" role="alert">{loginError}</p>}
    {linked.length ? <PlatformAccountList accounts={linked}>{account => <>
      <Button variant={account.confirmationState === "confirmed" ? "default" : "primary"} disabled={!account.enabled || Boolean(busy) || profile.archived} onClick={() => { setError(""); setConfirming(account); }}>{account.confirmationState === "confirmed" ? "更新登录确认" : "确认已登录"}</Button>
      <Button disabled={!account.enabled || Boolean(busy) || profile.archived || profile.headless} onClick={() => void openLogin(account.platformId)}>打开桌面登录</Button>
      <details className="platform-addresses"><summary>登录与账户页地址</summary><p>请在此实例桌面的 Chrome 中自行访问：</p><p>登录：<span>{account.loginUrl}</span></p><p>账户：<span>{account.accountUrl}</span></p></details>
      <Button disabled={Boolean(busy) || profile.archived} onClick={() => void unlink(account.platformId)}>解除关联</Button>
    </>}</PlatformAccountList> : <Empty title="尚未登记关联平台"><p>先在平台管理添加平台，再在此登记关联。</p></Empty>}
    {confirming && <Modal title="人工确认平台登录" subtitle={confirming.platformName} onClose={() => setConfirming(undefined)}>
      <form onSubmit={event => void confirm(event)}>
        <Notice>请先在此浏览器实例中核对已登录账号。此操作仅保存人工确认记录。</Notice>
        <Field label="平台账号 ID" hint={confirming.expectedIdentity ? "账号已绑定；更换账号需先解除原关联。" : "填写平台的唯一账号 ID 或邮箱。"}><input name="identity" required maxLength={256} defaultValue={confirming.expectedIdentity} readOnly={Boolean(confirming.expectedIdentity)} /></Field>
        <Field label="昵称（选填）"><input name="nickname" maxLength={256} defaultValue={confirming.nickname} /></Field>
        <label className="check-field"><input name="confirmedLoggedIn" type="checkbox" required />我已在此浏览器实例中核对，上述平台账号已登录。</label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions"><Button type="button" onClick={() => setConfirming(undefined)}>取消</Button><Button type="submit" variant="primary" busy={busy === "confirm"}>保存人工确认</Button></div>
      </form>
    </Modal>}
    {show && <Modal title="登记关联平台" subtitle={profile.googleBinding?.email} onClose={() => setShow(false)}>
      <form onSubmit={event => void link(event)}><Field label="关联平台"><select name="platformId" aria-label="关联平台" required value={selectedPlatformId} onChange={event => setSelectedPlatformId(event.target.value)}><option value="" disabled>选择已启用的平台</option>{available.map(platform => <option key={platform.id} value={platform.id}>{platform.name}</option>)}</select></Field>
        {!available.length && <p>暂无可选平台，请先在「平台管理」新增并启用平台。</p>}
        <Button type="button" icon="desktop" disabled={!selectedPlatformId || Boolean(busy)} onClick={() => void openLogin(selectedPlatformId)}>先打开桌面登录</Button>
        {selectedPlatformId && <p className="muted small platform-addresses">登录入口：{platforms.find(platform => platform.id === selectedPlatformId)?.loginUrl}</p>}
        <p className="muted small">在此实例桌面中自行打开平台登录入口，使用 Google 首次创建账户后登记关联。</p>
        {loginError && <p className="error" role="alert">{loginError}</p>}
        <label className="check-field"><input name="confirmed" type="checkbox" required />确认此平台账户是通过 {profile.googleBinding?.email} 首次登录创建的。</label>
        <p className="muted small">登记后可填写平台账号 ID 并人工确认登录。解除关联仅移除管理记录。</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions"><Button type="button" onClick={() => setShow(false)}>取消</Button><Button type="submit" variant="primary" busy={busy === "link"} disabled={!available.length}>登记关联</Button></div>
      </form>
    </Modal>}
  </section>;
}
