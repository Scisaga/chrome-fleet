/** Real deployed HTTP MCP + Chrome Google navigation + authenticated VNC. Never logs in a real account. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = process.env.FLEET_DATA_ROOT || "/var/lib/chrome-fleet";
const base = process.env.FLEET_TEST_URL || "http://127.0.0.1:8080";
const token = readFileSync(
  process.env.FLEET_TEST_TOKEN_FILE || join(root, "secrets/admin-token"),
  "utf8",
).trim();
const headers = {
  authorization: `Bearer ${token}`,
  origin: new URL(base).origin,
};
async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(base + "/api/v1" + path, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const result: any = await response.json();
  if (!response.ok)
    throw new Error(`${method}: ${result.code || response.status}`);
  return result.data;
}
async function done(jobId: string) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const job = await call("GET", `/jobs/${jobId}`);
    if (!["queued", "running"].includes(job.status)) {
      assert.equal(job.status, "succeeded", job.error?.code);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("测试任务超时");
}

let profileId: string | undefined;
let sessionId: string | undefined;
const client = new Client({ name: "fleet-lan-http-validation", version: "1" });
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers },
    }),
  );
  assert.ok((await client.listTools()).tools.length >= 35);
  assert.equal(
    (await client.callTool({ name: "profiles_list", arguments: {} })).isError,
    undefined,
  );
  console.log("PASS: 已部署的局域网 HTTP MCP 初始化、工具发现与调用");
  const catalog = await call("GET", "/google-accounts");
  assert.ok(Array.isArray(catalog.items));
  assert.equal(JSON.stringify(catalog).includes("credentialsRef"), false);
  assert.equal(JSON.stringify(catalog).includes('"password"'), false);
  const profile = await call("POST", "/profiles", {
    name: "验收 · Google人工登录入口",
    browserMode: "automation",
    vncPassword: "fixture1",
    idleTimeoutMinutes: 0,
  });
  profileId = profile.id;
  const session = await call("POST", `/profiles/${profileId}/google-login`, {});
  sessionId = session.id;
  assert.equal(session.googleLogin.status, "waiting");
  assert.equal(session.fencingToken, undefined);

  if (session.googleLogin.navigationStatus === "opened") {
    // Inspect only this test's pages from the authorized control network; no Agent host port is published.
    const inspectPages = `
    import { DatabaseSync } from 'node:sqlite';
    import { Vault } from './packages/core/dist/index.js';
    const root = process.env.FLEET_DATA_ROOT;
    const db = new DatabaseSync(root + '/db/fleet.sqlite', {readOnly:true});
    const row = (collection,id) => JSON.parse(db.prepare('SELECT value FROM records WHERE collection=? AND id=?').get(collection,id).value);
    const profile = row('profiles',process.argv[1]);
    const lease = row('manual-sessions',process.argv[2]);
    db.close();
    const vault = new Vault(root,process.env.FLEET_MASTER_KEY_FILE);
    const response = await fetch(profile.agentUrl + '/execute', {
      method:'POST',headers:{authorization:'Bearer '+vault.get(profile.agentTokenRef),'content-type':'application/json'},
      body:JSON.stringify({fencingToken:lease.fencingToken,steps:[{action:'pages'}],timeoutMs:5000}),signal:AbortSignal.timeout(10000)
    });
    const out = await response.json();
    const pages = (out.results || []).flatMap(result => Array.isArray(result.result) ? result.result : []);
    const googlePage = pages.some(page => {const url=new URL(page.url);return url.protocol==='https:'&&['accounts.google.com','myaccount.google.com'].includes(url.hostname);});
    console.log(JSON.stringify({ok:response.ok,googlePage,code:out.code}));
  `;
    const inspected = JSON.parse(
      execFileSync(
        "docker",
        [
          "exec",
          process.env.FLEET_TEST_CONTAINER || "chrome-fleet-control-plane-1",
          "node",
          "--input-type=module",
          "-e",
          inspectPages,
          profileId!,
          sessionId!,
        ],
        { encoding: "utf8", timeout: 20000 },
      ),
    );
    assert.equal(inspected.ok, true, inspected.code);
    assert.equal(
      inspected.googlePage,
      true,
      "同一真实Chrome中没有Google官方页面",
    );
    console.log("PASS: 真实Chrome中Google官方登录页面已完成加载");
  } else {
    assert.equal(session.googleLogin.navigationStatus, "pending");
    assert.match(session.googleLogin.message, /网络|代理/);
    console.log(
      "SKIP: Google页面加载验收受当前网络阻塞；保留真实桌面并提示配置实例代理，未宣称登录成功",
    );
  }
  assert.equal(
    (await call("GET", `/profiles/${profileId}/accounts`)).items.length,
    0,
  );
  console.log(
    "PASS: Google人工登录请求唤起真实Chrome，未将打开页面误判为登录或绑定",
  );

  const desktop = await fetch(base + session.desktopPath, { headers });
  assert.equal(desktop.ok, true);
  const socket = new WebSocket(
    base.replace(/^http/, "ws") + `/profiles/${profileId}/desktop/websockify`,
    { headers },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("VNC RFB握手超时"));
    }, 10000);
    socket.once("message", (message) => {
      clearTimeout(timer);
      if (
        Buffer.from(message as Buffer)
          .toString()
          .startsWith("RFB ")
      )
        resolve();
      else reject(new Error("VNC协议不符合预期"));
      socket.close();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const checked = await call(
    "POST",
    `/profiles/${profileId}/google-login/check`,
    {},
  );
  assert.ok(["waiting", "unknown"].includes(checked.status));
  console.log(
    "PASS: 局域网来源的受保护noVNC桌面与真实RFB握手；Google登录仍等待人工操作",
  );
} finally {
  await client.close().catch(() => undefined);
  if (sessionId)
    await call("DELETE", `/manual-sessions/${sessionId}`).catch(
      () => undefined,
    );
  if (profileId) {
    const stopped = await call("POST", `/profiles/${profileId}/stop`, {});
    await done(stopped.jobId);
    const archived = await call("DELETE", `/profiles/${profileId}`);
    await done(archived.jobId);
    await call("POST", `/profiles/${profileId}/purge`, {
      confirmation: profileId,
    });
    console.log("PASS: 仅清理本次创建的临时实例、容器和状态目录");
  }
}
