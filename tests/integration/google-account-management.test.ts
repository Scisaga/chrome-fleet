import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers/fleet.js";

const catalog = "/api/v1/google-accounts";
const input = {
  email: "managed@example.test",
  password: " synthetic-managed-password \t",
  recoveryEmail: "recovery@example.test",
};

test("directory accounts can be created and edited without changing bindings or browser state", async () => {
  const f = await fixture();
  try {
    const created = await f.request("POST", catalog, { ...input, email: "  MANAGED@example.test  " });
    assert.equal(created.statusCode, 201, created.body);
    const account = created.json().data;
    assert.equal(account.email, input.email);
    assert.match(account.id, /^google_[0-9a-f]{24}$/);
    assert.equal(created.body.includes(input.password), false);
    assert.equal(created.body.includes("credentialsRef"), false);
    assert.equal(f.service.db.list("profiles").length, 0);
    assert.equal(f.service.db.list("jobs").length, 0);

    const profile = (await f.request("POST", "/api/v1/profiles", { name: "目录编辑夹具" })).json().data;
    await f.request("PUT", `/api/v1/profiles/${profile.id}/google-binding`, { accountId: account.id });
    const before = JSON.stringify(f.service.db.list("accounts"));
    const profileBefore = JSON.stringify(f.service.profile(profile.id));
    const storedBefore = f.service.db.get<any>("google-accounts", account.id);
    const recoveryOnly = await f.request("PATCH", `${catalog}/${account.id}`, { recoveryEmail: "OTHER@example.test" });
    assert.equal(recoveryOnly.statusCode, 200, recoveryOnly.body);
    assert.equal(recoveryOnly.json().data.recoveryEmail, "other@example.test");
    assert.equal(f.service.vault.get(storedBefore.credentialsRef).password, input.password);

    const password = "replacement-secret-with-空格 ";
    const updated = await f.request("PATCH", `${catalog}/${account.id}`, { password, recoveryEmail: "" });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().data.id, account.id);
    assert.equal(updated.json().data.bindings[0].profileId, profile.id);
    assert.equal(updated.body.includes(password), false);
    assert.equal(JSON.stringify(f.service.db.list("accounts")), before);
    assert.equal(JSON.stringify(f.service.profile(profile.id)), profileBefore);
    const stored = f.service.db.get<any>("google-accounts", account.id);
    assert.equal(stored.createdAt, storedBefore.createdAt);
    assert.deepEqual(f.service.vault.get(stored.credentialsRef), { email: input.email, password, recoveryEmail: "" });
    const encrypted = await readFile(join(f.root, "vault", stored.credentialsRef));
    assert.equal(encrypted.includes(Buffer.from(password)), false);
    const records = JSON.stringify(f.service.db.db.prepare("SELECT value FROM records").all());
    for (const secret of [input.password, password]) assert.equal(records.includes(secret), false);
    const listed = await f.request("GET", catalog);
    assert.equal(listed.body.includes("password"), false);
    assert.equal(listed.body.includes("credentialsRef"), false);
    assert.equal(f.starts.size, 0);
    assert.equal(f.service.db.list("jobs").length, 0);
  } finally { await f.close(); }
});

test("password disclosure is explicit, audited and never replays an old idempotent response", async () => {
  const f = await fixture();
  try {
    const file = join(f.root, "imported.tsv");
    await writeFile(file, `${input.email}\timported-password\t${input.recoveryEmail}\n`);
    f.service.google.importFile(file);
    const account = f.service.google.list()[0];
    const path = `${catalog}/${account.id}/password/reveal`;
    const extra = { "idempotency-key": "same-disclosure-key" };
    const first = await f.request("POST", path, {}, undefined, extra);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().data.password, "imported-password");
    assert.equal(first.headers["cache-control"], "no-store");
    await f.request("PATCH", `${catalog}/${account.id}`, { password: input.password });
    const second = await f.request("POST", path, {}, undefined, extra);
    assert.equal(second.json().data.password, input.password);
    assert.equal(f.service.db.db.prepare("SELECT * FROM idempotency").all().length, 0);
    const audits = f.service.db.list<any>("audit").filter(entry => entry.action === "google_account_password_reveal");
    assert.equal(audits.length, 2);
    assert.ok(audits.every(entry => entry.result === "succeeded" && entry.reason === account.id));
    assert.equal(JSON.stringify(audits).includes(input.password), false);
    assert.equal(JSON.stringify(audits).includes("imported-password"), false);
    const imported = f.service.db.get<any>("google-accounts", account.id);
    f.service.vault.put({ email: "wrong@example.test", password: "must-not-return" }, imported.credentialsRef);
    const broken = await f.request("POST", path, {});
    assert.equal(broken.statusCode, 409);
    assert.equal(broken.json().code, "GOOGLE_PASSWORD_UNAVAILABLE");
    assert.equal(broken.body.includes("must-not-return"), false);
    assert.equal(f.service.db.list<any>("audit").filter(entry => entry.action === "google_account_password_reveal" && entry.result === "failed").length, 1);
    assert.equal((await f.request("PATCH", `${catalog}/${account.id}`, { password: "repaired-password" })).statusCode, 200);
    assert.equal((await f.request("POST", path, {})).json().data.password, "repaired-password");
  } finally { await f.close(); }
});

test("account validation and duplicate creation never overwrite existing credentials", async () => {
  const f = await fixture();
  try {
    const key = { "idempotency-key": "create-once" };
    const created = await f.request("POST", catalog, input, undefined, key);
    const account = created.json().data;
    const repeated = await f.request("POST", catalog, input, undefined, key);
    assert.deepEqual(repeated.json().data, account);
    const duplicate = await f.request("POST", catalog, { ...input, email: input.email.toUpperCase(), password: "do-not-overwrite" });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().code, "DUPLICATE_ACCOUNT");
    assert.equal(f.service.vault.get(f.service.db.get<any>("google-accounts", account.id).credentialsRef).password, input.password);
    for (const body of [
      {}, { ...input, email: "invalid" }, { ...input, password: "" },
      { ...input, password: "x".repeat(4097) }, { ...input, recoveryEmail: "invalid" },
      { ...input, credentialsRef: "secret_injected" },
    ]) assert.equal((await f.request("POST", catalog, body)).statusCode, 400);
    for (const body of [{}, { password: "" }, { email: "renamed@example.test" }, { password: "x".repeat(4097) }, { recoveryEmail: "invalid" }])
      assert.equal((await f.request("PATCH", `${catalog}/${account.id}`, body)).statusCode, 400);
    assert.equal(f.service.google.list().length, 1);
    const minimal = await f.request("POST", catalog, { email: "minimal@example.test", password: "minimal-password" });
    assert.equal(minimal.statusCode, 201);
    assert.equal(minimal.json().data.recoveryEmail, "");
    assert.equal((await f.request("PATCH", `${catalog}/google_${"0".repeat(24)}`, { password: "missing-password" })).statusCode, 404);
    assert.equal((await f.request("POST", `${catalog}/google_${"0".repeat(24)}/password/reveal`, {})).statusCode, 404);
  } finally { await f.close(); }
});

test("account writes and disclosure require an active admin credential and session CSRF", async () => {
  const f = await fixture();
  try {
    const account = (await f.request("POST", catalog, input)).json().data;
    const reader = f.auth.issue(["read", "manage", "automate"], ["*"], new Date(Date.now() + 60000).toISOString());
    const actions: [string, string, object][] = [
      ["POST", catalog, { ...input, email: "unauthorized@example.test" }],
      ["PATCH", `${catalog}/${account.id}`, { password: "unauthorized-password" }],
      ["POST", `${catalog}/${account.id}/password/reveal`, {}],
    ];
    for (const [method, path, body] of actions) {
      assert.equal((await f.request(method, path, body, "")).statusCode, 401);
      assert.equal((await f.request(method, path, body, reader.token)).statusCode, 403);
    }
    const admin = f.auth.issue(["admin"], ["*"], new Date(Date.now() + 60000).toISOString());
    const path = actions[2][1];
    assert.equal((await f.request("POST", path, {}, admin.token)).statusCode, 200);
    f.service.db.set("credentials", admin.id, { ...f.service.db.get<any>("credentials", admin.id), revoked: true });
    assert.equal((await f.request("POST", path, {}, admin.token)).statusCode, 401);

    const { sid, csrfToken } = f.auth.login("fixture-platform-token-at-least-32-chars");
    const cookie = { cookie: `fleet_session=${sid}` };
    for (const [method, path, body] of actions)
      assert.equal((await f.request(method, path, body, "", cookie)).statusCode, 403);
    const allowed = await f.request("POST", path, {}, "", { ...cookie, "x-csrf-token": csrfToken });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.json().data.password, input.password);
  } finally { await f.close(); }
});
