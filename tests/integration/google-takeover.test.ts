import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers/fleet.js";

for (const browserMode of ["vnc", "automation"]) test(`${browserMode} confirmation never implies takeover, restarts Chrome or changes persistent data`, async () => {
  const f = await fixture();
  try {
    const selected = (await f.request("POST", "/api/v1/google-accounts", { email: "confirm@example.test", password: "synthetic-password" })).json().data;
    const profile = (await f.request("POST", "/api/v1/profiles", { name: "manual confirmation", browserMode, accountAlias: selected.email })).json().data;
    const desktop = (await f.request("POST", `/api/v1/profiles/${profile.id}/google-login`, {})).json().data;
    const proof = join(f.root, "profiles", profile.id, "state/chrome/login-proof"); await writeFile(proof, "unchanged-login-data");
    const before = f.service.profile(profile.id);
    const path = `/api/v1/profiles/${profile.id}/google-login/confirm`;
    f.service.agent = async () => { throw new Error("confirmation must not inspect browser"); };
    f.service.revokeDesktop = async () => { throw new Error("confirmation must not close desktop"); };
    f.service.ensureStart = async () => { throw new Error("confirmation must not restart Chrome"); };
    f.service.vault.get = () => { throw new Error("confirmation must not read login credentials"); };
    for (const body of [{ accountId: selected.id }, { accountId: selected.id, enableAutomation: false }]) {
      const confirmed = await f.request("POST", path, body);
      assert.equal(confirmed.statusCode, 200, confirmed.body);
      assert.equal(confirmed.json().data.takeoverJobId, undefined);
      assert.equal(confirmed.json().data.verificationSource, "manual_confirmation");
    }
    assert.equal((await f.request("POST", path, { accountId: selected.id, enableAutomation: true })).statusCode, 400);
    assert.deepEqual(f.service.profile(profile.id), before);
    assert.equal(f.service.db.list("jobs").length, 0); assert.equal(f.service.db.list("snapshots").length, 0);
    assert.equal(f.service.db.get<any>("manual-sessions", desktop.id).closed, false);
    assert.equal(f.service.db.lease(profile.id)?.owner, desktop.id);
    assert.equal(await readFile(proof, "utf8"), "unchanged-login-data");
    assert.equal(f.service.google.binding(profile.id)?.confirmationState, "confirmed");
  } finally { await f.close(); }
});
