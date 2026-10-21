import test from "node:test";
import assert from "node:assert/strict";
import { fixture, eventually } from "./helpers/fleet.js";

const configuration = { name: "合成关联平台", homeUrl: "https://platform.example.test/", loginUrl: "https://platform.example.test/login", accountUrl: "https://platform.example.test/settings" };
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function setup(f: Fixture, browserMode = "vnc", email = "platform-owner@example.test", platformId?: string) {
  const google = (await f.request("POST", "/api/v1/google-accounts", { email, password: "synthetic-password" })).json().data;
  const profile = (await f.request("POST", "/api/v1/profiles", { name: "关联平台夹具", browserMode, accountAlias: email })).json().data;
  const platform = platformId ? f.service.platforms.get(platformId) : (await f.request("POST", "/api/v1/platforms", configuration)).json().data;
  const path = `/api/v1/profiles/${profile.id}/platforms/${platform.id}`;
  const registered = await f.request("POST", path, { googleAccountId: google.id, confirmedGoogleSignup: true });
  assert.equal(registered.statusCode, 201, registered.body);
  return { google, profile, platform, path, link: registered.json().data };
}
const confirmation = (identity = "platform-123", nickname = "合成昵称") => ({ identity, nickname, confirmedLoggedIn: true });

test("platform configuration retains manual addresses, protects Google and rejects removed detection rules", async () => {
  const f = await fixture();
  try {
    const builtIn = (await f.request("GET", "/api/v1/platforms")).json().data.items[0];
    assert.equal(builtIn.accountUrl, "https://myaccount.google.com/");
    const spec = (await f.request("GET", "/api/v1/openapi.json")).json();
    assert.equal(spec.paths["/api/v1/profiles/{id}/accounts/check"], undefined);
    assert.equal(spec.paths["/api/v1/profiles/{id}/google-login/check"], undefined);
    assert.ok(spec.paths["/api/v1/profiles/{profileId}/platforms/{platformId}/confirm"]);
    for (const method of ["PATCH", "DELETE"]) assert.equal((await f.request(method, "/api/v1/platforms/google", method === "PATCH" ? { name: "改名" } : undefined)).statusCode, 409);
    const reader = f.auth.issue(["read"], ["*"]);
    assert.equal((await f.request("POST", "/api/v1/platforms", configuration, reader.token)).statusCode, 403);
    for (const change of [{ accountUrl: "https://user:password@example.test/" }, { identityLocator: { css: "#identity" } }])
      assert.equal((await f.request("POST", "/api/v1/platforms", { ...configuration, ...change })).statusCode, 400);
    const { path, platform } = await setup(f);
    assert.equal((await f.request("DELETE", `/api/v1/platforms/${platform.id}`)).statusCode, 409);
    assert.equal((await f.request("PATCH", `/api/v1/platforms/${platform.id}`, { enabled: false })).json().data.enabled, false);
    await f.request("DELETE", path);
    assert.equal((await f.request("DELETE", `/api/v1/platforms/${platform.id}`)).statusCode, 200);
  } finally { await f.close(); }
});

for (const mode of ["vnc", "automation"]) test(`${mode} manual confirmation saves identity, nickname, actor and time without browser or credentials`, async () => {
  const f = await fixture();
  try {
    const { path, profile, google, link } = await setup(f, mode);
    assert.equal(link.confirmationState, "unconfirmed");
    assert.equal(link.lastConfirmedAt, undefined);
    const beforeProfile = f.service.profile(profile.id);
    f.service.agent = async () => { throw new Error("confirmation must not call browser"); };
    f.service.ensureStart = async () => { throw new Error("confirmation must not wake Chrome"); };
    f.service.vault.get = () => { throw new Error("confirmation must not decrypt credentials"); };
    const saved = await f.request("POST", `${path}/confirm`, confirmation());
    assert.equal(saved.statusCode, 200, saved.body);
    const view = saved.json().data;
    assert.equal(view.expectedIdentity, "platform-123"); assert.equal(view.nickname, "合成昵称");
    assert.equal(view.authState, "manually_confirmed"); assert.equal(view.confirmationState, "confirmed");
    assert.equal(view.confirmedBy, "bootstrap"); assert.ok(view.lastConfirmedAt); assert.ok(view.firstLinkedAt);
    assert.deepEqual(f.service.profile(profile.id), beforeProfile);
    assert.equal(f.starts.size, 0); assert.equal(f.service.db.list("jobs").length, 0);
    const listed = (await f.request("GET", `/api/v1/profiles/${profile.id}`)).json().data;
    const directory = (await f.request("GET", "/api/v1/google-accounts")).json().data.items.find((a: any) => a.id === google.id);
    assert.deepEqual(listed.platformAccounts, directory.platformAccounts);
    assert.equal(listed.accountCheck, undefined);
    const record = f.service.db.get<any>("accounts", link.id);
    assert.equal(record.lastCheckedAt, undefined); assert.equal(record.lastSuccessAt, undefined);
    assert.equal(f.service.db.list<any>("audit").filter(row => row.action === "platform_account_manual_confirmation").length, 1);
    const repeated = await f.request("POST", `${path}/confirm`, confirmation("platform-123", "新昵称"));
    assert.equal(repeated.json().data.nickname, "新昵称");
    assert.equal(repeated.json().data.firstLinkedAt, view.firstLinkedAt);
  } finally { await f.close(); }
});

test("manual confirmation requires explicit declaration, preserves the bound ID and rejects duplicate identities", async () => {
  const f = await fixture();
  try {
    const { path, platform, profile, google, link } = await setup(f);
    for (const body of [{ identity: "uid" }, { ...confirmation(), confirmedLoggedIn: false }, confirmation("  ")])
      assert.equal((await f.request("POST", `${path}/confirm`, body)).statusCode, 400);
    assert.equal((await f.request("POST", `${path}/confirm`, confirmation())).statusCode, 200);
    const original = f.service.db.get<any>("accounts", link.id);
    assert.equal((await f.request("POST", `${path}/confirm`, confirmation("other-id"))).json().code, "ACCOUNT_MISMATCH");
    assert.deepEqual(f.service.db.get("accounts", link.id), original);
    const repeated = await f.request("POST", path, { googleAccountId: google.id, confirmedGoogleSignup: true });
    assert.equal(repeated.json().data.id, link.id);
    const other = await setup(f, "vnc", "other-owner@example.test", platform.id);
    assert.equal((await f.request("POST", `${other.path}/confirm`, confirmation())).json().code, "PLATFORM_ACCOUNT_ALREADY_BOUND");
    assert.equal((await f.request("PUT", `/api/v1/profiles/${profile.id}/google-binding`, { accountId: other.google.id })).json().code, "PLATFORM_LINKS_EXIST");
    assert.equal((await f.request("DELETE", path)).statusCode, 200);
    assert.equal((await f.request("POST", `${path}/confirm`, confirmation())).statusCode, 404);
    assert.equal((await f.request("POST", `${other.path}/confirm`, confirmation())).statusCode, 200);
  } finally { await f.close(); }
});

test("confirmation is available during human takeover, while unlink remains exclusive and no page is opened", async () => {
  const f = await fixture();
  try {
    const { path, profile } = await setup(f);
    const agentPaths: string[] = [], original = f.service.agent.bind(f.service);
    f.service.agent = async (p, path, body, token, timeout) => { agentPaths.push(path); return original(p, path, body, token, timeout); };
    const opened = await f.request("POST", `${path}/login`, {});
    assert.equal(opened.statusCode, 200, opened.body);
    const session = opened.json().data;
    assert.equal(session.loginUrl, configuration.loginUrl); assert.equal(session.fencingToken, undefined);
    assert.equal(agentPaths.some(path => path.startsWith("/accounts/")), false);
    agentPaths.length = 0;
    assert.equal((await f.request("POST", `${path}/confirm`, confirmation())).statusCode, 200);
    assert.deepEqual(agentPaths, []);
    assert.equal(f.service.db.lease(profile.id).owner, session.id);
    assert.equal(f.service.db.get<any>("manual-sessions", session.id).closed, false);
    assert.equal((await f.request("DELETE", path)).statusCode, 409);
    await f.request("DELETE", `/api/v1/manual-sessions/${session.id}`);
    assert.equal((await f.request("DELETE", path)).statusCode, 200);
    assert.equal(agentPaths.some(path => path.startsWith("/accounts/")), false);
  } finally { await f.close(); }
});

test("legacy automated observations remain historical and never imply manual confirmation", async () => {
  const f = await fixture();
  try {
    const { path, profile, link, platform } = await setup(f);
    const row = f.service.db.get<any>("accounts", link.id);
    f.service.db.set("accounts", link.id, { ...row, expectedIdentity: "platform-123", authState: "authenticated", lastVerificationSource: "account_page", lastCheckedAt: "2026-10-01T00:00:00Z", lastSuccessAt: "2026-10-01T00:00:00Z", evidence: "old-page" });
    f.service.db.set("platforms", platform.id, { ...platform, identityLocator: { css: "#obsolete" } });
    const before = JSON.stringify(f.service.db.get("accounts", link.id));
    const view = f.service.platforms.accountViews(profile.id)[0];
    assert.equal(view.confirmationState, "unconfirmed"); assert.equal(view.authState, "bound_unconfirmed");
    assert.equal(view.historicalVerification?.authState, "authenticated");
    assert.equal((f.service.platforms.list()[1] as any).identityLocator, undefined);
    assert.equal(JSON.stringify(f.service.db.get("accounts", link.id)), before);
    const confirmed = (await f.request("POST", `${path}/confirm`, confirmation())).json().data;
    assert.equal(confirmed.historicalVerification.authState, "authenticated");
    assert.equal(confirmed.historicalVerification.lastCheckedAt, "2026-10-01T00:00:00Z");
    assert.equal(confirmed.authState, "manually_confirmed");
  } finally { await f.close(); }
});

test("retired check APIs and queued legacy checks cannot wake instances or alter login records", async () => {
  const f = await fixture();
  try {
    const { profile } = await setup(f, "automation");
    const before = f.service.db.list("accounts");
    for (const suffix of ["accounts/check", "google-login/check"]) {
      const response = await f.request("POST", `/api/v1/profiles/${profile.id}/${suffix}`, { explicitStart: true });
      assert.equal(response.statusCode, 410); assert.equal(response.json().code, "ACCOUNT_CHECK_REMOVED");
    }
    assert.throws(() => f.service.submit("accounts_check", profile.id, {}, "bootstrap"), (e: any) => e.code === "ACCOUNT_CHECK_REMOVED");
    const job: any = { id: "job_legacy_check", profileId: profile.id, kind: "accounts_check", principal: "bootstrap", status: "queued", payload: {}, createdAt: new Date().toISOString() };
    f.service.saveJob(job);
    await f.service.tick();
    await eventually(() => f.service.job(job.id).status === "failed", "retired check finishes");
    assert.equal(f.service.job(job.id).error.code, "ACCOUNT_CHECK_REMOVED");
    assert.equal(f.starts.size, 0); assert.deepEqual(f.service.db.list("accounts"), before);
  } finally { await f.close(); }
});

test("manual confirmation enforces profile authorization, enabled platforms, and read-only credentials", async () => {
  const f = await fixture();
  try {
    const { path, platform, profile } = await setup(f);
    for (const scopes of [["read"], ["manage"], ["automate"]]) {
      const limited = f.auth.issue(scopes, [profile.id]);
      assert.equal((await f.request("POST", `${path}/confirm`, confirmation(), limited.token)).statusCode, 403);
    }
    const outsider = f.auth.issue(["admin"], ["cf_00000000-0000-4000-8000-000000000000"]);
    assert.equal((await f.request("POST", `${path}/confirm`, confirmation(), outsider.token)).statusCode, 403);
    await f.request("PATCH", `/api/v1/platforms/${platform.id}`, { enabled: false });
    assert.equal((await f.request("POST", `${path}/confirm`, confirmation())).json().code, "PLATFORM_DISABLED");
    await f.request("PATCH", `/api/v1/platforms/${platform.id}`, { enabled: true });
    const archived = f.service.profile(profile.id); archived.archived = true; f.service.saveProfile(archived);
    assert.equal((await f.request("POST", `${path}/confirm`, confirmation())).json().code, "PROFILE_ARCHIVED");
  } finally { await f.close(); }
});

for (const target of ["google", "platform"]) test(`task expected ${target} account uses manual confirmation without visiting account pages`, async () => {
  const f = await fixture();
  try {
    const { profile, path, link, google } = await setup(f, "automation");
    const expected = target === "google" ? f.service.db.list<any>("accounts").find(row => row.profileId === profile.id && row.provider === "google") : link;
    f.service.db.set("accounts", expected.id, { ...f.service.db.get<any>("accounts", expected.id), authState: "authenticated", lastCheckedAt: "2026-01-01T00:00:00Z" });
    const paths: string[] = [], original = f.service.agent.bind(f.service);
    f.service.agent = async (p, path, body, token, timeout) => { paths.push(path); return original(p, path, body, token, timeout); };
    const accepted = await f.request("POST", "/api/v1/jobs", { profileId: profile.id, expectedAccountId: expected.id, steps: [{ action: "pages" }] });
    assert.equal(accepted.statusCode, 202, accepted.body);
    const jid = accepted.json().data.jobId;
    await f.service.tick(); await eventually(() => f.service.job(jid).status === "waiting_for_human", "waits for a person");
    await eventually(() => f.service.active.size === 0, "waiting task released");
    assert.equal(f.starts.size, 0, "old authenticated status must not start browser");
    const confirm = target === "google" ? await f.request("POST", `/api/v1/profiles/${profile.id}/google-login/confirm`, { accountId: google.id }) : await f.request("POST", `${path}/confirm`, confirmation());
    assert.equal(confirm.statusCode, 200, confirm.body);
    assert.equal((await f.request("POST", `/api/v1/jobs/${jid}/resume`, {})).statusCode, 200);
    await f.service.tick(); await eventually(() => f.service.job(jid).status === "succeeded", "confirmed task finishes");
    assert.equal(paths.some(path => path.startsWith("/accounts/")), false);
  } finally { await f.close(); }
});
