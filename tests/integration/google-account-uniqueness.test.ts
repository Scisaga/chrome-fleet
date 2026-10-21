import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers/fleet.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const profiles = "/api/v1/profiles";
const binding = (pid: string) => `${profiles}/${pid}/google-binding`;
async function account(f: Fixture, email = "single@example.test") {
  const response = await f.request("POST", "/api/v1/google-accounts", { email, password: "synthetic-account-password" });
  assert.equal(response.statusCode, 201);
  return response.json().data;
}
function conflict(response: Awaited<ReturnType<Fixture["request"]>>) {
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, "GOOGLE_ACCOUNT_ALREADY_BOUND");
}

test("duplicate account creates in both browser modes fail before allocating files, secrets or start jobs", async () => {
  const f = await fixture();
  try {
    const selected = await account(f);
    const created = await f.request("POST", profiles, { name: "原实例", accountAlias: selected.email });
    assert.equal(created.statusCode, 201);
    const before = {
      profiles: f.service.db.list("profiles"), accounts: f.service.db.list("accounts"), jobs: f.service.db.list("jobs"),
      vault: await readdir(join(f.root, "vault")), directories: await readdir(join(f.root, "profiles")),
    };
    for (const browserMode of ["vnc", "automation"]) {
      conflict(await f.request("POST", profiles, { name: "禁止重复", browserMode, accountAlias: `  ${selected.email.toUpperCase()}  `, start: true }));
    }
    assert.deepEqual({
      profiles: f.service.db.list("profiles"), accounts: f.service.db.list("accounts"), jobs: f.service.db.list("jobs"),
      vault: await readdir(join(f.root, "vault")), directories: await readdir(join(f.root, "profiles")),
    }, before);
    assert.equal(f.starts.size, 0);
  } finally { await f.close(); }
});

test("binding endpoints reject another instance without replacing its confirmed account or cancelling takeover", async () => {
  const f = await fixture();
  try {
    const first = await account(f); const second = await account(f, "other@example.test");
    const owner = (await f.request("POST", profiles, { name: "已占用", accountAlias: first.email })).json().data;
    const target = (await f.request("POST", profiles, { name: "保留现有账号", accountAlias: second.email })).json().data;
    assert.equal((await f.request("POST", `${profiles}/${target.id}/google-login/confirm`, { accountId: second.id })).statusCode, 200);
    const before = { accounts: f.service.db.list("accounts"), jobs: f.service.db.list("jobs") };
    conflict(await f.request("PUT", binding(target.id), { accountId: first.id }));
    conflict(await f.request("POST", `${profiles}/${target.id}/accounts`, { provider: "GOOGLE", expectedIdentity: first.email.toUpperCase() }));
    const automation = await f.create();
    conflict(await f.request("POST", `${profiles}/${automation.id}/accounts`, { provider: "GOOGLE", expectedIdentity: ` ${first.email.toUpperCase()} ` }));
    assert.deepEqual({ accounts: f.service.db.list("accounts"), jobs: f.service.db.list("jobs") }, before);
    const repeat = await f.request("PUT", binding(owner.id), { accountId: first.id });
    assert.equal(repeat.statusCode, 200);
    assert.equal(f.service.google.list().find(entry => entry.id === first.id)!.bindings.length, 1);
  } finally { await f.close(); }
});

test("concurrent account creates have one winner and leave no orphan profile", async () => {
  const f = await fixture();
  try {
    const selected = await account(f);
    const responses = await Promise.all(["vnc", "automation"].map(browserMode => f.request("POST", profiles, {
      name: `竞争实例 ${browserMode}`, browserMode, accountAlias: selected.email,
      proxy: { enabled: true, host: "proxy.example.test", port: 8080 },
    })));
    assert.deepEqual(responses.map(response => response.statusCode).sort(), [201, 409]);
    conflict(responses.find(response => response.statusCode === 409)!);
    assert.equal(f.service.db.list("profiles").length, 1);
    assert.equal(f.service.db.list("accounts").length, 1);
    assert.equal((await readdir(join(f.root, "profiles"))).length, 1);
    assert.equal((await readdir(join(f.root, "vault"))).length, 4, "only catalog and winner secrets are allocated");
  } finally { await f.close(); }
});

test("archived instances retain the account reservation until permanent cleanup", async () => {
  const f = await fixture();
  try {
    const selected = await account(f);
    const created = (await f.request("POST", profiles, { name: "待归档", accountAlias: selected.email })).json().data;
    const archived = f.service.profile(created.id); archived.archived = true; f.service.saveProfile(archived);
    const listed = (await f.request("GET", "/api/v1/google-accounts")).json().data.items[0];
    assert.deepEqual(listed.bindings, [{ profileId: created.id, profileName: created.name, archived: true }]);
    conflict(await f.request("POST", profiles, { name: "归档仍占用", accountAlias: selected.email }));
    assert.equal((await f.request("POST", `${profiles}/${created.id}/purge`, { confirmation: created.id })).statusCode, 200);
    assert.equal(f.service.google.list()[0].bindings.length, 0);
    const replacement = await f.request("POST", profiles, { name: "清理后重建", accountAlias: selected.email });
    assert.equal(replacement.statusCode, 201);
    assert.equal(f.service.google.list()[0].bindings[0].profileId, replacement.json().data.id);
  } finally { await f.close(); }
});

test("selected Google login cannot start another browser or decrypt an occupied account", async () => {
  const f = await fixture();
  try {
    const selected = await account(f);
    await f.request("POST", profiles, { name: "账号所属实例", accountAlias: selected.email });
    const target = await f.create();
    f.service.vault.get = () => { throw new Error("must not read account credentials"); };
    conflict(await f.request("POST", `${profiles}/${target.id}/google-login`, { accountId: selected.id }));
    assert.equal(f.starts.size, 0);
    assert.equal(f.service.db.list("manual-sessions").length, 0);
  } finally { await f.close(); }
});

test("removed identity endpoints cannot auto-bind even when another instance releases the account", async () => {
  const f = await fixture();
  try {
    const selected = await account(f), other = await account(f, "replacement@example.test");
    const owner = (await f.request("POST", profiles, { name: "已绑定实例", accountAlias: selected.email })).json().data;
    const target = await f.create();
    for (const released of [false, true]) {
      if (released) await f.request("PUT", binding(owner.id), { accountId: other.id });
      assert.equal((await f.request("POST", `${profiles}/${target.id}/google-login/check`, {})).statusCode, 410);
      assert.equal(f.service.db.list<any>("accounts").filter(row => row.profileId === target.id).length, 0);
    }
    assert.equal(f.starts.size, 0);
  } finally { await f.close(); }
});
