import { id, now } from "@chrome-fleet/core";
import {
  FleetError, PlatformInputSchema, PlatformPatchSchema, PlatformLinkSchema, PlatformConfirmationSchema,
  type Platform, type PlatformAccount,
} from "@chrome-fleet/contracts";
import type { FleetService } from "./service.js";
import type { Principal } from "./auth.js";
import { accountView, confirmationRecord } from "./account-confirmation.js";

export class Platforms {
  constructor(private service: FleetService) {
    if (!service.db.get("platforms", "google")) {
      service.db.set<Platform>("platforms", "google", {
        id: "google", name: "Google", builtin: true, enabled: true,
        homeUrl: "https://www.google.com/", loginUrl: "https://accounts.google.com/ServiceLogin",
        accountUrl: "https://myaccount.google.com/", createdAt: now(), updatedAt: now(),
      });
    }
  }

  private view(platform: Platform): Platform {
    return { ...PlatformInputSchema.parse({ name: platform.name, homeUrl: platform.homeUrl, loginUrl: platform.loginUrl,
      accountUrl: platform.accountUrl, enabled: platform.enabled }), id: platform.id, builtin: platform.builtin,
      createdAt: platform.createdAt, updatedAt: platform.updatedAt };
  }
  list() { return this.service.db.list<Platform>("platforms").map(platform => this.view(platform)); }
  get(platformId: string) {
    const platform = this.service.db.get<Platform>("platforms", platformId);
    if (!platform) throw new FleetError("PLATFORM_NOT_FOUND", "平台不存在", 404);
    return this.view(platform);
  }
  create(input: unknown) {
    const platform: Platform = { ...PlatformInputSchema.parse(input), id: id("platform"), createdAt: now(), updatedAt: now() };
    return this.service.db.set("platforms", platform.id, platform);
  }
  update(platformId: string, input: unknown) {
    const platform = this.get(platformId);
    if (platform.builtin) throw new FleetError("BUILTIN_PLATFORM", "Google 使用内置平台配置", 409);
    const changes = PlatformPatchSchema.parse(input);
    const updated = { ...platform, ...changes, updatedAt: now() };
    return this.service.db.set("platforms", platformId, updated);
  }
  delete(platformId: string) {
    if (this.get(platformId).builtin) throw new FleetError("BUILTIN_PLATFORM", "Google 内置平台不能删除", 409);
    if (this.service.db.list<any>("accounts").some(row => row.platformId === platformId && !this.service.db.get<any>("profiles", row.profileId)?.purgedAt))
      throw new FleetError("PLATFORM_IN_USE", "平台仍有关联账号，请停用或先解除关联", 409);
    this.service.db.delete("platforms", platformId);
    return { deleted: true };
  }
  assertGoogleBinding(profileId: string, googleAccountId?: string) {
    if (this.service.db.list<any>("accounts").some(row => row.profileId === profileId && row.platformId && row.googleAccountId !== googleAccountId))
      throw new FleetError("PLATFORM_LINKS_EXIST", "请先解除关联平台，再更换 Google 主账号", 409);
  }
  accountViews(profileId?: string, googleAccountId?: string): PlatformAccount[] {
    return this.service.db.list<any>("accounts")
      .filter(row => row.platformId && (!profileId || row.profileId === profileId) && (!googleAccountId || row.googleAccountId === googleAccountId))
      .filter(row => {
        const profile = this.service.db.get<any>("profiles", row.profileId);
        return profile && !profile.purgedAt;
      })
      .map(row => {
        const platform = this.service.db.get<Platform>("platforms", row.platformId);
        const view = accountView(row);
        return {
          id: row.id, profileId: row.profileId, platformId: row.platformId,
          platformName: platform?.name || row.provider, googleAccountId: row.googleAccountId,
          loginMethod: "google", expectedIdentity: row.expectedIdentity || "", nickname: row.nickname,
          authState: view.authState, confirmationState: view.confirmationState, linkState: row.expectedIdentity ? "linked" : "pending",
          firstLinkedAt: row.firstLinkedAt, lastConfirmedAt: row.lastConfirmedAt, confirmedBy: row.confirmedBy,
          historicalVerification: view.historicalVerification,
          accountUrl: platform?.accountUrl || "", loginUrl: platform?.loginUrl || "", enabled: platform?.enabled === true,
        };
      });
  }
  link(profileId: string, platformId: string, input: unknown, principal: Principal) {
    const platform = this.get(platformId);
    const profile = this.service.profile(profileId, false);
    if (platform.builtin) throw new FleetError("BUILTIN_PLATFORM", "请通过现有 Google 目录绑定管理主账号", 409);
    if (!platform.enabled) throw new FleetError("PLATFORM_DISABLED", "请先启用此平台", 409);
    const data = PlatformLinkSchema.parse(input);
    if (this.service.google.binding(profileId)?.accountId !== data.googleAccountId)
      throw new FleetError("ACCOUNT_MISMATCH", "请选择此实例绑定的 Google 目录账号", 409);
    return this.service.db.transaction(() => {
      const existing = this.service.db.list<any>("accounts").find(row => row.platformId === platformId && row.googleAccountId === data.googleAccountId && !this.service.db.get<any>("profiles", row.profileId)?.purgedAt);
      if (existing) {
        if (existing.profileId !== profileId) throw new FleetError("PLATFORM_ACCOUNT_ALREADY_BOUND", "此 Google 账号的平台关联属于其他实例", 409);
        return this.accountViews(profileId).find(row => row.id === existing.id)!;
      }
      const account = {
        id: id("account"), profileId, platformId, provider: platformId, googleAccountId: data.googleAccountId,
        loginMethod: "google", expectedIdentity: "", alias: platform.name, authState: "unknown",
        boundAt: now(), signupConfirmedAt: now(), signupConfirmedBy: principal.id,
        bindingSource: "google_signup_confirmation",
      };
      this.service.db.set("accounts", account.id, account);
      return this.accountViews(profileId).find(row => row.id === account.id)!;
    });
  }
  unlink(profileId: string, platformId: string) {
    this.service.profile(profileId, false);
    this.assertIdle(profileId);
    for (const account of this.service.db.list<any>("accounts").filter(row => row.profileId === profileId && row.platformId === platformId))
      this.service.db.delete("accounts", account.id);
    return { deleted: true };
  }
  assertIdle(profileId: string) {
    const lease = this.service.db.lease(profileId);
    if (lease?.owner && lease.expires_at > Date.now())
      throw new FleetError("PROFILE_BUSY", "实例正在被任务或人工操作占用，请先结束接管", 409);
    if (this.service.db.list<any>("jobs").some(job => job.profileId === profileId && ["queued", "running", "waiting_for_human"].includes(job.status)))
      throw new FleetError("PROFILE_BUSY", "实例有待处理任务，请完成后重试", 409);
  }
  async openLogin(profileId: string, platformId: string, principal: Principal) {
    const platform = this.get(platformId);
    this.service.profile(profileId, false);
    if (!platform.enabled) throw new FleetError("PLATFORM_DISABLED", "此平台已停用", 409);
    if (!this.service.google.binding(profileId))
      throw new FleetError("GOOGLE_BINDING_REQUIRED", "请先绑定 Google 目录账号，再打开平台登录入口", 409);
    const opened = await this.service.openDesktop(profileId, principal, { explicitStart: true });
    const { fencingToken: _token, ...safe } = opened;
    return { ...safe, loginUrl: platform.loginUrl,
      message: "请在此实例的桌面中自行打开登录入口，完成登录后回到实例详情人工确认" };
  }
  confirm(profileId: string, platformId: string, input: unknown, principal: Principal) {
    this.service.profile(profileId, false);
    const platform = this.get(platformId);
    if (platform.builtin) throw new FleetError("BUILTIN_PLATFORM", "请使用 Google 人工确认入口", 409);
    if (!platform.enabled) throw new FleetError("PLATFORM_DISABLED", "此平台已停用", 409);
    const data = PlatformConfirmationSchema.parse(input);
    if (this.service.db.list<any>("jobs").some(job => job.profileId === profileId && ["queued", "running"].includes(job.status)))
      throw new FleetError("PROFILE_BUSY", "实例正在处理任务，请稍后确认", 409);
    return this.service.db.transaction(() => {
      const account = this.service.db.list<any>("accounts").find(row => row.profileId === profileId && row.platformId === platformId);
      if (!account) throw new FleetError("ACCOUNT_NOT_FOUND", "请先登记此平台关联", 404);
      if (this.service.google.binding(profileId)?.accountId !== account.googleAccountId)
        throw new FleetError("ACCOUNT_MISMATCH", "Google 绑定已变化，请核对此平台关联", 409);
      if (account.expectedIdentity && account.expectedIdentity !== data.identity)
        throw new FleetError("ACCOUNT_MISMATCH", "账号 ID 与原关联不一致；更换账号请先解除原关联", 409);
      if (this.service.db.list<any>("accounts").some(row => row.id !== account.id && row.platformId === platformId && row.expectedIdentity === data.identity && !this.service.db.get<any>("profiles", row.profileId)?.purgedAt))
        throw new FleetError("PLATFORM_ACCOUNT_ALREADY_BOUND", "此平台账号 ID 已属于其他关联", 409);
      const at = now();
      this.service.db.set("accounts", account.id, {
        ...confirmationRecord(account, principal.id, at), expectedIdentity: data.identity,
        nickname: data.nickname ?? account.nickname, firstLinkedAt: account.firstLinkedAt || at,
      });
      this.service.audit(principal.id, "platform_account_manual_confirmation", profileId, "succeeded", platformId);
      return this.accountViews(profileId).find(row => row.id === account.id)!;
    });
  }
}
