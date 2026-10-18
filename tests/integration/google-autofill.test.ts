import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FleetError } from "@chrome-fleet/contracts";
import { fixture, fixtureToken, eventually } from "./helpers/fleet.js";

const secret = "synthetic-google-password-never-public";
const email = "autofill-fixture@example.test";
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function setup(f: Fixture) {
  const path = join(f.root, "autofill.tsv");
  await writeFile(path, `${email}\t${secret}\trecovery@example.test\n`, { mode: 0o600 });
  f.service.google.importFile(path);
  return { profile: await f.create(), account: f.service.google.list()[0] };
}
function stub(f: Fixture, fn: (path: string, body: any) => any) {
  const original = f.service.agent.bind(f.service);
  f.service.agent = async (p, path, body, token, timeout) => {
    if (path.startsWith("/accounts/google-")) {
      assert.equal(f.service.db.lease(p.id).token, token);
      return fn(path, body);
    }
    return original(p, path, body, token, timeout);
  };
}
const loginPath = (pid: string) => `/api/v1/profiles/${pid}/google-login`;
const checkPath = (pid: string) => `${loginPath(pid)}/check`;
const expires = () => new Date(Date.now() + 60_000).toISOString();

test("selected Google credentials travel only through fenced autofill, polling waits at filled email until the person advances", async () => {
  const f = await fixture();
  try {
    const { profile, account } = await setup(f);
    let personAdvancedToPassword = false;
    const paths: string[] = [];
    let identity = "needs_verification";
    stub(f, (path, body) => {
      paths.push(path);
      if (path.endsWith("google-login")) { assert.deepEqual(body, {}); return { opened: true }; }
      if (path.endsWith("google-identity")) { assert.deepEqual(body, {}); return { status: identity, ...(identity === "authenticated" ? { identity: email } : {}) }; }
      assert.equal(path, "/accounts/google-autofill");
      assert.deepEqual(body, { email, password: secret });
      return { stage: personAdvancedToPassword ? "password_filled" : "email_filled", message: secret, password: secret, nested: { secret } };
    });
    const opened = await f.request("POST", loginPath(profile.id), { accountId: account.id }, fixtureToken, { "idempotency-key": "autofill-open" });
    assert.equal(opened.statusCode, 201);
    assert.equal(opened.json().data.googleLogin.autofill.stage, "email_filled");
    assert.match(opened.json().data.googleLogin.autofill.message, /邮箱已填好，请点击下一步/);
    assert.deepEqual(paths, ["/accounts/google-login", "/accounts/google-autofill"]);
    f.service.google.poll();
    await eventually(() => paths.filter(path => path.endsWith("google-autofill")).length === 2 &&
      Boolean(f.service.db.get<any>("manual-sessions", opened.json().data.id).googleLogin.lastCheckedAt), "email_filled应继续轮询");
    const waiting = f.service.db.get<any>("manual-sessions", opened.json().data.id).googleLogin;
    assert.equal(waiting.autofill.stage, "email_filled", "未人工进入密码页时应停留邮箱已填写");
    assert.equal(f.service.db.list("accounts").length, 0);
    personAdvancedToPassword = true;
    const filled = await f.request("POST", checkPath(profile.id), {});
    assert.equal(filled.json().data.autofill.stage, "password_filled");
    assert.match(filled.json().data.autofill.message, /本人.*点击下一步/);
    for (let i = 0; i < 2; i++) await f.request("POST", checkPath(profile.id), {});
    assert.equal(paths.filter(path => path.endsWith("google-autofill")).length, 3);
    assert.equal(f.service.db.list("accounts").length, 0, "填好密码不等同已登录或绑定");
    identity = "authenticated";
    assert.equal((await f.request("POST", checkPath(profile.id), {})).json().data.status, "bound");
    assert.equal(f.service.db.list("accounts").length, 1, "终态之后仍检测人工完成的身份");
    for (const response of [opened, filled, await f.request("GET", "/api/v1/google-accounts"), await f.request("GET", `/api/v1/profiles/${profile.id}`)]) {
      assert.equal(response.body.includes(secret), false);
      assert.equal(response.body.includes("credentialsRef"), false);
    }
    const records = JSON.stringify(f.service.db.db.prepare("SELECT value FROM records").all());
    const cached = JSON.stringify(f.service.db.db.prepare("SELECT * FROM idempotency").all());
    assert.equal(records.includes(secret), false);
    assert.equal(cached.includes(secret), false);
    assert.equal(JSON.stringify(f.service.db.list("audit")).includes(secret), false);
  } finally { await f.close(); }
});

test("legacy email_submitted sessions remain pollable and describe a person submitting the email", async () => {
  const f = await fixture();
  try {
    const { profile, account } = await setup(f);
    let fills = 0;
    stub(f, path => {
      if (path.endsWith("google-login")) return { opened: true };
      if (path.endsWith("google-identity")) return { status: "needs_login" };
      fills++;
      return { stage: fills === 1 ? "email_submitted" : "password_filled" };
    });
    const opened = await f.request("POST", loginPath(profile.id), { accountId: account.id });
    assert.equal(opened.json().data.googleLogin.autofill.stage, "email_submitted");
    assert.match(opened.json().data.googleLogin.autofill.message, /检测到你提交邮箱/);
    assert.doesNotMatch(opened.json().data.googleLogin.autofill.message, /系统.*点击|自动提交邮箱/);
    const checked = await f.request("POST", checkPath(profile.id), {});
    assert.equal(checked.json().data.autofill.stage, "password_filled");
    assert.equal(fills, 2);
  } finally { await f.close(); }
});

test("autofill requires an explicitly selected account, admin/profile authorization and valid Web CSRF", async () => {
  const f = await fixture();
  try {
    const { profile, account } = await setup(f);
    let fills = 0;
    stub(f, (path) => {
      if (path.endsWith("google-login")) return { opened: true };
      if (path.endsWith("google-identity")) return { status: "needs_login" };
      fills++; return { stage: "password_filled" };
    });
    const manager = f.auth.issue(["manage", "automate"], [profile.id], expires());
    assert.equal((await f.request("POST", loginPath(profile.id), { accountId: account.id }, manager.token)).statusCode, 403);
    const foreign = f.auth.issue(["admin"], ["cf_00000000-0000-4000-8000-000000000000"], expires());
    assert.equal((await f.request("POST", loginPath(profile.id), { accountId: account.id }, foreign.token)).statusCode, 403);
    const unsigned = await f.request("POST", loginPath(profile.id), {}, manager.token);
    assert.equal(unsigned.statusCode, 201);
    assert.equal(unsigned.json().data.googleLogin.autofill, undefined);
    await f.request("POST", checkPath(profile.id), {}, manager.token);
    assert.equal(fills, 0, "不能从catalog或绑定猜测账号并发送密码");
    await f.request("DELETE", `/api/v1/manual-sessions/${unsigned.json().data.id}`, undefined, manager.token);
    const logged = await f.request("POST", "/api/v1/session", { token: fixtureToken }, "");
    const cookie = logged.cookies.find(value => value.name === "fleet_session")!;
    const headers = { cookie: `fleet_session=${cookie.value}`, origin: "http://127.0.0.1:8080" };
    assert.equal((await f.request("POST", loginPath(profile.id), { accountId: account.id }, "", headers)).statusCode, 403);
    assert.equal((await f.request("POST", loginPath(profile.id), { accountId: account.id }, "", { ...headers, "x-csrf-token": "wrong" })).statusCode, 403);
    assert.equal(fills, 0);
    const accepted = await f.request("POST", loginPath(profile.id), { accountId: account.id }, "", { ...headers, "x-csrf-token": logged.json().data.csrfToken });
    assert.equal(accepted.statusCode, 201);
    assert.equal(fills, 1);
    assert.equal((await f.request("POST", loginPath(profile.id), { accountId: account.id, password: secret })).statusCode, 400);
  } finally { await f.close(); }
});

test("catalog/Vault email mismatch stops filling, and agent output or old-agent errors cannot leak secrets", async () => {
  const f = await fixture();
  try {
    const { profile, account } = await setup(f);
    let fills = 0;
    stub(f, path => {
      if (path.endsWith("google-login")) return { opened: true };
      if (path.endsWith("google-identity")) return { status: "needs_login" };
      fills++; throw new FleetError("NOT_FOUND", secret, 404, { secret });
    });
    const stored = f.service.db.get<any>("google-accounts", account.id);
    f.service.vault.put({ email: "other@example.test", password: secret }, stored.credentialsRef);
    const mismatched = await f.request("POST", loginPath(profile.id), { accountId: account.id });
    assert.equal(mismatched.json().data.googleLogin.autofill.stage, "account_mismatch");
    assert.equal(fills, 0);
    f.service.vault.put({ email, password: secret }, stored.credentialsRef);
    const unsupported = await f.request("POST", loginPath(profile.id), { accountId: account.id });
    assert.equal(unsupported.statusCode, 201);
    assert.equal(unsupported.json().data.googleLogin.autofill.stage, "unsupported");
    assert.equal(unsupported.body.includes(secret), false);
    await f.request("POST", checkPath(profile.id), {});
    assert.equal(fills, 1, "旧agent不支持后不重复发送凭据");
  } finally { await f.close(); }
});

test("revoking selected-account authorization during identity detection blocks subsequent password dispatch", async () => {
  const f = await fixture();
  try {
    const { profile, account } = await setup(f);
    const admin = f.auth.issue(["admin"], [profile.id], expires());
    let fills = 0, entered = false;
    let release!: () => void;
    stub(f, async path => {
      if (path.endsWith("google-login")) return { opened: true };
      if (path.endsWith("google-autofill")) { fills++; return { stage: "email_filled" }; }
      entered = true; await new Promise<void>(resolve => { release = resolve; });
      return { status: "needs_verification" };
    });
    await f.request("POST", loginPath(profile.id), { accountId: account.id }, admin.token);
    const pending = f.request("POST", checkPath(profile.id), {}, admin.token);
    await eventually(() => entered, "身份检测未开始");
    const credential = f.service.db.get<any>("credentials", admin.id);
    credential.revoked = true;
    f.service.db.set("credentials", admin.id, credential);
    release();
    assert.equal((await pending).statusCode, 403);
    assert.equal(fills, 1);
    assert.equal(f.service.db.list("accounts").length, 0);
  } finally { await f.close(); }
});

test("changing the selected account or current scopes during navigation cannot dispatch Vault credentials", async () => {
  for (const change of ["account", "scope", "profile"] as const) {
    const f = await fixture();
    try {
      const { profile, account } = await setup(f);
      const admin = f.auth.issue(["admin"], [profile.id], expires());
      let entered = false, fills = 0;
      let release!: () => void;
      stub(f, async path => {
        if (path.endsWith("google-login")) {
          entered = true; await new Promise<void>(resolve => { release = resolve; }); return { opened: true };
        }
        fills++; return { stage: "password_filled" };
      });
      const pending = f.request("POST", loginPath(profile.id), { accountId: account.id }, admin.token);
      await eventually(() => entered, "Google导航未开始");
      if (change === "account") {
        const session = f.service.db.list<any>("manual-sessions")[0];
        session.googleLogin.expectedAccountId = "google_" + "0".repeat(24);
        f.service.db.set("manual-sessions", session.id, session);
      } else {
        const current = f.service.db.get<any>("credentials", admin.id);
        if (change === "scope") current.scopes = ["manage", "automate"];
        else current.profiles = [];
        f.service.db.set("credentials", admin.id, current);
      }
      release();
      assert.equal((await pending).statusCode, 403);
      assert.equal(fills, 0);
    } finally { await f.close(); }
  }
});

test("ending a Google manual session performs identity-only finalization and suppresses in-flight checks from starting a new fill", async () => {
  const f = await fixture();
  try {
    const { profile, account } = await setup(f);
    let fills = 0, identityCalls = 0, entered = false;
    let release!: () => void;
    stub(f, async path => {
      if (path.endsWith("google-login")) return { opened: true };
      if (path.endsWith("google-autofill")) { fills++; return { stage: "email_filled" }; }
      identityCalls++;
      if (identityCalls === 1) {
        entered = true; await new Promise<void>(resolve => { release = resolve; });
      }
      return { status: "needs_verification" };
    });
    const opened = await f.request("POST", loginPath(profile.id), { accountId: account.id });
    const sid = opened.json().data.id;
    const checking = f.request("POST", checkPath(profile.id), {});
    await eventually(() => entered, "身份检测未开始");
    const closing = f.request("DELETE", `/api/v1/manual-sessions/${sid}`);
    // Inject enters the closing handler before releasing the deliberately held identity call.
    await new Promise(resolve => setImmediate(resolve));
    release();
    assert.equal((await checking).statusCode, 200);
    assert.equal((await closing).statusCode, 200);
    assert.equal(fills, 1, "结束会话不能触发新的填写");
    assert.equal(identityCalls, 2);
    assert.equal(f.service.db.get<any>("manual-sessions", sid).closed, true);
    assert.equal(f.service.db.lease(profile.id).owner, null);
  } finally { await f.close(); }
});

test("an administrator ending another principal's Google session waits for its check and never triggers a fill or identity finalization", async () => {
  const f = await fixture();
  try {
    const { profile, account } = await setup(f);
    const owner = f.auth.issue(["admin"], [profile.id], expires());
    let fills = 0, identityCalls = 0, entered = false;
    let release!: () => void;
    stub(f, async path => {
      if (path.endsWith("google-login")) return { opened: true };
      if (path.endsWith("google-autofill")) { fills++; return { stage: "email_filled" }; }
      identityCalls++; entered = true;
      await new Promise<void>(resolve => { release = resolve; });
      return { status: "needs_login" };
    });
    const opened = await f.request("POST", loginPath(profile.id), { accountId: account.id }, owner.token);
    const sid = opened.json().data.id;
    const checking = f.request("POST", checkPath(profile.id), {}, owner.token);
    await eventually(() => entered, "身份检测未开始");
    let closed = false;
    const closing = f.request("DELETE", `/api/v1/manual-sessions/${sid}`).then(response => { closed = true; return response; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false, "管理员关闭应等待既有操作完成");
    release();
    assert.equal((await checking).statusCode, 200);
    assert.equal((await closing).statusCode, 200);
    assert.equal(fills, 1);
    assert.equal(identityCalls, 1, "跨主体关闭不代替用户收尾识别身份");
    assert.equal(f.service.db.get<any>("manual-sessions", sid).closed, true);
    assert.equal(f.service.db.lease(profile.id).owner, null);
  } finally { await f.close(); }
});
