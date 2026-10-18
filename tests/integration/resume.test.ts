import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/fleet.js";
async function drained(f: Awaited<ReturnType<typeof fixture>>) {
  const until = Date.now() + 3000;
  while (f.service.active.size) {
    if (Date.now() > until) throw new Error("队列未结束");
    await new Promise((r) => setTimeout(r, 5));
  }
}
for (const exhausted of [false, true])
  test(
    exhausted
      ? "resumed jobs retain their previous execution budget"
      : "human resume retains results from completed steps",
    async () => {
      const f = await fixture();
      try {
        const p = await f.create();
        f.setExecuteDelay(1);
        const j = f.service.submit(
          "automation",
          p.id,
          {
            steps: [
              { action: "pages" },
              { action: "requireHuman" },
              { action: "pages" },
            ],
            timeoutMs: 1000,
          },
          "bootstrap",
        );
        await f.service.tick();
        await drained(f);
        let paused = f.service.job(j.id);
        assert.equal(paused.status, "waiting_for_human");
        assert.equal(paused.completedSteps, 2);
        assert.equal(paused.result.results.length, 1);
        if (exhausted) {
          paused.activeElapsedMs = 1001;
          f.service.saveJob(paused);
        }
        assert.equal(
          (await f.request("POST", `/api/v1/jobs/${j.id}/resume`, {}))
            .statusCode,
          200,
        );
        await f.service.tick();
        await drained(f);
        const result = f.service.job(j.id);
        assert.equal(result.status, exhausted ? "timed_out" : "succeeded");
        assert.equal(result.result.results.length, exhausted ? 1 : 2);
      } finally {
        await f.close();
      }
    },
  );
test("an active browser download defers an update without replacing the image", async () => {
  const f = await fixture();
  try {
    const p = await f.create();
    await f.service.ensureStart(p.id, true);
    const original = f.service.agent.bind(f.service);
    f.service.agent = async (profile, path, body, token, timeout) =>
      path === "/health"
        ? { activeDownloads: 1, ready: true }
        : original(profile, path, body, token, timeout);
    const vid = "google-144.0.7559.0";
    f.service.db.set("versions", vid, {
      id: vid,
      distribution: "google",
      version: "144.0.7559.0",
      image: "chrome-fleet/browser:new",
      imageDigest: "sha256:" + "b".repeat(64),
      validated: true,
      applied: false,
    });
    const run = await f.service.applyUpdate({ versionId: vid });
    assert.equal(run.profiles[0].phase, "deferred");
    assert.equal(f.service.profile(p.id).image, f.config.defaultImage);
    assert.equal(f.service.db.get<any>("versions", vid).applied, false);
  } finally {
    await f.close();
  }
});

test("an explicit temporary proxy test preserves a manually paused always policy", async () => {
  const f = await fixture();
  try {
    const created = await f.create();
    const p = f.service.profile(created.id);
    p.startupPolicy = "always";
    p.autoWakePaused = true;
    f.service.saveProfile(p);
    const original = f.service.agent.bind(f.service);
    f.service.agent = async (profile, path, body, token, timeout) =>
      path === "/proxy/test"
        ? { success: true, checks: [] }
        : original(profile, path, body, token, timeout);
    const job = f.service.submit(
      "proxy_test",
      p.id,
      { explicitStart: true },
      "bootstrap",
    );
    await f.service.tick();
    await drained(f);
    assert.equal(f.service.job(job.id).status, "succeeded");
    assert.equal(f.service.profile(p.id).state, "stopped");
    assert.equal(f.service.profile(p.id).autoWakePaused, true);
    await f.service.tick();
    assert.equal(
      f.service.db.list<any>("jobs").filter((j) => j.status === "queued")
        .length,
      0,
    );
  } finally {
    await f.close();
  }
});
