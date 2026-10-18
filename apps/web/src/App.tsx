import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  api,
  ApiError,
  setCsrfToken,
  items,
  message,
  date,
  safeDesktopPath,
  type Profile,
  type Job,
  type Account,
  type ManualSession,
  type GoogleLoginStatus,
  type GoogleAccountOption,
} from "./api";
import AccountManager from "./AccountManager";
import McpPage from "./McpPage";
import VncPasswordSettings from "./VncPasswordSettings";
import BrowserModeSettings from "./BrowserModeSettings";
import VncGoogleBindingPanel from "./VncGoogleBindingPanel";
import ResourceMetrics from "./ResourceMetrics";
import HostResourceMetrics from "./HostResourceMetrics";
import JobTimeline from "./JobTimeline";
import { jobKind, jobColor, recentJobRange, jobHistoryQuery } from "./job-history";
import { useJobHistory } from "./use-job-history";
import ProxyFields from "./ProxyFields";
import { ProfileAccountEntry, ProfileConfirmationSummary } from "./ProfileAccountStatus";
import { formatProxyAddress, proxyConfigFromForm } from "./proxy-address";
import { resourceMetrics } from "./resource-metrics";
import { bindingProgress, googleBindingLabel } from "./google-binding";
import { browserMode, browserModeLabel, vncModeDescription, type BrowserMode } from "./browser-mode";
import { routePath, useAppRoute, type View, type DetailTab } from "./router";
import { googleAutofillSummary } from "./google-login-state";
import {
  GoogleAccountPicker,
  GoogleLoginDialog,
  GoogleLoginProgress,
  GoogleMark,
} from "./GoogleLogin";
import {
  Icon,
  Button,
  Modal,
  Badge,
  Empty,
  Notice,
  Field,
  Data,
  type IconName,
} from "./components";

type Notify = (text: string, error?: boolean) => void;
const policyNames = {
  on_demand: "按需启动",
  manual: "手动启动",
  always: "持续运行",
};
const tabs: [DetailTab, string][] = [
  ["overview", "概览"],
  ["settings", "实例设置"],
  ["accounts", "账号状态"],
  ["tasks", "自动化任务"],
  ["sessions", "会话与备份"],
  ["updates", "浏览器更新"],
];
const busyStates = ["starting", "stopping", "updating"];
function bytes(value?: number) {
  if (value === undefined || !Number.isFinite(value)) return "未上报";
  return value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(1)} GiB`
    : `${(value / 1024 ** 2).toFixed(1)} MiB`;
}
interface DesktopSession extends ManualSession {
  popup: Window | null;
}
function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Icon name="chrome" size={28} />
      </span>
      <span>
        Chrome<span className="brand-light"> Fleet</span>
        <small>浏览器工作台</small>
      </span>
    </div>
  );
}

export default function App() {
  const { route, navigate: navigateRoute } = useAppRoute();
  const view = route.kind === "page" ? route.view : route.kind === "create" ? route.from : "profiles";
  const selected = route.kind === "profile" ? route.profileId : undefined;
  const create = route.kind === "create";
  const createAccountId = route.kind === "create" ? route.accountId : undefined;
  const detailTab = route.kind === "profile" ? route.tab : "overview";
  const currentPath = routePath(route);
  const [session, setSession] = useState<
    "loading" | "authenticated" | "anonymous"
  >("loading");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [createAccount, setCreateAccount] = useState<GoogleAccountOption>();
  const [createAccountError, setCreateAccountError] = useState("");
  const [createAccountRetry, setCreateAccountRetry] = useState(0);
  const [embeddedSession, setEmbeddedSession] = useState<string>();
  const [googleLoginTarget, setGoogleLoginTarget] = useState<string>();
  const [googleChecking, setGoogleChecking] = useState<string[]>([]);
  const [toast, setToast] = useState<{ text: string; error?: boolean }>();
  const [mobileNav, setMobileNav] = useState(false);
  const [directProfile, setDirectProfile] = useState<Profile>();
  const [profileLookup, setProfileLookup] = useState<"loading" | "found" | "missing" | "error">("loading");
  const [profileError, setProfileError] = useState("");
  const [profileRetry, setProfileRetry] = useState(0);
  const notify: Notify = useCallback(
    (text, error) => setToast({ text, error }),
    [],
  );
  useEffect(() => {
    setCreateAccount((current) => current?.id === createAccountId ? current : undefined);
    setCreateAccountError("");
  }, [createAccountId]);
  useEffect(() => {
    setMobileNav(false);
    setGoogleLoginTarget(undefined);
    setEmbeddedSession(undefined);
    window.scrollTo(0, 0);
  }, [currentPath]);
  useEffect(() => {
    if (!selected || session !== "authenticated") {
      setDirectProfile(undefined);
      return;
    }
    let active = true;
    setDirectProfile(undefined);
    setProfileLookup("loading");
    setProfileError("");
    api<Profile>(`/profiles/${encodeURIComponent(selected)}`)
      .then((profile) => {
        if (!active) return;
        setDirectProfile(profile);
        setProfileLookup("found");
      })
      .catch((error) => {
        if (!active) return;
        setProfileLookup(error instanceof ApiError && error.code === "PROFILE_NOT_FOUND" ? "missing" : "error");
        setProfileError(message(error));
      });
    return () => { active = false; };
  }, [selected, session, profileRetry]);
  useEffect(() => {
    if (
      !create ||
      !createAccountId ||
      createAccount?.id === createAccountId ||
      session !== "authenticated"
    )
      return;
    let active = true;
    setCreateAccountError("");
    const recover = async () => {
      try {
        const first = await api<{
          items: GoogleAccountOption[];
          total: number;
        }>("/google-accounts?limit=100");
        let page = items<GoogleAccountOption>(first);
        let offset = page.length;
        let account = page.find((account) => account.id === createAccountId);
        while (!account && offset < first.total) {
          page = items<GoogleAccountOption>(
            await api(`/google-accounts?limit=100&offset=${offset}`),
          );
          if (!page.length) break;
          offset += page.length;
          account = page.find((account) => account.id === createAccountId);
        }
        if (!account)
          throw new Error("该账号不在当前账号清单中，请返回账号管理重新选择。");
        if (active)
          setCreateAccount({
            id: account.id,
            email: account.email,
            recoveryEmail: account.recoveryEmail,
            bindings: account.bindings,
          });
      } catch (error) {
        if (active) setCreateAccountError(message(error));
      }
    };
    void recover();
    return () => {
      active = false;
    };
  }, [create, createAccountId, createAccount?.id, createAccountRetry, session]);
  function openCreate(account: GoogleAccountOption) {
    setCreateAccount(account);
    setCreateAccountError("");
    navigateRoute({ kind: "create", from: "accounts", accountId: account.id });
  }
  function cancelCreate() {
    setCreateAccount(undefined);
    setCreateAccountError("");
    navigateRoute({ kind: "page", view: "accounts" });
  }
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(
        () => setToast(undefined),
        toast.error ? 10000 : 5000,
      );
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    api<{ authenticated: boolean; csrfToken: string }>("/session")
      .then((data) => {
        setCsrfToken(data.csrfToken);
        setSession(data.authenticated ? "authenticated" : "anonymous");
      })
      .catch(() => setSession("anonymous"));
    const expired = () => {
      setCsrfToken("");
      setSession("anonymous");
      setProfiles([]);
      setCreateAccount(undefined);
      setGoogleLoginTarget(undefined);
      setEmbeddedSession(undefined);
      setDesktopSessions([]);
    };
    window.addEventListener("fleet-session-expired", expired);
    return () => window.removeEventListener("fleet-session-expired", expired);
  }, []);
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setProfiles(
        items<Profile>(await api("/profiles?limit=100&includeArchived=true")).filter((profile) => !profile.purgedAt),
      );
      setError("");
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (session !== "authenticated") return;
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 3000);
    return () => clearInterval(timer);
  }, [session, load]);
  async function logout() {
    try {
      for (const s of desktopSessions) {
        await api(`/manual-sessions/${encodeURIComponent(s.id)}`, "DELETE");
        s.popup?.close();
      }
      setDesktopSessions([]);
      await api("/session", "DELETE");
      setCsrfToken("");
      setSession("anonymous");
      setProfiles([]);
      setCreateAccount(undefined);
      setGoogleLoginTarget(undefined);
      setEmbeddedSession(undefined);
    } catch (e) {
      notify(message(e), true);
    }
  }
  const [actionId, setActionId] = useState("");
  const [desktopSessions, setDesktopSessions] = useState<DesktopSession[]>([]);
  useEffect(() => {
    if (session !== "authenticated") return;
    let disposed = false;
    const recover = async () => {
      try {
        const sessions = items<Omit<DesktopSession, "popup">>(
          await api("/manual-sessions?limit=100"),
        ).map((s) => ({ ...s, desktopPath: safeDesktopPath(s.desktopPath) }));
        if (!disposed)
          setDesktopSessions((current) =>
            sessions.map((s) => ({
              ...s,
              popup:
                current.find((existing) => existing.id === s.id)?.popup || null,
            })),
          );
      } catch {
        // 只读凭证没有人工接管权限；实例列表仍保持可用。
      }
    };
    void recover();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void recover();
    }, 3000);
    window.addEventListener("fleet-desktops-changed", recover);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener("fleet-desktops-changed", recover);
    };
  }, [session]);
  async function closeDesktop(id: string) {
    try {
      await api(`/manual-sessions/${encodeURIComponent(id)}`, "DELETE");
      desktopSessions.find((s) => s.id === id)?.popup?.close();
      setDesktopSessions((current) => current.filter((s) => s.id !== id));
      notify("人工接管已结束，桌面权限与租约已回收。");
    } catch (e) {
      notify(message(e), true);
    }
  }
  useEffect(() => {
    if (!desktopSessions.length) return;
    const timer = setInterval(() => {
      for (const s of desktopSessions) {
        if (s.popup?.closed || Date.parse(s.expiresAt) <= Date.now())
          void closeDesktop(s.id);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [desktopSessions]);
  async function action(profile: Profile, actionName: string) {
    setActionId(`${profile.id}:${actionName}`);
    try {
      await api(`/profiles/${profile.id}/${actionName}`, "POST", {});
      notify(
        actionName === "stop"
          ? "关闭请求已提交。会话数据会保留，自动唤起已暂停。"
          : "操作已提交，正在更新实例状态。",
      );
      await load(true);
    } catch (e) {
      notify(message(e), true);
    } finally {
      setActionId("");
    }
  }
  async function checkGoogleLogin(profileId: string) {
    if (browserMode(profiles.find((profile) => profile.id === profileId)) === "vnc") return;
    if (googleChecking.includes(profileId)) return;
    setGoogleChecking((current) => [...current, profileId]);
    try {
      const result = await api<
        GoogleLoginStatus | { googleLogin: GoogleLoginStatus }
      >(`/profiles/${profileId}/google-login/check`, "POST", {});
      const googleLogin = "googleLogin" in result ? result.googleLogin : result;
      setDesktopSessions((current) =>
        current.map((session) =>
          session.profileId === profileId
            ? { ...session, googleLogin }
            : session,
        ),
      );
      await load(true);
      if (googleLogin.status === "bound")
        notify(
          `已识别并绑定 Google 账号${googleLogin.detectedEmail ? `：${googleLogin.detectedEmail}` : ""}。`,
        );
    } catch (error) {
      notify(message(error), true);
    } finally {
      setGoogleChecking((current) => current.filter((id) => id !== profileId));
    }
  }
  async function confirmGoogleLogin(profileId: string, accountId?: string) {
    if (!accountId || googleChecking.includes(profileId)) return;
    setGoogleChecking((current) => [...current, profileId]);
    try {
      const googleLogin = await api<GoogleLoginStatus>(`/profiles/${profileId}/google-login/confirm`, "POST", { accountId });
      desktopSessions.filter((session) => session.profileId === profileId).forEach((session) => session.popup?.close());
      setDesktopSessions((current) => current.filter((session) => session.profileId !== profileId));
      setEmbeddedSession(undefined);
      await load(true);
      if (googleLogin.takeoverJobId) {
        notify("登录已确认，正在切换到自动化接管。桌面会结束，用户目录与账号绑定会保留。");
        const deadline = Date.now() + 180000;
        for (;;) {
          const job = await api<Job>(`/jobs/${googleLogin.takeoverJobId}`);
          if (job.status === "succeeded") break;
          if (!["queued", "running"].includes(job.status || ""))
            throw new Error(`自动化接管未完成：${job.error?.message || job.status}。可在任务中心查看详情。`);
          if (Date.now() > deadline) {
            notify("自动化接管仍在处理中，请在任务中心查看结果。");
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      await load(true);
      notify("已启用自动化接管，空闲自动关闭将按实例设置生效。");
    } catch (error) { notify(message(error), true); }
    finally { setGoogleChecking((current) => current.filter((id) => id !== profileId)); }
  }
  function startGoogleLogin(profile: Profile, accountId?: string) {
    if (browserMode(profile) === "vnc") {
      if (!profile.googleBinding) {
        setGoogleLoginTarget(undefined);
        navigateRoute({ kind: "profile", profileId: profile.id, tab: "accounts" });
        notify("请先绑定此 Chrome 的 Google 账号。保存绑定不表示已登录。");
        return;
      }
      if (accountId && accountId !== profile.googleBinding.accountId) {
        notify("Google 登录只能操作此 Chrome 已绑定的账号；如需更换，请先明确换绑。", true);
        return;
      }
      accountId = profile.googleBinding.accountId;
    }
    void openDesktop(profile, { googleLogin: true, accountId });
    setGoogleLoginTarget(undefined);
  }
  async function openDesktop(
    profile: Profile,
    options?: { googleLogin: boolean; accountId?: string },
  ) {
    const existing = desktopSessions.find((s) => s.profileId === profile.id);
    if (existing?.popup && !existing.popup.closed && !options?.googleLogin) {
      existing.popup.focus();
      return;
    }
    const reusePopup =
      existing?.popup && !existing.popup.closed ? existing.popup : null;
    const popup = reusePopup || window.open("about:blank", "_blank");
    if (popup && !reusePopup) {
      popup.document.title = "正在准备远程桌面";
      popup.document.body.textContent =
        "正在启动并准备受保护的远程桌面，请稍候…";
      popup.opener = null;
    }
    setActionId(`${profile.id}:${options?.googleLogin ? "google" : "desktop"}`);
    try {
      const data = await api<ManualSession>(
        `/profiles/${profile.id}/${options?.googleLogin ? "google-login" : "manual-sessions"}`,
        "POST",
        options?.googleLogin
          ? { accountId: options.accountId }
          : { explicitStart: true },
      );
      const path = safeDesktopPath(data.desktopPath);
      if (popup && (!reusePopup || existing?.id !== data.id))
        popup.location.replace(path);
      else popup?.focus();
      setDesktopSessions((current) => [
        ...current.filter((s) => s.profileId !== profile.id),
        { ...data, profileId: profile.id, desktopPath: path, popup },
      ]);
      notify(
        options?.googleLogin
          ? browserMode(profile) === "vnc"
            ? "已打开已绑定账号的 VNC 桌面。登录后可在账号状态或账号目录点击「确认已登录」，无需再次打开桌面。"
            : data.googleLogin?.navigationStatus === "pending"
            ? "Google页面尚未完成加载，已保留可自动连接的远程桌面。请检查此实例的网络和代理设置。"
            : options.accountId
              ? `远程桌面会自动连接。${googleAutofillSummary(data.googleLogin).title}。${googleAutofillSummary(data.googleLogin).description}`
              : "已打开 Google 登录，远程桌面会自动连接。未选择已导入账号，请自行填写凭证并完成验证。"
          : browserMode(profile) === "vnc"
            ? "普通 Chrome 的 VNC 会话已开始，远程桌面会使用已保存的密码自动连接。"
            : "人工会话已开始，远程桌面会使用已保存的密码自动连接。自动化将在会话结束后恢复。",
      );
      await load(true);
    } catch (e) {
      if (!reusePopup) popup?.close();
      notify(message(e), true);
    } finally {
      setActionId("");
    }
  }
  const profile = profiles.find((p) => p.id === selected) ||
    (directProfile?.id === selected ? directProfile : undefined);
  const embedded = desktopSessions.find((s) => s.id === embeddedSession);
  const googleTarget = profiles.find((p) => p.id === googleLoginTarget);
  if (session === "loading")
    return (
      <div className="app-loading">
        <Brand />
        <span className="spinner" />
        <p>正在连接工作台…</p>
      </div>
    );
  if (session === "anonymous")
    return <Login onLogin={() => setSession("authenticated")} />;
  const navigate = (target: View) => {
    navigateRoute({ kind: "page", view: target });
  };
  return (
    <div className="app-shell">
      {mobileNav && (
        <button
          className="nav-scrim"
          aria-label="关闭导航"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
        <Brand />
        <div className="workspace-label">管理空间</div>
        <nav aria-label="主导航">
          {(
            [
              ["profiles", "grid", "浏览器实例"],
              ["accounts", "users", "账号管理"],
              ["jobs", "terminal", "任务中心"],
              ["updates", "refresh", "更新管理"],
              ["mcp", "mcp", "MCP"],
              ["guide", "file", "使用指南"],
            ] as [View, IconName, string][]
          ).map(([key, icon, label]) => (
            <button
              key={key}
              className={`nav-item ${view === key ? "active" : ""}`}
              aria-current={view === key ? "page" : undefined}
              onClick={() => navigate(key)}
            >
              <Icon name={icon} />
              {label}
              {key === "profiles" && (
                <span className="nav-count">
                  {profiles.filter((p) => !p.archived).length}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="private-note">
            <Icon name="shield" />
            <div>
              私有部署<small>会话与数据由你掌控</small>
            </div>
          </div>
          <div className="admin">
            <span className="avatar">A</span>
            <div>
              管理员<small>安全会话已连接</small>
            </div>
            <button
              className="icon-button"
              title="退出登录"
              aria-label="退出登录"
              onClick={() => void logout()}
            >
              <Icon name="logout" />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setMobileNav(true)}
            >
              <Icon name="menu" />
            </button>
            <span>工作空间</span>
            <Icon name="chevron" size={13} />
            <strong>
              {route.kind === "not-found"
                ? "页面不存在"
                : create
                ? "创建 Chrome 容器"
                : view === "profiles"
                  ? "浏览器实例"
                  : view === "accounts"
                    ? "账号管理"
                    : view === "jobs"
                      ? "任务中心"
                      : view === "updates"
                        ? "更新管理"
                        : view === "mcp"
                          ? "MCP"
                        : "使用指南"}
            </strong>
            {!create && profile && (
              <>
                <Icon name="chevron" size={13} />
                <span>{profile.name}</span>
              </>
            )}
          </div>
          <div className="topbar-status">
            <span className={`connection-dot ${error ? "offline" : ""}`} />
            {error ? "连接异常" : "控制服务已连接"}
            <span className="topbar-divider" />
            自托管
          </div>
        </header>
        <main className={create ? "create-profile-page" : undefined}>
          {create &&
            (!createAccount || createAccount.id !== createAccountId ? (
              <section className="create-profile-layout">
                <button
                  className="back-link"
                  aria-label="返回创建来源"
                  onClick={cancelCreate}
                >
                  <Icon name="arrow" size={16} />
                  返回账号管理
                </button>
                <div className="page-heading">
                  <div>
                    <div className="eyebrow">NEW CHROME ENVIRONMENT</div>
                    <h1>创建 Chrome 容器</h1>
                  </div>
                </div>
                {createAccountError ? (
                  <div className="error-banner" role="alert">
                    <span>{createAccountError}</span>
                    <Button
                      onClick={() =>
                        setCreateAccountRetry((current) => current + 1)
                      }
                    >
                      重试
                    </Button>
                  </div>
                ) : (
                  <div className="panel loading-inline">
                    <span className="spinner" />
                    正在读取待关联账号…
                  </div>
                )}
                <Button onClick={cancelCreate}>取消创建</Button>
              </section>
            ) : (
              <CreateProfile
                key={createAccountId}
                initialAccount={createAccount}
                onOpenProfile={(profileId) => navigateRoute({ kind: "profile", profileId, tab: "accounts" })}
                onClose={cancelCreate}
                onCreated={async (data) => {
                  await load(true);
                  setCreateAccount(undefined);
                  navigateRoute({ kind: "profile", profileId: data.id, tab: "accounts" });
                  notify(
                    "实例已创建并配置期望账号。VNC 密码已加密保存，可在实例设置查看。",
                  );
                }}
              />
            ))}
          {desktopSessions.map((s) => (
            <div className="desktop-session-banner" key={s.id}>
              <Icon name="desktop" />
              <div>
                <strong>
                  {profiles.find((p) => p.id === s.profileId)?.name || "浏览器"}{" "}
                  · 人工接管中
                </strong>
                <small>{browserMode(profiles.find((profile) => profile.id === s.profileId)) === "vnc" ? "VNC 人工会话" : "自动化已暂停"} · 到期 {date(s.expiresAt)}</small>
              </div>
              <Button
                onClick={() => {
                  const profile = profiles.find((p) => p.id === s.profileId);
                  if (profile) void openDesktop(profile);
                }}
              >
                进入桌面
                <Icon name="external" size={13} />
              </Button>
              <Button onClick={() => setEmbeddedSession(s.id)}>内嵌桌面</Button>
              <Button onClick={() => void closeDesktop(s.id)}>
                结束人工接管
              </Button>
              {s.googleLogin && (
                <div className="google-session-status">
                  <GoogleLoginProgress
                    value={browserMode(profiles.find((profile) => profile.id === s.profileId)) === "vnc" && profiles.find((profile) => profile.id === s.profileId)?.googleBinding ? bindingProgress(profiles.find((profile) => profile.id === s.profileId)!.googleBinding!) : s.googleLogin}
                    mode={s.googleLogin.browserMode || browserMode(profiles.find((profile) => profile.id === s.profileId))}
                    busy={googleChecking.includes(s.profileId)}
                    onCheck={() => void checkGoogleLogin(s.profileId)}
                    confirmBusy={googleChecking.includes(s.profileId)}
                    onConfirm={profiles.find((profile) => profile.id === s.profileId)?.googleBinding ? () => void confirmGoogleLogin(s.profileId, profiles.find((profile) => profile.id === s.profileId)?.googleBinding?.accountId) : undefined}
                  />
                </div>
              )}
            </div>
          ))}
          {error && (
            <div className="error-banner" role="alert">
              <Icon name="alert" />
              <span>{error}</span>
              <Button onClick={() => void load()}>重试</Button>
            </div>
          )}
          {route.kind === "not-found" && (
            <Empty title="页面不存在" icon="file">
              <p>这个地址没有对应的工作台页面。请从导航重新选择。</p>
              <Button variant="primary" onClick={() => navigate("profiles")}>
                返回浏览器实例
              </Button>
            </Empty>
          )}
          {!create && route.kind !== "not-found" &&
            view === "profiles" &&
            (profile ? (
              <ProfileDetail
                key={profile.id}
                profile={profile}
                tab={detailTab}
                setTab={(tab) => navigateRoute({ kind: "profile", profileId: profile.id, tab })}
                jobId={route.kind === "profile" ? route.jobId : undefined}
                onSelectJob={(jobId) => navigateRoute({ kind: "profile", profileId: profile.id, tab: "tasks", jobId })}
                onBack={() => navigate("profiles")}
                reload={() => load(true)}
                notify={notify}
                action={action}
                openDesktop={openDesktop}
                busy={actionId}
                onGoogleLogin={(profile) => setGoogleLoginTarget(profile.id)}
                onGoogleLoginStart={startGoogleLogin}
                googleStatus={
                  desktopSessions.find(
                    (session) => session.profileId === profile.id,
                  )?.googleLogin
                }
                onGoogleCheck={() => void checkGoogleLogin(profile.id)}
                onGoogleConfirm={() => void confirmGoogleLogin(profile.id, profile.googleBinding?.accountId)}
                googleCheckBusy={googleChecking.includes(profile.id)}
              />
            ) : selected ? (
              profileLookup === "loading" ? (
                <div className="panel loading-inline" role="status">
                  <span className="spinner" />正在读取实例…
                </div>
              ) : (
                <Empty title={profileLookup === "missing" ? "找不到这个实例" : "无法读取实例"} icon="box">
                  <p>{profileLookup === "missing" ? "实例可能已被清理，或当前账号无法访问。" : profileError}</p>
                  <div className="heading-actions">
                    <Button variant="primary" onClick={() => navigate("profiles")}>返回浏览器实例</Button>
                    <Button onClick={() => setProfileRetry((current) => current + 1)}>重试</Button>
                  </div>
                </Empty>
              )
            ) : (
              <ProfileList
                profiles={profiles}
                loading={loading}
                onOpenAccounts={() => navigate("accounts")}
                onSelect={(id, tab = "overview") => navigateRoute({ kind: "profile", profileId: id, tab })}
                action={action}
                openDesktop={openDesktop}
                busy={actionId}
              />
            ))}
          {route.kind === "page" && view === "accounts" && (
            <AccountManager
              profiles={profiles}
              notify={notify}
              onOpenProfile={(id) => navigateRoute({ kind: "profile", profileId: id, tab: "accounts" })}
              onOpenDesktop={(profile) => void openDesktop(profile)}
              onLogin={startGoogleLogin}
              onCreateProfile={openCreate}
              onReloadProfiles={() => load(true)}
              onConfirm={(profile) => confirmGoogleLogin(profile.id, profile.googleBinding?.accountId)}
            />
          )}
          {route.kind === "page" && view === "jobs" && (
            <JobsPanel notify={notify} profiles={profiles} jobId={route.jobId} onSelectJob={(jobId) => navigateRoute({ kind: "page", view: "jobs", jobId })} />
          )}
          {route.kind === "page" && view === "updates" && <UpdatesPanel notify={notify} />}
          {route.kind === "page" && view === "mcp" && <McpPage origin={window.location.origin} notify={notify} />}
          {route.kind === "page" && view === "guide" && <Guide />}
        </main>
        <footer className="page-footer">
          <span>CHROME FLEET</span>
          <span>独立浏览器 · 持久化会话 · 自主掌控</span>
          <span>时间显示为 Asia/Shanghai</span>
        </footer>
      </div>
      {googleTarget && (
        <GoogleLoginDialog
          profile={googleTarget}
          onClose={() => setGoogleLoginTarget(undefined)}
          onStart={(accountId) => startGoogleLogin(googleTarget, accountId)}
        />
      )}
      {embedded && (
        <Modal
          title={`${profiles.find((p) => p.id === embedded.profileId)?.name || "浏览器"} · 远程桌面`}
          subtitle="远程桌面会使用已保存的密码自动连接。关闭此面板会结束人工接管并释放租约。"
          wide
          onClose={() => {
            setEmbeddedSession(undefined);
            void closeDesktop(embedded.id);
          }}
        >
          <div className="desktop-frame">
            <iframe
              title="Chrome 实例远程桌面"
              src={embedded.desktopPath}
              referrerPolicy="no-referrer"
            />
          </div>
        </Modal>
      )}
      {toast && (
        <div
          className={`toast ${toast.error ? "toast-error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          <Icon name={toast.error ? "alert" : "check"} />
          <span>{toast.text}</span>
          <button
            className="icon-button"
            aria-label="关闭通知"
            onClick={() => setToast(undefined)}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ csrfToken: string }>("/session", "POST", {
        token,
      });
      setCsrfToken(result.csrfToken);
      setToken("");
      onLogin();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <div className="login-visual">
        <Brand />
        <div className="login-orbit">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <span className="orbit-node node-one">
            <Icon name="desktop" size={24} />
          </span>
          <span className="orbit-node node-two">
            <Icon name="shield" size={24} />
          </span>
          <span className="orbit-node node-three">
            <Icon name="box" size={24} />
          </span>
          <div className="orbit-center">
            <Icon name="chrome" size={56} />
          </div>
        </div>
        <h1>
          你的浏览器。
          <br />
          你的工作空间。
        </h1>
        <p>
          每个账号，独立的 Chrome 环境。
          <br />
          让会话延续，让自动化有序运行。
        </p>
        <small>PRIVATE BY DESIGN · SELF-HOSTED</small>
      </div>
      <div className="login-form-wrap">
        <form className="login-form" onSubmit={submit}>
          <span className="eyebrow">CHROME FLEET CONSOLE</span>
          <h2>登录浏览器工作台</h2>
          <p>使用管理员平台访问令牌建立安全会话。</p>
          <Field
            label="平台访问令牌"
            hint="令牌仅用于本次登录，不会保存到浏览器本地存储。"
          >
            <input
              type="password"
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="输入你的访问令牌"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <Button variant="primary" busy={busy} type="submit" icon="arrow">
            安全登录
          </Button>
          <div className="login-foot">
            <Icon name="shield" size={16} />
            通过 HttpOnly 会话保护你的访问
          </div>
        </form>
      </div>
    </div>
  );
}

function ProfileList({
  profiles,
  loading,
  onOpenAccounts,
  onSelect,
  action,
  openDesktop,
  busy,
}: {
  profiles: Profile[];
  loading: boolean;
  onOpenAccounts: () => void;
  onSelect: (id: string, tab?: DetailTab) => void;
  action: (p: Profile, a: string) => Promise<void>;
  openDesktop: (p: Profile) => Promise<void>;
  busy: string;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [archived, setArchived] = useState(false);
  const active = profiles.filter((p) => !p.archived);
  const running = active.filter((p) => p.state === "running").length;
  const needsHelp = active.filter(
    (p) =>
      p.state === "error" ||
      p.accounts?.some((a) =>
        ["needs_login", "needs_verification"].includes(
          a.authState || a.state || a.status || "",
        ),
      ),
  ).length;
  const filtered = profiles.filter(
    (p) =>
      Boolean(p.archived) === archived &&
      (filter === "all" || p.state === filter) &&
      `${p.name} ${p.id} ${p.tags?.join(" ")} ${p.accounts?.map((a) => a.alias).join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="page-heading profile-list-heading">
        <div>
          <div className="eyebrow">BROWSER WORKSPACE</div>
          <h1>
            浏览器实例 <span className="heading-pill">{active.length}</span>
          </h1>
          <p>管理独立的 Chrome 环境，安心保存每一段工作会话。</p>
        </div>
        <HostResourceMetrics />
      </div>
      <div className="stats-grid">
        <Stat
          label="全部实例"
          value={active.length}
          icon="layers"
          caption="独立持久化环境"
        />
        <Stat
          label="正在运行"
          value={running}
          icon="play"
          color="green"
          caption="独立 Chrome 桌面与会话"
        />
        <Stat
          label="已停止"
          value={active.filter((p) => p.state === "stopped").length}
          icon="stop"
          caption="释放资源，保留会话数据"
        />
        <Stat
          label="需要关注"
          value={needsHelp}
          icon="shield"
          color="amber"
          caption="运行异常或账号待验证"
        />
      </div>
      <section className="instances-section">
        <div className="section-toolbar">
          <div className="segment">
            <button
              className={!archived ? "selected" : ""}
              onClick={() => setArchived(false)}
            >
              当前实例
            </button>
            <button
              className={archived ? "selected" : ""}
              onClick={() => setArchived(true)}
            >
              已归档 <span>{profiles.filter((p) => p.archived).length}</span>
            </button>
          </div>
          <div className="filters">
            <label className="search-input">
              <Icon name="search" size={17} />
              <input
                aria-label="搜索实例"
                placeholder="搜索名称、账号或标签…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <select
              aria-label="按运行状态筛选"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">所有状态</option>
              <option value="running">运行中</option>
              <option value="stopped">已停止</option>
              <option value="starting">启动中</option>
              <option value="error">异常</option>
            </select>
          </div>
        </div>
        {loading ? (
          <div className="cards-grid">
            {[0, 1, 2].map((i) => (
              <div className="profile-card skeleton" key={i}>
                <div />
                <div />
                <div />
              </div>
            ))}
          </div>
        ) : filtered.length ? (
          <div className="cards-grid">
            {filtered.map((p) => (
              <ProfileCard
                key={p.id}
                profile={p}
                onSelect={onSelect}
                action={action}
                openDesktop={openDesktop}
                busy={busy}
              />
            ))}
          </div>
        ) : (
          <Empty
            title={
              search || filter !== "all"
                ? "没有匹配的实例"
                : archived
                  ? "暂无归档实例"
                  : "暂无浏览器实例"
            }
          >
            <p>
              {search || filter !== "all"
                ? "试试其他名称、标签或状态。"
                : archived
                  ? "归档后，实例数据会保留在这里。"
                  : "前往账号管理，为账号创建独立的 Chrome 实例。"}
            </p>
            {!archived && !search && filter === "all" && (
              <Button variant="primary" icon="key" onClick={onOpenAccounts}>
                前往账号管理
              </Button>
            )}
          </Empty>
        )}
        <div className="list-foot">
          <span>{filtered.length} 个实例</span>
          <span>
            <span className="small-dot" /> 每 3 秒同步状态
          </span>
        </div>
      </section>
      <div className="bottom-note">
        <Icon name="shield" size={18} />
        <span>
          关闭容器会保留用户目录与账号会话。账号标记会区分人工确认与自动化检测；网站实际登录状态请在桌面核对。
        </span>
      </div>
    </>
  );
}
function Stat({
  label,
  value,
  icon,
  caption,
  color = "purple",
}: {
  label: string;
  value: number;
  icon: IconName;
  caption: string;
  color?: string;
}) {
  return (
    <div className="stat-card">
      <div>
        <span className="stat-label">{label}</span>
        <strong>{value.toString().padStart(2, "0")}</strong>
        <small>{caption}</small>
      </div>
      <span className={`stat-icon ${color}`}>
        <Icon name={icon} size={22} />
      </span>
    </div>
  );
}
function ProfileCard({
  profile: p,
  onSelect,
  action,
  openDesktop,
  busy,
}: {
  profile: Profile;
  onSelect: (id: string, tab?: DetailTab) => void;
  action: (p: Profile, a: string) => Promise<void>;
  openDesktop: (p: Profile) => Promise<void>;
  busy: string;
}) {
  const pending = Boolean(
    p.proxy?.enabled && p.proxy.version !== p.proxy.appliedVersion,
  );
  const locked = busyStates.includes(p.state) || busy.startsWith(`${p.id}:`);
  const primaryAccount =
    p.accounts
      ?.filter((account) => account.provider === "google")
      .sort(
        (a, b) =>
          (Date.parse(b.lastCheckedAt || "") || 0) -
          (Date.parse(a.lastCheckedAt || "") || 0),
      )[0] || p.accounts?.[0];
  return (
    <article
      className={`profile-card ${p.state === "running" ? "is-running" : ""}`}
    >
      <div className="profile-card-head">
        <span
          className={`browser-icon ${p.state === "running" ? "active-browser" : ""}`}
        >
          <ChromeMark />
        </span>
        <div className="profile-name">
          <button onClick={() => onSelect(p.id)}>{p.name}</button>
          <small>{p.googleBinding?.email || primaryAccount?.alias || "尚未关联账号"}</small>
        </div>
        <Badge value={p.archived ? "archived" : p.state} />
      </div>
      <div className="tag-row">
        <span className="tag">{browserModeLabel(p)}</span>
        {p.tags?.length ? (
          p.tags.slice(0, 3).map((tag) => (
            <span className="tag" key={tag}>
              {tag}
            </span>
          ))
        ) : (
          <span className="tag tag-muted">未添加标签</span>
        )}
        {p.autoWakePaused && <span className="tag paused">自动唤起已暂停</span>}
      </div>
      <div className="card-details">
        <div>
          <Icon name="box" size={15} />
          <span>{p.state !== "running" ? "上次 Chrome" : "Chrome"}</span>
          <strong>{p.chromeVersion || "尚未运行"}</strong>
        </div>
        <div>
          <Icon name="layers" size={15} />
          <span>启动策略</span>
          <strong>{policyNames[p.startupPolicy]}</strong>
        </div>
        <div>
          <Icon name="shield" size={15} />
          <span>网络代理</span>
          <strong className="proxy-address">
            {p.proxy?.enabled
              ? formatProxyAddress(p.proxy)
              : "直连"}
            {pending && <i title="保存的代理配置将在受控重启后应用">待生效</i>}
          </strong>
        </div>
        <div>
          <Icon name="key" size={15} />
          <span>登录确认</span>
          <strong>
            <Badge value={p.googleBinding ? p.googleBinding.confirmationState === "confirmed" ? "manually_confirmed" : "bound_unconfirmed" : "unknown"} label={p.googleBinding ? googleBindingLabel(p.googleBinding) : "账号关联待完善"} />
          </strong>
        </div>
      </div>
      <ResourceMetrics profile={p} />
      {p.currentJob && (
        <div className="card-job">
          <span className="spinner" />
          任务进行中{" "}
          <span className="mono">
            {typeof p.currentJob === "string"
              ? p.currentJob.slice(0, 8)
              : p.currentJob.id?.slice(0, 8)}
          </span>
        </div>
      )}
      {p.lastError && (
        <div
          className="card-error"
          title={
            typeof p.lastError === "string" ? p.lastError : p.lastError.message
          }
        >
          <Icon name="alert" size={14} />
          {typeof p.lastError === "string"
            ? p.lastError
            : p.lastError.message || "运行异常，请查看详情"}
        </div>
      )}
      {!p.archived && <ProfileAccountEntry profile={p} onOpen={() => onSelect(p.id, "accounts")} />}
      <div className="card-actions">
        {!p.archived && (
          <>
            <Button
              variant={p.state === "running" ? "default" : "primary"}
              icon={p.state === "running" ? "stop" : "play"}
              disabled={locked}
              onClick={() =>
                void action(p, p.state === "running" ? "stop" : "start")
              }
            >
              {p.state === "running" ? "关闭" : "启动"}
            </Button>
            <Button
              icon="desktop"
              disabled={locked || p.headless}
              title={p.headless ? "无头模式不能使用远程桌面" : undefined}
              onClick={() => void openDesktop(p)}
            >
              {p.state === "stopped" &&
              (p.startupPolicy === "manual" || p.autoWakePaused)
                ? "启动并打开"
                : "打开桌面"}
            </Button>
            <button
              className="icon-button"
              aria-label={`重启 ${p.name}`}
              title="重启"
              disabled={locked || p.state !== "running"}
              onClick={() => void action(p, "restart")}
            >
              <Icon name="refresh" />
            </button>
          </>
        )}
        <button
          className="icon-button card-settings"
          aria-label={`设置 ${p.name}`}
          title="设置"
          onClick={() => onSelect(p.id, "settings")}
        >
          <Icon name="settings" />
        </button>
        <button
          className="icon-button"
          aria-label={`查看 ${p.name} 的任务`}
          title="查看任务"
          onClick={() => onSelect(p.id, "tasks")}
        >
          <Icon name="chevron" />
        </button>
      </div>
    </article>
  );
}
function ChromeMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="14" fill="#e8eaf0" />
      <path
        d="M16 2a14 14 0 0 1 12.13 7H16a7 7 0 0 0-6.06 3.5L5.7 5.7A14 14 0 0 1 16 2"
        fill="#ef6c67"
      />
      <path
        d="M28.13 9a14 14 0 0 1-12.13 21l6.06-10.5A7 7 0 0 0 16 9Z"
        fill="#e8be5e"
      />
      <path
        d="M16 30A14 14 0 0 1 5.7 5.7l6.05 10.5A7 7 0 0 0 22.06 19.5Z"
        fill="#65ae88"
      />
      <circle cx="16" cy="16" r="7" fill="#f6f8fc" />
      <circle cx="16" cy="16" r="5.3" fill="#6e9cde" />
    </svg>
  );
}

function CreateProfile({
  onClose,
  onCreated,
  initialAccount,
  onOpenProfile,
}: {
  onClose: () => void;
  onCreated: (result: { id: string }) => void | Promise<void>;
  initialAccount: GoogleAccountOption;
  onOpenProfile: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyAddress, setProxyAddress] = useState("");
  const [mode, setMode] = useState<BrowserMode>("vnc");
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await api<{ id: string }>("/profiles", "POST", {
        name: data.get("name"),
        browserMode: mode,
        tags: String(data.get("tags") || "")
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean),
        accountAlias: initialAccount.email,
        startupPolicy: data.get("startupPolicy"),
        idleTimeoutMinutes: Number(data.get("idleTimeoutMinutes")),
        headless: mode === "vnc" ? false : data.get("headless") === "on",
        start: data.get("start") === "on",
        distribution: data.get("distribution") || "google",
        locale: data.get("locale") || "zh-CN",
        timezoneId: data.get("timezoneId") || "Asia/Shanghai",
        viewport: {
          width: Number(data.get("viewportWidth") || 1440),
          height: Number(data.get("viewportHeight") || 900),
        },
        resources: {
          memoryMb: Number(data.get("memoryMb") || 2048),
          cpus: Number(data.get("cpus") || 2),
          pidsLimit: 512,
        },
        vncPassword: data.get("vncPassword") || undefined,
        proxy: proxyEnabled ? proxyConfigFromForm(data) : undefined,
      });
      if (active.current) await onCreated(result);
    } catch (e) {
      if (active.current) setError(message(e));
    } finally {
      if (active.current) setBusy(false);
    }
  }
  if (initialAccount.bindings?.length) return (
    <section className="create-profile-layout">
      <button className="back-link" aria-label="返回创建来源" onClick={onClose}><Icon name="arrow" size={16} />返回账号管理</button>
      <div className="page-heading"><div><h1>该账号已关联 Chrome 实例</h1><p>每个账号只能关联一个 Chrome 实例，请继续使用现有实例。</p></div></div>
      <section className="panel">
        {initialAccount.bindings.map(binding => <Button key={binding.profileId} onClick={() => onOpenProfile(binding.profileId)}>查看实例 {binding.profileName}</Button>)}
      </section>
    </section>
  );
  return (
    <section className="create-profile-layout">
      <button
        className="back-link"
        aria-label="返回创建来源"
        onClick={onClose}
        disabled={busy}
      >
        <Icon name="arrow" size={16} />
        返回账号管理
      </button>
      <div className="page-heading">
        <div>
          <div className="eyebrow">NEW CHROME ENVIRONMENT</div>
          <h1>创建 Chrome 容器</h1>
          <p>每个实例拥有独立的用户目录、密钥存储与登录会话。</p>
        </div>
      </div>
      <Notice>
        将为 {initialAccount.email} 创建独立 Chrome 实例。创建后仍需通过
        VNC 桌面自行完成 Google 登录，再点击「确认已登录」切换到自动化接管。
      </Notice>
      <form className="panel create-profile-form" onSubmit={submit}>
        <div className="form-section">
          <h3>基本信息</h3>
          <div className="form-grid">
            <Field label="实例名称">
              <input
                required
                name="name"
                defaultValue={`Google · ${initialAccount.email.split("@")[0]}`.slice(0, 80)}
                placeholder="例如：日常工作"
                maxLength={80}
              />
            </Field>
            <Field label="关联账号">
              <input
                name="accountAlias"
                value={initialAccount.email}
                readOnly
              />
            </Field>
            <Field label="标签" hint="使用逗号分隔">
              <input name="tags" placeholder="工作, Google" />
            </Field>
            <Field label="浏览器模式" hint={mode === "vnc" ? vncModeDescription : "自动化模式为网页任务提供兼容支持；账号填写和检测由此模式单独启用。"}>
              <select value={mode} onChange={(event) => setMode(event.target.value as BrowserMode)} name="browserMode">
                <option value="vnc">VNC · 普通 Chrome（默认）</option>
                <option value="automation">自动化模式 · 兼容网页任务</option>
              </select>
            </Field>
            <Field label="启动策略">
              <select name="startupPolicy" defaultValue="on_demand">
                <option value="on_demand">按需启动</option>
                <option value="manual">仅手动启动</option>
                <option value="always">持续运行</option>
              </select>
            </Field>
            <Field label="空闲自动关闭（分钟）" hint="默认 15 分钟，0 表示禁用">
              <input
                type="number"
                name="idleTimeoutMinutes"
                defaultValue={15}
                min={0}
                max={10080}
              />
            </Field>
            <Field
              label="VNC 密码"
              hint="传统 VNCAuth 恰好使用 8 个可见 ASCII 字符；留空会生成独立密码并加密保存，可在实例设置随时查看"
            >
              <input
                type="password"
                name="vncPassword"
                minLength={8}
                maxLength={8}
                pattern="[\x21-\x7E]{8}"
                placeholder="留空自动生成"
                autoComplete="new-password"
              />
            </Field>
          </div>
        </div>
        <div className="form-section">
          <div className="section-title">
            <h3>独立网络代理</h3>
            <label className="check-field">
              <input
                type="checkbox"
                checked={proxyEnabled}
                onChange={(e) => setProxyEnabled(e.target.checked)}
              />
              启用代理
            </label>
          </div>
          {proxyEnabled ? (
            <>
              <ProxyFields address={proxyAddress} onAddressChange={setProxyAddress} />
              <p className="muted small">
                认证 SOCKS5 暂不支持。连接失败不会自动切回直连。
              </p>
            </>
          ) : (
            <p className="muted small">未设置代理，浏览器网页请求将直连。</p>
          )}
        </div>
        <div className="form-section compact">
          <label className="check-field">
            <input name="start" type="checkbox" />
            创建后立即启动
          </label>
          <label className="check-field">
            <input name="headless" type="checkbox" disabled={mode === "vnc"} />
            无头模式（不能使用远程桌面）
          </label>
        </div>
        <details className="advanced-options">
          <summary>高级参数 · 浏览器分发、语言与资源</summary>
          <div className="form-grid">
            <Field label="浏览器分发">
              <select name="distribution" defaultValue="google">
                <option value="google">Google Chrome Stable（默认）</option>
                <option value="cft">Chrome for Testing（显式替代）</option>
              </select>
            </Field>
            <Field label="浏览器语言">
              <input name="locale" defaultValue="zh-CN" />
            </Field>
            <Field label="浏览器时区">
              <input name="timezoneId" defaultValue="Asia/Shanghai" />
            </Field>
            <Field label="内存上限（MiB）">
              <input
                name="memoryMb"
                type="number"
                min={512}
                max={16384}
                defaultValue={2048}
              />
            </Field>
            <Field label="CPU 上限">
              <input
                name="cpus"
                type="number"
                min={0.25}
                max={8}
                step={0.25}
                defaultValue={2}
              />
            </Field>
            <Field label="窗口宽度">
              <input
                name="viewportWidth"
                type="number"
                min={800}
                max={3840}
                defaultValue={1440}
              />
            </Field>
            <Field label="窗口高度">
              <input
                name="viewportHeight"
                type="number"
                min={600}
                max={2160}
                defaultValue={900}
              />
            </Field>
          </div>
        </details>
        <Notice>
          登录提交、验证码与二次验证请在远程桌面中完成。保存会话不依赖
          Chrome Sync，也不保证网站登录永久有效。
        </Notice>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="create-profile-actions">
          <Button type="button" onClick={onClose} disabled={busy}>
            取消创建
          </Button>
          <Button type="submit" variant="primary" icon="plus" busy={busy}>
            创建实例
          </Button>
        </div>
      </form>
    </section>
  );
}
function ProfileDetail({
  profile: p,
  tab,
  setTab,
  jobId,
  onSelectJob,
  onBack,
  reload,
  notify,
  action,
  openDesktop,
  busy,
  onGoogleLogin,
  onGoogleLoginStart,
  googleStatus,
  onGoogleCheck,
  onGoogleConfirm,
  googleCheckBusy,
}: {
  profile: Profile;
  tab: DetailTab;
  setTab: (t: DetailTab) => void;
  jobId?: string;
  onSelectJob: (jobId?: string) => void;
  onBack: () => void;
  reload: () => Promise<void>;
  notify: Notify;
  action: (p: Profile, a: string) => Promise<void>;
  openDesktop: (p: Profile) => Promise<void>;
  busy: string;
  onGoogleLogin: (profile: Profile) => void;
  onGoogleLoginStart: (profile: Profile, accountId?: string) => void;
  googleStatus?: GoogleLoginStatus;
  onGoogleCheck: () => void;
  onGoogleConfirm: () => void;
  googleCheckBusy: boolean;
}) {
  const locked = busyStates.includes(p.state) || busy.startsWith(`${p.id}:`);
  return (
    <>
      <button className="back-link" onClick={onBack}>
        <Icon name="arrow" size={16} />
        返回全部实例
      </button>
      <div className="page-heading detail-heading">
        <div>
          <div className="detail-title">
            <span className="browser-icon">
              <ChromeMark />
            </span>
            <h1>{p.name}</h1>
            <Badge value={p.archived ? "archived" : p.state} />
          </div>
          <div className="detail-meta">
            <span className="mono">{p.id}</span>
            <span className="tag">{browserModeLabel(p)}</span>
          </div>
        </div>
        <div className="heading-actions">
          {!p.archived && (
            <>
              {browserMode(p) === "vnc" && !p.googleBinding ? <Button icon="key" onClick={() => setTab("accounts")}>绑定账号</Button> : <Button
                className="google-login-button"
                disabled={locked || p.headless}
                title={browserMode(p) === "vnc" ? "选择账号并打开普通 Chrome VNC 桌面" : "导航此实例的 Chrome 到 Google 登录"}
                onClick={() => onGoogleLogin(p)}
              >
                <GoogleMark />
                Google 登录
              </Button>}
              <Button
                icon={p.state === "running" ? "stop" : "play"}
                disabled={locked}
                onClick={() =>
                  void action(p, p.state === "running" ? "stop" : "start")
                }
              >
                {p.state === "running" ? "关闭实例" : "启动实例"}
              </Button>
              <Button
                icon="refresh"
                disabled={locked || p.state !== "running"}
                onClick={() => void action(p, "restart")}
              >
                重启
              </Button>
              <Button
                variant="primary"
                icon="desktop"
                disabled={locked || p.headless}
                onClick={() => void openDesktop(p)}
              >
                {p.state === "stopped" ? "启动并打开桌面" : "打开桌面"}
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="detail-tabs" role="tablist" aria-label="实例详情">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? "active" : ""}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="detail-content" role="tabpanel">
        {p.archived && (
          <Notice warning>
            此实例已归档，会话数据仍保留。请在实例设置中重新启用后，再执行任务、打开桌面或恢复操作。
          </Notice>
        )}
        {tab === "overview" && (
          <div className="detail-grid">
            <section className="panel">
              <div className="panel-heading">
                <h2>运行概览</h2>
                <span className="live-label">
                  <span className="small-dot" />
                  实时同步
                </span>
              </div>
              <dl className="info-list">
                <Info label="实际状态">
                  <Badge value={p.state} />
                </Info>
                <Info label="期望状态">
                  <Badge value={p.desiredState || "stopped"} />
                </Info>
                <Info label="启动策略">
                  {policyNames[p.startupPolicy]}
                  {p.autoWakePaused && (
                    <span className="tag paused">自动唤起已暂停</span>
                  )}
                </Info>
                <Info label="运行模式">
                  {browserModeLabel(p)}{p.headless ? " · 无头" : ""}
                </Info>
                <Info
                  label={
                    p.state !== "running" ? "上次运行 Chrome" : "Chrome 版本"
                  }
                >
                  {p.chromeVersion || "尚未运行"}
                </Info>
                {browserMode(p) !== "vnc" && <Info label="Playwright">{p.playwrightVersion || "—"}</Info>}
                <Info label="Agent 最近健康">
                  {p.state !== "running"
                    ? "未运行"
                    : p.health?.ready === true
                      ? "已就绪"
                      : p.health?.ready === false
                        ? "未就绪"
                        : "未上报"}
                </Info>
                <Info label="Chrome sandbox">
                  {p.state !== "running"
                    ? "未运行"
                    : p.health?.sandboxEnabled === true
                      ? "已启用"
                      : "未上报"}
                </Info>
                <Info label="keyring 最近检测">
                  {p.state !== "running"
                    ? "未运行"
                    : p.health?.keyring?.unlocked &&
                        p.health.keyring.probeVerified
                      ? "已解锁 · 探针通过"
                      : "未通过或未上报"}
                </Info>
                <Info label="空闲自动关闭">
                  {p.idleTimeoutMinutes
                    ? `${p.idleTimeoutMinutes} 分钟`
                    : "已禁用"}
                </Info>
                <Info label="最近活动">{date(p.lastActivityAt)}</Info>
                <Info label="创建时间">{date(p.createdAt)}</Info>
              </dl>
            </section>
            <div className="stack">
              <section className="panel">
                <div className="panel-heading">
                  <h2>资源与恢复点</h2>
                  <Icon name="layers" />
                </div>
                <ResourceMetrics profile={p} detail />
                <dl className="info-list">
                  <Info label="进程数">
                    {p.state === "running"
                      ? ["live", "sampling"].includes(resourceMetrics(p).status) && p.metrics?.available
                        ? (p.metrics?.pids ?? "未上报")
                        : "采样不可用"
                      : "未运行"}
                  </Info>
                  <Info label="数据磁盘占用（慢采样）">
                    {bytes(p.metrics?.diskBytes)}
                  </Info>
                  {p.resources && (
                    <Info label="资源上限">
                      {p.resources.cpus} CPU · {p.resources.memoryMb} MiB
                    </Info>
                  )}
                  <Info label="最近完整快照">
                    {p.lastSnapshotId ? (
                      <button
                        className="table-link mono"
                        onClick={() => setTab("sessions")}
                      >
                        {p.lastSnapshotId.slice(0, 18)}
                      </button>
                    ) : (
                      "尚无快照"
                    )}
                  </Info>
                  <Info label="最近更新记录">
                    {p.lastUpdateId ? (
                      <button
                        className="table-link mono"
                        onClick={() => setTab("updates")}
                      >
                        {p.lastUpdateId.slice(0, 18)}
                      </button>
                    ) : (
                      "尚无记录"
                    )}
                  </Info>
                </dl>
              </section>
              <section className="panel overview-access-panel">
                <div className="panel-heading">
                  <h2>访问与会话</h2>
                  <Icon name="shield" />
                </div>
                <dl className="info-list">
                  <Info label="网络代理">
                    {p.proxy?.enabled
                      ? formatProxyAddress(p.proxy)
                      : "直接连接"}
                  </Info>
                  <Info label="代理配置">
                    {p.proxy?.enabled
                      ? p.proxy.version === p.proxy.appliedVersion
                        ? "已生效"
                        : "待重启生效"
                      : "未启用"}
                  </Info>
                  <Info label="桌面密码">
                    {p.remoteDesktop?.passwordConfigured ? "已配置" : "待配置"}
                  </Info>
                  {browserMode(p) === "vnc" ? <><Info label="Google 绑定">{p.googleBinding?.email || "未绑定"}</Info><Info label="登录确认">{googleBindingLabel(p.googleBinding)}{p.googleBinding?.lastConfirmedAt && ` · ${date(p.googleBinding.lastConfirmedAt)}`}</Info></> : <Info label="账号绑定">{p.accounts?.length || 0} 个</Info>}
                </dl>
                <div className="overview-access-actions">
                {browserMode(p) === "vnc" && p.googleBinding && <Button variant="primary" busy={googleCheckBusy} onClick={onGoogleConfirm}>{p.googleBinding.confirmationState === "confirmed" ? "启用自动化接管" : "确认已登录"}</Button>}
                {browserMode(p) === "vnc" && <Button icon="key" onClick={() => setTab("accounts")}>账号绑定与登录确认</Button>}
                <Button
                  variant="ghost"
                  icon="settings"
                  onClick={() => setTab("settings")}
                >
                  管理实例设置
                </Button>
                <Button
                  variant="ghost"
                  icon="key"
                  onClick={() => {
                    setTab("settings");
                    requestAnimationFrame(() =>
                      document
                        .getElementById("vnc-password-settings")
                        ?.scrollIntoView({ block: "start" }),
                    );
                  }}
                >
                  前往查看 VNC 密码
                </Button>
                </div>
              </section>
              <Notice>
                {browserMode(p) === "vnc" ? "请在桌面完成登录并核对邮箱，再到「账号状态」确认已登录，启用自动化接管。" : "运行正常与账号登录有效是不同状态。自动化模式的账号检测结果可在「账号状态」中查看。"}
              </Notice>
              {p.lastError && (
                <div className="panel error-panel">
                  <h3>最近错误</h3>
                  <Data value={p.lastError} />
                </div>
              )}
            </div>
          </div>
        )}
        {tab === "settings" && (
          <Settings
            key={p.id}
            profile={p}
            reload={reload}
            notify={notify}
            onBack={onBack}
          />
        )}
        {tab === "accounts" && (
          browserMode(p) === "vnc" ? <VncGoogleBindingPanel
            profile={p} reload={reload} notify={notify}
            onLogin={(accountId) => onGoogleLoginStart(p, accountId)}
            onConfirm={onGoogleConfirm} onOpenDesktop={() => void openDesktop(p)}
            busy={locked} confirming={googleCheckBusy}
          /> : <AccountsPanel
            profile={p}
            notify={notify}
            onGoogleLogin={(accountId) => onGoogleLoginStart(p, accountId)}
            googleStatus={googleStatus}
            onGoogleCheck={onGoogleCheck}
            onGoogleConfirm={onGoogleConfirm}
            onOpenDesktop={() => void openDesktop(p)}
            googleCheckBusy={googleCheckBusy}
            loginBusy={locked}
            onOpenSettings={() => setTab("settings")}
          />
        )}
        {tab === "tasks" && (
          <JobsPanel profileId={p.id} profiles={[p]} notify={notify} jobId={jobId} onSelectJob={onSelectJob} />
        )}
        {tab === "sessions" && <SessionsPanel profile={p} notify={notify} />}
        {tab === "updates" && (browserMode(p) === "vnc" ? <Notice>当前为 VNC 模式，浏览器更新所需的自动化兼容验证未启用。请在实例设置单独管理浏览器模式。</Notice> : <UpdatesPanel profile={p} notify={notify} />)}
      </div>
    </>
  );
}
function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Settings({
  profile: p,
  reload,
  notify,
  onBack,
}: {
  profile: Profile;
  reload: () => Promise<void>;
  notify: Notify;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState("");
  const [proxyEnabled, setProxyEnabled] = useState(p.proxy?.enabled || false);
  const [proxyAddress, setProxyAddress] = useState(() => formatProxyAddress(p.proxy));
  const [confirm, setConfirm] = useState<"archive" | "purge" | undefined>();
  const [confirmation, setConfirmation] = useState("");
  async function save(
    path: string,
    method: string,
    body?: unknown,
    success = "配置已保存",
  ) {
    setBusy(path || "basic");
    try {
      const result = await api(`/profiles/${p.id}${path}`, method, body);
      notify(success);
      await reload();
      return result;
    } catch (e) {
      notify(message(e), true);
      return undefined;
    } finally {
      setBusy("");
    }
  }
  async function runtime(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    await save("/runtime-policy", "PATCH", {
      startupPolicy: d.get("startupPolicy"),
      idleTimeoutMinutes: Number(d.get("idleTimeoutMinutes")),
      autoWakePaused: d.get("autoWakePaused") === "on",
    });
  }
  async function rename(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    await save(
      "",
      "PATCH",
      {
        name: d.get("name"),
        tags: String(d.get("tags"))
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean),
        ...(p.state !== "running" && p.headless !== (d.get("headless") === "on")
          ? { headless: d.get("headless") === "on" }
          : {}),
      },
      "基本设置已保存。",
    );
  }
  async function proxy(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const d = new FormData(form);
    if (!proxyEnabled) {
      await save(
        "/proxy",
        "DELETE",
        undefined,
        "代理已禁用，运行中的实例需要受控重启以应用。",
      );
      return;
    }
    let config;
    try { config = proxyConfigFromForm(d, p.proxy); }
    catch (error) { notify(message(error), true); return; }
    const result = await save(
      "/proxy",
      "PUT",
      config,
      "代理配置已保存。请查看生效版本，必要时重启实例。",
    );
    if (result) {
      setProxyAddress(formatProxyAddress(result));
      for (const name of ["proxyUsername", "proxyPassword"]) {
        const input = form.elements.namedItem(name) as HTMLInputElement | null;
        if (input) input.value = "";
      }
    }
  }
  async function destructive() {
    const result = await save(
      confirm === "purge" ? "/purge" : "",
      confirm === "purge" ? "POST" : "DELETE",
      confirm === "purge" ? { confirmation } : undefined,
      confirm === "purge"
        ? "实例数据已彻底清理。"
        : "实例已归档，会话数据仍保留。",
    );
    if (result !== undefined) {
      setConfirm(undefined);
      onBack();
    }
  }
  return (
    <div className="settings-stack settings-layout">
      <div className="settings-columns">
        <div className="settings-column">
          <section className="panel settings-basic">
            <div className="panel-heading">
              <div>
                <h2>基本设置</h2>
                <p>为独立环境命名，组织你的工作空间。</p>
              </div>
              <Icon name="box" />
            </div>
            <form onSubmit={rename}>
              <div className="form-grid settings-basic-fields">
                <Field label="实例名称">
                  <input name="name" required defaultValue={p.name} />
                </Field>
                <Field label="标签">
                  <input
                    name="tags"
                    defaultValue={p.tags?.join(", ")}
                    placeholder="用逗号分隔"
                  />
                </Field>
              </div>
              <div className="settings-inline-option">
                <Field
                  label="运行模式"
                  hint={
                    p.state === "running" ? "请先停止实例后修改运行模式" : undefined
                  }
                >
                  <span className="check-field inline-check">
                    <input
                      name="headless"
                      type="checkbox"
                      disabled={p.state === "running" || browserMode(p) === "vnc"}
                      defaultChecked={p.headless}
                    />
                    无头模式
                  </span>
                </Field>
              </div>
              <div className="form-actions">
                <Button
                  type="submit"
                  busy={busy === "basic"}
                  disabled={Boolean(busy)}
                >
                  保存基本设置
                </Button>
              </div>
            </form>
          </section>
          <section className="panel settings-runtime">
            <div className="panel-heading">
              <div>
                <h2>启动与空闲策略</h2>
                <p>按需分配浏览器资源。</p>
              </div>
              <Icon name="clock" />
            </div>
            <form onSubmit={runtime}>
              <Field label="启动策略">
                <select name="startupPolicy" defaultValue={p.startupPolicy}>
                  <option value="on_demand">
                    按需启动 · 任务或桌面需要时运行
                  </option>
                  <option value="manual">手动启动 · 后台任务不能自动启动</option>
                  <option value="always">持续运行 · 维持实例在线</option>
                </select>
              </Field>
              <div className="field settings-idle-policy">
                <label htmlFor={`${p.id}-idle-timeout`}>空闲自动关闭（分钟）</label>
                <div className="settings-policy-controls">
                  <input
                    id={`${p.id}-idle-timeout`}
                    name="idleTimeoutMinutes"
                    type="number"
                    min={0}
                    max={10080}
                    defaultValue={p.idleTimeoutMinutes}
                  />
                  <label className="check-field">
                    <input
                      name="autoWakePaused"
                      type="checkbox"
                      defaultChecked={p.autoWakePaused}
                    />
                    暂停自动唤起
                  </label>
                </div>
                <small>任务、下载和人工接管期间不会被视为空闲；0 为禁用</small>
              </div>
              <div className="form-actions">
                <Button
                  type="submit"
                  busy={busy === "/runtime-policy"}
                  disabled={Boolean(busy)}
                >
                  保存运行策略
                </Button>
              </div>
            </form>
          </section>
          <BrowserModeSettings profile={p} reload={reload} notify={notify} />
        </div>
        <div className="settings-column">
          <VncPasswordSettings
            key={p.id}
            profile={p}
            onChanged={reload}
            notify={notify}
          />
          <section className="panel settings-proxy">
            <div className="panel-heading">
              <div>
                <h2>实例网络代理</h2>
                <p>代理应用于此实例中 Chrome 的网页请求。</p>
              </div>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={proxyEnabled}
                  onChange={(e) => setProxyEnabled(e.target.checked)}
                />
                启用代理
              </label>
            </div>
            <div className="proxy-status">
              <span>
                配置版本 <b>{p.proxy?.version || 0}</b>
              </span>
              <span>
                生效版本 <b>{p.proxy?.appliedVersion || 0}</b>
              </span>
              {p.proxy?.version !== p.proxy?.appliedVersion && (
                <span className="tag paused">待重启生效</span>
              )}
              {p.proxy?.hasCredentials && (
                <span className="tag">认证凭证已设置</span>
              )}
            </div>
            <form onSubmit={proxy}>
              {proxyEnabled && (
                <ProxyFields
                  proxy={p.proxy}
                  address={proxyAddress}
                  onAddressChange={setProxyAddress}
                />
              )}
              <Notice>
                代理连接失败时不会切换为直连。HTTP/HTTPS 和无认证 SOCKS5
                可用；代理不等价于整个容器的网络隧道，bypass、DNS 与 WebRTC
                的行为需要按目标站点验证。
                {browserMode(p) === "vnc" && " VNC 模式不执行自动化出口测试，请在 Chrome 桌面自行检查代理连接。"}
              </Notice>
              <div className="form-actions">
                <Button
                  type="button"
                  icon="arrow"
                  disabled={Boolean(busy) || !p.proxy?.enabled || browserMode(p) === "vnc"}
                  title={browserMode(p) === "vnc" ? "VNC 模式不使用自动化页面测试，请在桌面自行检查代理连接" : undefined}
                  onClick={async () => {
                    const r = await save(
                      "/proxy/test",
                      "POST",
                      {},
                      "浏览器代理测试已加入任务队列，请在自动化任务中查看 HTTP、HTTPS 与出口结果。",
                    );
                    if (r?.jobId) notify(`代理测试任务已提交：${r.jobId}`);
                  }}
                >
                  测试浏览器出口
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  busy={busy === "/proxy"}
                  disabled={Boolean(busy)}
                >
                  保存代理配置
                </Button>
              </div>
            </form>
          </section>
        </div>
      </div>
      <section className="panel danger-zone">
        <div>
          <h2>{p.archived ? "已归档实例" : "归档与清理"}</h2>
          <p>
            {p.archived
              ? "你可以重新启用此实例，或明确清理全部会话数据。"
              : "归档会停止并移除容器，保留用户目录、密钥存储、配置和账号绑定。"}
          </p>
        </div>
        <div className="heading-actions">
          {p.archived ? (
            <Button
              disabled={Boolean(busy)}
              onClick={() =>
                void save(
                  "/unarchive",
                  "POST",
                  {},
                  "实例已重新启用，当前保持停止状态。",
                )
              }
            >
              重新启用
            </Button>
          ) : (
            <Button onClick={() => setConfirm("archive")}>归档实例</Button>
          )}
          <Button
            variant="danger"
            disabled={!p.archived}
            title={!p.archived ? "请先归档实例，再彻底清理" : undefined}
            onClick={() => setConfirm("purge")}
          >
            彻底清理数据
          </Button>
        </div>
      </section>
      {confirm && (
        <Modal
          title={confirm === "purge" ? "彻底清理这个实例？" : "归档这个实例？"}
          onClose={() => setConfirm(undefined)}
        >
          <Notice warning>
            {confirm === "purge"
              ? "将永久删除该实例的用户目录、keyring、Cookies、备份及关联数据，无法撤销。不会影响其他实例。"
              : "正在运行的实例会停止，容器将移除。会话数据和实例配置仍会保留，可重新启用。"}
          </Notice>
          {confirm === "purge" && (
            <Field label="输入实例 ID 确认清理" hint={p.id}>
              <input
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="off"
              />
            </Field>
          )}
          <div className="modal-actions">
            <Button onClick={() => setConfirm(undefined)}>取消</Button>
            <Button
              variant="danger"
              disabled={confirm === "purge" && confirmation !== p.id}
              busy={Boolean(busy)}
              onClick={() => void destructive()}
            >
              {confirm === "purge" ? "永久清理" : "确认归档"}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function AccountsPanel({
  profile: p,
  notify,
  onGoogleLogin,
  googleStatus,
  onGoogleCheck,
  onGoogleConfirm,
  onOpenDesktop,
  googleCheckBusy,
  loginBusy,
  onOpenSettings,
}: {
  profile: Profile;
  notify: Notify;
  onGoogleLogin: (accountId?: string) => void;
  googleStatus?: GoogleLoginStatus;
  onGoogleCheck: () => void;
  onGoogleConfirm: () => void;
  onOpenDesktop: () => void;
  googleCheckBusy: boolean;
  loginBusy: boolean;
  onOpenSettings: () => void;
}) {
  const vnc = browserMode(p) === "vnc";
  const [googleAccountId, setGoogleAccountId] = useState(googleStatus?.expectedAccountId || "");
  useEffect(() => { if (googleStatus?.expectedAccountId) setGoogleAccountId(googleStatus.expectedAccountId); }, [googleStatus?.expectedAccountId]);
  const [accounts, setAccounts] = useState<Account[]>(p.accounts || []);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [detector, setDetector] = useState(false);
  const load = useCallback(async () => {
    try {
      setAccounts(items<Account>(await api(`/profiles/${p.id}/accounts`)));
      setError("");
    } catch (e) {
      setError(message(e));
    }
  }, [p.id]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    setBusy(true);
    try {
      await api(`/profiles/${p.id}/accounts`, "POST", {
        provider: d.get("provider"),
        alias: d.get("alias"),
        expectedIdentity: d.get("identity"),
        detector: detector
          ? {
              url: d.get("detectorUrl"),
              identityLocator: { css: d.get("identitySelector") },
              verificationLocator: d.get("verificationSelector")
                ? { css: d.get("verificationSelector") }
                : undefined,
            }
          : undefined,
      });
      setShow(false);
      notify(vnc ? "已记录期望账号，尚未确认登录。请在 VNC 桌面登录后人工确认映射。" : "期望账号已绑定。请通过实际站点检测确认登录身份。");
      await load();
    } catch (e) {
      notify(message(e), true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="sub-heading">
        <div>
          <h2>账号状态</h2>
          <p>{vnc ? "记录此 Chrome 与账号的人工确认映射，不代表服务器验证实际登录。" : "记录期望身份，避免在错误账号中执行任务。"}</p>
        </div>
        <div className="heading-actions">
          <Button
            icon="refresh"
            busy={busy}
            disabled={vnc}
            title={vnc ? "VNC 模式不读取网页或检测登录身份" : undefined}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api(
                  `/profiles/${p.id}/accounts/check`,
                  "POST",
                  {},
                );
                notify(`登录状态检测任务已提交：${r.jobId}`);
              } catch (e) {
                notify(message(e), true);
              } finally {
                setBusy(false);
              }
            }}
          >
            检测登录状态
          </Button>
          <Button variant="primary" icon="plus" onClick={() => setShow(true)}>
            绑定期望账号
          </Button>
        </div>
      </div>
      <ProfileConfirmationSummary profile={p} onOpenSettings={onOpenSettings} />
      <section className="panel google-account-panel">
        <div className="panel-heading">
          <div className="google-account-panel-title">
            <GoogleMark />
            <div>
              <h2>{vnc ? "VNC 登录与人工绑定" : "Google 登录辅助"}</h2>
              <p>{vnc ? "先选账号，进入普通 Chrome 自行登录，再明确确认绑定。" : "自动化模式的填写与身份检测兼容功能。"}</p>
            </div>
          </div>
          <Button
            className="google-login-button"
            disabled={loginBusy || p.headless || p.archived || (vnc && !googleAccountId)}
            onClick={() => onGoogleLogin(googleAccountId || undefined)}
          >
            <GoogleMark />
            {vnc ? "打开VNC登录" : "Google 登录"}
          </Button>
        </div>
        <GoogleAccountPicker
          profileId={p.id}
          value={googleAccountId}
          onChange={setGoogleAccountId}
          refreshKey={googleStatus?.status}
          mode={browserMode(p)}
        />
        <p className="google-login-guidance">
          远程桌面会自动连接。{vnc ? "请自行在 Chrome 打开 Google 登录页，填写邮箱、密码并完成验证。系统不读取 DOM、不自动填凭据、不检测身份。登录后回到下方确认，系统会保留用户目录并切换到自动化接管。" : googleAccountId
            ? "系统填写所选账号的邮箱，等待你点击邮箱页的下一步；检测进入密码页后再填写密码，由你确认提交。"
            : "选择已导入账号可启用填写辅助；不指定账号时，请在桌面自行填写登录凭证。"}
          {!vnc && " 验证码与二次验证由你完成。保存的账号密码可在账号管理中查看和编辑。登录后由自动化模式检测身份。"}
        </p>
        {vnc && <Button disabled={loginBusy || p.headless || p.archived} onClick={onOpenDesktop}>仅打开桌面，不绑定账号</Button>}
        {googleStatus && (
          <GoogleLoginProgress
            value={googleStatus}
            busy={googleCheckBusy}
            onCheck={onGoogleCheck}
            mode={browserMode(p)}
            onConfirm={googleStatus.expectedAccountId ? onGoogleConfirm : undefined}
            confirmBusy={googleCheckBusy}
          />
        )}
      </section>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Notice>
        {vnc ? "「人工确认」只表示你确认了此账号与 Chrome 的映射，不表示服务器检测过 Google。已有历史绑定也不能证明当前网站实际已登录。" : "Cookie 存在不代表账号已登录。自动化检测结果与人工确认记录会分别标记。"}
      </Notice>
      <div className="panel account-list">
        {accounts.length ? (
          accounts.map((a) => (
            <div className="account-row" key={a.id}>
              <span className="account-avatar">
                {(a.provider || "A").slice(0, 1).toUpperCase()}
              </span>
              <div>
                <strong>{a.alias || a.provider}</strong>
                <p>{a.expectedIdentity}</p>
                <small>
                  {a.provider} · {a.authState === "manually_confirmed" ? `人工确认 ${date(a.boundAt || a.lastCheckedAt)} · 非服务器验证` : `最近检测 ${date(a.lastCheckedAt)}`}
                </small>
              </div>
              <Badge value={a.authState || a.state || a.status || "unknown"} label={vnc && a.authState === "authenticated" ? "历史自动化检测" : undefined} />
            </div>
          ))
        ) : (
          <Empty title="尚未绑定期望账号" icon="key">
            <p>先在远程桌面完成登录，再绑定对应的账号身份。</p>
          </Empty>
        )}
      </div>
      {show && (
        <Modal
          title="绑定期望账号"
          subtitle="只记录期望身份，不收集你的网站密码"
          onClose={() => setShow(false)}
        >
          <form onSubmit={add}>
            <Field label="站点 / 提供商">
              <input
                name="provider"
                required
                placeholder="例如 google 或 example.com"
              />
            </Field>
            <Field label="账号别名">
              <input name="alias" required placeholder="例如 工作账号" />
            </Field>
            <Field label="期望账号身份">
              <input
                name="identity"
                required
                placeholder="邮箱或可核验的账号标识"
              />
            </Field>
            <label className="check-field">
              <input
                type="checkbox"
                checked={detector}
                onChange={(e) => setDetector(e.target.checked)}
              />
              配置自有站点检测器
            </label>
            {detector && (
              <>
                <Field label="检测页面 URL">
                  <input
                    name="detectorUrl"
                    type="url"
                    required
                    placeholder="https://example.com/account"
                  />
                </Field>
                <Field label="账号身份 CSS 选择器">
                  <input
                    name="identitySelector"
                    required
                    placeholder="[data-account-email]"
                  />
                </Field>
                <Field label="验证 / CAPTCHA 元素 CSS 选择器">
                  <input name="verificationSelector" placeholder="可选" />
                </Field>
              </>
            )}
            <div className="modal-actions">
              <Button type="button" onClick={() => setShow(false)}>
                取消
              </Button>
              <Button type="submit" variant="primary" busy={busy}>
                绑定账号
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

function JobsPanel({
  profileId,
  notify,
  profiles = [],
  jobId,
  onSelectJob,
}: {
  profileId?: string;
  notify: Notify;
  profiles?: Profile[];
  jobId?: string;
  onSelectJob: (jobId?: string) => void;
}) {
  const automationProfiles = profiles.filter((profile) => !profile.archived && browserMode(profile) === "automation");
  const vnc = Boolean(profileId && browserMode(profiles.find((profile) => profile.id === profileId)) === "vnc");
  const [targetId, setTargetId] = useState(
    profileId || automationProfiles[0]?.id || "",
  );
  useEffect(() => {
    if (!profileId && !automationProfiles.some((profile) => profile.id === targetId)) setTargetId(automationProfiles[0]?.id || "");
  }, [profileId, profiles, targetId]);
  const [jobRange, setJobRange] = useState(() => recentJobRange());
  const { jobs, total, density, loading, loadingMore, hasMore, error, moreError, densityError, refresh: load, loadMore } = useJobHistory(jobHistoryQuery(jobRange, profileId));
  const loadMoreTarget = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (loading || loadingMore || !hasMore || moreError || !loadMoreTarget.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore();
    }, { rootMargin: "240px" });
    observer.observe(loadMoreTarget.current);
    return () => observer.disconnect();
  }, [loading, loadingMore, hasMore, moreError, jobs.length, loadMore]);
  const [submit, setSubmit] = useState(false);
  const [busy, setBusy] = useState("");
  const [detail, setDetail] = useState<Job>();
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  useEffect(() => {
    setDetail(undefined);
    setDetailError("");
    if (!jobId) return;
    let active = true;
    setDetailLoading(true);
    const recover = async () => {
      try {
        const job = await api<Job>(`/jobs/${encodeURIComponent(jobId)}`);
        if (profileId && job.profileId !== profileId)
          throw new Error("这个任务不属于当前实例，请返回任务中心查看。");
        if (active) {
          setDetail(job);
          setDetailError("");
        }
      } catch (error) {
        if (active) setDetailError(message(error));
      } finally {
        if (active) setDetailLoading(false);
      }
    };
    void recover();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void recover();
    }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [jobId, profileId]);
  async function control(job: Job, action: string) {
    setBusy(job.id);
    try {
      await api(`/jobs/${job.id}/${action}`, "POST", {});
      notify(
        action === "cancel"
          ? "取消请求已提交，已发生的副作用不会自动撤销。"
          : "任务恢复请求已提交。",
      );
      await load();
    } catch (e) {
      notify(message(e), true);
    } finally {
      setBusy("");
    }
  }
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    setBusy("create");
    try {
      if (!automationProfiles.some((profile) => profile.id === (profileId || d.get("profileId"))))
        throw new Error("VNC 模式不执行网页自动化任务。");
      const steps = JSON.parse(String(d.get("steps")));
      if (!Array.isArray(steps)) throw new Error("步骤必须是 JSON 数组");
      const r = await api("/jobs", "POST", {
        profileId: profileId || d.get("profileId"),
        steps,
        timeoutMs: Number(d.get("timeoutMs")),
        expectedAccountId: d.get("expectedAccountId") || undefined,
      });
      notify(`任务已提交：${r.jobId}`);
      setSubmit(false);
      await load();
    } catch (e) {
      notify(message(e), true);
    } finally {
      setBusy("");
    }
  }
  const displayedDetail = jobId
    ? jobs.find((j) => j.id === jobId) || (detail?.id === jobId ? detail : undefined)
    : undefined;
  return (
    <>
      <div className={profileId ? "sub-heading" : "page-heading"}>
        <div>
          {!profileId && <div className="eyebrow">AUTOMATION QUEUE</div>}
          <h1 className={profileId ? "sub-title" : ""}>
            {profileId ? "自动化任务" : "任务中心"}
          </h1>
          <p>同一实例串行执行，不同实例可并行。异常动作不会自动重放。</p>
        </div>
        <Button
          variant="primary"
          icon="plus"
          onClick={() => setSubmit(true)}
          aria-label="提交任务"
          title="提交任务"
          disabled={vnc || !automationProfiles.length}
        >
          提交任务
        </Button>
      </div>
      {(vnc || !automationProfiles.length) && <Notice>VNC 模式不执行网页自动化任务。此处可查看历史任务，浏览器模式在实例设置中单独管理。</Notice>}
      <JobTimeline range={jobRange} onRangeChange={setJobRange} density={density} error={densityError} onRetry={() => void load()} />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="panel table-panel job-history-table">
        <div className="job-history-summary"><h2>任务记录</h2><span>已加载 {jobs.length} / {total} 条</span></div>
        {loading ? (
          <div className="loading-inline">
            <span className="spinner" />
            正在读取任务队列…
          </div>
        ) : jobs.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>任务</th>
                  {!profileId && <th>实例</th>}
                  <th>状态</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => {
                  const state = j.state || j.status || "unknown";
                  return (
                    <tr key={j.id} data-job-id={j.id}>
                      <td>
                        <div className="job-history-task"><i style={{ background: jobColor(j.kind || j.type || "automation") }} aria-hidden="true" /><button
                          className="table-link"
                          onClick={() => onSelectJob(j.id)}
                        >
                          {jobKind(j.kind || j.type)}
                        </button></div>
                        <small className="mono">{j.id.slice(0, 12)}</small>
                      </td>
                      {!profileId && (
                        <td>
                          {profiles.find((p) => p.id === j.profileId)?.name ||
                            j.profileId?.slice(0, 8)}
                        </td>
                      )}
                      <td>
                        <Badge value={state} />
                      </td>
                      <td className="muted">{date(j.createdAt)}</td>
                      <td>
                        <div className="table-actions">
                          <Button variant="ghost" onClick={() => onSelectJob(j.id)}>
                            查看
                          </Button>
                          {state === "waiting_for_human" && (
                            <Button
                              busy={busy === j.id}
                              disabled={browserMode(profiles.find((profile) => profile.id === j.profileId)) === "vnc"}
                              onClick={() => void control(j, "resume")}
                            >
                              恢复
                            </Button>
                          )}
                          {["queued", "running", "waiting_for_human"].includes(
                            state,
                          ) && (
                            <Button
                              variant="ghost"
                              busy={busy === j.id}
                              onClick={() => void control(j, "cancel")}
                            >
                              取消
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={error ? "任务读取失败" : "所选日期范围内暂无任务"} icon="terminal">
            {error ? <Button onClick={() => void load()}>重新加载</Button> : <p>可调整日期范围，或提交新的自动化任务。</p>}
          </Empty>
        )}
        {!loading && jobs.length > 0 && <div ref={loadMoreTarget} className="job-history-footer" aria-live="polite">
          {loadingMore ? <><span className="spinner" />正在加载更多任务…</> : moreError ? <><span className="form-error">加载失败：{moreError}</span><Button variant="ghost" onClick={() => void loadMore()}>重试加载</Button></> : hasMore ? <><span>继续向下滚动加载更多</span><Button variant="ghost" onClick={() => void loadMore()}>加载更多</Button></> : <span>已加载全部 {total} 条任务</span>}
        </div>}
      </div>
      <div className="bottom-note">
        <Icon name="alert" size={18} />
        <span>
          「等待人工」需要你完成验证；「结果未知」表示动作可能已经发生，请先人工核验，再决定下一步。
        </span>
      </div>
      {submit && (
        <Modal
          title="提交自动化任务"
          subtitle="声明式步骤通过持久化队列执行，和远程桌面共用同一浏览器"
          onClose={() => setSubmit(false)}
          wide
        >
          <form onSubmit={create}>
            {!profileId && (
              <Field label="目标实例">
                <select
                  name="profileId"
                  required
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                >
                  {automationProfiles
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </Field>
            )}
            <Field
              label="执行前核验账号"
              hint="选定后，身份未验证将暂停任务等待人工处理"
            >
              <select name="expectedAccountId">
                <option value="">不指定账号检测</option>
                {profiles
                  .find((p) => p.id === (profileId || targetId))
                  ?.accounts?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.alias} · {a.expectedIdentity}
                    </option>
                  ))}
              </select>
            </Field>
            <Field
              label="任务步骤（JSON）"
              hint="支持 goto、click、fill、extractText、screenshot、waitFor 等受限步骤；不支持任意脚本执行"
            >
              <textarea
                className="code-input"
                name="steps"
                required
                rows={10}
                defaultValue={
                  '[\n  { "action": "goto", "url": "https://example.com" },\n  { "action": "extractText", "locator": { "css": "h1" } }\n]'
                }
              />
            </Field>
            <Field label="超时（毫秒）">
              <input
                name="timeoutMs"
                type="number"
                min={1000}
                max={600000}
                defaultValue={60000}
              />
            </Field>
            <Notice warning>
              点击、导航等操作也可能产生副作用。任务异常时请先检查结果，避免重复提交不可逆动作。
            </Notice>
            <div className="modal-actions">
              <Button type="button" onClick={() => setSubmit(false)}>
                取消
              </Button>
              <Button type="submit" variant="primary" busy={busy === "create"}>
                提交任务
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {jobId && (
        <Modal
          title="任务详情"
          subtitle={jobId}
          onClose={() => onSelectJob(undefined)}
          wide
        >
          {detailError && <p className="form-error" role="alert">{detailError}</p>}
          {displayedDetail ? <>
          <div className="job-detail-top">
            <Badge
              value={
                displayedDetail.state || displayedDetail.status || "unknown"
              }
            />
            <span className="muted">{date(displayedDetail.createdAt)}</span>
          </div>
          {["waiting_for_human", "outcome_unknown"].includes(
            displayedDetail.state || displayedDetail.status || "",
          ) && (
            <Notice warning>
              {displayedDetail.reason ||
                (displayedDetail.status === "waiting_for_human"
                  ? "请打开实例桌面完成人工验证，结束人工接管后再恢复任务。"
                  : "动作可能已产生副作用，请先人工核验结果，避免重复提交。")}
            </Notice>
          )}
          {displayedDetail.progress !== undefined && (
            <>
              <h3>执行进度</h3>
              <Data value={displayedDetail.progress} />
            </>
          )}
          {displayedDetail.result && (
            <>
              <h3>任务结果</h3>
              <Data value={displayedDetail.result} />
              <ArtifactLinks value={displayedDetail.result} />
            </>
          )}
          {displayedDetail.error && (
            <>
              <h3>错误信息</h3>
              <Data value={displayedDetail.error} />
            </>
          )}
          {!displayedDetail.result && !displayedDetail.error && (
            <p className="muted">任务执行后，结果与可下载产物会显示在这里。</p>
          )}
          </> : !detailError && (
            <div className="loading-inline" role="status">
              {detailLoading && <span className="spinner" />}正在读取任务详情…
            </div>
          )}
          <div className="modal-actions">
            <Button onClick={() => onSelectJob(undefined)}>关闭</Button>
          </div>
        </Modal>
      )}
    </>
  );
}
function ArtifactLinks({ value }: { value: any }) {
  const ids = new Set<string>();
  function scan(v: any, depth = 0) {
    if (!v || typeof v !== "object" || depth > 6) return;
    for (const [key, entry] of Object.entries(v)) {
      if (
        (key === "artifactId" || (key === "id" && v.type === "artifact")) &&
        typeof entry === "string"
      )
        ids.add(entry);
      else if (entry && typeof entry === "object") scan(entry, depth + 1);
    }
  }
  scan(value);
  return (
    <div className="artifact-links">
      {[...ids].map((id) => (
        <a
          key={id}
          className="button"
          href={`/api/v1/artifacts/${encodeURIComponent(id)}/download`}
          download
        >
          <Icon name="download" />
          下载产物 {id.slice(0, 8)}
        </a>
      ))}
    </div>
  );
}

function SessionsPanel({
  profile: p,
  notify,
}: {
  profile: Profile;
  notify: Notify;
}) {
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [importType, setImportType] = useState<"cookies" | "storage-state">();
  const [restore, setRestore] = useState<any>();
  const [manualSessions, setManualSessions] = useState<
    Omit<DesktopSession, "popup">[]
  >([]);
  const load = useCallback(async () => {
    const results = await Promise.allSettled([
      api(`/profiles/${p.id}/snapshots`),
      api(`/manual-sessions?profileId=${encodeURIComponent(p.id)}`),
    ]);
    if (results[0].status === "fulfilled")
      setSnapshots(items(results[0].value));
    if (results[1].status === "fulfilled")
      setManualSessions(items(results[1].value));
    const failure = results.find((result) => result.status === "rejected");
    setError(failure?.status === "rejected" ? message(failure.reason) : "");
  }, [p.id]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  async function queue(
    path: string,
    body: unknown = {},
    success = "操作已加入任务队列，请在自动化任务中查看结果。",
  ) {
    setBusy(path);
    try {
      const r = await api(`/profiles/${p.id}/${path}`, "POST", body);
      notify(`${success}${r?.jobId ? ` · ${r.jobId}` : ""}`);
      await load();
      return r;
    } catch (e) {
      notify(message(e), true);
    } finally {
      setBusy("");
    }
  }
  async function importFile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const file = d.get("file") as File;
    if (!file?.size) {
      notify("请选择 JSON 文件。", true);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      notify("文件超过 10 MiB 的界面上传限制。", true);
      return;
    }
    setBusy("import");
    try {
      const text = await file.text();
      JSON.parse(text);
      const bytes = new TextEncoder().encode(text);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const artifact = await api("/artifacts", "POST", {
        profileId: p.id,
        type: "import",
        base64: btoa(binary),
        mimeType: "application/json",
      });
      const r = await api(`/profiles/${p.id}/${importType}/import`, "POST", {
        artifactId: artifact.id || artifact.artifactId,
        mode: d.get("mode"),
        domains: String(d.get("domains") || "")
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean),
      });
      notify(`导入任务已提交：${r.jobId}。写入成功不代表账号已登录。`);
      setImportType(undefined);
    } catch (e) {
      notify(message(e), true);
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <div className="sub-heading">
        <div>
          <h2>会话与备份</h2>
          <p>选择适合的恢复范围，安全管理你的账号会话。</p>
        </div>
      </div>
      {browserMode(p) === "vnc" && <Notice>VNC 模式不读取页面会话，Cookies 与站点状态的自动导入导出已停用。完整用户目录的文件级快照和恢复仍可使用。</Notice>}
      <div className="capability-grid">
        {(
          [
            [
              "cookies",
              "Cookies",
              "仅包含 Cookie",
              "保留支持的 HttpOnly、SameSite、分区与会话期限字段；不包含站点本地存储。",
            ],
            [
              "storage-state",
              "站点状态",
              "Cookie + localStorage + IndexedDB",
              "Playwright storageState 格式。恢复能力依赖站点和浏览器支持，不包含完整用户目录。",
            ],
          ] as const
        ).map(([type, title, range, desc]) => (
          <section className="panel capability-card" key={type}>
            <span className="capability-icon">
              <Icon name={type === "cookies" ? "key" : "layers"} size={23} />
            </span>
            <h2>{title}</h2>
            <span className="capability-range">{range}</span>
            <p>{desc}</p>
            <div className="heading-actions">
              <Button
                icon="download"
                busy={busy === `${type}/export`}
                disabled={Boolean(busy) || browserMode(p) === "vnc"}
                onClick={() => void queue(`${type}/export`)}
              >
                导出
              </Button>
              <Button
                icon="plus"
                disabled={Boolean(busy) || browserMode(p) === "vnc"}
                onClick={() => setImportType(type)}
              >
                导入
              </Button>
            </div>
          </section>
        ))}
      </div>
      <Notice warning>
        Cookies、站点状态和快照可能包含账号访问权限。下载逐次检查身份，请按敏感凭证保管。恢复后请在桌面检查实际登录状态，人工确认记录不代表服务器验证。
      </Notice>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>完整会话快照</h2>
            <p>
              一致性备份包含用户目录、Local State、keyring
              及匹配的版本与配置引用。
            </p>
          </div>
          <Button
            variant="primary"
            icon="plus"
            busy={busy === "snapshots"}
            disabled={Boolean(busy)}
            onClick={() =>
              void queue(
                "snapshots",
                {},
                "停机快照任务已提交；服务会先正常退出 Chrome。",
              )
            }
          >
            创建完整快照
          </Button>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {snapshots.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>恢复点</th>
                  <th>Chrome 版本</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {date(s.createdAt)}
                      <small className="mono">{s.id?.slice(0, 12)}</small>
                    </td>
                    <td>{s.chromeVersion || "—"}</td>
                    <td>{s.state || s.status || "已创建"}</td>
                    <td>
                      <Button
                        disabled={Boolean(busy) || p.state !== "stopped"}
                        onClick={() => setRestore(s)}
                      >
                        恢复此快照
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="还没有完整快照" icon="layers">
            <p>创建停机一致性快照，为更新与恢复保留可验证的恢复点。</p>
          </Empty>
        )}
        <p className="muted small">
          恢复只能在实例停止时执行，将使用匹配的浏览器版本、用户目录与
          keyring。请先关闭实例。
        </p>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>当前人工接管</h2>
            <p>
              会话信息会从控制服务同步；结束会话后释放租约，队列任务才能继续。
            </p>
          </div>
          <Icon name="desktop" />
        </div>
        {manualSessions.length ? (
          manualSessions.map((s) => (
            <div className="manual-session-row" key={s.id}>
              <div>
                <strong>人工接管会话</strong>
                <small>到期 {date(s.expiresAt)}</small>
              </div>
              <Button
                disabled={Boolean(busy)}
                onClick={async () => {
                  setBusy("close-session");
                  try {
                    await api(
                      `/manual-sessions/${encodeURIComponent(s.id)}`,
                      "DELETE",
                    );
                    notify("人工会话已结束，访问权限与租约已回收。");
                    await load();
                    window.dispatchEvent(new Event("fleet-desktops-changed"));
                  } catch (e) {
                    notify(message(e), true);
                  } finally {
                    setBusy("");
                  }
                }}
              >
                结束会话
              </Button>
            </div>
          ))
        ) : (
          <p className="muted small">
            当前没有有效的人工接管会话。通过实例的「打开桌面」入口开始。
          </p>
        )}
      </section>
      {importType && (
        <Modal
          title={`导入${importType === "cookies" ? " Cookies" : "站点状态"}`}
          subtitle="上传授权的 JSON 文件，通过任务队列写入目标实例"
          onClose={() => setImportType(undefined)}
        >
          <form onSubmit={importFile}>
            <Field label="选择 JSON 文件">
              <input
                name="file"
                type="file"
                accept="application/json,.json"
                required
              />
            </Field>
            <Field label="写入方式">
              <select name="mode">
                <option value="merge">合并到现有状态</option>
                <option value="replace">替换所选范围的现有状态</option>
              </select>
            </Field>
            <Field
              label="域名范围"
              hint="可选，用逗号分隔；替换只限明确选择的范围"
            >
              <input name="domains" placeholder="example.com" />
            </Field>
            <Notice warning>
              只导入你有权使用的会话。导入成功仅代表数据写入，请重新核验账号登录状态。
            </Notice>
            <div className="modal-actions">
              <Button type="button" onClick={() => setImportType(undefined)}>
                取消
              </Button>
              <Button variant="primary" type="submit" busy={busy === "import"}>
                提交导入任务
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {restore && (
        <Modal title="恢复完整会话快照？" onClose={() => setRestore(undefined)}>
          <Notice warning>
            实例当前用户目录与 keyring 将恢复到 {date(restore.createdAt)}{" "}
            的恢复点。快照之后的本地状态可能丢失，恢复前请保存需要的数据。
          </Notice>
          <p className="muted mono">快照：{restore.id}</p>
          <div className="modal-actions">
            <Button onClick={() => setRestore(undefined)}>取消</Button>
            <Button
              variant="danger"
              busy={busy === "restore"}
              onClick={async () => {
                const r = await queue(
                  "restore",
                  { snapshotId: restore.id },
                  "恢复任务已提交。",
                );
                if (r) setRestore(undefined);
              }}
            >
              确认恢复
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function UpdatesPanel({
  profile,
  notify,
}: {
  profile?: Profile;
  notify: Notify;
}) {
  const [versions, setVersions] = useState<any>();
  const [policy, setPolicy] = useState<any>();
  const [runs, setRuns] = useState<any[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [runId, setRunId] = useState(profile?.lastUpdateId || "");
  const [run, setRun] = useState<any>();
  const [rollback, setRollback] = useState(false);
  const load = useCallback(async () => {
    const results = await Promise.allSettled([
      api("/browser-versions"),
      api("/update-policy"),
      api("/updates?limit=50"),
    ]);
    if (results[0].status === "fulfilled") setVersions(results[0].value);
    if (results[1].status === "fulfilled") setPolicy(results[1].value);
    if (results[2].status === "fulfilled") setRuns(items(results[2].value));
    const failure = results.find((r) => r.status === "rejected");
    setError(failure?.status === "rejected" ? message(failure.reason) : "");
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (!runId) return;
    let disposed = false;
    const poll = async () => {
      try {
        const r = await api(`/updates/${encodeURIComponent(runId)}`);
        if (!disposed) setRun(r);
      } catch (e) {
        if (!disposed) setError(message(e));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [runId]);
  async function savePolicy(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    setBusy("policy");
    try {
      await api("/update-policy", "PATCH", {
        mode: d.get("mode"),
        paused: d.get("paused") === "on",
        checkIntervalHours: Number(d.get("checkIntervalHours")),
        maintenanceStart: d.get("windowStart"),
        maintenanceEnd: d.get("windowEnd"),
      });
      notify("更新策略已保存。仅已通过兼容验证的版本可在维护窗口自动应用。");
      await load();
    } catch (e) {
      notify(message(e), true);
    } finally {
      setBusy("");
    }
  }
  async function update(action: "check" | "apply") {
    setBusy(action);
    try {
      const r = await api(
        `/updates/${action}`,
        "POST",
        action === "apply"
          ? {
              profileIds: profile ? [profile.id] : undefined,
              versionId: selected || undefined,
            }
          : { prepare: true },
      );
      notify(
        `${action === "check" ? "官方版本检查已提交。" : "受控更新已提交，将先备份再逐个升级。"}${r.jobId ? ` · 任务 ${r.jobId}` : ""}`,
      );
      if (r.updateId || r.id) setRunId(r.updateId || r.id);
      await load();
    } catch (e) {
      notify(message(e), true);
    } finally {
      setBusy("");
    }
  }
  const list = Array.isArray(versions)
    ? versions
    : items<any>(versions?.versions || versions?.available || versions);
  return (
    <div className="updates-layout">
      <div className={profile ? "sub-heading" : "page-heading"}>
        <div>
          {!profile && <div className="eyebrow">CONTROLLED UPDATES</div>}
          <h1 className={profile ? "sub-title" : ""}>浏览器更新</h1>
          <p>先验证、再备份、逐个升级。失败时按配对镜像与快照恢复。</p>
        </div>
        <Button
          icon="refresh"
          busy={busy === "check"}
          disabled={Boolean(busy)}
          aria-label="检查并准备版本"
          title="检查并准备版本"
          onClick={() => void update("check")}
        >
          检查并准备版本
        </Button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="updates-columns">
        <section className="panel updates-policy">
          <div className="panel-heading">
            <div>
              <h2>平台更新策略</h2>
              <p>作用于所有实例</p>
            </div>
            <Icon name="clock" />
          </div>
          {policy ? (
            <form onSubmit={savePolicy}>
              <Field label="更新方式">
                <select name="mode" defaultValue={policy.mode || "auto"}>
                  <option value="auto">
                    自动 · 仅维护窗口内应用已验证版本
                  </option>
                  <option value="notify">通知 · 检查后等待手动应用</option>
                  <option value="manual">手动 · 由管理员发起</option>
                </select>
              </Field>
              <Field label="检查间隔（小时）">
                <input
                  name="checkIntervalHours"
                  type="number"
                  min={1}
                  max={168}
                  defaultValue={policy.checkIntervalHours || 24}
                />
              </Field>
              <div className="form-grid">
                <Field label="维护窗口开始">
                  <input
                    name="windowStart"
                    type="time"
                    defaultValue={policy.maintenanceStart || "02:00"}
                  />
                </Field>
                <Field label="维护窗口结束">
                  <input
                    name="windowEnd"
                    type="time"
                    defaultValue={policy.maintenanceEnd || "05:00"}
                  />
                </Field>
              </div>
              <p className="muted small">维护窗口时区：Asia/Shanghai</p>
              <label className="check-field">
                <input
                  name="paused"
                  type="checkbox"
                  defaultChecked={policy.paused}
                />
                暂停自动更新
              </label>
              <div className="form-actions">
                <Button
                  variant="primary"
                  type="submit"
                  busy={busy === "policy"}
                  disabled={Boolean(busy)}
                >
                  保存更新策略
                </Button>
              </div>
            </form>
          ) : (
            <p className="muted">
              {error ? "无法读取策略，请检查权限与控制服务。" : "正在读取策略…"}
            </p>
          )}
        </section>
        <div className="updates-stack">
          <section className="panel updates-versions">
            <div className="panel-heading">
              <h2>{profile ? "此实例的浏览器" : "可用浏览器版本"}</h2>
              <Icon name="box" />
            </div>
            {profile && (
              <>
                <dl className="info-list">
                  <Info
                    label={
                      profile.state !== "running" ? "上次运行版本" : "实际版本"
                    }
                  >
                    {profile.chromeVersion || "尚未运行"}
                  </Info>
                  <Info label="Playwright">
                    {profile.playwrightVersion || "—"}
                  </Info>
                  <Info label="镜像 digest">
                    <span className="mono break-word">
                      {profile.imageDigest || "尚未记录"}
                    </span>
                  </Info>
                </dl>
                <form
                  className="version-pin"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const d = new FormData(e.currentTarget);
                    setBusy("pin");
                    try {
                      await api(`/profiles/${profile.id}`, "PATCH", {
                        pinnedVersion: d.get("pinnedVersion") || null,
                      });
                      notify(
                        "实例版本策略已保存。固定版本的实例将跳过自动更新。",
                      );
                    } catch (e) {
                      notify(message(e), true);
                    } finally {
                      setBusy("");
                    }
                  }}
                >
                  <Field
                    label="固定实例版本"
                    hint="留空跟随平台策略；填写版本后跳过自动升级"
                  >
                    <input
                      name="pinnedVersion"
                      defaultValue={profile.pinnedVersion || ""}
                      placeholder="例如 155.0.8059.79"
                      pattern="[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+"
                    />
                  </Field>
                  <Button
                    type="submit"
                    busy={busy === "pin"}
                    disabled={Boolean(busy)}
                  >
                    保存版本策略
                  </Button>
                </form>
              </>
            )}
            {list.length ? (
              <>
                <Field label="选择目标版本">
                  <select
                    value={selected}
                    onChange={(e) => setSelected(e.target.value)}
                  >
                    <option value="">最新已验证 Stable 版本</option>
                    {list.map((v: any, i: number) => (
                      <option
                        key={v.id || i}
                        value={v.id || v.version}
                        disabled={!v.validated}
                      >
                        {v.chromeVersion || v.version || v.id} ·{" "}
                        {v.validated ? "已验证" : v.status || "待验证"}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="version-list">
                  {list.slice(0, 4).map((v: any, i: number) => (
                    <div key={v.id || i}>
                      <span className="mono">
                        {v.chromeVersion || v.version || v.id}
                      </span>
                      <span className={`tag ${v.validated ? "verified" : ""}`}>
                        {v.validated ? "已验证" : v.status || "待验证"}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="muted">
                尚无已记录的候选版本。请先检查官方版本并完成镜像准备与兼容验证。
              </p>
            )}
            <div className="form-actions">
              <Button
                icon="refresh"
                disabled={Boolean(busy) || Boolean(profile?.pinnedVersion)}
                title={
                  profile?.pinnedVersion
                    ? "此实例已固定版本，请解除固定后更新"
                    : undefined
                }
                busy={busy === "apply"}
                onClick={() => void update("apply")}
              >
                应用受控更新
              </Button>
            </div>
          </section>
          <section className="panel updates-recovery">
            <div className="panel-heading">
              <div>
                <h2>更新进度与恢复</h2>
                <p>选择更新记录，查看持久化阶段、恢复点与每个实例结果。</p>
              </div>
              <Icon name="layers" />
            </div>
            <div className="inline-form">
              <select
                aria-label="更新记录"
                value={runId}
                onChange={(e) => setRunId(e.target.value)}
              >
                <option value="">
                  {runs.length ? "选择更新记录" : "暂无更新记录"}
                </option>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {date(r.createdAt)} · {r.targetVersion || r.id} ·{" "}
                    {(
                      {
                        applying: "应用中",
                        draining: "排空中",
                        snapshot: "创建快照",
                        starting: "启动验证",
                        succeeded: "已完成",
                        failed: "失败",
                        interrupted: "中断",
                        rolling_back: "回滚中",
                        rolled_back: "已回滚",
                        rollback_failed: "回滚失败",
                        pending: "待下次启动应用",
                        deferred: "已延后",
                      } as Record<string, string>
                    )[r.phase] || r.phase}
                  </option>
                ))}
              </select>
              <Button
                disabled={!runId || !run}
                variant="danger"
                onClick={() => setRollback(true)}
              >
                按恢复点回滚
              </Button>
            </div>
            {run && <Data value={run} />}
          </section>
        </div>
      </div>
      <Notice>
        停止中的实例不会因更新永久启动。运行中的任务或人工会话会阻止立即升级；新版若只触发网站重新验证，账号会进入人工处理流程。
      </Notice>
      {rollback && (
        <Modal title="按升级前恢复点回滚？" onClose={() => setRollback(false)}>
          <Notice warning>
            将停止新浏览器，恢复匹配的旧镜像和升级前完整快照。升级后的本地状态可能丢失。旧版本不会直接打开已经迁移的目录。
          </Notice>
          <div className="modal-actions">
            <Button onClick={() => setRollback(false)}>取消</Button>
            <Button
              variant="danger"
              busy={busy === "rollback"}
              onClick={async () => {
                setBusy("rollback");
                try {
                  const r = await api(
                    `/updates/${encodeURIComponent(runId)}/rollback`,
                    "POST",
                    {},
                  );
                  notify(`回滚任务已提交${r.jobId ? `：${r.jobId}` : ""}`);
                  setRollback(false);
                } catch (e) {
                  notify(message(e), true);
                } finally {
                  setBusy("");
                }
              }}
            >
              确认回滚
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Guide() {
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">GETTING STARTED</div>
          <h1>让每个账号，各就其位</h1>
          <p>先选账号，在普通 Chrome 中登录，再明确确认账号与实例的映射。</p>
        </div>
        <span className="guide-heading-icon">
          <Icon name="layers" size={38} />
        </span>
      </div>
      <div className="guide-grid">
        {[
          [
            "01",
            "选择账号与 Chrome",
            "在账号管理选择邮箱，为它创建独立 Chrome 实例。每个账号只能创建一个实例；保存关联不表示已经登录。",
            "box",
          ],
          [
            "02",
            "在桌面中完成登录",
            "已绑定的 Chrome 卡片才会显示 Google 登录，并固定操作绑定邮箱。自行在 VNC 的普通 Chrome 中登录；已经登录的实例无需重新打开桌面。",
            "desktop",
          ],
          [
            "03",
            "确认登录并启用自动化接管",
            "在账号状态页或账号目录关联行点击「确认已登录」，系统会结束人工桌面、保存恢复点，并使用原用户目录切换到自动化接管。之后可执行网页任务，并按设置自动关闭空闲实例。",
            "shield",
          ],
          [
            "04",
            "保存恢复点，安心维护",
            "关闭实例会保留会话。定期制作完整快照，更新时使用配对的镜像与快照支持受控恢复。",
            "layers",
          ],
        ].map(([n, title, text, icon]) => (
          <section className="panel guide-card" key={n}>
            <span className="guide-step">{n}</span>
            <Icon name={icon as IconName} size={27} />
            <h2>{title}</h2>
            <p>{text}</p>
          </section>
        ))}
      </div>
      <section className="panel">
        <h2>理解三种会话保存方式</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>方式</th>
                <th>包含的状态</th>
                <th>适用场景</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Cookies</td>
                <td>支持 schema 的 Cookie 字段</td>
                <td>在明确域名范围内导入或导出 Cookie</td>
              </tr>
              <tr>
                <td>站点状态</td>
                <td>Cookies、localStorage、受支持的 IndexedDB</td>
                <td>支持 Playwright storageState 的站点会话迁移</td>
              </tr>
              <tr>
                <td>完整会话快照</td>
                <td>用户目录、Local State、keyring、匹配镜像与配置</td>
                <td>一致性备份、容器重建和浏览器更新恢复</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <Notice>
        网站可能撤销或使登录状态过期。Google 网站登录与 Chrome Sync
        分开处理；持久化会话不依赖开启 Sync，也不保证账号永久在线。真实 Google
        登录仍需通过你自己的环境人工验收。
      </Notice>
    </>
  );
}
