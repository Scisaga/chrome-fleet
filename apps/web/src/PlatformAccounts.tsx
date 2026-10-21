import { date, type PlatformAccount, type Profile } from "./api";
import { Badge } from "./components";
import "./platforms.css";

export function accountsChanged() { window.dispatchEvent(new Event("fleet-account-updated")); }

export function PlatformAccountList({ accounts, children }: { accounts: PlatformAccount[]; children?: (account: PlatformAccount) => React.ReactNode }) {
  return <div className="platform-account-list">{accounts.map(account => <div className="platform-account-row" key={account.id} data-platform-id={account.platformId}>
    <div className="platform-account-identity"><strong>{account.platformName}</strong><span>{account.nickname || account.expectedIdentity || "尚未填写平台账号 ID"}</span>
      {account.expectedIdentity && <small>ID：{account.expectedIdentity}</small>}
      <small>{account.lastConfirmedAt ? `人工确认 ${date(account.lastConfirmedAt)}` : "尚未人工确认登录"}</small>
      {account.firstLinkedAt && <small>首次关联 {date(account.firstLinkedAt)}</small>}
      {account.historicalVerification?.lastCheckedAt && <details className="platform-history"><summary>历史自动检测（已停止）</summary><small>{date(account.historicalVerification.lastCheckedAt)}</small></details>}
    </div>
    <div className="platform-account-actions"><Badge value={account.authState} label={!account.enabled ? "平台已停用" : account.confirmationState === "confirmed" ? "已人工确认登录" : "待人工确认"} />{children?.(account)}</div>
  </div>)}</div>;
}

export function ProfilePlatformTags({ profile }: { profile: Profile }) {
  return <div className="platform-tags">{profile.platformAccounts?.map(account => <span key={account.id} title={account.lastConfirmedAt ? `人工确认 ${date(account.lastConfirmedAt)}` : "请到实例详情人工确认"}>{account.platformName} <Badge value={account.authState} label={!account.enabled ? "已停用" : account.confirmationState === "confirmed" ? "已人工确认" : "待人工确认"} /></span>)}</div>;
}
