/** Real REST/queue/Chrome/desktop/backup workflow. Creates and purges only its own synthetic profile. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";
const base = process.env.FLEET_TEST_URL || "http://127.0.0.1:8080";
const token = readFileSync(
  process.env.FLEET_TEST_TOKEN_FILE ||
    "/var/lib/chrome-fleet/secrets/admin-token",
  "utf8",
).trim();
const headers = { authorization: `Bearer ${token}` };
async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(base + "/api/v1" + path, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(150000),
  });
  const b: any = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${b.code} ${b.message}`);
  return b.data;
}
async function done(jid: string, allowFailure = false) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const j = await call("GET", `/jobs/${jid}`);
    if (!["queued", "running"].includes(j.status)) {
      if (!allowFailure)
        assert.equal(j.status, "succeeded", JSON.stringify(j.error));
      return j;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("真实任务超时");
}
async function job(method: string, path: string, body?: unknown) {
  return done((await call(method, path, body)).jobId);
}
let pid: string | undefined, manualId: string | undefined;
try {
  const p = await call("POST", "/profiles", {
    name: "验收 · 真实控制面工作流",
    browserMode: "automation",
    vncPassword: "fixture1",
    idleTimeoutMinutes: 0,
  });
  pid = p.id;
  assert.equal(p.state, "stopped");
  await job("POST", `/profiles/${pid}/start`, {});
  const nav = await job("POST", "/jobs", {
    profileId: pid,
    steps: [
      { action: "goto", url: "https://example.com" },
      { action: "extractText", locator: { css: "body" } },
    ],
  });
  assert.ok(JSON.stringify(nav.result).match(/example|documentation|示例|文档/i));
  const cookieValue = "fleet-synthetic-" + Date.now();
  const cookieDoc = {
    format: "chrome-fleet.cookies",
    version: 1,
    cookies: [
      {
        name: "fleet_live_proof",
        value: cookieValue,
        domain: "example.com",
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 86400,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ],
  };
  const upload = await call("POST", "/artifacts", {
    profileId: pid,
    type: "import",
    mimeType: "application/json",
    base64: Buffer.from(JSON.stringify(cookieDoc)).toString("base64"),
  });
  await job("POST", `/profiles/${pid}/cookies/import`, {
    artifactId: upload.id,
    mode: "merge",
  });
  const exported = await job("POST", `/profiles/${pid}/cookies/export`, {
    domains: ["example.com"],
  });
  const download = await fetch(
    base + `/api/v1/artifacts/${exported.result.artifactId}/download`,
    { headers },
  );
  assert.equal(download.status, 200);
  const doc: any = await download.json();
  assert.equal(
    doc.cookies.find((c: any) => c.name === "fleet_live_proof").value,
    cookieValue,
  );
  const login = await fetch(base + "/api/v1/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const browserCookie = login.headers.get("set-cookie")!.split(";")[0];
  const manual = await call("POST", `/profiles/${pid}/manual-sessions`, {
    durationSeconds: 60,
  });
  manualId = manual.id;
  const desktop = await fetch(base + manual.desktopPath, {
    headers: { cookie: browserCookie },
  });
  assert.equal(desktop.status, 200);
  assert.match(await desktop.text(), /noVNC/i);
  const denied = await fetch(base + manual.desktopPath, { redirect: "manual" });
  assert.equal(denied.status, 401);
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(
      base.replace(/^http/, "ws") + `/profiles/${pid}/desktop/websockify`,
      { headers: { cookie: browserCookie, origin: new URL(base).origin } },
    );
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("桌面网关未收到RFB握手"));
    }, 10000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      try {
        assert.ok(
          Buffer.from(data as Buffer)
            .toString()
            .startsWith("RFB "),
        );
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        socket.close();
      }
    });
    socket.once("error", reject);
  });
  const blocked = await call("POST", "/jobs", {
    profileId: pid,
    steps: [{ action: "pages" }],
  });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await call("GET", `/jobs/${blocked.jobId}`)).status, "queued");
  await call("DELETE", `/manual-sessions/${manualId}`);
  manualId = undefined;
  await done(blocked.jobId);
  const snapshot = await job("POST", `/profiles/${pid}/snapshots`, {});
  assert.ok(snapshot.result.id);
  await job("POST", `/profiles/${pid}/stop`, {});
  const paused = await call("POST", "/jobs", {
    profileId: pid,
    steps: [{ action: "pages" }],
  });
  assert.equal((await done(paused.jobId, true)).error.code, "PROFILE_STOPPED");
  await job("DELETE", `/profiles/${pid}`);
  await call("POST", `/profiles/${pid}/unarchive`, {});
  await job("POST", `/profiles/${pid}/start`, {});
  const rebuilt = await job("POST", `/profiles/${pid}/cookies/export`, {
    domains: ["example.com"],
  });
  const rebuiltDoc: any = await (
    await fetch(
      base + `/api/v1/artifacts/${rebuilt.result.artifactId}/download`,
      { headers },
    )
  ).json();
  assert.equal(
    rebuiltDoc.cookies.find((c: any) => c.name === "fleet_live_proof").value,
    cookieValue,
  );
  await job("POST", `/profiles/${pid}/stop`, {});
  await job("POST", `/profiles/${pid}/restore`, {
    snapshotId: snapshot.result.id,
  });
  await job("POST", `/profiles/${pid}/start`, {});
  const restored = await job("POST", `/profiles/${pid}/cookies/export`, {
    domains: ["example.com"],
  });
  const restoredDoc: any = await (
    await fetch(
      base + `/api/v1/artifacts/${restored.result.artifactId}/download`,
      { headers },
    )
  ).json();
  assert.equal(
    restoredDoc.cookies.find((c: any) => c.name === "fleet_live_proof").value,
    cookieValue,
  );
  process.stdout.write(
    "通过：真实REST队列、Chrome导航、HttpOnly导入导出、认证桌面HTTP/WebSocket、人工互斥、停机快照、归档重建、会话恢复与手动停止策略。\n",
  );
} finally {
  if (manualId)
    await call("DELETE", `/manual-sessions/${manualId}`).catch(() => {});
  if (pid) {
    await job("POST", `/profiles/${pid}/stop`, { force: true }).catch(() => {});
    await job("DELETE", `/profiles/${pid}`).catch(() => {});
    await call("POST", `/profiles/${pid}/purge`, { confirmation: pid }).catch(
      () => {},
    );
  }
}
