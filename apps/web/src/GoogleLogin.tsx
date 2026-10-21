import { useCallback, useEffect, useState } from "react";
import {
  api,
  items,
  message,
  date,
  type GoogleAccountOption,
  type GoogleLoginStatus,
  type Profile,
} from "./api";
import { Button, Field, Icon, Modal, Notice } from "./components";
import { browserMode, vncModeDescription, type BrowserMode } from "./browser-mode";

export function GoogleMark() {
  return (
    <svg
      className="google-mark"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        fill="#4285F4"
        d="M21.8 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.5a4.8 4.8 0 0 1-2.1 3.2v2.6h3.4c2-1.8 3-4.5 3-7.7Z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.8 0 5.2-.9 6.9-2.5l-3.4-2.6a6.2 6.2 0 0 1-9.2-3.2H2.8v2.7A10.4 10.4 0 0 0 12 22Z"
      />
      <path
        fill="#FBBC05"
        d="M6.3 13.7a6.3 6.3 0 0 1 0-3.4V7.6H2.8a10.4 10.4 0 0 0 0 8.8l3.5-2.7Z"
      />
      <path
        fill="#EA4335"
        d="M12 6.2c1.6 0 3 .5 4.1 1.6l3.1-3A10 10 0 0 0 12 2a10.4 10.4 0 0 0-9.2 5.6l3.5 2.7A6.2 6.2 0 0 1 12 6.2Z"
      />
    </svg>
  );
}

export function GoogleAccountPicker({
  profileId,
  value,
  onChange,
  refreshKey,
  mode = "automation",
}: {
  profileId: string;
  value: string;
  onChange: (value: string) => void;
  refreshKey?: string;
  mode?: BrowserMode;
}) {
  const [accounts, setAccounts] = useState<GoogleAccountOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const first = await api<{ items: GoogleAccountOption[]; total: number }>(
        "/google-accounts?limit=100",
      );
      const all = items<GoogleAccountOption>(first);
      while (all.length < first.total) {
        const next = items<GoogleAccountOption>(
          await api(`/google-accounts?limit=100&offset=${all.length}`),
        );
        if (!next.length) break;
        all.push(...next);
      }
      setAccounts(all);
      setError("");
    } catch (error) {
      setError(message(error));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  const selected = accounts.find((account) => account.id === value);
  const otherBindings =
    selected?.bindings?.filter((binding) => binding.profileId !== profileId) ||
    [];
  return (
    <div className="google-account-picker">
      <Field
        label="待绑定 Google 账号"
        hint="每个账号只能关联一个 Chrome 实例。保存绑定仅记录映射，不表示已经登录。"
      >
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={loading}
        >
          <option value="">
            {loading ? "正在读取账号清单…" : "请选择要绑定的账号"}
          </option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id} disabled={account.bindings?.some(binding => binding.profileId !== profileId)}>
              {account.email}
              {account.bindings?.length
                ? ` · 已关联 ${account.bindings.map((binding) => binding.profileName).join("、")}`
                : " · 未关联实例"}
            </option>
          ))}
        </select>
      </Field>
      {error && (
        <div className="catalog-error" role="alert">
          <span>账号清单读取失败：{error}。可通过普通桌面入口登录，暂不记录账号绑定。</span>
          <Button type="button" variant="ghost" onClick={() => void load()}>
            重试
          </Button>
        </div>
      )}
      {!loading && !error && !accounts.length && (
        <p className="muted small">
          账号清单中暂无记录。可仅打开桌面自行登录，暂不确认账号映射。
        </p>
      )}
      {selected?.recoveryEmail && (
        <p className="muted small">辅助邮箱：{selected.recoveryEmail}</p>
      )}
      {otherBindings.length > 0 && (
        <p className="muted small">
          此账号已关联{" "}
          {otherBindings.map((binding) => binding.profileName).join("、")}
          ，请使用已关联的实例。
        </p>
      )}
    </div>
  );
}

export function GoogleLoginProgress({ value, mode, onConfirm, confirmBusy }: {
  value: GoogleLoginStatus;
  busy?: boolean;
  mode?: BrowserMode;
  onConfirm?: () => void;
  confirmBusy?: boolean;
}) {
  const confirmed = value.verificationSource === "manual_confirmation" && value.status === "bound";
  return <div className={`google-login-progress ${confirmed ? "bound" : "waiting"}`} role="status" aria-live="polite">
    <div className={`google-login-progress-summary${value.expectedEmail && onConfirm ? " has-actions" : ""}`}>
      <div className="google-login-progress-copy">
        <div className="google-login-progress-title"><Icon name={confirmed ? "check" : "clock"} size={17} /><strong>{confirmed ? "已人工确认登录" : "已绑定，待人工确认"}</strong></div>
        {value.expectedEmail && <div className="google-login-identities"><span>已绑定账号：{value.expectedEmail}</span></div>}
        <p>{confirmed ? "已记录人工登录确认。请以此实例桌面中的实际登录情况为准。" : "请先在此实例桌面完成登录并核对邮箱，再点击「确认已登录」，无需重新打开桌面。"}确认只保存人工记录，浏览器模式和桌面会话保持不变。</p>
        {confirmed && value.lastConfirmedAt && <p>人工确认时间：{date(value.lastConfirmedAt)}</p>}
        {!value.expectedAccountId && <p>尚未绑定账号。请先在账号状态页保存目录账号绑定。</p>}
      </div>
      {value.expectedEmail && onConfirm && <div className="google-login-progress-actions"><Button type="button" variant={confirmed ? "default" : "primary"} busy={confirmBusy} onClick={onConfirm}>{confirmed ? "更新登录确认" : "确认已登录"}</Button></div>}
    </div>
  </div>;
}

export function GoogleLoginDialog({ profile, onClose, onStart }: {
  profile: Profile;
  onClose: () => void;
  onStart: (accountId?: string) => void;
}) {
  const vnc = browserMode(profile) === "vnc";
  return <Modal title="Google 登录" subtitle={`目标实例：${profile.name}`} onClose={onClose}>
    <Notice>打开此实例的桌面后，请自行访问 Google 登录页并完成登录，再保存人工确认。</Notice>
    <div className="google-login-fixed-account"><strong>已绑定账号</strong><p>{profile.googleBinding?.email || "尚未绑定，请先到账号状态页保存绑定。"}</p></div>
    <p className="google-login-guidance">登录地址：https://accounts.google.com/ 。请在此实例桌面中的 Chrome 打开。确认登录只保存人工记录，浏览器模式和桌面会话保持不变。</p>
    <div className="modal-actions"><Button type="button" onClick={onClose}>取消</Button><Button type="button" variant="primary" disabled={!profile.googleBinding} onClick={() => onStart(profile.googleBinding?.accountId)}><GoogleMark />{vnc ? "打开VNC登录" : "打开登录桌面"}</Button></div>
  </Modal>;
}
