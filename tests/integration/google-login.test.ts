import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/fleet.js";

for (const browserMode of ["vnc", "automation"]) test(`${browserMode} Google entry only opens human desktop and never navigates, detects or autofills`, async () => {
  const f = await fixture();
  try {
    const selected = (await f.request("POST", "/api/v1/google-accounts", { email: "manual-google@example.test", password: "synthetic-password" })).json().data;
    const profile = (await f.request("POST", "/api/v1/profiles", { name: "manual login", browserMode, accountAlias: selected.email })).json().data;
    const paths: string[] = [], original = f.service.agent.bind(f.service);
    f.service.agent = async (p, path, body, token, timeout) => { paths.push(path); return original(p, path, body, token, timeout); };
    const opened = await f.request("POST", `/api/v1/profiles/${profile.id}/google-login`, {});
    assert.equal(opened.statusCode, 201, opened.body);
    const session = opened.json().data;
    assert.equal(session.googleLogin.expectedEmail, selected.email);
    assert.equal(session.googleLogin.status, "waiting");
    assert.equal(session.googleLogin.autofill, undefined);
    assert.equal(session.googleLogin.detectedEmail, undefined);
    assert.equal(session.loginUrl, "https://accounts.google.com/ServiceLogin");
    assert.equal(session.fencingToken, undefined);
    const before = f.service.db.list("accounts");
    await f.service.tick();
    assert.equal((await f.request("POST", `/api/v1/profiles/${profile.id}/google-login/check`, {})).statusCode, 410);
    await f.request("DELETE", `/api/v1/manual-sessions/${session.id}`);
    assert.equal(paths.some(path => path.startsWith("/accounts/")), false);
    assert.deepEqual(f.service.db.list("accounts"), before);
  } finally { await f.close(); }
});

test("legacy account agent endpoints are denied before network, Vault access or browser mode checks", async () => {
  const f = await fixture();
  try {
    const p = (await f.request("POST", "/api/v1/profiles", { name: "stopped ordinary Chrome" })).json().data;
    f.service.vault.get = () => { throw new Error("must not read credentials"); };
    for (const path of ["/accounts/check", "/accounts/google-identity", "/accounts/google-autofill", "/accounts/google-login", "/accounts/open-login"])
      await assert.rejects(() => f.service.agent(f.service.profile(p.id), path, {}), (e: any) => e.status === 410 || e.code === "ACCOUNT_CHECK_REMOVED");
    assert.equal(f.starts.size, 0);
  } finally { await f.close(); }
});
