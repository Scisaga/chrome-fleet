import { date, type Profile } from "./api";
import { Badge, Button, Icon } from "./components";

export function ProfileAccountEntry({ profile, onOpen }: {
  profile: Profile;
  onOpen: () => void;
}) {
  const binding = profile.googleBinding;
  const confirmed = binding?.confirmationState === "confirmed";
  const state = binding ? confirmed ? "confirmed" : "unconfirmed" : "unbound";
  const label = binding ? confirmed ? "已人工确认登录" : "待人工确认登录" : "账号关联待完善";
  return (
    <button
      type="button"
      className={`card-account-entry ${state}`}
      data-confirmation={state}
      aria-label={`${profile.name}：${label}，查看账号状态`}
      title={confirmed
        ? `已记录人工登录确认${binding?.lastConfirmedAt ? `：${date(binding.lastConfirmedAt)}` : ""}，点击查看详情`
        : binding ? "完成桌面登录后，前往账号状态页人工确认" : "查看并完善此实例的账号关联"}
      onClick={onOpen}
    >
      <span><Icon name={confirmed ? "check" : binding ? "clock" : "key"} size={16} />{label}</span>
      <span>{confirmed ? "查看详情" : binding ? "前往确认" : "查看账号"}<Icon name="arrow" size={14} /></span>
    </button>
  );
}

export function ProfileConfirmationSummary({ profile, onOpenSettings }: {
  profile: Profile;
  onOpenSettings: () => void;
}) {
  const binding = profile.googleBinding;
  if (!binding) return null;
  const confirmed = binding.confirmationState === "confirmed";
  return (
    <section className="panel profile-confirmation-summary">
      <div className="panel-heading">
        <h2>人工登录确认</h2>
        <Badge value={confirmed ? "manually_confirmed" : "bound_unconfirmed"} label={confirmed ? "已人工确认登录" : "待人工确认登录"} />
      </div>
      <dl className="info-list">
        <div><dt>关联账号</dt><dd>{binding.email}</dd></div>
        {confirmed && binding.lastConfirmedAt && <div><dt>人工确认时间</dt><dd>{date(binding.lastConfirmedAt)}</dd></div>}
      </dl>
      <p className="muted small">{confirmed
        ? "已保存人工确认记录。下方的自动化检测结果与人工确认分别记录。"
        : "尚未进行人工确认。请先在实例设置切换为 VNC 模式，在桌面完成登录后点击「确认已登录」。"}</p>
      {!confirmed && !profile.archived && <div className="heading-actions"><Button icon="settings" onClick={onOpenSettings}>前往实例设置</Button></div>}
    </section>
  );
}
