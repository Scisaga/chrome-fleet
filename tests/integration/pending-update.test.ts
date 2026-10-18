import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { FleetError } from "@chrome-fleet/contracts";
import { fixture } from "./helpers/fleet.js";
const versionId = "google-144.0.7559.0";
async function setup() {
  const f = await fixture();
  const p = await f.create();
  f.service.db.set("versions", versionId, {
    id: versionId,
    distribution: "google",
    version: "144.0.7559.0",
    image: "chrome-fleet/browser:new",
    imageDigest: "sha256:" + "b".repeat(64),
    validated: true,
    applied: false,
  });
  const run = await f.service.applyUpdate({ versionId });
  return { f, p, run };
}
test("rolling back an unapplied stopped update revokes its pending image without starting Chrome", async () => {
  const { f, p, run } = await setup();
  try {
    assert.ok(f.service.profile(p.id).pendingImage);
    await f.service.rollbackUpdate(run.id);
    assert.equal(f.service.profile(p.id).pendingImage, undefined);
    assert.equal(f.startImages.length, 0);
    assert.equal(
      f.service.db.get<any>("updates", run.id).profiles[0].phase,
      "rolled_back",
    );
  } finally {
    await f.close();
  }
});
test("a stopped profile records its eventual recovery point and can roll back after first start", async () => {
  const { f, p, run } = await setup();
  try {
    const state = join(f.root, "profiles", p.id, "state", "chrome", "marker");
    await writeFile(state, "old-state");
    const token = f.service.db.acquire(p.id, "fixture-start")!;
    try {
      await f.service.ensureStart(p.id, true, token);
    } finally {
      f.service.db.release(p.id, "fixture-start", token);
    }
    const updated = f.service.db.get<any>("updates", run.id);
    assert.ok(updated.profiles[0].snapshotId);
    assert.equal(updated.profiles[0].phase, "succeeded");
    await writeFile(state, "new-state");
    await f.service.rollbackUpdate(run.id);
    assert.equal(await readFile(state, "utf8"), "old-state");
    assert.equal(f.service.profile(p.id).image, f.config.defaultImage);
    assert.equal(f.service.profile(p.id).state, "stopped");
  } finally {
    await f.close();
  }
});
test("a pending upgrade retains its target when the next-start backup fails", async () => {
  const { f, p } = await setup();
  try {
    f.service.snapshot = async () => {
      throw new FleetError("BACKUP_FAILED", "注入备份失败", 507);
    };
    const token = f.service.db.acquire(p.id, "fixture-start")!;
    try {
      await assert.rejects(
        () => f.service.ensureStart(p.id, true, token),
        (e: any) => e.code === "BACKUP_FAILED",
      );
    } finally {
      f.service.db.release(p.id, "fixture-start", token);
    }
    assert.equal(f.service.profile(p.id).pendingImage.version, "144.0.7559.0");
    assert.equal(f.service.profile(p.id).image, f.config.defaultImage);
    assert.equal(f.startImages.length, 0);
  } finally {
    await f.close();
  }
});
