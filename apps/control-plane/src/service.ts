import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  existsSync,
  chmodSync,
  chownSync,
  lstatSync,
  readdirSync,
  statfsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { Store, Vault, id, now, hash, atomicJson } from "@chrome-fleet/core";
import {
  CreateProfileSchema,
  ProxySchema,
  JobSchema,
  FleetError,
  type Profile,
  type Job,
} from "@chrome-fleet/contracts";
import { Runner } from "./runner.js";
import type { Config } from "./config.js";
import type { Principal } from "./auth.js";
import { GoogleAccounts } from "./google-accounts.js";
import { Platforms } from "./platforms.js";
import { accountView, manuallyConfirmed } from "./account-confirmation.js";
import { metricsIntervalMs, metricsView, unavailableMetrics } from "./metrics.js";
import { HostMetricsSampler } from "./host-metrics.js";
export class FleetService {
  db: Store;
  vault: Vault;
  runner: Runner;
  google: GoogleAccounts;
  platforms: Platforms;
  hostMetrics = new HostMetricsSampler();
  active = new Set<string>();
  starts = new Map<string, Promise<Profile>>();
  timer?: NodeJS.Timeout;
  metricsTimer?: NodeJS.Timeout;
  private metricsRefreshing = false;
  private metricsEpoch = new Map<string, number>();
  maintenance = false;
  lastHousekeeping = 0;
  ticking = false;
  desktopRevoker?: (sessionId: string) => Promise<void>;
  private networkPolicyQueue: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(public config: Config) {
    this.db = new Store(config.root);
    this.vault = new Vault(config.root, config.keyFile);
    this.runner = new Runner(config.runnerUrl, config.runnerTokenFile);
    this.google = new GoogleAccounts(this);
    this.platforms = new Platforms(this);
    for (const d of ["profiles", "artifacts", "backups", "tmp"])
      mkdirSync(join(config.root, d), { recursive: true, mode: 0o700 });
    if (!this.db.get("settings", "update-policy"))
      this.db.set("settings", "update-policy", {
        mode: "auto",
        paused: false,
        checkIntervalHours: 24,
        maintenanceStart: "02:00",
        maintenanceEnd: "05:00",
        timezone: "Asia/Shanghai",
        lastCheckedAt: null,
      });
  }
  audit(
    principal: string,
    action: string,
    profileId?: string,
    result = "succeeded",
    reason?: string,
  ) {
    this.db.set("audit", id("audit"), {
      id: id("event"),
      principal,
      action,
      profileId,
      result,
      reason,
      at: now(),
    });
  }
  profile(pid: string, includeArchived = true): Profile {
    const p = this.db.get<Profile>("profiles", pid);
    if (!p) throw new FleetError("PROFILE_NOT_FOUND", "实例不存在", 404);
    if (!includeArchived && p.archived)
      throw new FleetError("PROFILE_ARCHIVED", "实例已归档，请先恢复", 409);
    return p;
  }
  publicProfile(p: Profile) {
    const copy: any = {
      ...p,
      browserMode: this.browserMode(p),
      googleBinding: this.google.binding(p.id),
      platformAccounts: this.platforms.accountViews(p.id),
      metrics: metricsView(p),
      accounts: this.db
        .list<any>("accounts")
        .filter((a) => a.profileId === p.id).map(accountView),
      currentJob: this.db
        .list<Job>("jobs")
        .find(
          (j) =>
            j.profileId === p.id &&
            ["running", "waiting_for_human"].includes(j.status),
        )?.id,
    };
    delete copy.agentTokenRef;
    delete copy.keyringSecretRef;
    delete copy.vncSecretRef;
    delete copy.agentUrl;
    delete copy.desktopUrl;
    if (p.proxy) copy.proxy = this.proxyView(p);
    return copy;
  }
  saveProfile(p: Profile) {
    const previous = this.db.get<Profile>("profiles", p.id);
    if (previous?.state !== p.state) {
      this.metricsEpoch.set(p.id, (this.metricsEpoch.get(p.id) || 0) + 1);
      p.metrics = unavailableMetrics(p.state === "running" ? "METRICS_NOT_SAMPLED" : "PROFILE_NOT_RUNNING");
    } else if (previous?.metrics && (!p.metrics || Date.parse(previous.metrics.sampledAt || "") > Date.parse(p.metrics.sampledAt || "1970-01-01"))) {
      p.metrics = previous.metrics;
    }
    p.updatedAt = now();
    return this.db.set("profiles", p.id, p);
  }
  browserMode(p: Profile): "automation" | "vnc" {
    return p.browserMode === "vnc" ? "vnc" : "automation";
  }
  requireAutomation(p: Profile) {
    if (this.browserMode(p) === "vnc")
      throw new FleetError("VNC_MODE_UNSUPPORTED", "当前为纯VNC模式，此操作需要先切换到自动化模式", 409);
  }
  private needsAutomation(kind: string) {
    return ["automation", "proxy_test", "cookies_export", "cookies_import", "storage-state_export", "storage-state_import"].includes(kind);
  }
  syncNetworkPolicy(): Promise<boolean> {
    const synchronize = async () => {
      if (this.closed) return false;
      // Read inside the queue: concurrent edits must never send an older snapshot last.
      const previous = this.db.get<any>("settings", "network-policy-sync");
      const revision = Math.max(Date.now(), (previous?.revision || 0) + 1);
      const profiles = this.db.list<Profile>("profiles")
        .filter(profile => !profile.purgedAt)
        .map(profile => ({
          profileId: profile.id,
          proxyVersion: profile.proxy?.version || 0,
          proxy: profile.proxy?.enabled
            ? { host: profile.proxy.host, port: profile.proxy.port }
            : null,
        }));
      this.db.set("settings", "network-policy-sync", { ...previous, revision, pending: true });
      try {
        await this.runner.call("/network-policy/sync", { revision, profiles }, "POST", 60000);
        if (this.closed) return false;
        this.db.set("settings", "network-policy-sync", { revision, applied: true, pending: false, syncedAt: now() });
        return true;
      } catch (error) {
        if (this.closed) return false;
        const code = error instanceof FleetError ? error.code : "NETWORK_POLICY_UNAVAILABLE";
        this.db.set("settings", "network-policy-sync", { revision, applied: false, pending: true, errorCode: code, checkedAt: now() });
        if (previous?.errorCode !== code || previous?.applied)
          this.audit("system", "network_policy_sync", undefined, "failed", code);
        // Desired browser configuration remains saved. Startup also reconciles before launch.
        return false;
      }
    };
    const pending = this.networkPolicyQueue.then(synchronize, synchronize);
    this.networkPolicyQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }
  diskCheck(min = 256 * 1024 * 1024) {
    const s = statfsSync(this.config.root);
    if (Number(s.bavail) * Number(s.bsize) < min)
      throw new FleetError("DISK_FULL", "可用磁盘空间不足，操作已停止", 507);
  }
  async create(input: unknown, principal?: Principal) {
    const c = CreateProfileSchema.parse(input);
    if (c.browserMode === "vnc") c.headless = false;
    if (c.browserMode === "vnc" && c.accountAlias)
      this.google.catalogForEmail(c.accountAlias);
    // Validate before allocating secrets, directories or an optional start job.
    if (c.accountAlias) this.google.assertAvailable(c.accountAlias);
    this.diskCheck();
    const alternate = this.db
      .list<any>("versions")
      .filter(
        (v) =>
          v.distribution === c.distribution &&
          v.validated &&
          (c.distribution === "cft" || v.applied),
      )
      .at(-1);
    if (c.distribution === "cft" && !alternate)
      throw new FleetError(
        "DISTRIBUTION_NOT_PREPARED",
        "请先检查并准备 Chrome for Testing 镜像，再创建该分发的实例",
        409,
      );
    const pid = id("cf"),
      password = c.vncSecretRef
        ? this.vault.get<string>(c.vncSecretRef)
        : c.vncPassword || randomBytes(6).toString("base64url");
    if (!/^[\x21-\x7e]{8}$/.test(password))
      throw new FleetError(
        "VNC_PASSWORD_LENGTH",
        "VNCAuth 密码须为8个可见ASCII字符",
      );
    const p: Profile = {
      ...c,
      id: pid,
      state: "stopped",
      desiredState: "stopped",
      archived: false,
      autoWakePaused: false,
      image: alternate?.image || this.config.defaultImage,
      imageDigest: alternate?.imageDigest || null,
      chromeVersion: null,
      playwrightVersion: "1.64.1",
      proxy: undefined,
      remoteDesktop: {
        passwordConfigured: true,
        version: 1,
        appliedVersion: 0,
      },
      vncSecretRef: this.vault.put(password),
      keyringSecretRef: this.vault.put(randomBytes(32).toString("base64url")),
      agentTokenRef: this.vault.put(randomBytes(32).toString("base64url")),
      createdAt: now(),
      lastActivityAt: now(),
      lastError: null,
    };
    delete p.start;
    delete p.vncPassword;
    delete p.accountAlias;
    if (c.proxy) p.proxy = this.storeProxy(p, c.proxy);
    this.saveProfile(p);
    this.prepareFiles(p, true);
    if (c.accountAlias)
      this.bindAccount(pid, {
        provider: "google",
        alias: c.accountAlias,
        expectedIdentity: c.accountAlias,
      }, principal);
    if (p.proxy?.enabled) await this.syncNetworkPolicy();
    return {
      ...this.publicProfile(p),
      oncePassword: c.vncPassword || c.vncSecretRef ? undefined : password,
    };
  }
  prepareFiles(p: Profile, initializing = false) {
    const base = join(this.config.root, "profiles", p.id),
      state = join(base, "state"),
      secret = join(base, "secrets");
    if (
      !initializing &&
      (!existsSync(join(state, "chrome")) ||
        !existsSync(join(state, "keyrings")))
    )
      throw new FleetError(
        "SESSION_DATA_MISSING",
        "实例会话目录缺失；已拒绝创建空白目录，请恢复快照或检查磁盘挂载",
        409,
      );
    mkdirSync(state, { recursive: true, mode: 0o700 });
    mkdirSync(secret, { recursive: true, mode: 0o700 });
    for (const d of ["chrome", "keyrings", "downloads", "config"])
      mkdirSync(join(state, d), { recursive: true, mode: 0o700 });
    let proxy: any;
    if (p.proxy?.enabled) {
      proxy = {
        server: `${p.proxy.scheme}://${p.proxy.host}:${p.proxy.port}`,
        bypass: p.proxy.bypass,
      };
      if (p.proxy.secretRef)
        Object.assign(proxy, this.vault.get(p.proxy.secretRef));
    }
    atomicJson(join(secret, "config.json"), {
      browserMode: this.browserMode(p),
      headless: p.headless,
      locale: p.locale,
      timezoneId: p.timezoneId,
      viewport: p.viewport,
      proxy,
      proxyVersion: p.proxy?.version || 0,
    });
    for (const [filename, ref] of [
      ["agent-token", p.agentTokenRef],
      ["keyring-password", p.keyringSecretRef],
      ["vnc-password", p.vncSecretRef],
    ]) {
      writeFileSync(join(secret, filename), this.vault.get<string>(ref), {
        mode: 0o400,
      });
      chmodSync(join(secret, filename), 0o400);
    }
    if (process.getuid?.() === 0) {
      for (const d of [
        base,
        state,
        secret,
        ...readdirSync(secret).map((n) => join(secret, n)),
        ...["chrome", "keyrings", "downloads", "config"].map((n) =>
          join(state, n),
        ),
      ])
        chownSync(d, 1000, 1000);
    }
  }
  storeProxy(p: Profile, input: any) {
    const c = ProxySchema.parse(input);
    let secretRef =
      c.secretRef ??
      (c.scheme !== "socks5" &&
      p.proxy?.scheme === c.scheme &&
      p.proxy?.host === c.host &&
      p.proxy?.port === c.port
        ? p.proxy.secretRef
        : undefined);
    if (c.username !== undefined || c.password !== undefined)
      secretRef = this.vault.put({
        username: c.username || "",
        password: c.password || "",
      });
    if (secretRef) this.vault.get(secretRef);
    return {
      enabled: c.enabled,
      scheme: c.scheme,
      host: c.host,
      port: c.port,
      bypass: c.bypass,
      version: (p.proxy?.version || 0) + 1,
      appliedVersion: p.proxy?.appliedVersion || 0,
      secretRef,
      hasCredentials: !!secretRef,
      failClosed: true,
    };
  }
  proxyView(p: Profile) {
    if (!p.proxy)
      return {
        enabled: false,
        version: 0,
        appliedVersion: 0,
        hasCredentials: false,
      };
    const { secretRef, ...v } = p.proxy;
    return v;
  }
  bindAccount(pid: string, b: any, principal?: Principal) {
    if (
      typeof b.provider !== "string" ||
      typeof b.expectedIdentity !== "string" ||
      !b.expectedIdentity.trim()
    )
      throw new FleetError("INVALID_ACCOUNT", "须指定站点与期望账号身份");
    if (b.detector) throw new FleetError("ACCOUNT_CHECK_REMOVED", "不再支持账号检测规则，请使用人工确认", 410);
    if (b.provider.toLowerCase() === "google") {
      let catalog: any;
      try { catalog = this.google.catalogForEmail(b.expectedIdentity); }
      catch (error) { if (this.browserMode(this.profile(pid)) === "vnc") throw error; }
      if (catalog) {
        this.google.bind(pid, catalog.id, principal);
        return accountView(this.db.list<any>("accounts").find(account => account.profileId === pid && account.provider === "google"));
      }
      const existing = this.db.list<any>("accounts").find(account => account.profileId === pid && account.provider?.toLowerCase() === "google" &&
        account.expectedIdentity?.trim().toLowerCase() === b.expectedIdentity.trim().toLowerCase());
      if (existing) return accountView(existing);
    }
    const a = {
      id: id("account"),
      profileId: pid,
      provider: b.provider,
      alias: String(b.alias || b.expectedIdentity).slice(0, 128),
      expectedIdentity: b.expectedIdentity.slice(0, 256),
      authState: "unknown",
      lastCheckedAt: null,
    };
    return this.db.transaction(() => {
      if (b.provider.toLowerCase() === "google") {
        this.google.assertAvailable(b.expectedIdentity, pid);
        let catalogId: string | undefined;
        try { catalogId = this.google.catalogForEmail(b.expectedIdentity).id; } catch { /* Legacy bindings may have no catalog entry. */ }
        this.platforms.assertGoogleBinding(pid, catalogId);
      }
      return this.db.set("accounts", a.id, a);
    });
  }
  job(jid: string): Job {
    const j = this.db.get<Job>("jobs", jid);
    if (j?.payloadRef) j.payload = this.vault.get(j.payloadRef);
    if (!j) throw new FleetError("JOB_NOT_FOUND", "任务不存在", 404);
    return j;
  }
  saveJob(j: Job) {
    if (j.payload !== undefined && !j.payloadRef)
      j.payloadRef = this.vault.put(j.payload);
    const { payload, ...stored } = j;
    return this.db.set("jobs", j.id, stored) as Job;
  }
  submit(
    kind: string,
    profileId: string,
    payload: any,
    principal: string,
  ): Job {
    if (kind === "accounts_check") throw new FleetError("ACCOUNT_CHECK_REMOVED", "主动账号检测已移除，请在实例详情人工确认登录", 410);
    if (profileId !== "system") {
      const profile = this.profile(profileId, false);
      if (this.needsAutomation(kind)) this.requireAutomation(profile);
    }
    const j: Job = {
      id: id("job"),
      profileId,
      kind,
      payload,
      status: "queued",
      progress: 0,
      completedSteps: 0,
      cancelRequested: false,
      createdAt: now(),
      principal,
    };
    this.saveJob(j);
    this.event(j, "queued");
    return j;
  }
  event(j: Job, type: string) {
    this.db.set("events", id("evt"), {
      jobId: j.id,
      type,
      progress: j.progress,
      status: j.status,
      at: now(),
    });
  }
  async agent(
    p: Profile,
    path: string,
    body?: any,
    token?: number,
    timeout = 120000,
  ): Promise<any> {
    if (["/accounts/check", "/accounts/google-identity", "/accounts/google-login", "/accounts/google-autofill", "/accounts/open-login"].includes(path))
      throw new FleetError("ACCOUNT_CHECK_REMOVED", "自动访问和识别账号的功能已移除，请在桌面登录后人工确认", 410);
    if (this.browserMode(p) === "vnc" && !["/health", "/fence", "/shutdown", "/cancel", "/vnc/reload", "/desktop/clipboard"].includes(path))
      this.requireAutomation(p);
    if (path === "/health") timeout = Math.min(timeout, 5000);
    const root = p.agentUrl;
    if (!root) throw new FleetError("AGENT_NOT_READY", "浏览器尚未就绪", 409);
    try {
      const r = await fetch(root + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${this.vault.get(p.agentTokenRef)}`,
          "content-type": "application/json",
        },
        body:
          body === undefined
            ? undefined
            : JSON.stringify(
                path === "/fence"
                  ? body
                  : {
                      ...body,
                      fencingToken: token ?? this.db.lease(p.id)?.token,
                    },
              ),
        signal: AbortSignal.timeout(timeout),
      });
      const result: any = await r.json();
      if (!r.ok)
        throw new FleetError(
          result.code || result.error?.code || "AGENT_ERROR",
          result.message || result.error?.message || "浏览器操作失败",
          r.status,
          result.details,
        );
      return result.data ?? result;
    } catch (e) {
      if (
        e instanceof FleetError &&
        path === "/fence" &&
        e.code === "FENCE_RESTART_REQUIRED"
      ) {
        await this.runner.call(`/profiles/${p.id}/stop`, { force: true });
        p.state = "stopped";
        this.saveProfile(p);
        const restarted = await this.ensureStart(p.id, true, body.token);
        Object.assign(p, restarted);
        return { fencingToken: body.token, restarted: true };
      }
      if (e instanceof FleetError) throw e;
      throw new FleetError(
        "AGENT_CONNECTION_LOST",
        "浏览器连接中断，已执行动作可能产生结果",
        502,
      );
    }
  }
  async ensureStart(
    pid: string,
    explicit = false,
    token?: number,
  ): Promise<Profile> {
    if (this.starts.has(pid)) return this.starts.get(pid)!;
    const run = this.startImpl(pid, explicit, token).finally(() =>
      this.starts.delete(pid),
    );
    this.starts.set(pid, run);
    return run;
  }
  async startImpl(pid: string, explicit: boolean, token?: number) {
    let p = this.profile(pid, false);
    if (p.state === "running") {
      if (token !== undefined) await this.agent(p, "/fence", { token });
      return p;
    }
    if (!explicit && (p.startupPolicy === "manual" || p.autoWakePaused))
      throw new FleetError(
        "PROFILE_STOPPED",
        "实例已停止，请手动启动或解除暂停自动唤起",
        409,
      );
    if (p.pendingImage && this.browserMode(p) === "automation" && !this.db.get("browser-mode-transitions", pid)) {
      await this.applyPending(p, token!);
      p = this.profile(pid);
    }
    p.state = "starting";
    p.desiredState = "running";
    if (explicit) p.autoWakePaused = false;
    this.saveProfile(p);
    try {
      if (p.lastError)
        await this.runner.call(`/profiles/${pid}/stop`, { force: this.browserMode(p) !== "vnc" && !this.db.get("browser-mode-transitions", pid) });
      this.prepareFiles(p);
      const result = await this.runner.call(`/profiles/${pid}/start`, {
        image: p.image,
        expectedDigest: p.imageDigest || undefined,
        config: JSON.parse(
          readFileSync(
            join(this.config.root, "profiles", p.id, "secrets", "config.json"),
            "utf8",
          ),
        ),
        resources: p.resources,
      });
      p.agentUrl = result.agentUrl;
      p.desktopUrl = result.desktopUrl;
      p.imageDigest = result.imageDigest || p.imageDigest;
      this.saveProfile(p);
      let health: any;
      for (let i = 0; i < 90; i++) {
        try {
          health = await this.agent(p, "/health");
          if (health.ready === false || health.status === "starting")
            throw new Error();
          break;
        } catch (e) {
          if (i === 89) throw e;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if ((health?.browserMode || "automation") !== this.browserMode(p))
        throw new FleetError("BROWSER_MODE_MISMATCH", "浏览器实际运行模式与实例配置不符，请更新镜像后重试", 409);
      if (token !== undefined) {
        await this.agent(p, "/fence", { token });
        if (this.browserMode(p) === "automation")
          await this.agent(p, "/cookies/export", {}, token);
      }
      p.state = "running";
      p.chromeVersion = health?.chromeVersion || health?.browserVersion || null;
      if (
        p.upgradeExpectedVersion &&
        p.chromeVersion !== p.upgradeExpectedVersion
      )
        throw new FleetError(
          "VERSION_MISMATCH",
          "候选镜像实际版本不匹配，已停止升级",
          409,
        );
      p.playwrightVersion = health?.playwrightVersion || "1.64.1";
      p.health = health;
      p.lastError = null;
      p.lastActivityAt = now();
      if (p.proxy) p.proxy.appliedVersion = p.proxy.version;
      p.remoteDesktop.appliedVersion = p.remoteDesktop.version;
      this.saveProfile(p);
      if (p.upgradeSnapshotId) {
        this.pendingProgress(p.upgradeUpdateId, p.id, "succeeded");
        delete p.upgradeUpdateId;
        p.lastUpgradeSnapshotId = p.upgradeSnapshotId;
        delete p.upgradeSnapshotId;
        delete p.upgradeExpectedVersion;
        this.saveProfile(p);
      }
      return p;
    } catch (e) {
      if (p.upgradeSnapshotId) {
        const updateId = p.upgradeUpdateId;
        try {
          await this.runner.call(`/profiles/${p.id}/stop`, { force: true });
          p.state = "stopped";
          this.saveProfile(p);
          await this.restore(p.id, p.upgradeSnapshotId);
          p = this.profile(pid);
          this.pendingProgress(updateId, pid, "rolled_back");
          p.lastError = "新版本启动失败，已恢复旧镜像和升级前快照；请手动启动";
          this.saveProfile(p);
        } catch {
          this.pendingProgress(updateId, pid, "rollback_failed");
          p.state = "error";
          p.lastError = "新版本启动失败且快照回滚失败，请按恢复文档操作";
          this.saveProfile(p);
        }
      } else {
        p.state = "error";
        p.lastError = (e as Error).message;
        this.saveProfile(p);
      }
      throw e;
    }
  }
  async stop(pid: string, manual = false, force = false) {
    const p = this.profile(pid);
    if (p.state === "stopped") {
      if (manual) {
        p.autoWakePaused = true;
        p.desiredState = "stopped";
        this.saveProfile(p);
      }
      return p;
    }
    if (!force && p.agentUrl) {
      const health = await this.agent(p, "/health");
      if (health.activeDownloads > 0)
        throw new FleetError(
          "DOWNLOAD_ACTIVE",
          "实例仍在下载文件，请等待下载结束或显式强制关闭",
          409,
        );
    }
    p.state = "stopping";
    p.desiredState = "stopped";
    if (manual) p.autoWakePaused = true;
    this.saveProfile(p);
    try {
      if (p.agentUrl && !force)
        await this.agent(p, "/shutdown", {}, undefined, 40000);
      await this.runner.call(`/profiles/${pid}/stop`, { force });
      p.state = "stopped";
      p.health = null;
      p.lastActivityAt = now();
      return this.saveProfile(p);
    } catch (e) {
      p.state = "error";
      p.lastError = (e as Error).message;
      this.saveProfile(p);
      throw e;
    }
  }
  async revokeDesktop(pid: string) {
    for (const s of this.db
      .list<any>("manual-sessions")
      .filter((s) => s.profileId === pid && !s.closed)) {
      s.closed = true;
      this.db.set("manual-sessions", s.id, s);
      await this.desktopRevoker?.(s.id);
      this.db.release(pid, s.id, s.fencingToken);
    }
    const p = this.profile(pid);
    p.lastActivityAt = now();
    this.saveProfile(p);
  }
  async openDesktop(pid: string, principal: Principal, body: any) {
    let p = this.profile(pid, false);
    if (this.db.list<Job>("jobs").some(job => job.profileId === pid && job.kind === "browser_mode" && ["queued", "running"].includes(job.status)))
      throw new FleetError("PROFILE_BUSY", "浏览器正在切换模式，请完成后重新打开桌面", 409);
    const existing = this.db
      .list<any>("manual-sessions")
      .find(
        (s) =>
          s.profileId === pid &&
          s.principal === principal.id &&
          !s.closed &&
          Date.parse(s.expiresAt) > Date.now(),
      );
    if (existing && this.db.lease(pid)?.owner === existing.id)
      return { ...existing, desktopPath: `/profiles/${pid}/desktop` };
    if (p.headless)
      throw new FleetError(
        "HEADLESS_DESKTOP",
        "请关闭无头模式并重启实例后打开桌面",
        409,
      );
    if (
      this.db
        .list<Job>("jobs")
        .some((j) => j.profileId === pid && j.status === "running")
    )
      throw new FleetError("PROFILE_BUSY", "实例正在执行任务，请稍后接管", 409);
    const sid = id("manual"),
      duration = Math.min(
        Math.max(Number(body.durationSeconds || 900), 60),
        3600,
      ),
      token = this.db.acquire(pid, sid, duration * 1000);
    if (token === undefined)
      throw new FleetError("PROFILE_BUSY", "实例已被任务或人工操作占用", 409);
    try {
      p = await this.ensureStart(pid, body.explicitStart === true, token);
      const s = {
        id: sid,
        profileId: pid,
        principal: principal.id,
        fencingToken: token,
        expiresAt: new Date(Date.now() + duration * 1000).toISOString(),
        closed: false,
      };
      this.db.set("manual-sessions", sid, s);
      return { ...s, desktopPath: `/profiles/${pid}/desktop` };
    } catch (e) {
      this.db.release(pid, sid, token);
      throw e;
    }
  }
  manualSession(pid: string, principal: Principal) {
    const s = this.db
      .list<any>("manual-sessions")
      .find(
        (s) =>
          s.profileId === pid &&
          s.principal === principal.id &&
          !s.closed &&
          Date.parse(s.expiresAt) > Date.now(),
      );
    if (!s)
      throw new FleetError(
        "MANUAL_SESSION_EXPIRED",
        "人工会话已过期，请从实例重新打开桌面",
        403,
      );
    const lease = this.db.lease(pid);
    if (lease?.owner !== s.id || lease.token !== s.fencingToken)
      throw new FleetError("MANUAL_SESSION_EXPIRED", "人工操作租约已释放", 403);
    return s;
  }
  async artifact(
    profileId: string,
    type: string,
    data: Buffer,
    mimeType: string,
    jobId?: string,
  ) {
    this.diskCheck(data.length * 2 + 64 * 1024 * 1024);
    const aid = id("artifact");
    writeFileSync(
      join(this.config.root, "artifacts", aid),
      this.vault.encrypt(data, aid),
      { mode: 0o600 },
    );
    return this.db.set("artifacts", aid, {
      id: aid,
      profileId,
      type,
      mimeType,
      size: data.length,
      jobId,
      keyId: this.vault.keyId,
      createdAt: now(),
      expiresAt: new Date(
        Date.now() + this.config.retentionDays * 86400000,
      ).toISOString(),
      encrypted: true,
    });
  }
  readArtifact(aid: string) {
    const a = this.db.get<any>("artifacts", aid);
    if (!a || Date.parse(a.expiresAt) < Date.now())
      throw new FleetError("ARTIFACT_NOT_FOUND", "文件不存在或已过期", 404);
    return {
      meta: a,
      data: this.vault.decrypt(
        readFileSync(join(this.config.root, "artifacts", aid)),
        aid,
      ),
    };
  }
  async snapshot(pid: string, token: number) {
    const p = this.profile(pid);
    if (p.state !== "stopped")
      throw new FleetError(
        "PROFILE_MUST_STOP",
        "完整快照需要正常停止浏览器",
        409,
      );
    this.diskCheck();
    const state = join(this.config.root, "profiles", pid, "state");
    this.checkTree(state);
    const sid = id("snapshot"),
      tmp = join(this.config.root, "tmp", `${sid}.tar`);
    await command("tar", ["--format=posix", "-cf", tmp, "-C", state, "."]);
    try {
      const size = lstatSync(tmp).size;
      if (size > 1024 * 1024 * 1024)
        throw new FleetError(
          "SNAPSHOT_TOO_LARGE",
          "首版单快照最大1GiB，请清理下载目录后重试",
          413,
        );
      const plain = readFileSync(tmp);
      writeFileSync(
        join(this.config.root, "backups", sid),
        this.vault.encrypt(plain, sid),
        { mode: 0o600 },
      );
      const s = {
        id: sid,
        profileId: pid,
        formatVersion: 1,
        image: p.image,
        imageDigest: p.imageDigest,
        chromeVersion: p.chromeVersion,
        uid: 1000,
        gid: 1000,
        keyringSecretRef: p.keyringSecretRef,
        vncSecretRef: p.vncSecretRef,
        checksum: hash(plain),
        keyId: this.vault.keyId,
        size,
        createdAt: now(),
        restorePoint: now(),
      };
      this.db.set("snapshots", sid, s);
      p.lastSnapshotId = sid;
      this.saveProfile(p);
      return s;
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  checkTree(path: string) {
    if (!existsSync(path)) return;
    for (const name of readdirSync(path)) {
      const f = join(path, name),
        s = lstatSync(f);
      if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile())) {
        if (name.startsWith("Singleton")) {
          rmSync(f, { force: true });
          continue;
        }
        throw new FleetError(
          "UNSAFE_SNAPSHOT",
          "快照不接受符号链接或特殊文件",
          400,
        );
      }
      if (s.isDirectory()) this.checkTree(f);
    }
  }
  async restore(pid: string, snapshotId: string) {
    const p = this.profile(pid),
      s = this.db.get<any>("snapshots", snapshotId);
    if (!s || s.profileId !== pid)
      throw new FleetError("SNAPSHOT_NOT_FOUND", "快照不属于此实例", 404);
    if (p.state !== "stopped")
      throw new FleetError("PROFILE_MUST_STOP", "恢复快照前须停止实例", 409);
    this.vault.get(s.keyringSecretRef);
    const plain = this.vault.decrypt(
      readFileSync(join(this.config.root, "backups", s.id)),
      s.id,
    );
    if (hash(plain) !== s.checksum)
      throw new FleetError("SNAPSHOT_CORRUPTED", "快照完整性校验失败", 409);
    this.diskCheck(plain.length * 2 + 64 * 1024 * 1024);
    const tmp = join(this.config.root, "tmp", s.id + ".tar"),
      staging = join(this.config.root, "profiles", pid, "restore-staging"),
      state = join(this.config.root, "profiles", pid, "state"),
      old = state + ".previous";
    writeFileSync(tmp, plain, { mode: 0o600 });
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { mode: 0o700 });
    try {
      const listing = await command("tar", ["-tf", tmp]);
      for (const line of listing.split("\n").filter(Boolean)) {
        if (line.startsWith("/") || line.split("/").includes(".."))
          throw new FleetError("UNSAFE_SNAPSHOT", "快照路径越界");
      }
      await command("tar", [
        "--no-same-owner",
        "--no-same-permissions",
        "-xf",
        tmp,
        "-C",
        staging,
      ]);
      this.checkTree(staging);
      if (process.getuid?.() === 0)
        await command("chown", ["-R", "1000:1000", staging]);
      rmSync(old, { recursive: true, force: true });
      this.db.set("restore-journals", pid, {
        profileId: pid,
        snapshotId,
        createdAt: now(),
      });
      renameSync(state, old);
      renameSync(staging, state);
      p.image = s.image;
      p.imageDigest = s.imageDigest;
      p.chromeVersion = s.chromeVersion;
      p.keyringSecretRef = s.keyringSecretRef;
      p.pendingImage = null;
      delete p.upgradeSnapshotId;
      delete p.upgradeExpectedVersion;
      delete p.upgradeUpdateId;
      p.lastRestorePoint = s.restorePoint;
      this.db.transaction(() => {
        this.saveProfile(p);
        this.db.delete("restore-journals", pid);
      });
      this.prepareFiles(p);
      rmSync(old, { recursive: true, force: true });
      return { snapshotId: s.id, restorePoint: s.restorePoint, image: s.image };
    } finally {
      rmSync(tmp, { force: true });
      rmSync(staging, { recursive: true, force: true });
    }
  }
  pendingProgress(
    updateId: string | undefined,
    profileId: string,
    phase: string,
    extra: any = {},
  ) {
    if (!updateId) return;
    const run = this.db.get<any>("updates", updateId);
    if (!run) return;
    const progress = run.profiles.find((r: any) => r.profileId === profileId);
    if (progress) Object.assign(progress, extra, { phase });
    run.phase = ["rolled_back", "rollback_failed"].includes(phase)
      ? "failed"
      : phase === "starting"
        ? "applying"
        : "succeeded";
    this.db.set("updates", updateId, run);
  }
  async applyPending(p: Profile, token: number) {
    const pending = p.pendingImage;
    const snap = await this.snapshot(p.id, token);
    // Persist the recovery point before assigning the migrated image.
    this.pendingProgress(pending.updateId, p.id, "starting", {
      snapshotId: snap.id,
      restorePoint: snap.restorePoint,
    });
    delete p.pendingImage;
    p.image = pending.image;
    p.imageDigest = pending.imageDigest;
    p.upgradeSnapshotId = snap.id;
    p.upgradeUpdateId = pending.updateId;
    p.upgradeExpectedVersion = pending.version;
    p.lastSnapshotId = snap.id;
    this.saveProfile(p);
  }
  async reconcile() {
    // Interrupted mode switches keep the current on-disk state. Restoring the
    // pre-switch backup here could erase a login completed by the human.
    for (const transition of this.db.list<any>("browser-mode-transitions")) {
      const p = this.profile(transition.profileId);
      try {
        await this.runner.call(`/profiles/${p.id}/stop`, { force: false });
        p.state = "stopped";
      } catch { p.state = "error"; }
      p.desiredState = "stopped";
      p.autoWakePaused = true;
      p.lastError = "浏览器模式切换曾被中断；当前会话数据已保留，请检查后显式重试切换或启动";
      this.saveProfile(p);
      transition.phase = "interrupted";
      this.db.set("browser-mode-transitions", p.id, transition);
    }
    // A journal remains only if metadata and directory replacement did not commit together.
    for (const journal of this.db.list<any>("restore-journals")) {
      const pid = journal.profileId,
        base = join(this.config.root, "profiles", pid),
        state = join(base, "state"),
        old = state + ".previous";
      if (existsSync(old)) {
        if (existsSync(state)) rmSync(state, { recursive: true, force: true });
        renameSync(old, state);
      }
      rmSync(join(base, "restore-staging"), { recursive: true, force: true });
      const p = this.profile(pid);
      p.state = "stopped";
      p.lastError = "快照恢复曾被中断，已保留操作前会话，请重新提交恢复任务";
      this.saveProfile(p);
      this.db.delete("restore-journals", pid);
    }
    for (const s of this.db
      .list<any>("manual-sessions")
      .filter((s) => !s.closed)) {
      s.closed = true;
      this.db.set("manual-sessions", s.id, s);
      this.db.release(s.profileId, s.id, s.fencingToken);
    }
    for (const j of this.db
      .list<Job>("jobs")
      .filter((j) => j.status === "running")) {
      j.status = "outcome_unknown";
      j.error = {
        code: "CONTROL_RESTARTED",
        message: "控制服务重启；任务不会自动重放，请检查已执行步骤",
      };
      j.finishedAt = now();
      this.saveJob(j);
      this.event(j, "interrupted");
      const lease = this.db.lease(j.profileId);
      if (lease) this.db.release(j.profileId, lease.owner, lease.token);
      if (j.profileId !== "system") {
        const p = this.profile(j.profileId);
        try {
          await this.runner.call(`/profiles/${p.id}/stop`, { force: j.kind !== "browser_mode" && this.browserMode(p) !== "vnc" });
          p.state = "stopped";
          this.saveProfile(p);
        } catch {
          p.state = "error";
          p.lastError = "恢复任务前须确认旧浏览器已停止";
          this.saveProfile(p);
        }
      }
    }
    for (const u of this.db
      .list<any>("updates")
      .filter(
        (u) => !["succeeded", "failed", "rolled_back"].includes(u.phase),
      )) {
      u.phase = "interrupted";
      u.error = "控制服务在更新时重启；自动恢复配对快照";
      this.db.set("updates", u.id, u);
      for (const r of u.profiles || []) {
        if (
          r.snapshotId &&
          !["succeeded", "rolled_back", "pending"].includes(r.phase)
        ) {
          try {
            const p = this.profile(r.profileId);
            await this.runner.call(`/profiles/${p.id}/stop`, { force: true });
            p.state = "stopped";
            this.saveProfile(p);
            await this.restore(p.id, r.snapshotId);
            const abandoned = this.db.lease(p.id);
            if (abandoned?.owner === u.id)
              this.db.release(p.id, u.id, abandoned.token);
            r.phase = "rolled_back";
          } catch {
            r.phase = "rollback_failed";
            this.profile(r.profileId).lastError =
              "更新中断后恢复失败，请按快照手动恢复";
          }
        }
      }
      u.phase = "failed";
      this.db.set("updates", u.id, u);
    }
    for (const p of this.db
      .list<Profile>("profiles")
      .filter((p) => !p.archived)) {
      try {
        const s = await this.runner.call(`/profiles/${p.id}/status`);
        if (s.status === "running" || s.state === "running") {
          if ((s.browserMode || "automation") !== this.browserMode(p))
            throw new FleetError("BROWSER_MODE_MISMATCH", "运行中的浏览器模式与配置不一致", 409);
          p.state = "running";
          p.agentUrl = s.agentUrl || p.agentUrl;
          p.desktopUrl = s.desktopUrl || p.desktopUrl;
        } else p.state = "stopped";
        this.saveProfile(p);
      } catch {
        if (p.state !== "stopped") {
          p.state = "error";
          p.lastError = "Runner对账失败";
          this.saveProfile(p);
        }
      }
    }
    await this.syncNetworkPolicy();
  }
  async housekeeping() {
    if (this.closed) return;
    await this.syncNetworkPolicy();
    if (this.closed) return;
    for (const a of this.db.list<any>("artifacts"))
      if (Date.parse(a.expiresAt) < Date.now()) {
        rmSync(join(this.config.root, "artifacts", a.id), { force: true });
        this.db.delete("artifacts", a.id);
      }
    for (const a of this.db.list<any>("audit"))
      if (Date.now() - Date.parse(a.at) > this.config.retentionDays * 86400000)
        this.db.delete("audit", a.id);
    for (const session of this.db.list<any>("sessions"))
      if (Date.parse(session.expiresAt) < Date.now())
        this.db.delete("sessions", session.id);
    for (const p of this.db
      .list<Profile>("profiles")
      .filter((p) => !p.archived && p.state === "running")) {
      try {
        const diskBytes = treeBytes(
          join(this.config.root, "profiles", p.id, "state"),
        );
        const health = await this.agent(p, "/health");
        if (this.closed) return;
        const current = this.profile(p.id);
        current.diskBytes = diskBytes;
        if (current.state === "running") current.health = health;
        this.saveProfile(current);
      } catch {}
    }
  }
  async refreshMetrics() {
    if (this.closed || this.metricsRefreshing) return;
    this.metricsRefreshing = true;
    try {
      const profiles = this.db.list<Profile>("profiles").filter(profile => !profile.archived && !profile.purgedAt);
      let index = 0;
      const worker = async () => {
        while (!this.closed && index < profiles.length) {
          const captured = profiles[index++];
          const epoch = this.metricsEpoch.get(captured.id) || 0;
          let metrics: any;
          if (captured.state !== "running") {
            if (captured.metrics?.available !== true) continue;
            metrics = unavailableMetrics("PROFILE_NOT_RUNNING");
          } else {
            try {
              const runtime = await this.runner.call(`/profiles/${captured.id}/status`, undefined, "GET", 2500);
              metrics = runtime.status === "running" || runtime.state === "running"
                ? metricsView({ state: "running", metrics: runtime.metrics })
                : unavailableMetrics("PROFILE_NOT_RUNNING", new Date().toISOString());
            } catch { metrics = unavailableMetrics("RUNNER_UNAVAILABLE", new Date().toISOString()); }
          }
          if (this.closed) return;
          const current = this.db.get<Profile>("profiles", captured.id);
          if (!current || current.archived || current.purgedAt || (this.metricsEpoch.get(captured.id) || 0) !== epoch) continue;
          current.metrics = current.state === "running" ? metrics : unavailableMetrics("PROFILE_NOT_RUNNING");
          // Runtime samples do not change configuration timestamps or activity/leases.
          this.db.set("profiles", current.id, current);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, profiles.length) }, worker));
    } finally { this.metricsRefreshing = false; }
  }
  startWorker() {
    if (this.timer) return;
    const refresh = () => {
      void this.hostMetrics.refresh();
      void this.refreshMetrics().catch(() => undefined);
    };
    this.metricsTimer = setInterval(refresh, metricsIntervalMs);
    this.metricsTimer.unref();
    refresh();
    this.timer = setInterval(
      () =>
        void this.tick().catch(() =>
          process.stderr.write("后台对账失败，请检查磁盘与服务状态\n"),
        ),
      1000,
    );
    this.timer.unref();
  }
  async tick() {
    if (this.maintenance || this.ticking) return;
    this.ticking = true;
    try {
      if (Date.now() - this.lastHousekeeping > 60000) {
        this.lastHousekeeping = Date.now();
        void this.housekeeping();
      }
      for (const s of this.db
        .list<any>("manual-sessions")
        .filter(
          (s) =>
            !s.closed &&
            (Date.parse(s.expiresAt) < Date.now() ||
              this.db.get<any>("credentials", s.principal)?.revoked ||
              (this.db.get<any>("credentials", s.principal)?.expiresAt &&
                Date.parse(
                  this.db.get<any>("credentials", s.principal).expiresAt,
                ) < Date.now())),
        ))
        await this.revokeDesktop(s.profileId);
      for (const stored of this.db
        .list<Job>("jobs")
        .filter((j) => j.status === "queued")) {
        const j = this.job(stored.id);
        if (this.active.size >= this.config.maxConcurrency) break;
        if (this.active.has(j.profileId)) continue;
        const token = this.db.acquire(j.profileId, j.id, 60000);
        if (token === undefined) continue;
        this.active.add(j.profileId);
        j.status = "running";
        j.startedAt = now();
        j.fencingToken = token;
        this.saveJob(j);
        void this.run(j, token).finally(() => this.active.delete(j.profileId));
      }
      for (const p of this.db
        .list<Profile>("profiles")
        .filter((p) => !p.archived)) {
        const busy =
          this.db.lease(p.id)?.expires_at > Date.now() ||
          this.db
            .list<Job>("jobs")
            .some(
              (j) =>
                j.profileId === p.id &&
                ["queued", "running", "waiting_for_human"].includes(j.status),
            );
        if (
          !busy &&
          p.state === "running" &&
          this.browserMode(p) === "automation" &&
          p.idleTimeoutMinutes > 0 &&
          p.startupPolicy !== "always" &&
          Date.now() - Date.parse(p.lastActivityAt) >
            p.idleTimeoutMinutes * 60000
        ) {
          try {
            const health = await this.agent(p, "/health");
            if (!health.activeDownloads)
              this.submit("stop", p.id, { manual: false }, "scheduler");
          } catch {
            /* A missing health response never authorizes idle shutdown. */
          }
        }
        if (
          !busy &&
          p.startupPolicy === "always" &&
          !p.autoWakePaused &&
          p.state === "stopped"
        )
          this.submit("start", p.id, {}, "scheduler");
      }
      const policy = this.db.get<any>("settings", "update-policy");
      if (
        policy &&
        !policy.paused &&
        (!policy.lastCheckedAt ||
          Date.now() - Date.parse(policy.lastCheckedAt) >
            policy.checkIntervalHours * 3600000) &&
        !this.db
          .list<Job>("jobs")
          .some(
            (j) =>
              ["update_check", "update_apply"].includes(j.kind) &&
              ["queued", "running"].includes(j.status),
          )
      ) {
        this.submit("update_check", "system", {}, "scheduler");
        policy.lastCheckedAt = now();
        this.db.set("settings", "update-policy", policy);
      }
      const hour = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date());
      if (
        policy?.mode === "auto" &&
        !policy.paused &&
        (policy.maintenanceStart <= policy.maintenanceEnd
          ? hour >= policy.maintenanceStart && hour < policy.maintenanceEnd
          : hour >= policy.maintenanceStart || hour < policy.maintenanceEnd)
      ) {
        const candidate = this.db
          .list<any>("versions")
          .find(
            (v) =>
              v.validated &&
              !v.applied &&
              v.distribution === "google" &&
              (!v.nextAttemptAt || Date.parse(v.nextAttemptAt) < Date.now()),
          );
        if (
          candidate &&
          !this.db
            .list<Job>("jobs")
            .some(
              (j) =>
                j.kind === "update_apply" &&
                ["queued", "running"].includes(j.status),
            )
        )
          this.submit(
            "update_apply",
            "system",
            { versionId: candidate.id },
            "scheduler",
          );
      }
    } finally {
      this.ticking = false;
    }
  }
  async run(j: Job, token: number) {
    let leaseLost = false;
    const renew = setInterval(() => {
      if (!this.db.renew(j.profileId, j.id, token)) {
        leaseLost = true;
        if (j.profileId !== "system")
          void this.runner
            .call(`/profiles/${j.profileId}/stop`, { force: j.kind !== "browser_mode" && this.browserMode(this.profile(j.profileId)) !== "vnc" })
            .catch(() => {});
      }
    }, 15000);
    let result: any;
    try {
      if (j.kind === "accounts_check") throw new FleetError("ACCOUNT_CHECK_REMOVED", "主动账号检测已移除，请在实例详情人工确认登录", 410);
      if (j.kind === "browser_mode") {
        const credential = this.db.get<any>("credentials", j.principal);
        const scopes = credential?.scopes || [], profiles = credential?.profiles || [];
        if (!credential || credential.revoked || (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) ||
            !(scopes.includes("admin") || (scopes.includes("automate") && (j.kind !== "browser_mode" || scopes.includes("manage")))) ||
            !(profiles.includes("*") || profiles.includes(j.profileId)))
          throw new FleetError("SCOPE_DENIED", "浏览器模式切换授权已失效", 403);
        if (j.kind === "browser_mode" && j.payload.googleAccountId) {
          const binding = this.google.binding(j.profileId);
          if (binding?.accountId !== j.payload.googleAccountId || binding?.confirmationState !== "confirmed")
            throw new FleetError("ACCOUNT_MISMATCH", "已确认的账号绑定已变化，请重新确认登录后接管", 409);
        }
      }
      if (j.profileId !== "system") {
        const p = this.profile(j.profileId);
        if (this.needsAutomation(j.kind)) this.requireAutomation(p);
        if (p.state === "running") await this.agent(p, "/fence", { token });
      }
      switch (j.kind) {
        case "start":
          result = this.publicProfile(
            await this.ensureStart(j.profileId, true, token),
          );
          break;
        case "stop":
          result = this.publicProfile(
            await this.stop(
              j.profileId,
              j.payload.manual !== false,
              j.payload.force === true,
            ),
          );
          break;
        case "restart":
          await this.stop(j.profileId, false);
          result = this.publicProfile(
            await this.ensureStart(j.profileId, true, token),
          );
          break;
        case "browser_mode": {
          const target = j.payload.browserMode;
          if (!["automation", "vnc"].includes(target))
            throw new FleetError("INVALID_BROWSER_MODE", "浏览器模式无效");
          let p = this.profile(j.profileId, false);
          const transition: any = { profileId: p.id, jobId: j.id, from: this.browserMode(p), to: target, phase: "stopping", createdAt: now() };
          this.db.set("browser-mode-transitions", p.id, transition);
          try {
            await this.stop(p.id, false);
            transition.phase = "snapshot";
            this.db.set("browser-mode-transitions", p.id, transition);
            const snapshot = await this.snapshot(p.id, token);
            transition.snapshotId = snapshot.id;
            transition.phase = "starting";
            p = this.profile(p.id);
            p.browserMode = target;
            if (target === "vnc") p.headless = false;
            p.state = "stopped";
            p.lastError = null;
            this.saveProfile(p);
            this.db.set("browser-mode-transitions", p.id, transition);
            result = this.publicProfile(await this.ensureStart(p.id, true, token));
            this.db.delete("browser-mode-transitions", p.id);
          } catch (error) {
            p = this.profile(p.id);
            try { await this.runner.call(`/profiles/${p.id}/stop`, { force: false }); p.state = "stopped"; }
            catch { p.state = "error"; }
            p.desiredState = "stopped";
            p.autoWakePaused = true;
            p.lastError = "模式切换未完成，当前会话数据及已有恢复点已保留；请检查后显式重试";
            this.saveProfile(p);
            transition.phase = "failed";
            this.db.set("browser-mode-transitions", p.id, transition);
            throw error;
          }
          break;
        }
        case "archive":
          await this.stop(j.profileId, true);
          await this.runner.call(
            `/profiles/${j.profileId}/container`,
            undefined,
            "DELETE",
          );
          {
            const p = this.profile(j.profileId);
            p.archived = true;
            result = this.publicProfile(this.saveProfile(p));
          }
          break;
        case "proxy_test": {
          let p = this.profile(j.profileId);
          const wasStopped = p.state !== "running",
            wasPaused = p.autoWakePaused;
          try {
            if (!wasStopped && p.proxy?.version !== p.proxy?.appliedVersion) {
              await this.stop(p.id, false);
              p = await this.ensureStart(p.id, true, token);
            } else
              p = await this.ensureStart(
                p.id,
                j.payload.explicitStart === true,
                token,
              );
            result = await this.agent(p, "/proxy/test", {}, token);
            p.proxy = p.proxy || {
              enabled: false,
              version: 0,
              appliedVersion: 0,
            };
            p.proxy.lastTest = { ...result, at: now() };
            this.saveProfile(p);
          } finally {
            try {
              if (wasStopped) await this.stop(p.id, false);
            } finally {
              const restored = this.profile(p.id);
              restored.autoWakePaused = wasPaused;
              this.saveProfile(restored);
            }
          }
          break;
        }
        case "automation":
          result = await this.runAutomation(j, token);
          break;
        case "cookies_export":
        case "storage-state_export": {
          const p = await this.ensureStart(j.profileId, false, token),
            out = await this.agent(
              p,
              `/${j.kind.startsWith("cookies") ? "cookies" : "storage-state"}/export`,
              j.payload,
              token,
            );
          const a = await this.artifact(
            p.id,
            j.kind.startsWith("cookies") ? "cookies" : "storage-state",
            Buffer.from(
              JSON.stringify(
                j.kind.startsWith("cookies")
                  ? {
                      ...(out.document || out),
                      browserVersion: p.chromeVersion,
                      scope: { profileId: p.id, ...j.payload },
                    }
                  : out.document || out,
              ),
            ),
            "application/json",
            j.id,
          );
          result = {
            artifactId: a.id,
            count: out.count,
            encrypted: true,
            expiresAt: a.expiresAt,
            scope: j.payload.domains || j.payload.urls || "profile",
          };
          break;
        }
        case "cookies_import":
        case "storage-state_import": {
          const p = await this.ensureStart(j.profileId, false, token),
            a = this.readArtifact(j.payload.artifactId);
          if (a.meta.profileId !== p.id)
            throw new FleetError(
              "ARTIFACT_PROFILE_MISMATCH",
              "导入文件不属于目标实例",
              403,
            );
          let document;
          try {
            document = JSON.parse(a.data.toString());
          } catch {
            throw new FleetError("INVALID_IMPORT", "导入文件不是有效JSON");
          }
          result = await this.agent(
            p,
            `/${j.kind.startsWith("cookies") ? "cookies" : "storage-state"}/import`,
            {
              document,
              mode: j.payload.mode || "merge",
              domains: j.payload.domains,
              dryRun: j.payload.dryRun,
            },
            token,
          );
          for (const a of this.db
            .list<any>("accounts")
            .filter((a) => a.profileId === p.id)) {
            a.authState = "unknown";
            this.db.set("accounts", a.id, a);
          }
          break;
        }
        case "snapshot": {
          const p = this.profile(j.profileId),
            running = p.state === "running";
          if (running) await this.stop(p.id, false);
          try {
            const snapshot = await this.snapshot(p.id, token);
            const { keyringSecretRef, vncSecretRef, ...publicSnapshot } =
              snapshot;
            result = publicSnapshot;
          } finally {
            if (running) await this.ensureStart(p.id, true, token);
          }
          break;
        }
        case "restore":
          result = await this.restore(j.profileId, j.payload.snapshotId);
          break;
        case "update_check":
          result = await this.checkVersions(j.payload);
          break;
        case "update_apply":
          result = await this.applyUpdate(j.payload);
          break;
        case "update_rollback":
          result = await this.rollbackUpdate(j.payload.updateId);
          break;
        default:
          throw new FleetError("UNSUPPORTED_JOB", "任务类型不支持");
      }
      if (leaseLost)
        throw new FleetError("LEASE_LOST", "租约失效，结果须人工检查", 409);
      const current = this.job(j.id);
      if (current.status !== "running") {
        if (current.status !== "waiting_for_human") {
          current.finishedAt = now();
          this.saveJob(current);
          this.event(current, "finished");
        }
        this.audit(
          j.principal,
          j.kind,
          j.profileId,
          current.status,
          current.error?.code,
        );
        return;
      }
      j.status = current.cancelRequested ? "cancelled" : "succeeded";
      j.result = result;
      j.progress = 100;
      j.finishedAt = now();
      this.saveJob(j);
      this.event(j, "finished");
      this.audit(j.principal, j.kind, j.profileId, j.status);
    } catch (e) {
      const current = this.job(j.id);
      j.status =
        leaseLost ||
        ["AGENT_CONNECTION_LOST", "RUNNER_UNAVAILABLE"].includes(
          (e as any).code,
        )
          ? "outcome_unknown"
          : current.cancelRequested
            ? "cancelled"
            : (e as any).code === "TASK_TIMEOUT"
              ? "timed_out"
              : "failed";
      j.error = {
        code: (e as any).code || "OPERATION_FAILED",
        message:
          e instanceof FleetError ? e.message : "操作失败，请查看系统诊断",
      };
      j.finishedAt = now();
      this.saveJob(j);
      this.event(j, "failed");
      this.audit(j.principal, j.kind, j.profileId, j.status, j.error.code);
    } finally {
      clearInterval(renew);
      this.db.release(j.profileId, j.id, token);
      if (j.profileId !== "system") {
        const p = this.profile(j.profileId);
        p.lastActivityAt = now();
        this.saveProfile(p);
      }
    }
  }
  async runAutomation(j: Job, token: number) {
    const expectedId = j.payload.expectedAccountId;
    if (expectedId) {
      const a = this.db.get<any>("accounts", expectedId);
      if (!a || a.profileId !== j.profileId || !manuallyConfirmed(a)) {
        j.status = "waiting_for_human";
        j.reason = "期望账号尚未人工确认，请在实例详情确认登录后继续任务";
        this.saveJob(j);
        return { waitingForHuman: true };
      }
    }
    const p = await this.ensureStart(j.profileId, false, token);
    const results: any[] = [...(j.result?.results || [])];
    const started = Date.now() - (j.activeElapsedMs || 0);
    for (let i = j.completedSteps || 0; i < j.payload.steps.length; i++) {
      const current = this.job(j.id);
      if (current.cancelRequested) break;
      if (Date.now() - started > j.payload.timeoutMs)
        throw new FleetError("TASK_TIMEOUT", "任务已超时", 408);
      const step = { ...j.payload.steps[i] };
      const resultKey = step.resultKey;
      delete step.resultKey;
      delete step.safeToRetry;
      if (step.expected !== undefined) {
        step.text = step.expected;
        delete step.expected;
      }
      if (step.action === "requireHuman") {
        j.activeElapsedMs = Date.now() - started;
        j.status = "waiting_for_human";
        j.completedSteps = i + 1;
        j.reason = step.reason || "任务等待人工接管";
        this.saveJob(j);
        return { waitingForHuman: true };
      }
      if (step.artifactId) {
        const a = this.readArtifact(step.artifactId);
        if (a.meta.profileId !== p.id)
          throw new FleetError(
            "ARTIFACT_PROFILE_MISMATCH",
            "上传文件不属于目标实例",
            403,
          );
        step.base64 = a.data.toString("base64");
        step.fileName = "upload";
        step.mimeType = a.meta.mimeType;
      }
      j.inFlightStep = i;
      this.saveJob(j);
      const out = await this.agent(
        p,
        "/execute",
        {
          steps: [step],
          timeoutMs: Math.min(
            j.payload.timeoutMs - (Date.now() - started),
            step.timeoutMs || 60000,
          ),
        },
        token,
        Math.min(
          j.payload.timeoutMs - (Date.now() - started),
          step.timeoutMs || 60000,
        ) + 5000,
      );
      j.activeElapsedMs = Date.now() - started;
      for (const a of out.artifacts || []) {
        const artifact = await this.artifact(
          p.id,
          a.type || "screenshot",
          Buffer.from(a.base64, "base64"),
          a.mimeType || "application/octet-stream",
          j.id,
        );
        results.push({ artifactId: artifact.id, type: artifact.type });
      }
      results.push(...(out.results || []));
      if (resultKey)
        results.push({ resultKey, value: out.results?.[0]?.result });
      if (out.status && out.status !== "succeeded") {
        j.status = out.status;
        j.completedSteps = i + (out.completedSteps || 0);
        j.error = out.error;
        j.reason = out.evidence?.message;
        j.result = { results };
        this.saveJob(j);
        this.event(j, out.status);
        return out;
      }
      j.completedSteps = i + 1;
      delete j.inFlightStep;
      j.progress = Math.floor(((i + 1) / j.payload.steps.length) * 100);
      j.result = { results };
      this.saveJob(j);
      this.event(j, "step_completed");
      if (out.status === "waiting_for_human") {
        j.status = "waiting_for_human";
        this.saveJob(j);
        return out;
      }
    }
    return { results, completedSteps: j.completedSteps };
  }
  async checkVersions(payload: any) {
    const distribution = payload.distribution || "google";
    let version: string;
    if (distribution === "google") {
      const r = await fetch(
        "https://dl.google.com/linux/chrome/deb/dists/stable/main/binary-amd64/Packages.gz",
        { signal: AbortSignal.timeout(30000) },
      );
      if (!r.ok)
        throw new FleetError(
          "VERSION_SOURCE_FAILED",
          "Google官方软件源不可用",
          502,
        );
      const text = gunzipSync(Buffer.from(await r.arrayBuffer())).toString();
      const block = text
        .split("\n\n")
        .find((b) => b.includes("Package: google-chrome-stable\n"));
      version = block?.match(/^Version: ([0-9.]+)-/m)?.[1] || "";
    } else {
      const r = await fetch(
        "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json",
        { signal: AbortSignal.timeout(30000) },
      );
      const b: any = await r.json();
      version = b.channels.Stable.version;
    }
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(version))
      throw new FleetError(
        "VERSION_SOURCE_INVALID",
        "官方版本数据格式无效",
        502,
      );
    const vid = `${distribution}-${version}`;
    let v = this.db.get<any>("versions", vid) || {
      id: vid,
      distribution,
      version,
      validated: false,
      discoveredAt: now(),
      source:
        distribution === "google"
          ? "Google signed apt repository"
          : "Chrome for Testing official release data",
    };
    this.db.set("versions", vid, v);
    const policy = this.db.get<any>("settings", "update-policy");
    policy.lastCheckedAt = now();
    this.db.set("settings", "update-policy", policy);
    if (
      (policy.mode === "auto" && !policy.paused) ||
      payload.prepare === true
    ) {
      const prepared = await this.runner.call(
        "/images/prepare",
        { version, distribution },
        "POST",
        1800000,
      );
      const validated = await this.runner.call(
        "/images/validate",
        { image: prepared.image || `chrome-fleet/browser:${vid}` },
        "POST",
        300000,
      );
      if (validated.valid === false || validated.compatible === false)
        throw new FleetError(
          "COMPATIBILITY_FAILED",
          "候选Chrome镜像兼容性测试失败",
          409,
        );
      v = {
        ...v,
        ...prepared,
        validation: validated,
        validated: true,
        validatedAt: now(),
      };
      this.db.set("versions", vid, v);
    }
    return v;
  }
  async applyUpdate(payload: any) {
    const v = payload.versionId
      ? this.db.get<any>("versions", payload.versionId)
      : this.db
          .list<any>("versions")
          .filter((v) => v.validated && !v.applied)
          .at(-1);
    if (!v?.validated)
      throw new FleetError(
        "VERSION_NOT_VALIDATED",
        "须先准备镜像并完成兼容性验证",
        409,
      );
    const uid = id("update"),
      run: any = {
        id: uid,
        targetVersion: v.version,
        targetImage: v.image,
        phase: "applying",
        createdAt: now(),
        profiles: [],
      };
    this.db.set("updates", uid, run);
    let failed = false;
    for (const p of this.db
      .list<Profile>("profiles")
      .filter(
        (p) =>
          !p.archived &&
          !p.pinnedVersion &&
          (p.distribution || "google") === v.distribution &&
          (!payload.profileIds || payload.profileIds.includes(p.id)),
      )) {
      if (p.chromeVersion === v.version && p.imageDigest === v.imageDigest)
        continue;
      const r: any = {
        profileId: p.id,
        oldImage: p.image,
        oldVersion: p.chromeVersion,
        phase: "draining",
        wasRunning: p.state === "running",
      };
      run.profiles.push(r);
      this.db.set("updates", uid, run);
      if (this.browserMode(p) === "vnc") {
        r.phase = "deferred";
        r.reason = "VNC_MODE_UNSUPPORTED";
        this.db.set("updates", uid, run);
        continue;
      }
      const token = this.db.acquire(p.id, uid, 3600000);
      if (
        token === undefined ||
        this.db
          .list<Job>("jobs")
          .some(
            (j) =>
              j.profileId === p.id &&
              ["queued", "running", "waiting_for_human"].includes(j.status),
          )
      ) {
        if (token !== undefined) this.db.release(p.id, uid, token);
        r.phase = "deferred";
        this.db.set("updates", uid, run);
        continue;
      }
      try {
        if (
          r.wasRunning &&
          (await this.agent(p, "/health")).activeDownloads > 0
        ) {
          r.phase = "deferred";
          continue;
        }
        if (!r.wasRunning) {
          p.pendingImage = {
            image: v.image,
            imageDigest: v.imageDigest,
            version: v.version,
            updateId: uid,
          };
          this.saveProfile(p);
          r.phase = "pending";
          continue;
        }
        await this.agent(p, "/fence", { token });
        await this.stop(p.id, false);
        r.phase = "snapshot";
        this.db.set("updates", uid, run);
        const s = await this.snapshot(p.id, token);
        p.state = "stopped";
        r.snapshotId = s.id;
        r.restorePoint = s.restorePoint;
        r.phase = "starting";
        this.db.set("updates", uid, run);
        p.image = v.image;
        p.imageDigest = v.imageDigest;
        this.saveProfile(p);
        Object.assign(p, await this.ensureStart(p.id, true, token));
        if (p.chromeVersion !== v.version)
          throw new FleetError(
            "VERSION_MISMATCH",
            "候选镜像实际 Chrome 版本与目标版本不一致",
            409,
          );
        r.phase = "succeeded";
        p.lastUpdateId = uid;
        this.saveProfile(p);
      } catch (e) {
        r.error = e instanceof FleetError ? e.message : "升级技术验证失败";
        r.phase = "rolling_back";
        this.db.set("updates", uid, run);
        if (r.snapshotId) {
          try {
            await this.runner.call(`/profiles/${p.id}/stop`, { force: true });
            p.state = "stopped";
            this.saveProfile(p);
            await this.restore(p.id, r.snapshotId);
            if (r.wasRunning) await this.ensureStart(p.id, true, token);
            r.phase = "rolled_back";
          } catch {
            r.phase = "rollback_failed";
            p.state = "error";
            p.lastError = "回滚失败：保留原快照，请按恢复文档操作";
            this.saveProfile(p);
          }
        } else r.phase = "failed";
        failed = true;
        break;
      } finally {
        this.db.release(p.id, uid, token);
        this.db.set("updates", uid, run);
      }
    }
    run.phase = failed ? "failed" : "succeeded";
    run.finishedAt = now();
    this.db.set("updates", uid, run);
    if (!failed) {
      v.applied = !run.profiles.some((r: any) => r.phase === "deferred");
      if (!v.applied)
        v.nextAttemptAt = new Date(Date.now() + 3600000).toISOString();
      this.db.set("versions", v.id, v);
    }
    return run;
  }
  async rollbackUpdate(uid: string) {
    const run = this.db.get<any>("updates", uid);
    if (!run) throw new FleetError("UPDATE_NOT_FOUND", "更新记录不存在", 404);
    for (const r of [...run.profiles].reverse()) {
      const token = this.db.acquire(r.profileId, uid, 3600000);
      if (token === undefined)
        throw new FleetError("PROFILE_BUSY", "回滚实例正在被使用", 409);
      try {
        const current = this.profile(r.profileId);
        if (!r.snapshotId) {
          if (current.pendingImage?.updateId === uid) {
            delete current.pendingImage;
            this.saveProfile(current);
          } else if (current.image !== r.oldImage)
            throw new FleetError(
              "RECOVERY_POINT_MISSING",
              "此更新缺少配对恢复点，已拒绝把当前状态标为回滚成功",
              409,
            );
          r.phase = "rolled_back";
          continue;
        }
        if (current.state === "running")
          await this.agent(current, "/fence", { token });
        await this.stop(r.profileId, false);
        await this.restore(r.profileId, r.snapshotId);
        if (r.wasRunning) await this.ensureStart(r.profileId, true, token);
        r.phase = "rolled_back";
      } finally {
        this.db.release(r.profileId, uid, token);
        this.db.set("updates", uid, run);
      }
    }
    run.phase = "rolled_back";
    run.rollbackAt = now();
    this.db.set("updates", uid, run);
    return run;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    this.db.close();
  }
}
export async function command(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.stderr.on("data", (c) => (stderr += c));
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(
            new FleetError("LOCAL_OPERATION_FAILED", `${bin} 操作失败`, 500),
          ),
    );
  });
}

function treeBytes(path: string): number {
  let total = 0;
  if (!existsSync(path)) return 0;
  for (const name of readdirSync(path)) {
    try {
      const full = join(path, name),
        s = lstatSync(full);
      total += s.isDirectory() ? treeBytes(full) : s.size;
    } catch {}
  }
  return total;
}
