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
import { googleAutofillSummary } from "./google-login-state";
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
        hint={mode === "vnc" ? "每个账号只能关联一个 Chrome 实例。保存绑定仅记录映射，不表示已经登录。" : "每个账号只能关联一个 Chrome 实例；已关联其他实例的账号不可选。"}
      >
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={loading}
        >
          <option value="">
            {loading ? "正在读取账号清单…" : mode === "vnc" ? "请选择要绑定的账号" : "不指定 · 自行登录"}
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

export function GoogleLoginProgress({
  value,
  busy,
  onCheck,
  mode,
  onConfirm,
  confirmBusy,
}: {
  value: GoogleLoginStatus;
  busy?: boolean;
  onCheck?: () => void;
  mode?: BrowserMode;
  onConfirm?: () => void;
  confirmBusy?: boolean;
}) {
  const vnc = (mode || value.browserMode) === "vnc";
  const manuallyConfirmed = value.verificationSource === "manual_confirmation";
  const canConfirm = vnc && value.expectedEmail && onConfirm;
  const autofill = googleAutofillSummary(value);
  const title = manuallyConfirmed && value.status === "bound"
    ? "已人工确认登录"
    : vnc ? "已绑定，待人工确认"
    : (value.status === "waiting" || value.status === "unknown")
    ? autofill.title
    : {
    waiting: "等待 Google 登录与账号识别",
    bound: "Google 账号已识别并绑定",
    mismatch: "登录账号与所选账号不一致",
    unknown: "尚未识别出 Google 账号",
    }[value.status];
  return (
    <div
      className={`google-login-progress ${value.status}`}
      role="status"
      aria-live="polite"
    >
      <div className={`google-login-progress-summary${canConfirm ? " has-actions" : ""}`}>
        <div className="google-login-progress-copy">
          <div className="google-login-progress-title">
            <Icon
              name={
                value.status === "bound"
                  ? "check"
                  : value.status === "mismatch"
                    ? "alert"
                    : "clock"
              }
              size={17}
            />
            <strong>{title}</strong>
            {!vnc && onCheck && <Button type="button" variant="ghost" busy={busy} onClick={onCheck}>
              重新检测
            </Button>}
          </div>
          {(value.expectedEmail || value.detectedEmail) && (
            <div className="google-login-identities">
              {value.expectedEmail && <span>{vnc || manuallyConfirmed ? "已绑定账号" : "待绑定"}：{value.expectedEmail}</span>}
              {value.detectedEmail && !manuallyConfirmed && <span>已识别：{value.detectedEmail}</span>}
            </div>
          )}
          {!vnc && (value.status === "waiting" || value.status === "unknown") && (
            <p className="google-login-autofill" data-autofill-stage={autofill.stage}>
              {autofill.description}
              {value.autofill?.message && <> {value.autofill.message}</>}
            </p>
          )}
          {vnc || manuallyConfirmed ? <p>
            {manuallyConfirmed ? "已记录人工登录确认。启用自动化接管后可执行网页任务，并按设置自动关闭空闲实例。" : "请先在 VNC 桌面完成上述邮箱的登录，再点击「确认已登录」切换到自动化接管，无需重新打开桌面。确认后会结束人工桌面，保留用户目录并重启 Chrome。"}
          </p> : value.message && <p>{value.message}</p>}
          {manuallyConfirmed && value.lastConfirmedAt && <p>人工确认时间：{date(value.lastConfirmedAt)}</p>}
          {vnc && !value.expectedAccountId && <p>尚未绑定账号。请先在账号状态页保存目录账号绑定；普通桌面入口保持可用。</p>}
          {!vnc && value.status === "mismatch" && (
            <p>
              未覆盖账号绑定。请在该实例的 Chrome 中切换到所选账号，再重新检测。
            </p>
          )}
          {!vnc && value.status !== "bound" && (
            <p>
              密码页提交、验证码与二次验证由你完成。登录成功后打开 Google
              首页或「我的账号」，让已登录头像可供识别。
            </p>
          )}
        </div>
        {canConfirm && (
          <div className="google-login-progress-actions">
            <Button type="button" variant="primary" busy={confirmBusy} onClick={onConfirm}>{manuallyConfirmed ? "启用自动化接管" : "确认已登录"}</Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function GoogleLoginDialog({
  profile,
  onClose,
  onStart,
}: {
  profile: Profile;
  onClose: () => void;
  onStart: (accountId?: string) => void;
}) {
  const [accountId, setAccountId] = useState("");
  const mode = browserMode(profile);
  const vnc = mode === "vnc";
  return (
    <Modal
      title="Google 登录"
      subtitle={`目标实例：${profile.name}`}
      onClose={onClose}
    >
      <Notice>
        {vnc ? "只打开此 Chrome 已绑定账号的 VNC 桌面。请自行完成 Google 登录，之后可在账号状态页或账号目录直接确认已登录。" : "将导航当前实例的同一个 Chrome 到 Google 登录页面，并打开受保护远程桌面。此为自动化模式的兼容功能。"}
      </Notice>
      {vnc ? <div className="google-login-fixed-account"><strong>已绑定账号</strong><p>{profile.googleBinding?.email || "尚未绑定，请先到账号状态页保存绑定。"}</p></div> : <GoogleAccountPicker
        profileId={profile.id}
        value={accountId}
        onChange={setAccountId}
        mode={mode}
      />}
      <p className="google-login-guidance">
        {vnc ? vncModeDescription : accountId
          ? "系统会填写所选账号的邮箱，等待你点击邮箱页的下一步；检测进入密码页后自动填写密码，再由你确认提交。验证码与二次验证由你完成。密码仅在目标 Chrome 中填写，不会传到管理界面。"
          : "选择已导入账号可自动填写邮箱；邮箱页下一步由你点击，检测进入密码页后系统再填写密码。不指定账号时自行填写凭证。密码提交、验证码与二次验证由你完成。"}
        {vnc ? " 确认登录后会结束人工桌面，保留原用户目录并重启 Chrome，切换到自动化接管。换账号请先在账号状态页明确换绑。" : " 登录后可打开 Google 首页或「我的账号」，由自动化模式检测身份。"}
      </p>
      <div className="modal-actions">
        <Button type="button" onClick={onClose}>
          取消
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={vnc && !profile.googleBinding}
          onClick={() => onStart(vnc ? profile.googleBinding?.accountId : accountId || undefined)}
        >
          <GoogleMark />
          {vnc ? "打开VNC登录" : "Google 登录"}
        </Button>
      </div>
    </Modal>
  );
}
