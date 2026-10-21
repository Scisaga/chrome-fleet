import { readFileSync, statSync } from "node:fs";
import { hash, id, now } from "@chrome-fleet/core";
import { FleetError, type GoogleBinding } from "@chrome-fleet/contracts";
import { z } from "zod";
import type { Principal } from "./auth.js";
import type { FleetService } from "./service.js";
import { confirmationRecord } from "./account-confirmation.js";

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
  private opening = new Set<string>();
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
    const confirmed = (row.verificationSource === "manual_confirmation" || row.bindingSource === "manual_confirmation") &&
      typeof row.lastConfirmedAt === "string" && Number.isFinite(Date.parse(row.lastConfirmedAt));
    return {
      accountId: catalog.id, email: normalizeEmail(catalog.email),
      confirmationState: confirmed ? "confirmed" : "unconfirmed",
      ...(confirmed ? { lastConfirmedAt: row.lastConfirmedAt } : {}),
    };
  }

  private metadataProfile(pid: string, principal?: Principal) {
    const profile = this.service.profile(pid, false);
    if (profile.purgedAt) throw new FleetError("PROFILE_PURGED", "实例已彻底清理", 410);
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
    if (!unchanged) {
      this.service.platforms.assertGoogleBinding(pid, accountId);
      if (this.service.db.list<any>("jobs").some(job => job.profileId === pid && ["queued", "running", "waiting_for_human"].includes(job.status)))
        throw new FleetError("PROFILE_BUSY", "实例有待处理任务，请完成后再更换账号", 409);
    }
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
            own.googleLogin = this.loginState(pid, own.googleLogin);
            this.service.db.set("manual-sessions", own.id, own);
          }
        } catch { /* Binding metadata neither needs nor takes over a desktop. */ }
      }
      this.service.audit(principal?.id || "system", "google_binding_set", pid);
    });
    return this.binding(pid)!;
  }

  loginState(pid: string, previous?: any) {
    const binding = this.binding(pid);
    const confirmed = binding?.confirmationState === "confirmed";
    const row = this.service.db.list<any>("accounts").find(account => account.profileId === pid && account.provider === "google");
    return {
      status: confirmed ? "bound" : "waiting", navigationStatus: "opened", browserMode: this.service.browserMode(this.service.profile(pid)),
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
    return this.list(principal).find(entry => entry.id === key)!;
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
    return this.list(principal).find(entry => entry.id === accountId)!;
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

  list(principal?: Principal) {
    const bindings = this.service.db.list<any>("accounts");
    return this.service.db.list<any>("google-accounts").map((account) => ({
      id: account.id,
      email: account.email,
      recoveryEmail: account.recoveryEmail,
      updatedAt: account.updatedAt,
      platformAccounts: this.service.platforms.accountViews(undefined, account.id).filter(row => !principal || principal.profiles.includes("*") || principal.profiles.includes(row.profileId)),
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
    this.metadataProfile(pid, principal);
    if (accountId) {
      const selected = this.catalog(accountId);
      this.assertAvailable(selected.email, pid);
    }
    const binding = this.binding(pid);
    if (!binding) throw new FleetError("GOOGLE_BINDING_REQUIRED", "请先绑定一个已导入的 Google 目录账号", 409);
    if (accountId && accountId !== binding.accountId) throw new FleetError("ACCOUNT_MISMATCH", "此实例已绑定其他目录账号，请先显式换绑", 409);
    if (this.opening.has(pid)) throw new FleetError("PROFILE_BUSY", "正在打开此实例的登录桌面，请稍候", 409);
    this.opening.add(pid);
    try {
      const opened = await this.service.openDesktop(pid, principal, { explicitStart: true });
      if (this.binding(pid)?.accountId !== binding.accountId)
        throw new FleetError("ACCOUNT_MISMATCH", "目录绑定已变化，请重新打开", 409);
      const session = this.service.manualSession(pid, principal);
      session.googleLogin = this.loginState(pid);
      this.service.db.set("manual-sessions", session.id, session);
      this.service.audit(principal.id, "google_login_open", pid);
      const { fencingToken: _token, ...safe } = opened;
      return { ...safe, googleLogin: session.googleLogin, loginUrl: "https://accounts.google.com/ServiceLogin" };
    } finally { this.opening.delete(pid); }
  }

  async confirm(pid: string, principal: Principal, accountId: string) {
    const profile = this.metadataProfile(pid, principal);
    const binding = this.binding(pid);
    if (!binding) throw new FleetError("GOOGLE_BINDING_REQUIRED", "请先绑定一个已导入的 Google 目录账号", 409);
    if (binding.accountId !== accountId) throw new FleetError("ACCOUNT_MISMATCH", "确认账号必须与当前目录绑定一致", 409);
    if (this.opening.has(pid) || this.service.db.list<any>("jobs").some(job => job.profileId === pid && ["queued", "running"].includes(job.status)))
      throw new FleetError("PROFILE_BUSY", "实例正在处理其他操作，请稍后确认登录", 409);
    const existing = this.service.db.list<any>("accounts").find(account => account.profileId === pid && account.provider?.toLowerCase() === "google")!;
    const at = now();
    this.service.db.transaction(() => {
      this.service.db.set("accounts", existing.id, {
        ...confirmationRecord(existing, principal.id, at), provider: "google", catalogId: accountId,
        bindingSource: "manual_confirmation", boundAt: existing.boundAt || at,
      });
      this.service.audit(principal.id, "google_account_manual_confirmation", pid);
    });
    return { ...this.loginState(pid), browserMode: this.service.browserMode(profile), message: "已记录人工登录确认，浏览器模式和桌面会话保持不变" };
  }

  async finishSession(session: any) {
    await this.service.revokeDesktop(session.profileId);
  }

  private stillOwned(session: any) {
    const current = this.service.db.get<any>("manual-sessions", session.id);
    const lease = this.service.db.lease(session.profileId);
    return current && !current.closed && current.principal === session.principal &&
      lease?.owner === session.id && lease.token === session.fencingToken && lease.expires_at > Date.now();
  }
}
