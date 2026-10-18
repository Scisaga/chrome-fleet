import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseGoogleAccounts } from "../../apps/control-plane/src/google-accounts.js";
import { fixture, eventually } from "./helpers/fleet.js";

const synthetic =
  "fixture-google@example.test\tfixture-sensitive-password\tfixture-recovery@example.test\n";
async function importCatalog(f: Awaited<ReturnType<typeof fixture>>) {
  const file = join(f.root, "accounts.txt");
  await writeFile(file, synthetic, { mode: 0o600 });
  return f.service.google.importFile(file);
}

test("Google account import encrypts passwords, redacts catalog output and validates every row before writing", async () => {
  const f = await fixture();
  try {
    assert.equal(
      parseGoogleAccounts(synthetic)[0].password,
      "fixture-sensitive-password",
    );
    assert.throws(
      () => parseGoogleAccounts(synthetic + "invalid-secret-row"),
      (error: any) =>
        error.code === "INVALID_ACCOUNT_FILE" &&
        !error.message.includes("invalid-secret-row"),
    );
    assert.throws(
      () => parseGoogleAccounts(synthetic + synthetic),
      (error: any) => error.code === "DUPLICATE_ACCOUNT",
    );
    const invalid = join(f.root, "invalid.txt");
    await writeFile(invalid, synthetic + "invalid-secret-row");
    assert.throws(() => f.service.google.importFile(invalid));
    assert.equal(f.service.google.list().length, 0);
    assert.deepEqual(await importCatalog(f), { imported: 1 });
    const stored = f.service.db.list<any>("google-accounts")[0];
    const encrypted = await readFile(
      join(f.root, "vault", stored.credentialsRef),
    );
    assert.equal(
      encrypted.includes(Buffer.from("fixture-sensitive-password")),
      false,
    );
    assert.equal(
      f.service.vault.get(stored.credentialsRef).password,
      "fixture-sensitive-password",
    );
    const dbContents = JSON.stringify(
      f.service.db.db.prepare("SELECT value FROM records").all(),
    );
    assert.equal(dbContents.includes("fixture-sensitive-password"), false);
    const catalog = await f.request("GET", "/api/v1/google-accounts");
    assert.equal(catalog.statusCode, 200);
    assert.equal(catalog.json().data.items.length, 1);
    assert.equal(catalog.body.includes("password"), false);
    assert.equal(catalog.body.includes("credentialsRef"), false);
    const before = stored.id;
    await importCatalog(f);
    assert.equal(f.service.google.list().length, 1);
    assert.equal(f.service.google.list()[0].id, before);
    const reader = f.auth.issue(
      ["read"],
      ["*"],
      new Date(Date.now() + 60000).toISOString(),
    );
    assert.equal(
      (
        await f.request(
          "GET",
          "/api/v1/google-accounts",
          undefined,
          reader.token,
        )
      ).statusCode,
      403,
    );
  } finally {
    await f.close();
  }
});

test("Google login uses the profile human lease and binds only a confirmed matching identity", async () => {
  const f = await fixture();
  try {
    await importCatalog(f);
    const target = f.service.google.list()[0];
    const p = await f.create();
    let identity: any = { status: "needs_login" };
    const calls: { path: string; body: any; token: number | undefined }[] = [];
    const original = f.service.agent.bind(f.service);
    f.service.agent = async (profile, path, body, token, timeout) => {
      if (
        path === "/accounts/google-login" ||
        path === "/accounts/google-identity" ||
        path === "/accounts/google-autofill"
      ) {
        calls.push({ path, body, token });
        assert.equal(f.service.db.lease(profile.id).token, token);
        return path.endsWith("google-login") ? { opened: true }
          : path.endsWith("google-autofill") ? { stage: "password_filled" } : identity;
      }
      return original(profile, path, body, token, timeout);
    };
    const opened = await f.request(
      "POST",
      `/api/v1/profiles/${p.id}/google-login`,
      { accountId: target.id },
    );
    assert.equal(opened.statusCode, 201, opened.body);
    const session = opened.json().data;
    assert.equal(session.googleLogin.status, "waiting");
    assert.equal(session.googleLogin.expectedEmail, target.email);
    assert.equal(session.fencingToken, undefined);
    assert.equal(f.service.profile(p.id).state, "running");
    assert.equal(f.service.db.list("accounts").length, 0);
    assert.equal(
      JSON.stringify(calls.filter(call => call.path !== "/accounts/google-autofill")).includes("fixture-sensitive-password"),
      false,
    );
    const again = await f.request(
      "POST",
      `/api/v1/profiles/${p.id}/google-login`,
      { accountId: target.id },
    );
    assert.equal(again.json().data.id, session.id, "重新打开复用同一人工租约");
    assert.equal(f.starts.get(p.id), 1);
    const queued = f.service.submit(
      "automation",
      p.id,
      { steps: [{ action: "pages" }], timeoutMs: 1000 },
      "bootstrap",
    );
    await f.service.tick();
    assert.equal(f.service.job(queued.id).status, "queued");
    const waiting = await f.request(
      "POST",
      `/api/v1/profiles/${p.id}/google-login/check`,
      {},
    );
    assert.equal(waiting.json().data.status, "waiting");
    identity = { status: "authenticated", identity: "another@example.test" };
    const mismatch = await f.request(
      "POST",
      `/api/v1/profiles/${p.id}/google-login/check`,
      {},
    );
    assert.equal(mismatch.json().data.status, "mismatch");
    assert.equal(f.service.db.list("accounts").length, 0);
    identity = {
      status: "authenticated",
      identity: target.email.toUpperCase(),
    };
    const current = f.service.db.get<any>("manual-sessions", session.id);
    current.googleLogin.lastCheckedAt = "1970-01-01T00:00:00.000Z";
    f.service.db.set("manual-sessions", current.id, current);
    f.service.google.poll();
    await eventually(
      () => f.service.db.list("accounts").length === 1,
      "自动识别未写入绑定",
    );
    const account = f.service.db.list<any>("accounts")[0];
    assert.equal(account.expectedIdentity, target.email);
    assert.equal(account.profileId, p.id);
    assert.equal(account.authState, "authenticated");
    assert.equal(account.catalogId, target.id);
    assert.equal(f.service.google.list()[0].bindings[0].profileId, p.id);
    assert.equal(
      f.service.publicProfile(f.service.profile(p.id)).accounts[0].id,
      account.id,
    );
    assert.equal(
      (
        await f.request(
          "POST",
          `/api/v1/profiles/${p.id}/google-login/check`,
          {},
        )
      ).json().data.status,
      "bound",
    );
    assert.equal(f.service.db.list("accounts").length, 1);
    assert.equal(
      f.service.db.get<any>("manual-sessions", session.id).closed,
      false,
    );
    await f.request("DELETE", `/api/v1/manual-sessions/${session.id}`);
    await f.service.tick();
    await eventually(
      () => f.service.active.size === 0,
      "人工接管结束后队列未恢复",
    );
    assert.equal(f.service.job(queued.id).status, "succeeded");
  } finally {
    await f.close();
  }
});

test("Google binding rejects password bodies, limited scopes and checks outside the owning live manual session", async () => {
  const f = await fixture();
  try {
    const p = await f.create();
    assert.equal(
      (
        await f.request("POST", `/api/v1/profiles/${p.id}/google-login`, {
          password: "never-accept-this",
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.request(
          "POST",
          `/api/v1/profiles/${p.id}/google-login/check`,
          {},
        )
      ).statusCode,
      403,
    );
    const automate = f.auth.issue(
      ["automate"],
      [p.id],
      new Date(Date.now() + 60000).toISOString(),
    );
    assert.equal(
      (
        await f.request(
          "POST",
          `/api/v1/profiles/${p.id}/google-login`,
          {},
          automate.token,
        )
      ).statusCode,
      403,
    );
    const original = f.service.agent.bind(f.service);
    let release: (() => void) | undefined;
    let entered = false;
    f.service.agent = async (profile, path, body, token, timeout) => {
      if (path === "/accounts/google-login") return { opened: true };
      if (path === "/accounts/google-identity") {
        entered = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          status: "authenticated",
          identity: "fixture-google@example.test",
        };
      }
      return original(profile, path, body, token, timeout);
    };
    await f.request("POST", `/api/v1/profiles/${p.id}/google-login`, {});
    const principal = f.auth.token("fixture-platform-token-at-least-32-chars");
    const pending = f.service.google.check(p.id, principal);
    const rejected = assert.rejects(
      pending,
      (error: any) => error.code === "MANUAL_SESSION_EXPIRED",
    );
    await eventually(() => entered, "身份检测未开始");
    await f.service.revokeDesktop(p.id);
    release!();
    await rejected;
    assert.equal(f.service.db.list("accounts").length, 0);
    assert.equal(
      (
        await f.request(
          "POST",
          `/api/v1/profiles/${p.id}/google-login/check`,
          {},
        )
      ).statusCode,
      403,
    );
  } finally {
    await f.close();
  }
});

test("Google navigation failure preserves the human desktop without marking an account authenticated", async () => {
  const f = await fixture();
  try {
    const p = await f.create();
    const original = f.service.agent.bind(f.service);
    f.service.agent = async (profile, path, body, token, timeout) => {
      if (path === "/accounts/google-login")
        throw new Error("synthetic navigation failure");
      return original(profile, path, body, token, timeout);
    };
    const opened = await f.request(
      "POST",
      `/api/v1/profiles/${p.id}/google-login`,
      {},
    );
    assert.equal(opened.statusCode, 201);
    assert.ok(opened.json().data.desktopPath.includes(p.id));
    assert.match(opened.json().data.googleLogin.message, /远程桌面/);
    assert.equal(opened.json().data.googleLogin.navigationStatus, "pending");
    assert.equal(f.service.db.list("accounts").length, 0);
    assert.equal(f.service.db.lease(p.id).owner, opened.json().data.id);
  } finally {
    await f.close();
  }
});

test("closing a desktop while Google navigation is in flight never reopens the revoked human session", async () => {
  const f = await fixture();
  try {
    const p = await f.create();
    const original = f.service.agent.bind(f.service);
    let release: (() => void) | undefined;
    let entered = false;
    f.service.agent = async (profile, path, body, token, timeout) => {
      if (path === "/accounts/google-login") {
        entered = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        throw new Error("synthetic navigation interrupted");
      }
      return original(profile, path, body, token, timeout);
    };
    const request = f
      .request("POST", `/api/v1/profiles/${p.id}/google-login`, {})
      .then((response) => response);
    await eventually(() => entered, "Google导航未开始");
    const session = f.service.db.list<any>("manual-sessions")[0];
    await f.service.revokeDesktop(p.id);
    release!();
    const response = await request;
    assert.equal(response.statusCode, 403);
    assert.equal(
      f.service.db.get<any>("manual-sessions", session.id).closed,
      true,
    );
    assert.equal(f.service.db.lease(p.id).owner, null);
    assert.equal(f.service.db.list("accounts").length, 0);
  } finally {
    await f.close();
  }
});
