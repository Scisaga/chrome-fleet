import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  items,
  message,
  date,
  type GoogleAccountOption,
  type Profile,
} from "./api";
import { Badge, Button, Empty, Field, Icon, Modal, Notice } from "./components";
import "./accounts.css";
import { browserMode, browserModeLabel, vncModeDescription } from "./browser-mode";
import { AccountEditor, AccountPassword } from "./AccountCredentials";

interface AccountManagerProps {
  profiles: Profile[];
  onOpenProfile: (id: string) => void;
  onOpenDesktop: (profile: Profile) => void;
  onLogin: (profile: Profile, accountId: string) => void;
  onCreateProfile: (account: GoogleAccountOption) => void;
  onReloadProfiles: () => Promise<void>;
  onConfirm: (profile: Profile) => Promise<void>;
  notify: (message: string, error?: boolean) => void;
}

interface AccountAssociation {
  profileId: string;
  profileName: string;
  authState: string;
  lastCheckedAt?: string;
  boundAt?: string;
  lastConfirmedAt?: string;
  vnc?: boolean;
  archived?: boolean;
}

const normalizedEmail = (value: string) => value.trim().toLowerCase();
const transitionalStates = ["starting", "stopping", "updating"];
const profileStateLabels: Record<string, string> = {
  running: "运行中",
  stopped: "已停止，登录时启动",
  error: "异常，登录时尝试启动",
};
const authStateLabels: Record<string, string> = {
  authenticated: "已验证登录",
  manually_confirmed: "已人工确认登录",
  bound_unconfirmed: "已绑定，待人工确认",
  unknown: "登录待验证",
  needs_login: "需要登录",
  needs_verification: "需要人工验证",
  unsupported: "暂不支持检测",
};

function associationNote(binding: AccountAssociation) {
  if (binding.archived) return "归档保留账号关联，恢复实例后可继续使用";
  if (binding.authState === "manually_confirmed")
    return `人工确认 ${date(binding.lastConfirmedAt || binding.boundAt || binding.lastCheckedAt)} · 非服务器验证`;
  if (!binding.vnc && binding.lastCheckedAt) return `最近检测 ${date(binding.lastCheckedAt)}`;
}

function associationsFor(
  account: GoogleAccountOption,
  profiles: Profile[],
): AccountAssociation[] {
  const email = normalizedEmail(account.email);
  const associations = new Map(
    (account.bindings || [])
      .filter(
        (binding) => {
          const profile = profiles.find((p) => p.id === binding.profileId);
          return !profile?.purgedAt;
        },
      )
      .map((binding) => [binding.profileId, binding]),
  );
  for (const profile of profiles) {
    if (
      !profile.purgedAt &&
      (browserMode(profile) === "vnc" ? profile.googleBinding?.accountId === account.id : profile.accounts?.some(
        (binding) =>
          binding.provider === "google" &&
          normalizedEmail(binding.expectedIdentity) === email,
      ))
    ) {
      associations.set(profile.id, {
        profileId: profile.id,
        profileName: profile.name,
      });
    }
  }
  return [...associations.values()].map((association) => {
    const profile = profiles.find((p) => p.id === association.profileId);
    const binding = profile?.accounts
      ?.filter(
        (entry) =>
          entry.provider === "google" &&
          normalizedEmail(entry.expectedIdentity) === email,
      )
      .sort(
        (a, b) =>
          (Date.parse(b.lastCheckedAt || "") || 0) -
          (Date.parse(a.lastCheckedAt || "") || 0),
      )[0];
    return {
      profileId: association.profileId,
      profileName: profile?.name || association.profileName,
      authState: profile && browserMode(profile) === "vnc" ? profile.googleBinding?.confirmationState === "confirmed" ? "manually_confirmed" : "bound_unconfirmed" : binding?.authState || binding?.state || binding?.status || "unknown",
      lastCheckedAt: binding?.lastCheckedAt,
      boundAt: binding?.boundAt,
      lastConfirmedAt: profile?.googleBinding?.lastConfirmedAt || binding?.lastConfirmedAt || binding?.boundAt,
      vnc: profile && browserMode(profile) === "vnc",
      archived: profile?.archived || association.archived,
    };
  });
}

export default function AccountManager({
  profiles,
  onOpenProfile,
  onOpenDesktop,
  onLogin,
  onCreateProfile,
  onReloadProfiles,
  onConfirm,
  notify,
}: AccountManagerProps) {
  const [accounts, setAccounts] = useState<GoogleAccountOption[] | null>(null);
  const [total, setTotal] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [loginTarget, setLoginTarget] = useState<{
    account: GoogleAccountOption;
    profileId: string;
  }>();
  const [bindingTarget, setBindingTarget] = useState<{ account: GoogleAccountOption; profileId: string }>();
  const [busyId, setBusyId] = useState("");
  const [editor, setEditor] = useState<{ account?: GoogleAccountOption }>();
  const [credentialGeneration, setCredentialGeneration] = useState(0);
  const requestVersion = useRef(0);
  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    try {
      const first = await api<{ items: GoogleAccountOption[]; total: number }>(
        "/google-accounts?limit=100",
      );
      const loaded = [...items<GoogleAccountOption>(first)];
      while (loaded.length < first.total) {
        const page = items<GoogleAccountOption>(
          await api(`/google-accounts?limit=100&offset=${loaded.length}`),
        );
        if (!page.length) break;
        loaded.push(...page);
      }
      if (version !== requestVersion.current) return;
      setAccounts([
        ...new Map(
          loaded.map((account) => [
            account.id,
            {
              id: account.id,
              email: account.email,
              recoveryEmail: account.recoveryEmail,
              updatedAt: account.updatedAt,
              bindings: (account.bindings || []).map((binding) => ({
                profileId: binding.profileId,
                profileName: binding.profileName,
                archived: binding.archived,
              })),
            },
          ]),
        ).values(),
      ]);
      setTotal(first.total);
      setError("");
    } catch (error) {
      if (version === requestVersion.current) setError(message(error));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 5000);
    return () => {
      clearInterval(timer);
      requestVersion.current++;
    };
  }, [load]);

  const entries = (accounts || []).map((account) => ({
    account,
    associations: associationsFor(account, profiles),
  }));
  const associatedCount = entries.filter(
    (entry) => entry.associations.length > 0,
  ).length;
  const query = search.trim().toLowerCase();
  const filtered = entries.filter(
    ({ account, associations }) =>
      (!query ||
        `${account.email} ${account.recoveryEmail || ""}`
          .toLowerCase()
          .includes(query)) &&
      (filter === "all" ||
        (filter === "bound"
          ? associations.length > 0
          : associations.length === 0)),
  );
  const availableProfiles = profiles.filter(
    (profile) =>
      !profile.archived && !profile.purgedAt &&
      !profile.headless &&
      !transitionalStates.includes(profile.state),
  );
  const profilesForLogin = (account: GoogleAccountOption) => {
    const associations = associationsFor(account, profiles);
    return availableProfiles.filter(profile => associations.some(binding => binding.profileId === profile.id));
  };
  const loginProfiles = loginTarget ? profilesForLogin(loginTarget.account) : [];
  const selectedProfile = loginProfiles.find(
    (profile) => profile.id === loginTarget?.profileId,
  );
  const bindableProfiles = profiles.filter((profile) => !profile.archived && !profile.purgedAt && browserMode(profile) === "vnc");
  const bindingProfile = bindableProfiles.find((profile) => profile.id === bindingTarget?.profileId);
  function chooseBinding(account: GoogleAccountOption) {
    setLoginTarget(undefined);
    setBindingTarget({ account, profileId: bindableProfiles.find((profile) => !profile.googleBinding)?.id || bindableProfiles[0]?.id || "" });
  }
  async function saveBinding() {
    if (!bindingTarget || !bindingProfile || busyId) return;
    setBusyId(`${bindingProfile.id}:bind`);
    try {
      await api(`/profiles/${bindingProfile.id}/google-binding`, "PUT", { accountId: bindingTarget.account.id });
      await onReloadProfiles();
      await load();
      setBindingTarget(undefined);
      notify("账号绑定已保存，尚未人工确认登录。保存映射不会打开或重启 Chrome。");
    } catch (error) { notify(message(error), true); }
    finally { setBusyId(""); }
  }
  async function confirmBinding(profile: Profile) {
    if (busyId) return;
    setBusyId(`${profile.id}:confirm`);
    try { await onConfirm(profile); await load(); }
    finally { setBusyId(""); }
  }

  function chooseLogin(
    account: GoogleAccountOption,
    associations: AccountAssociation[],
  ) {
    const preferred =
      profilesForLogin(account).find((profile) =>
        associations.some((binding) => binding.profileId === profile.id),
      ) || profilesForLogin(account)[0];
    setLoginTarget({ account, profileId: preferred?.id || "" });
  }
  function createProfile(account: GoogleAccountOption) {
    setLoginTarget(undefined);
    const existing = associationsFor(account, profiles)[0];
    if (existing) { onOpenProfile(existing.profileId); return; }
    try {
      onCreateProfile(account);
    } catch (error) {
      notify(message(error), true);
    }
  }

  function editAccount(account?: GoogleAccountOption) {
    setCredentialGeneration(value => value + 1);
    setEditor({ account });
  }
  function accountSaved(account: GoogleAccountOption) {
    const added = !editor?.account;
    setEditor(undefined);
    setCredentialGeneration(value => value + 1);
    setAccounts(current => {
      if (!current) return [account];
      return added ? [...current, account] : current.map(entry => entry.id === account.id ? account : entry);
    });
    if (added) {
      setTotal(value => (value ?? accounts?.length ?? 0) + 1);
      setSearch("");
      setFilter("all");
    }
    notify(added ? "账号已新增，可继续创建或绑定 Chrome 实例。" : "账号资料已更新。密码已加密保存。");
    void load();
  }

  return (
    <section className="account-manager">
      <div className="page-heading account-manager-heading">
        <div>
          <div className="eyebrow">ACCOUNT DIRECTORY</div>
          <h1>
            账号管理{" "}
            <span
              className="heading-pill"
              aria-label={`账号总数 ${total ?? "读取中"}`}
            >
              {total ?? "—"}
            </span>
          </h1>
          <p>新增和编辑账号、查看密码，每个账号最多关联一个 Chrome 实例。</p>
        </div>
        <div className="account-manager-heading-actions">
          <Button variant="primary" icon="plus" onClick={() => editAccount()}>新增账号</Button>
          <Button icon="refresh" busy={loading} onClick={() => void load()} aria-label="刷新账号" title="刷新账号">刷新账号</Button>
        </div>
      </div>
      <Notice>
        账号清单与浏览器实例分别管理，新增账号不会自动创建 Chrome。密码可点击「查看」，通过「编辑账号」修改保存的密码。「人工确认」由你声明，不表示服务器验证了当前登录状态。
      </Notice>
      {accounts !== null && (
        <div className="account-manager-summary" aria-label="账号概况">
          <span>
            <strong>{total ?? accounts.length}</strong> 个账号
          </span>
          <span>
            <i className="am-dot associated" />
            <strong>{associatedCount}</strong> 个已关联账号
          </span>
          <span>
            <i className="am-dot" />
            <strong>{entries.length - associatedCount}</strong> 个未关联账号
          </span>
        </div>
      )}
      {error && (
        <div className="account-manager-error" role="alert">
          <Icon name="alert" />
          <span>
            {error}
            {accounts !== null ? "；下方保留上次读取的账号清单。" : ""}
          </span>
          <Button onClick={() => void load()}>重试</Button>
        </div>
      )}
      <div className="account-manager-toolbar">
        <label className="account-manager-search">
          <Icon name="search" size={17} />
          <input
            aria-label="搜索邮箱或辅助邮箱"
            placeholder="搜索邮箱或辅助邮箱…"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <select
          aria-label="按绑定状态筛选"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          <option value="all">所有绑定状态</option>
          <option value="bound">已关联实例</option>
          <option value="unbound">未关联实例</option>
        </select>
      </div>
      {loading && accounts === null ? (
        <div className="account-manager-loading" role="status">
          <span className="spinner" />
          正在读取账号清单…
        </div>
      ) : accounts !== null && !accounts.length ? (
        <div className="panel">
          <Empty title="暂无账号" icon="key">
            <p>
              点击「新增账号」保存已有账号的邮箱和密码，也可以通过文件导入。
            </p>
            <Button variant="primary" icon="plus" onClick={() => editAccount()}>新增账号</Button>
          </Empty>
        </div>
      ) : accounts !== null && !filtered.length ? (
        <div className="panel">
          <Empty title="没有匹配的账号" icon="search">
            <p>试试其他邮箱或关联状态。</p>
            <Button
              onClick={() => {
                setSearch("");
                setFilter("all");
              }}
            >
              清除筛选
            </Button>
          </Empty>
        </div>
      ) : (
        <div className="account-manager-list">
          {filtered.length > 0 && (
            <div className="account-manager-column-head" aria-hidden="true">
              <span>账号 / 辅助邮箱</span>
              <span>关联的 Chrome 与登录状态</span>
              <span>操作</span>
            </div>
          )}
          {filtered.map(({ account, associations }) => {
            const desktopProfile = profilesForLogin(account).find(profile =>
              (profile.googleBinding?.accountId === account.id && profile.googleBinding.confirmationState === "confirmed") ||
              associations.some(binding => binding.profileId === profile.id && ["manually_confirmed", "authenticated"].includes(binding.authState)),
            );
            return <article
              key={account.id}
              className="account-manager-row"
              data-account-id={account.id}
              aria-label={`账号 ${account.email}`}
            >
              <div className="account-manager-identity">
                <span className="account-manager-avatar">
                  <Icon name="key" size={20} />
                </span>
                <div>
                  <div className="account-manager-identity-heading">
                    <h2>{account.email}</h2>
                    <Button className="account-manager-edit" variant="ghost" icon="edit" aria-label="编辑账号" title="编辑账号" onClick={() => editAccount(account)} />
                  </div>
                  <p>
                    <span>辅助邮箱</span> {account.recoveryEmail || "未提供"}
                  </p>
                  <AccountPassword key={`${account.id}:${credentialGeneration}`} account={account} notify={notify} />
                </div>
              </div>
              <div className="account-manager-associations">
                {associations.length ? (
                  associations.map((binding) => (
                    <div
                      className="account-manager-binding"
                      key={binding.profileId}
                    >
                      <div className="account-manager-binding-heading">
                        <strong>{binding.profileName}</strong>
                        <Button
                          className="account-manager-view"
                          variant="ghost"
                          onClick={() => onOpenProfile(binding.profileId)}
                          aria-label={`查看实例 ${binding.profileName}`}
                        >
                          查看实例
                          <Icon name="chevron" size={13} />
                        </Button>
                      </div>
                      <div className="account-manager-binding-status">
                        <Badge
                          value={binding.authState}
                          label={
                            binding.archived ? "实例已归档" : binding.authState === "authenticated" && browserMode(profiles.find((profile) => profile.id === binding.profileId)) === "vnc" ? "历史自动化检测" : authStateLabels[binding.authState] || "登录待验证"
                          }
                        />
                        {associationNote(binding) && <small>{associationNote(binding)}</small>}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="account-manager-unassociated">
                    <Badge value="unknown" label="未绑定 Chrome" />
                    <small>绑定后可在此人工确认登录</small>
                  </div>
                )}
              </div>
              <div className="account-manager-actions">
                {associations.map(binding => {
                  const profile = profiles.find(entry => entry.id === binding.profileId);
                  return !binding.archived && binding.vnc && profile?.googleBinding?.accountId === account.id ? (
                    <Button key={profile.id} className="account-manager-confirm" variant="primary" busy={busyId === `${profile.id}:confirm`} disabled={Boolean(busyId)} onClick={() => void confirmBinding(profile)}>{binding.authState === "manually_confirmed" ? "启用自动化接管" : "确认已登录"}</Button>
                  ) : null;
                })}
                {associations.length === 0 && <Button icon="plus" onClick={() => createProfile(account)}>
                  创建 Chrome 实例
                </Button>}
                {associations.length === 0 && bindableProfiles.length > 0 && <Button onClick={() => chooseBinding(account)}>绑定到现有 Chrome</Button>}
                {desktopProfile ? <Button
                  className="account-manager-login account-manager-desktop"
                  icon="desktop"
                  onClick={() => onOpenDesktop(desktopProfile)}
                >
                  打开桌面
                </Button> : profilesForLogin(account).length > 0 && <Button
                  className="account-manager-login"
                  icon="desktop"
                  onClick={() => chooseLogin(account, associations)}
                >
                  Google 登录
                </Button>}
              </div>
            </article>;
          })}
        </div>
      )}
      {accounts !== null && (
        <div className="account-manager-result-count">
          显示 {filtered.length} / 共 {total ?? accounts.length} 个账号
          <span>账号数量与 Chrome 实例数量分别统计</span>
        </div>
      )}
      {editor && <AccountEditor account={editor.account} onClose={() => setEditor(undefined)} onSaved={accountSaved} notify={notify} />}
      {loginTarget && (
        <Modal
          title="选择登录实例"
          subtitle={loginTarget.account.email}
          onClose={() => setLoginTarget(undefined)}
        >
          {loginProfiles.length ? (
            <>
              <Notice>
                {browserMode(selectedProfile) === "vnc" ? `此入口固定操作已绑定邮箱 ${loginTarget.account.email}，只打开普通 Chrome VNC 桌面。已经登录时可直接在账号关联行点击「确认已登录」，启用自动化接管。` : "所选实例为自动化模式，会保留其 Google 登录辅助兼容功能。"}
              </Notice>
              <Field label="目标 Chrome 实例">
                <select
                  value={loginTarget.profileId}
                  onChange={(event) =>
                    setLoginTarget({
                      ...loginTarget,
                      profileId: event.target.value,
                    })
                  }
                >
                  {!selectedProfile && <option value="">请选择可用实例</option>}
                  {loginProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name} · {browserModeLabel(profile)} ·{" "}
                      {profileStateLabels[profile.state] || profile.state}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="account-manager-dialog-note">
                {browserMode(selectedProfile) === "vnc" ? `${vncModeDescription} 确认已登录后将结束人工桌面，并保留用户目录切换到自动化接管。` : "自动化模式的账号检测和人工确认会分别标记。"}
              </p>
              <div className="modal-actions">
                <Button onClick={() => setLoginTarget(undefined)}>取消</Button>
                <Button
                  variant="primary"
                  icon="desktop"
                  disabled={!selectedProfile}
                  onClick={() => {
                    if (!selectedProfile) {
                      notify("请选择可用的 Chrome 实例", true);
                      return;
                    }
                    const accountId = loginTarget.account.id;
                    setLoginTarget(undefined);
                    onLogin(selectedProfile, accountId);
                  }}
                >
                  {browserMode(selectedProfile) === "vnc" ? "打开VNC登录" : "Google 登录"}
                </Button>
              </div>
            </>
          ) : (
            <>
              <Notice>
                此邮箱还没有可登录的已绑定 Chrome。请先绑定到一个现有 VNC 实例，或创建实例；绑定不会宣称账号已登录。
              </Notice>
              {profiles.some((profile) => !profile.archived) && (
                <p className="account-manager-dialog-note">
                  无头模式或正在启动、停止、更新的实例暂不可选。
                </p>
              )}
              <div className="modal-actions">
                <Button onClick={() => setLoginTarget(undefined)}>关闭</Button>
                <Button
                  variant="primary"
                  icon="plus"
                  onClick={() => createProfile(loginTarget.account)}
                >
                  创建 Chrome 实例
                </Button>
                {bindableProfiles.length > 0 && <Button onClick={() => chooseBinding(loginTarget.account)}>绑定到现有 Chrome</Button>}
              </div>
            </>
          )}
        </Modal>
      )}
      {bindingTarget && <Modal title="绑定账号到 Chrome" subtitle={bindingTarget.account.email} onClose={() => setBindingTarget(undefined)}>
        <Field label="绑定到 Chrome 实例" hint="一个 Chrome 只绑定一个 Google 账号。保存仅修改映射，不打开、导航或重启浏览器。">
          <select value={bindingTarget.profileId} onChange={(event) => setBindingTarget({ ...bindingTarget, profileId: event.target.value })}>
            <option value="">请选择 Chrome</option>
            {bindableProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.googleBinding?.email || "未绑定账号"}</option>)}
          </select>
        </Field>
        <Notice>{bindingProfile?.googleBinding && bindingProfile.googleBinding.accountId !== bindingTarget.account.id ? `当前绑定 ${bindingProfile.googleBinding.email}。保存换绑会清除旧映射的人工登录确认；新账号需重新明确确认。` : "保存账号映射不表示已经登录。登录完成后可直接在目录关联行点击「确认已登录」，不需要重新打开 VNC。"}</Notice>
        <div className="modal-actions"><Button onClick={() => setBindingTarget(undefined)}>取消</Button><Button variant="primary" busy={Boolean(busyId)} disabled={!bindingProfile || bindingProfile.googleBinding?.accountId === bindingTarget.account.id} onClick={() => void saveBinding()}>{bindingProfile?.googleBinding ? "保存换绑" : "保存绑定"}</Button></div>
      </Modal>}
    </section>
  );
}
