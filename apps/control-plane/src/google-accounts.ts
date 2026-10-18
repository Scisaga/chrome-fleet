import { readFileSync, statSync } from "node:fs";
import { hash, id, now } from "@chrome-fleet/core";
import { FleetError, type GoogleBinding } from "@chrome-fleet/contracts";
import { z } from "zod";
import type { Principal } from "./auth.js";
import type { FleetService } from "./service.js";

const emailPattern =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const normalizeEmail = (value: string) => value.trim().toLowerCase();
const accountEmail = z.string().trim().toLowerCase().max(254).regex(emailPattern);
const accountPassword = z.string().min(1).max(4096);
const recoveryEmail = z.union([accountEmail, z.literal("")]);
const createAccountInput = z.object({
  email: accountEmail,
  password: accountPassword,
  recoveryEmail: recoveryEmail.default(""),
}).strict();
const updateAccountInput = z.object({
  password: accountPassword.optional(),
  recoveryEmail: recoveryEmail.optional(),
}).strict().refine(input => input.password !== undefined || input.recoveryEmail !== undefined);
const autofillMessages = {
  waiting: "正在等待Google邮箱或密码页面加载；邮箱页下一步与密码提交均由你操作",
  email_filled: "邮箱已填好，请点击下一步；检测进入密码页后系统会填写密码，仍由你提交",
  email_submitted: "已检测到你提交邮箱，正在等待密码页面；密码填写后仍由你提交",
  password_filled: "已填写密码，请本人在远程桌面点击下一步并完成后续验证",
  manual_required: "自动填充已暂停，请在远程桌面继续；系统不会提交密码或处理验证",
  account_mismatch: "页面或加密账号资料与所选账号不一致，已停止自动填充，请人工核对",
  unsupported: "当前浏览器暂不支持辅助填充，请在远程桌面手动登录",
} as const;
type AutofillStage = keyof typeof autofillMessages;
const pendingAutofill = new Set<AutofillStage>([
  "waiting", "email_filled", "email_submitted",
]);
const autofillState = (stage: AutofillStage) => ({
  stage, message: autofillMessages[stage],
});

export interface GoogleAccountInput {
  email: string;
  password: string;
  recoveryEmail: string;
}

export function parseGoogleAccounts(contents: string): GoogleAccountInput[] {
  const rows = contents.replace(/^\uFEFF/, "").split(/\r?\n/);
  const accounts: GoogleAccountInput[] = [];
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (!row.trim() || row.trimStart().startsWith("#")) continue;
    const fields = row.split("\t");
    const email = normalizeEmail(fields[0] || "");
    const recoveryEmail = normalizeEmail(fields[2] || "");
    if (
      fields.length !== 3 ||
      !emailPattern.test(email) ||
      email.length > 254 ||
      !fields[1] ||
      fields[1].length > 4096 ||
      !emailPattern.test(recoveryEmail) ||
      recoveryEmail.length > 254
    )
      throw new FleetError(
        "INVALID_ACCOUNT_FILE",
        `账号文件第 ${index + 1} 行格式错误，应为邮箱、密码、备用邮箱，以制表符分隔`,
      );
    if (seen.has(email))
      throw new FleetError(
        "DUPLICATE_ACCOUNT",
        `账号文件第 ${index + 1} 行邮箱重复`,
      );
    seen.add(email);
    accounts.push({ email, password: fields[1], recoveryEmail });
  }
  if (!accounts.length || accounts.length > 5000)
    throw new FleetError("INVALID_ACCOUNT_FILE", "账号文件须包含1至5000条记录");
  return accounts;
}

export class GoogleAccounts {
  private checks = new Map<string, Promise<any>>();
  private opening = new Set<string>();
  private closing = new Set<string>();
  constructor(private service: FleetService) {}

  catalogForEmail(value: string) {
    const email = normalizeEmail(value);
    const catalog = this.service.db.list<any>("google-accounts").find(account => typeof account.email === "string" && normalizeEmail(account.email) === email);
    if (!catalog || !emailPattern.test(email) || catalog.id !== `google_${hash(email).slice(0, 24)}`)
      throw new FleetError("ACCOUNT_NOT_FOUND", "请指定已导入目录中的Google账号", 404);
    return catalog;
  }

  assertAvailable(value: string, profileId?: string) {
    const email = normalizeEmail(value);
    const conflict = this.service.db.list<any>("accounts").some(account => {
      if (account.profileId === profileId || typeof account.provider !== "string" || account.provider.toLowerCase() !== "google" ||
          typeof account.expectedIdentity !== "string" || normalizeEmail(account.expectedIdentity) !== email) return false;
      const profile = this.service.db.get<any>("profiles", account.profileId);
      return profile && !profile.purgedAt;
    });
    if (conflict)
      throw new FleetError("GOOGLE_ACCOUNT_ALREADY_BOUND", "一个账号只能关联一个 Chrome 实例，请使用现有实例；归档实例仍保留关联", 409);
  }

  binding(pid: string): GoogleBinding | undefined {
    const rows = this.service.db.list<any>("accounts").filter(account => account.profileId === pid && typeof account.provider === "string" && account.provider.toLowerCase() === "google");
    // Ambiguous old records require an explicit selection, never a guessed account.
    if (rows.length !== 1 || typeof rows[0].expectedIdentity !== "string") return;
    const row = rows[0];
    let catalog: any;
    try { catalog = this.catalogForEmail(row.expectedIdentity); } catch { return; }
    if (row.catalogId && row.catalogId !== catalog.id) return;
    const confirmed = row.authState === "manually_confirmed" &&
      (row.verificationSource === "manual_confirmation" || row.bindingSource === "manual_confirmation") &&
      typeof row.lastConfirmedAt === "string" && Number.isFinite(Date.parse(row.lastConfirmedAt));
    return {
      accountId: catalog.id, email: normalizeEmail(catalog.email),
      confirmationState: confirmed ? "confirmed" : "unconfirmed",
      ...(confirmed ? { lastConfirmedAt: row.lastConfirmedAt } : {}),
    };
  }

  private metadataProfile(pid: string, principal?: Principal, allowAutomation = false) {
    const profile = this.service.profile(pid, false);
    if (profile.purgedAt) throw new FleetError("PROFILE_PURGED", "实例已彻底清理", 410);
    if (!allowAutomation && this.service.browserMode(profile) !== "vnc")
      throw new FleetError("BROWSER_MODE_REQUIRED", "目录绑定和人工确认仅适用于纯VNC模式", 409);
    if (principal) {
      const current = this.service.db.get<any>("credentials", principal.id);
      if (!current || current.revoked || (current.expiresAt && Date.parse(current.expiresAt) <= Date.now()))
        throw new FleetError("UNAUTHORIZED", "平台凭证已失效", 401);
      if (!current.scopes?.includes("admin")) throw new FleetError("SCOPE_DENIED", "目录绑定和人工确认需要管理员权限", 403);
      if (!current.profiles?.includes("*") && !current.profiles?.includes(pid)) throw new FleetError("PROFILE_DENIED", "无权访问此实例", 403);
    }
    return profile;
  }

  bind(pid: string, accountId: string, principal?: Principal): GoogleBinding {
    this.metadataProfile(pid, principal);
    const catalog = this.service.db.get<any>("google-accounts", accountId);
    if (!catalog || typeof catalog.email !== "string" || this.catalogForEmail(catalog.email).id !== accountId)
      throw new FleetError("ACCOUNT_NOT_FOUND", "待绑定的目录账号不存在", 404);
    const previous = this.binding(pid);
    const rows = this.service.db.list<any>("accounts").filter(account => account.profileId === pid && typeof account.provider === "string" && account.provider.toLowerCase() === "google");
    const email = normalizeEmail(catalog.email);
    const selected = rows.find(account => typeof account.expectedIdentity === "string" && normalizeEmail(account.expectedIdentity) === email) || rows[0];
    const unchanged = previous?.accountId === accountId;
    const takeover = selected?.automationTakeoverJobId && this.service.db.get<any>("jobs", selected.automationTakeoverJobId);
    if (!unchanged && takeover?.status === "running")
      throw new FleetError("PROFILE_BUSY", "自动化接管正在执行，请完成后再更改账号", 409);
    const record = unchanged ? { ...selected, provider: "google", catalogId: accountId, expectedIdentity: email } : {
      id: selected?.id || id("account"), profileId: pid, provider: "google", alias: email,
      expectedIdentity: email, catalogId: accountId, authState: "unknown", lastCheckedAt: null,
      boundAt: now(), bindingSource: "catalog_mapping",
      evidence: "仅记录导入目录账号与Chrome实例的映射，未确认或验证网站登录状态",
    };
    this.service.db.transaction(() => {
      this.assertAvailable(email, pid);
      if (!unchanged && takeover?.status === "queued") {
        takeover.status = "cancelled"; takeover.finishedAt = now();
        this.service.saveJob(takeover);
        this.service.event(takeover, "finished");
      }
      for (const row of rows) if (row.id !== record.id) this.service.db.delete("accounts", row.id);
      this.service.db.set("accounts", record.id, record);
      if (principal) {
        try {
          const own = this.service.manualSession(pid, principal);
          if (this.stillOwned(own)) {
            own.googleLogin = this.vncState(pid, own.googleLogin);
            this.service.db.set("manual-sessions", own.id, own);
          }
        } catch { /* Binding metadata neither needs nor takes over a desktop. */ }
      }
      this.service.audit(principal?.id || "system", "google_binding_set", pid);
    });
    return this.binding(pid)!;
  }

  private vncState(pid: string, previous?: any) {
    const binding = this.binding(pid);
    const confirmed = binding?.confirmationState === "confirmed";
    const row = this.service.db.list<any>("accounts").find(account => account.profileId === pid && account.provider === "google");
    return {
      status: confirmed ? "bound" : "waiting", navigationStatus: "opened", browserMode: "vnc",
      ...(binding ? { expectedAccountId: binding.accountId, expectedEmail: binding.email } : {}),
      startedAt: previous?.startedAt || now(),
      ...(confirmed ? { accountId: row?.id, verificationSource: "manual_confirmation", lastConfirmedAt: binding.lastConfirmedAt } : {}),
      message: confirmed ? "已记录此目录账号与实例的人工确认绑定；确认时间不代表实时Google登录证明" : binding
        ? "目录账号已绑定。请自行确认Google已登录后点击确认；系统不会读取页面或验证登录状态"
        : "请先为此实例绑定一个已导入的Google目录账号",
    };
  }

  importFile(path: string) {
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024)
      throw new FleetError(
        "INVALID_ACCOUNT_FILE",
        "账号文件须为不超过8MiB的普通文件",
      );
    const inputs = parseGoogleAccounts(readFileSync(path, "utf8"));
    const records = inputs.map((input) => {
      const key = `google_${hash(input.email).slice(0, 24)}`;
      const existing = this.service.db.get<any>("google-accounts", key);
      return {
        id: key,
        email: input.email,
        recoveryEmail: input.recoveryEmail,
        credentialsRef: this.service.vault.put(input, existing?.credentialsRef),
        createdAt: existing?.createdAt || now(),
        updatedAt: now(),
      };
    });
    this.service.db.transaction(() => {
      for (const record of records)
        this.service.db.set("google-accounts", record.id, record);
      this.service.audit(
        "local-import",
        "google_accounts_import",
        undefined,
        "succeeded",
        `${records.length}条`,
      );
    });
    return { imported: records.length };
  }

  private catalog(accountId: string) {
    const account = this.service.db.get<any>("google-accounts", accountId);
    if (!account || typeof account.email !== "string" || this.catalogForEmail(account.email).id !== accountId)
      throw new FleetError("ACCOUNT_NOT_FOUND", "目录账号不存在", 404);
    return account;
  }

  private savedPassword(account: any): string {
    try {
      const credentials = this.service.vault.get<GoogleAccountInput>(account.credentialsRef);
      if (typeof credentials?.email !== "string" || normalizeEmail(credentials.email) !== account.email || !accountPassword.safeParse(credentials.password).success)
        throw new Error("invalid credentials");
      return credentials.password;
    } catch {
      throw new FleetError("GOOGLE_PASSWORD_UNAVAILABLE", "已保存的账号密码不可用，请编辑账号重新设置", 409);
    }
  }

  create(input: unknown, principal: Principal) {
    const account = createAccountInput.parse(input);
    const key = `google_${hash(account.email).slice(0, 24)}`;
    if (this.service.db.get("google-accounts", key))
      throw new FleetError("DUPLICATE_ACCOUNT", "此邮箱已存在，请在账号行点击「编辑账号」", 409);
    const record = {
      id: key, email: account.email, recoveryEmail: account.recoveryEmail,
      credentialsRef: this.service.vault.put(account), createdAt: now(), updatedAt: now(),
    };
    this.service.db.transaction(() => {
      this.service.db.set("google-accounts", key, record);
      this.service.audit(principal.id, "google_account_create", undefined, "succeeded", key);
    });
    return this.list().find(entry => entry.id === key)!;
  }

  update(accountId: string, input: unknown, principal: Principal) {
    const changes = updateAccountInput.parse(input);
    const account = this.catalog(accountId);
    const credentials = {
      email: account.email,
      password: changes.password ?? this.savedPassword(account),
      recoveryEmail: changes.recoveryEmail ?? account.recoveryEmail ?? "",
    };
    const record = {
      ...account, recoveryEmail: credentials.recoveryEmail,
      credentialsRef: this.service.vault.put(credentials, account.credentialsRef), updatedAt: now(),
    };
    this.service.db.transaction(() => {
      this.service.db.set("google-accounts", accountId, record);
      this.service.audit(principal.id, "google_account_update", undefined, "succeeded", accountId);
    });
    return this.list().find(entry => entry.id === accountId)!;
  }

  revealPassword(accountId: string, principal: Principal) {
    try {
      const password = this.savedPassword(this.catalog(accountId));
      this.service.audit(principal.id, "google_account_password_reveal", undefined, "succeeded", accountId);
      return { password };
    } catch (error) {
      this.service.audit(principal.id, "google_account_password_reveal", undefined, "failed", accountId);
      throw error;
    }
  }

  list() {
    const bindings = this.service.db.list<any>("accounts");
    return this.service.db.list<any>("google-accounts").map((account) => ({
      id: account.id,
      email: account.email,
      recoveryEmail: account.recoveryEmail,
      updatedAt: account.updatedAt,
      bindings: bindings
        .filter(
          (a) =>
            typeof a.provider === "string" && a.provider.toLowerCase() === "google" &&
            typeof a.expectedIdentity === "string" && normalizeEmail(a.expectedIdentity) === normalizeEmail(account.email),
        )
        .flatMap((a) => {
          const profile = this.service.db.get<any>("profiles", a.profileId);
          return profile && !profile.purgedAt
            ? [{ profileId: profile.id, profileName: profile.name, ...(profile.archived ? { archived: true } : {}) }]
            : [];
        }),
    }));
  }

  async open(pid: string, principal: Principal, accountId?: string) {
    if (this.opening.has(pid) || this.closing.has(pid))
      throw new FleetError(
        "PROFILE_BUSY",
        "正在打开此实例的Google登录页面，请稍候",
        409,
      );
    const vncMode = this.service.browserMode(this.service.profile(pid, false)) === "vnc";
    if (vncMode) {
      this.metadataProfile(pid, principal);
      const binding = this.binding(pid);
      if (!binding) throw new FleetError("GOOGLE_BINDING_REQUIRED", "请先绑定一个已导入的Google目录账号", 409);
      if (accountId && accountId !== binding.accountId) throw new FleetError("ACCOUNT_MISMATCH", "此实例已绑定其他目录账号，请先显式换绑", 409);
    }
    let expected = accountId
      ? this.service.db.get<any>("google-accounts", accountId)
      : undefined;
    if (accountId && !expected)
      throw new FleetError("ACCOUNT_NOT_FOUND", "待绑定账号不存在", 404);
    if (expected) this.assertAvailable(expected.email, pid);
    this.opening.add(pid);
    try {
      const opened = await this.service.openDesktop(pid, principal, {
        explicitStart: true,
      });
      const prior = this.checks.get(opened.id);
      if (prior) await prior;
      const session = this.service.manualSession(pid, principal);
      const vnc = this.service.browserMode(this.service.profile(pid)) === "vnc";
      if (vnc) {
        const binding = this.binding(pid);
        if (!binding) throw new FleetError("GOOGLE_BINDING_REQUIRED", "请先绑定一个已导入的Google目录账号", 409);
        if (accountId && accountId !== binding.accountId) throw new FleetError("ACCOUNT_MISMATCH", "目录绑定已变化，请重新打开", 409);
        expected = this.service.db.get<any>("google-accounts", binding.accountId);
      }
      if (expected) this.assertAvailable(expected.email, pid);
      session.googleLogin = {
        status: "waiting",
        navigationStatus: vnc ? "opened" : "pending",
        browserMode: vnc ? "vnc" : "automation",
        expectedAccountId: expected?.id,
        expectedEmail: expected?.email,
        startedAt: now(),
        message: vnc ? "请在纯VNC桌面自行完成Google登录，再确认所选账号与此实例的人工绑定；系统不读取页面或验证登录结果" : "请在远程桌面手动登录Google，系统将识别已登录邮箱并自动绑定",
        ...(!vnc && expected ? { autofill: autofillState("waiting") } : {}),
      };
      if (vnc) session.googleLogin = this.vncState(pid);
      this.service.db.set("manual-sessions", session.id, session);
      this.assertOwned(session);
      if (vnc) {
        this.service.audit(principal.id, "google_login_open", pid);
        const { fencingToken, ...safe } = session;
        return { ...safe, desktopPath: `/profiles/${pid}/desktop` };
      }
      let navigationFailed = false;
      try {
        await this.service.agent(
          this.service.profile(pid),
          "/accounts/google-login",
          {},
          session.fencingToken,
          25000,
        );
      } catch {
        // The human still owns the same desktop and can complete navigation there.
        navigationFailed = true;
      }
      this.assertOwned(session);
      const current = this.service.db.get<any>("manual-sessions", session.id);
      current.googleLogin.navigationStatus = navigationFailed
        ? "pending"
        : "opened";
      if (navigationFailed) {
        current.googleLogin.message =
          "Google登录页面尚未加载完成，请检查网络或配置此实例的代理，再通过远程桌面继续或重试Google登录";
      }
      await this.advanceAutofill(session, current.googleLogin);
      this.assertOwned(session);
      this.service.db.set("manual-sessions", current.id, current);
      this.service.audit(principal.id, "google_login_open", pid);
      const { fencingToken, ...safe } = current;
      return { ...safe, desktopPath: `/profiles/${pid}/desktop` };
    } finally {
      this.opening.delete(pid);
    }
  }

  check(pid: string, principal: Principal) {
    if (this.service.browserMode(this.service.profile(pid, false)) === "vnc") {
      this.metadataProfile(pid);
      let state = this.vncState(pid);
      try {
        const own = this.service.manualSession(pid, principal);
        if (this.stillOwned(own)) {
          state = this.vncState(pid, own.googleLogin);
          own.googleLogin = state;
          this.service.db.set("manual-sessions", own.id, own);
        }
      } catch { /* Persistent metadata is readable without a current desktop. */ }
      return Promise.resolve(state);
    }
    const session = this.service.manualSession(pid, principal);
    if (!session.googleLogin)
      throw new FleetError(
        "GOOGLE_LOGIN_NOT_STARTED",
        "请先点击Google登录",
        409,
      );
    return this.checkSession(session);
  }

  async confirm(pid: string, principal: Principal, accountId: string) {
    const profile = this.metadataProfile(pid, principal, true);
    const binding = this.binding(pid);
    if (!binding) throw new FleetError("GOOGLE_BINDING_REQUIRED", "请先绑定一个已导入的Google目录账号", 409);
    if (binding.accountId !== accountId) throw new FleetError("ACCOUNT_MISMATCH", "确认账号必须与当前目录绑定一致", 409);
    const existing = this.service.db.list<any>("accounts").find(account => account.profileId === pid && account.provider?.toLowerCase() === "google")!;
    const state = () => ({
      ...this.vncState(pid), browserMode: this.service.browserMode(this.service.profile(pid)),
      takeoverJobId: this.service.db.get<any>("accounts", existing.id)?.automationTakeoverJobId,
      message: "已记录人工登录确认，正在切换到自动化接管；用户目录与账号绑定会保留",
    });
    const pending = existing.automationTakeoverJobId && this.service.db.get<any>("jobs", existing.automationTakeoverJobId);
    if (this.service.browserMode(profile) === "automation") {
      if (binding.confirmationState !== "confirmed")
        throw new FleetError("BROWSER_MODE_REQUIRED", "请在普通Chrome完成人工登录后确认接管", 409);
      if (!pending || ["queued", "running", "succeeded"].includes(pending.status) || profile.state === "running")
        return { ...state(), message: "此实例已启用自动化接管" };
    }
    if (pending && ["queued", "running"].includes(pending.status)) return state();
    if (this.opening.has(pid) || this.closing.has(pid) || this.service.db.list<any>("jobs").some(job => job.profileId === pid && ["queued", "running", "waiting_for_human"].includes(job.status)))
      throw new FleetError("PROFILE_BUSY", "实例正在处理其他操作，请稍后确认接管", 409);
    const at = now();
    const account = {
      ...existing,
      provider: "google", catalogId: accountId,
      authState: "manually_confirmed", bindingSource: "manual_confirmation", verificationSource: "manual_confirmation",
      boundAt: existing.boundAt || at, lastConfirmedAt: binding.lastConfirmedAt || at, confirmedBy: binding.confirmationState === "confirmed" ? existing.confirmedBy : principal.id,
      ...(existing?.bindingSource === "google_signed_in_identity" ? { previousVerification: { source: existing.bindingSource, authState: existing.authState, lastCheckedAt: existing.lastCheckedAt } } : {}),
      evidence: "用户主动确认目录账号与实例的映射；未自动读取页面或验证Google登录状态",
    };
    this.closing.add(pid);
    try {
      await this.service.revokeDesktop(pid);
      // Recheck authorization and the selected account after releasing desktop sockets.
      const current = this.metadataProfile(pid, principal, true);
      if (this.binding(pid)?.accountId !== accountId)
        throw new FleetError("ACCOUNT_MISMATCH", "目录绑定已变化，请核对后重新确认", 409);
      this.service.db.transaction(() => {
        const job = this.service.submit("browser_mode", pid, { browserMode: "automation", googleAccountId: accountId }, principal.id);
        this.service.db.set("accounts", account.id, { ...account, automationTakeoverJobId: job.id });
        current.lastActivityAt = at; this.service.saveProfile(current);
        this.service.audit(principal.id, "google_account_manual_confirmation", pid);
      });
      return state();
    } finally { this.closing.delete(pid); }
  }

  poll() {
    for (const session of this.service.db.list<any>("manual-sessions")) {
      if (
        session.closed ||
        this.service.browserMode(this.service.profile(session.profileId)) === "vnc" ||
        !session.googleLogin ||
        session.googleLogin.status === "bound" ||
        Date.parse(session.expiresAt) <= Date.now() ||
        this.opening.has(session.profileId) ||
        this.closing.has(session.profileId) ||
        Date.now() -
          Date.parse(session.googleLogin.lastCheckedAt || "1970-01-01") <
          5000
      )
        continue;
      void this.checkSession(session).catch(() => undefined);
    }
  }

  checkSession(session: any): Promise<any> {
    if (this.service.browserMode(this.service.profile(session.profileId)) === "vnc") {
      this.assertOwned(session);
      session.googleLogin = this.vncState(session.profileId, session.googleLogin);
      this.service.db.set("manual-sessions", session.id, session);
      return Promise.resolve(session.googleLogin);
    }
    if (this.opening.has(session.profileId) || this.closing.has(session.profileId))
      return Promise.resolve(session.googleLogin);
    const active = this.checks.get(session.id);
    if (active) return active;
    const operation = this.detect(session).finally(() =>
      this.checks.delete(session.id),
    );
    this.checks.set(session.id, operation);
    return operation;
  }

  async finishSession(session: any, detectIdentity = true) {
    // A closing request must not turn an in-flight identity check into a new fill.
    this.closing.add(session.profileId);
    try {
      await this.checks.get(session.id)?.catch(() => undefined);
      const current = this.service.db.get<any>("manual-sessions", session.id);
      if (detectIdentity && this.service.browserMode(this.service.profile(session.profileId)) === "automation" && current && !this.opening.has(session.profileId) && this.stillOwned(current))
        await this.detect(current, false).catch(() => undefined);
      await this.service.revokeDesktop(session.profileId);
    } finally {
      this.closing.delete(session.profileId);
    }
  }

  private stillOwned(session: any) {
    const current = this.service.db.get<any>("manual-sessions", session.id);
    const lease = this.service.db.lease(session.profileId);
    const credential = this.service.db.get<any>(
      "credentials",
      session.principal,
    );
    const profile = this.service.db.get<any>("profiles", session.profileId);
    const scopes = credential?.scopes || [];
    const profiles = credential?.profiles || [];
    const configured = session.googleLogin;
    const currentConfig = current?.googleLogin;
    return (
      current &&
      current.principal === session.principal &&
      current.profileId === session.profileId &&
      current.fencingToken === session.fencingToken &&
      (!configured || (
        configured.startedAt === currentConfig?.startedAt &&
        configured.expectedAccountId === currentConfig?.expectedAccountId &&
        configured.expectedEmail === currentConfig?.expectedEmail
      )) &&
      !current.closed &&
      Date.parse(current.expiresAt) > Date.now() &&
      lease?.owner === session.id &&
      lease.token === session.fencingToken &&
      lease.expires_at > Date.now() &&
      credential &&
      !credential.revoked &&
      (!credential.expiresAt || Date.parse(credential.expiresAt) > Date.now()) &&
      (scopes.includes("admin") || (
        !configured?.expectedAccountId &&
        scopes.includes("manage") && scopes.includes("automate")
      )) &&
      (profiles.includes("*") || profiles.includes(session.profileId)) &&
      profile?.state === "running" && !profile.archived && !profile.purgedAt
    );
  }

  private assertOwned(session: any) {
    if (!this.stillOwned(session))
      throw new FleetError("MANUAL_SESSION_EXPIRED", "人工操作租约或账号填充授权已失效", 403);
  }

  private async advanceAutofill(session: any, state: any) {
    if (this.closing.has(session.profileId)) return;
    if (!state.expectedAccountId || ["bound", "mismatch"].includes(state.status))
      return;
    if (state.autofill && !pendingAutofill.has(state.autofill.stage)) return;
    this.assertOwned(session);
    const catalog = this.service.db.get<any>("google-accounts", state.expectedAccountId);
    if (catalog) {
      try { this.assertAvailable(catalog.email, session.profileId); }
      catch (error) {
        if (!(error instanceof FleetError) || error.code !== "GOOGLE_ACCOUNT_ALREADY_BOUND") throw error;
        state.status = "mismatch";
        state.message = error.message;
        state.autofill = autofillState("account_mismatch");
        return;
      }
    }
    let credentials: any;
    try {
      credentials = catalog?.credentialsRef
        ? this.service.vault.get(catalog.credentialsRef)
        : undefined;
    } catch {
      // Vault failures never expose their input, reference or contents to the API.
    }
    const email = typeof credentials?.email === "string"
      ? normalizeEmail(credentials.email) : "";
    if (
      !catalog || catalog.id !== state.expectedAccountId ||
      !emailPattern.test(email) || email.length > 254 ||
      state.expectedAccountId !== `google_${hash(email).slice(0, 24)}` ||
      typeof catalog.email !== "string" || normalizeEmail(catalog.email) !== email ||
      typeof state.expectedEmail !== "string" || normalizeEmail(state.expectedEmail) !== email ||
      typeof credentials?.password !== "string" || !credentials.password ||
      credentials.password.length > 4096
    ) {
      state.autofill = autofillState("account_mismatch");
      return;
    }
    this.assertOwned(session);
    let stage: AutofillStage = "manual_required";
    try {
      // Browser autofill uses this fenced call; admin disclosure has its own audited endpoint.
      // Never put this body in a job, audit record, manual-session state or response.
      const result = await this.service.agent(
        this.service.profile(session.profileId),
        "/accounts/google-autofill",
        { email, password: credentials.password },
        session.fencingToken,
        10000,
      );
      if (typeof result?.stage === "string" &&
          Object.hasOwn(autofillMessages, result.stage))
        stage = result.stage as AutofillStage;
    } catch (error: any) {
      if (error?.status === 404 || error?.statusCode === 404)
        stage = "unsupported";
    }
    this.assertOwned(session);
    // Only allowlisted status and locally authored text cross the public boundary.
    state.autofill = autofillState(stage);
  }

  private async detect(session: any, autofill = true) {
    this.assertOwned(session);
    const state = { ...session.googleLogin, lastCheckedAt: now() };
    let evidence: any;
    try {
      evidence = await this.service.agent(
        this.service.profile(session.profileId),
        "/accounts/google-identity",
        {},
        session.fencingToken,
        5000,
      );
    } catch {
      evidence = { status: "unknown" };
    }
    this.assertOwned(session);
    const email =
      typeof evidence.identity === "string"
        ? normalizeEmail(evidence.identity)
        : "";
    if (
      evidence.status !== "authenticated" ||
      !emailPattern.test(email) ||
      email.length > 254
    ) {
      state.status =
        evidence.status === "needs_login" ||
        evidence.status === "needs_verification"
          ? "waiting"
          : "unknown";
      state.message =
        evidence.status === "needs_verification"
          ? "请在远程桌面完成人工验证，系统仍在等待确认身份"
          : "等待可确认的已登录邮箱；登录后可打开Google首页或“我的账号”页面";
      if (evidence.status === "unknown" && typeof evidence.reason === "string")
        state.message = evidence.reason.slice(0, 500);
      if (evidence.status === "unknown" && state.navigationStatus === "pending")
        state.message =
          "Google登录页面尚未加载完成，请检查网络或配置此实例的代理，再通过远程桌面继续或重试Google登录";
      if (["needs_login", "needs_verification"].includes(evidence.status))
        state.navigationStatus = "opened";
      delete state.detectedEmail;
    } else if (
      state.expectedEmail &&
      normalizeEmail(state.expectedEmail) !== email
    ) {
      state.status = "mismatch";
      state.navigationStatus = "opened";
      state.detectedEmail = email;
      state.message =
        "当前已登录邮箱与所选账号不一致，尚未绑定，请在远程桌面切换账号";
      if (state.expectedAccountId)
        state.autofill = autofillState("account_mismatch");
    } else {
      const catalog = this.service.db
        .list<any>("google-accounts")
        .find((a) => a.email === email);
      const existing = this.service.db
        .list<any>("accounts")
        .find(
          (a) =>
            a.profileId === session.profileId &&
            a.provider === "google" &&
            normalizeEmail(a.expectedIdentity) === email,
        );
      const account = {
        ...existing,
        id: existing?.id || id("account"),
        profileId: session.profileId,
        provider: "google",
        alias: existing?.alias || email,
        expectedIdentity: email,
        catalogId: catalog?.id,
        authState: "authenticated",
        lastCheckedAt: now(),
        boundAt: existing?.boundAt || now(),
        bindingSource: "google_signed_in_identity",
        evidence: "Google页面可见的已登录账号标记与邮箱匹配",
      };
      try {
        this.service.db.transaction(() => {
          this.assertAvailable(email, session.profileId);
          this.service.db.set("accounts", account.id, account);
          const profile = this.service.profile(session.profileId);
          profile.lastActivityAt = now();
          this.service.saveProfile(profile);
          if (!existing)
            this.service.audit(session.principal, "google_account_bound", session.profileId);
        });
        state.status = "bound";
        state.navigationStatus = "opened";
        state.detectedEmail = email;
        state.accountId = account.id;
        state.message = "已识别Google登录邮箱，并记录与此Chrome实例的绑定关系";
      } catch (error) {
        if (!(error instanceof FleetError) || error.code !== "GOOGLE_ACCOUNT_ALREADY_BOUND") throw error;
        state.status = "mismatch";
        state.detectedEmail = email;
        state.message = error.message;
        delete state.accountId;
        state.autofill = autofillState("account_mismatch");
      }
    }
    if (autofill) await this.advanceAutofill(session, state);
    this.assertOwned(session);
    const current = this.service.db.get<any>("manual-sessions", session.id);
    current.googleLogin = state;
    this.service.db.set("manual-sessions", session.id, current);
    return state;
  }
}
