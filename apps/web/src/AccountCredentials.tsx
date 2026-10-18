import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api, message, type GoogleAccountOption } from "./api";
import { Button, Field, Modal, Notice } from "./components";

type Notify = (text: string, error?: boolean) => void;
type CredentialAccount = Pick<GoogleAccountOption, "id" | "email" | "updatedAt">;

export function AccountLoginCredentials({ account, notify }: {
  account: CredentialAccount;
  notify: Notify;
}) {
  const emailId = useId();
  const emailInput = useRef<HTMLInputElement>(null);

  async function copyEmail() {
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(account.email);
        copied = true;
      }
    } catch { /* LAN HTTP can use the selected-input fallback. */ }
    if (!copied && emailInput.current) {
      emailInput.current.focus();
      emailInput.current.select();
      try { copied = document.execCommand("copy"); } catch { /* Keep the address selected. */ }
    }
    notify(copied ? "账号邮箱已复制。" : "请选中邮箱后手动复制。", !copied);
  }

  return (
    <div className="account-login-credentials" role="group" aria-label="账号登录资料">
      <div className="account-login-email">
        <label htmlFor={emailId}>账号邮箱</label>
        <input id={emailId} ref={emailInput} type="email" readOnly autoComplete="off" spellCheck={false} value={account.email} />
        <Button type="button" variant="ghost" icon="copy" aria-label="复制账号邮箱" onClick={() => void copyEmail()}>复制</Button>
      </div>
      <AccountPassword key={account.id} account={account} notify={notify} />
    </div>
  );
}

export function AccountPassword({ account, notify }: {
  account: CredentialAccount;
  notify: Notify;
}) {
  const [password, setPassword] = useState<string>();
  const [revealing, setRevealing] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  function hide() {
    generation.current++;
    setPassword(undefined);
    setRevealing(false);
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; };
  }, []);
  useEffect(() => { hide(); }, [account.id, account.updatedAt]);
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState !== "visible") hide(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  async function reveal() {
    const request = ++generation.current;
    setRevealing(true);
    try {
      const result = await api<{ password: string }>(
        `/google-accounts/${account.id}/password/reveal`, "POST", {},
      );
      if (mounted.current && generation.current === request) setPassword(result.password);
    } catch (error) {
      if (mounted.current && generation.current === request) notify(message(error), true);
    } finally {
      if (mounted.current && generation.current === request) setRevealing(false);
    }
  }

  async function copy() {
    if (password === undefined) return;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(password);
        copied = true;
      }
    } catch { /* LAN HTTP can use the selected-input fallback. */ }
    if (!copied && mounted.current && input.current) {
      input.current.focus();
      input.current.select();
      try { copied = document.execCommand("copy"); } catch { /* Keep the text selected. */ }
    }
    if (mounted.current) notify(copied ? "账号密码已复制。" : "请选中密码后手动复制。", !copied);
  }

  return (
    <div className="account-password">
      <span className="account-password-label">密码</span>
      <input
        ref={input}
        aria-label={`账号密码 ${account.email}`}
        readOnly
        autoComplete="off"
        spellCheck={false}
        type={password === undefined ? "password" : "text"}
        value={password ?? ""}
        placeholder="••••••••"
      />
      <Button
        type="button"
        variant="ghost"
        icon={password === undefined ? "eye" : "eye-off"}
        busy={revealing}
        aria-label={password === undefined ? "查看密码" : "隐藏密码"}
        onClick={() => password === undefined ? void reveal() : hide()}
      >
        {password === undefined ? "查看" : "隐藏"}
      </Button>
      {password !== undefined && <Button type="button" variant="ghost" icon="copy" aria-label="复制密码" title="复制密码" onClick={() => void copy()} />}
    </div>
  );
}

export function AccountEditor({ account, onClose, onSaved, notify }: {
  account?: GoogleAccountOption;
  onClose: () => void;
  onSaved: (account: GoogleAccountOption) => void;
  notify: Notify;
}) {
  const [email, setEmail] = useState(account?.email ?? "");
  const [recoveryEmail, setRecoveryEmail] = useState(account?.recoveryEmail ?? "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState !== "visible") setShowPassword(false); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const saved = await api<GoogleAccountOption>(
        account ? `/google-accounts/${account.id}` : "/google-accounts",
        account ? "PATCH" : "POST",
        account
          ? { recoveryEmail: recoveryEmail.trim(), ...(password ? { password } : {}) }
          : { email: email.trim(), password, recoveryEmail: recoveryEmail.trim() },
      );
      setPassword("");
      setShowPassword(false);
      onSaved(saved);
    } catch (error) {
      setError(message(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={account ? "编辑账号" : "新增账号"}
      subtitle={account ? account.email : "保存已有账号的登录资料"}
      onClose={() => { if (!saving) onClose(); }}
    >
      <form className="account-editor" onSubmit={(event) => void save(event)}>
        <Notice>这里管理已有账号的登录资料；保存密码只更新本系统记录。请先在 Google 修改密码，再来这里同步。</Notice>
        <Field label="账号邮箱" hint={account ? "邮箱是账号标识；其他邮箱请通过「新增账号」添加。" : undefined}>
          <input name="email" type="email" required maxLength={254} autoComplete="off" readOnly={Boolean(account)} disabled={saving} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@gmail.com" />
        </Field>
        {account && <AccountPassword account={account} notify={notify} />}
        <div className="account-editor-password">
          <Field label={account ? "新密码" : "密码"} hint={account ? "留空保留当前密码。" : "填写此账号当前使用的密码。"}>
            <input name="password" type={showPassword ? "text" : "password"} required={!account} maxLength={4096} autoComplete="new-password" spellCheck={false} disabled={saving} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={account ? "输入新密码，或留空保持不变" : "输入账号密码"} />
          </Field>
          <Button type="button" icon={showPassword ? "eye-off" : "eye"} disabled={saving} onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "隐藏输入密码" : "显示输入密码"}>
            {showPassword ? "隐藏" : "显示"}
          </Button>
        </div>
        <Field label="辅助邮箱（选填）">
          <input name="recoveryEmail" type="email" maxLength={254} autoComplete="off" disabled={saving} value={recoveryEmail} onChange={(event) => setRecoveryEmail(event.target.value)} placeholder="用于账号恢复的邮箱" />
        </Field>
        {error && <div className="account-manager-error" role="alert">{error}</div>}
        <div className="form-actions">
          <Button type="button" disabled={saving} onClick={onClose}>取消</Button>
          <Button type="submit" variant="primary" busy={saving} icon={account ? "check" : "plus"}>{account ? "保存修改" : "新增账号"}</Button>
        </div>
      </form>
    </Modal>
  );
}
