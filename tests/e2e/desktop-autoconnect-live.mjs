/** Real noVNC on an isolated profile. Optional clipboard checks type only synthetic text. No screenshots. */
import { readFileSync, lstatSync, realpathSync, readdirSync, openSync, fstatSync, fchmodSync, fchownSync, closeSync, constants } from "node:fs";
import { networkInterfaces } from "node:os";
import { resolve, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { chromium } from "playwright";
import { WebSocket } from "ws";

class SafeFailure extends Error {}
const requireTrue = (value, code) => { if (!value) throw new SafeFailure(code); };
let stage = "setup";
let base;
let adminToken;
let credential;
let profileId;
let browser;
let context;
let csrfToken;
let failed = false;
const manualIds = new Set();
const fixtureName = `QA desktop autoconnect ${randomUUID()}`;
const firstPassword = randomBytes(6).toString("base64url");
const nextPassword = (() => {
  let value;
  do { value = randomBytes(6).toString("base64url"); } while (value === firstPassword);
  return value;
})();
const counts = { connected: 0, credentials: 0, manageReveal: 0, pageErrors: 0, prompts: 0, secretUrls: 0 };
const records = new WeakMap();
const testClipboard = process.env.FLEET_TEST_CLIPBOARD === "1";
const diagnostics = process.env.FLEET_TEST_DIAGNOSTICS === "1";
const initializeChrome = process.env.FLEET_TEST_INITIALIZED_CHROME === "1";

async function initializeOwnFixtureChrome(profile) {
  requireTrue(initializeChrome && process.platform === "linux" && process.getuid?.() === 0, "LOCAL_ROOT_FIXTURE_REQUIRED");
  const ownHosts = new Set(["127.0.0.1", "::1", ...Object.values(networkInterfaces()).flatMap(entries => (entries || []).map(entry => entry.address))]);
  requireTrue(ownHosts.has(new URL(base).hostname.replace(/^\[|\]$/g, "")), "LOCAL_HOST_TEST_ORIGIN_REQUIRED");
  requireTrue(/^cf_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(profileId), "OWN_FIXTURE_UUID_REQUIRED");
  requireTrue(/^QA desktop autoconnect [0-9a-f-]{36}$/.test(fixtureName), "OWN_FIXTURE_NAME_REQUIRED");
  const fresh = await api("GET", `/profiles/${profileId}`, undefined, adminToken);
  requireTrue(profile.id === profileId && profile.name === fixtureName && fresh.id === profileId && fresh.name === fixtureName && fresh.state === "stopped" && !fresh.archived && fresh.browserMode === "vnc", "NEW_STOPPED_VNC_FIXTURE_REQUIRED");
  const root = resolve(process.env.FLEET_DATA_ROOT || "/var/lib/chrome-fleet");
  const profileRoot = join(root, "profiles", profileId), state = join(profileRoot, "state"), chrome = join(state, "chrome");
  for (const path of [root, join(root, "profiles"), profileRoot, state, chrome]) {
    const metadata = lstatSync(path);
    requireTrue(metadata.isDirectory() && !metadata.isSymbolicLink() && realpathSync(path) === path, "FIXTURE_DIRECTORY_UNSAFE");
    if ([profileRoot, state, chrome].includes(path)) requireTrue(metadata.uid === 1000 && (metadata.mode & 0o077) === 0, "FIXTURE_DIRECTORY_OWNER_UNSAFE");
  }
  requireTrue(readdirSync(chrome).length === 0, "NEW_EMPTY_FIXTURE_CHROME_REQUIRED");
  // This skips setup only in this new synthetic profile. Real first-run setup is not tested.
  const descriptor = openSync(join(chrome, "First Run"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchownSync(descriptor, 1000, 1000); fchmodSync(descriptor, 0o600);
    const metadata = fstatSync(descriptor);
    requireTrue(metadata.isFile() && metadata.nlink === 1 && metadata.uid === 1000 && metadata.gid === 1000 && (metadata.mode & 0o777) === 0o600, "FIXTURE_FIRST_RUN_FILE_UNSAFE");
  } finally { closeSync(descriptor); }
  console.log("PASS: 仅本机新建合成VNC实例预置首次设置标记；不代表真实首次设置已验收");
}

async function clipboardChecks(desktopPage, frame, meta) {
  const sample = `剪贴板验证 Chrome Fleet ${randomUUID()} 中文 Ω 🙂`;
  const probeOrigin = new URL(process.env.FLEET_TEST_CLIPBOARD_LOOPBACK_URL || "http://127.0.0.1:8080").origin;
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: probeOrigin });
  const probe = await context.newPage();
  await probe.goto(`${probeOrigin}/health`);
  requireTrue(await probe.evaluate(() => isSecureContext && typeof navigator.clipboard?.writeText === "function"), "SECURE_CLIPBOARD_PROBE_REQUIRED");
  await probe.evaluate(value => navigator.clipboard.writeText(value), sample);
  await desktopPage.bringToFront();
  requireTrue(await desktopPage.evaluate(() => !isSecureContext && !navigator.clipboard), "LAN_HTTP_FALLBACK_REQUIRED");
  await desktopPage.locator("#fleet_clipboard_button").click();
  const textarea = desktopPage.locator("#fleet_clipboard_text");
  await textarea.focus();
  await desktopPage.keyboard.press("Control+v");
  await waitUntil(() => textarea.evaluate((element, expected) => element.value === expected, sample), "LOCAL_OS_CLIPBOARD_PASTE_FAILED");
  await desktopPage.locator("#fleet_clipboard_send").click();
  await waitUntil(() => desktopPage.locator("#fleet_clipboard_status").innerText().then(text => /已发送|已写入/.test(text)), "REMOTE_CLIPBOARD_WRITE_FAILED");

  // Send shortcuts over the authenticated RFB connection to this fixture's blank Chrome.
  // Do not press Enter or navigate the address bar to any site.
  const remoteShortcut = async letter => {
    await desktopPage.evaluate(async key => {
      const { default: UI } = await import(location.pathname.slice(0, location.pathname.lastIndexOf("/") + 1) + "app/ui.js");
      const rfb = UI.rfb;
      if (!rfb) throw new Error("OWN_RFB_REQUIRED");
      rfb.sendKey(0xffe3, "ControlLeft", true);
      rfb.sendKey(key.charCodeAt(0), "Key" + key.toUpperCase(), true);
      rfb.sendKey(key.charCodeAt(0), "Key" + key.toUpperCase(), false);
      rfb.sendKey(0xffe3, "ControlLeft", false);
    }, letter);
    await pause(250);
  };
  await remoteShortcut("l");
  await remoteShortcut("v");

  // Remove the original X11 selection before copying back, proving a real Chrome copy.
  const clear = await context.request.post(`${base}/profiles/${profileId}/desktop/clipboard`, {
    headers: { origin: base, "x-csrf-token": csrfToken },
    data: { sessionId: meta.sessionId, version: meta.version, action: "write", text: "" },
  });
  requireTrue(clear.ok(), "REMOTE_CLIPBOARD_CLEAR_FAILED");
  await clear.dispose();
  await remoteShortcut("a");
  await remoteShortcut("c");
  await textarea.fill("");
  await desktopPage.locator("#fleet_clipboard_read").click();
  await waitUntil(() => textarea.evaluate((element, expected) => element.value === expected, sample), "REMOTE_CHROME_UNICODE_COPY_FAILED");
  await probe.bringToFront();
  await probe.evaluate(value => navigator.clipboard.writeText(value), `before-local-copy-${randomUUID()}`);
  await desktopPage.bringToFront();
  await desktopPage.locator("#fleet_clipboard_copy").click();
  await probe.bringToFront();
  requireTrue(await probe.evaluate(async value => (await navigator.clipboard.readText()) === value, sample), "HTTP_LOCAL_CLIPBOARD_COPY_FAILED");

  await desktopPage.bringToFront();
  await desktopPage.locator("#fleet_clipboard_close").click();
  requireTrue(await textarea.inputValue() === "", "CLIPBOARD_PANEL_CLOSE_MUST_CLEAR");
  await frame.locator("#fleet_clipboard_button").click();
  await frame.locator("#fleet_clipboard_read").click();
  await waitUntil(() => frame.locator("#fleet_clipboard_text").evaluate((element, expected) => element.value === expected, sample), "EMBEDDED_CLIPBOARD_READ_FAILED");
  await frame.locator("#fleet_clipboard_close").click();
  requireTrue(await frame.locator("#fleet_clipboard_text").inputValue() === "", "EMBEDDED_CLIPBOARD_CLOSE_MUST_CLEAR");
  for (const surface of [desktopPage, frame]) {
    requireTrue(await surface.evaluate(value => !JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]).includes(value), sample), "CLIPBOARD_PERSISTED_IN_BROWSER_STORAGE");
  }
  await probe.close();
  console.log("PASS: LAN HTTP真实本机剪贴板→面板Ctrl+V→远程Chrome粘贴并重新复制→面板→本机，中文/符号/emoji完整往返；内嵌与关闭清除通过");
}

async function rejectedClipboard(meta) {
  const response = await context.request.post(`${base}/profiles/${profileId}/desktop/clipboard`, {
    headers: { origin: base, "x-csrf-token": csrfToken },
    data: { sessionId: meta.sessionId, version: meta.version, action: "read" },
  });
  requireTrue([401, 403, 409, 410].includes(response.status()), "STALE_CLIPBOARD_CONTEXT_ACCEPTED");
  await response.dispose();
}

async function api(method, path, body, token = credential?.token || adminToken) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      origin: base,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(!["GET", "HEAD"].includes(method) ? { "idempotency-key": randomUUID() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(150_000),
  });
  if (!response.ok) throw new SafeFailure(`HTTP_${response.status}`);
  const result = await response.json();
  return result.data;
}
async function done(jobId) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const job = await api("GET", `/jobs/${jobId}`, undefined, adminToken);
    if (!["queued", "running"].includes(job.status)) {
      requireTrue(job.status === "succeeded", "JOB_FAILED");
      return;
    }
    await pause(300);
  }
  throw new SafeFailure("JOB_TIMEOUT");
}
async function waitUntil(predicate, code, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(100);
  }
  throw new SafeFailure(code);
}
async function manual() {
  const session = await api("POST", `/profiles/${profileId}/manual-sessions`, { durationSeconds: 600, explicitStart: true });
  requireTrue(session.profileId === profileId && typeof session.id === "string", "OWN_SESSION_REQUIRED");
  manualIds.add(session.id);
  const target = new URL(session.desktopPath, base);
  requireTrue(target.origin === base && target.pathname === `/profiles/${profileId}/desktop`, "OWN_DESKTOP_REQUIRED");
  return { ...session, url: target.href };
}
function record(page) {
  const current = records.get(page);
  requireTrue(Boolean(current), "PAGE_OBSERVER_MISSING");
  return current;
}
async function metadata(surface) {
  const meta = surface.locator('meta[name="fleet-desktop-context"]');
  await meta.waitFor({ state: "attached" });
  const value = await meta.evaluate(element => ({
    profileId: element.dataset.profileId,
    sessionId: element.dataset.sessionId,
    version: Number(element.dataset.version),
  }));
  requireTrue(value.profileId === profileId && manualIds.has(value.sessionId) && Number.isSafeInteger(value.version) && value.version > 0, "OWN_BOOTSTRAP_CONTEXT_REQUIRED");
  return value;
}
async function connected(surface) {
  try {
    await surface.waitForFunction(() => document.documentElement.dataset.fleetDesktopState === "connected", null, { timeout: 60_000 });
  } catch (error) {
    if (diagnostics) {
      const state = await surface.evaluate(() => ({ state: document.documentElement.dataset.fleetDesktopState || "missing", clipboardButton: Boolean(document.getElementById("fleet_clipboard_button")), canvas: Boolean(document.querySelector("canvas")), credentialPrompt: Boolean(document.querySelector("#noVNC_credentials_dlg.noVNC_open")) })).catch(() => ({ state: "unavailable" }));
      console.error(`DIAG: ${JSON.stringify({ ...state, credentialRequests: counts.credentials, pageErrors: counts.pageErrors })}`);
    }
    throw error;
  }
  counts.connected++;
  await clean(surface);
}
async function clean(surface) {
  // All comparisons run in the browser; no password or rendered HTML is returned.
  const checks = await surface.evaluate(secrets => {
    const containsSecret = text => secrets.some(secret => text.includes(secret));
    const stored = JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]);
    return [
      !containsSecret(location.href),
      !/[?&#](?:password|token)=/i.test(location.href),
      !containsSecret(document.documentElement.outerHTML),
      !containsSecret(stored),
      !containsSecret(document.cookie),
      [...document.querySelectorAll("input")].every(input => !containsSecret(input.value)),
      !document.querySelector("#noVNC_credentials_dlg.noVNC_open"),
      !globalThis.__fleetDesktopQa?.credentialsDialogSeen,
    ];
  }, [firstPassword, nextPassword, credential.token]);
  requireTrue(checks.every(Boolean), "DESKTOP_SECRET_OR_PASSWORD_PROMPT");
  requireTrue(counts.manageReveal === 0 && counts.secretUrls === 0 && counts.prompts === 0, "UNEXPECTED_CREDENTIAL_DISCLOSURE");
}
async function disconnected(surface) {
  await waitUntil(async () => {
    if (typeof surface.isDetached === "function" && surface.isDetached()) return true;
    try {
      return await surface.evaluate(() => ["disconnected", "expired", "authentication-failed", "error"].includes(document.documentElement.dataset.fleetDesktopState));
    } catch { return typeof surface.isDetached === "function" && surface.isDetached(); }
  }, "RFB_DID_NOT_DISCONNECT");
}
async function rejectedCredentials(meta) {
  const response = await context.request.post(`${base}/profiles/${profileId}/desktop/credentials`, {
    headers: { origin: base, "x-csrf-token": csrfToken },
    data: { sessionId: meta.sessionId, version: meta.version },
  });
  requireTrue([401, 403, 409, 410].includes(response.status()), "STALE_CREDENTIAL_CONTEXT_ACCEPTED");
  await response.dispose();
}
async function rejectedSocket(url) {
  requireTrue(Boolean(url), "OWN_SOCKET_URL_MISSING");
  const cookies = (await context.cookies(base)).map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
  const denied = await new Promise(resolve => {
    const socket = new WebSocket(url, { headers: { cookie: cookies, origin: base } });
    let settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); socket.terminate(); resolve(value); } };
    const timer = setTimeout(() => finish(false), 7_000);
    socket.once("open", () => finish(false));
    socket.once("error", () => finish(true));
    socket.once("unexpected-response", (_request, response) => { response.resume(); finish(response.statusCode >= 400); });
  });
  requireTrue(denied, "STALE_WEBSOCKET_CONTEXT_ACCEPTED");
}

try {
  requireTrue(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0", "UNSAFE_TLS_ENVIRONMENT");
  const target = new URL(process.env.FLEET_TEST_URL || "http://127.0.0.1:8080");
  requireTrue(["http:", "https:"].includes(target.protocol) && !target.username && !target.password, "INVALID_TEST_ORIGIN");
  base = target.origin;
  adminToken = readFileSync(process.env.FLEET_TEST_TOKEN_FILE || "/var/lib/chrome-fleet/secrets/admin-token", "utf8").trim();
  requireTrue(adminToken.length >= 32, "ADMIN_TOKEN_UNAVAILABLE");

  stage = "create_own_profile";
  const profile = await api("POST", "/profiles", { name: fixtureName, vncPassword: firstPassword, idleTimeoutMinutes: 0 }, adminToken);
  requireTrue(/^cf_[0-9a-f-]{36}$/.test(profile.id) && profile.name === fixtureName, "OWN_PROFILE_REQUIRED");
  profileId = profile.id;
  if (initializeChrome) {
    stage = "initialize_own_fixture_chrome";
    await initializeOwnFixtureChrome(profile);
  }
  stage = "issue_scoped_credential";
  credential = await api("POST", "/credentials", {
    scopes: ["automate", "read", "manage"], profiles: [profileId],
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  }, adminToken);
  requireTrue(typeof credential.id === "string" && typeof credential.token === "string", "TEST_CREDENTIAL_UNAVAILABLE");

  stage = "browser_login";
  browser = await chromium.launch({
    executablePath: process.env.FLEET_QA_CHROME || "/opt/chrome-fleet/.tools/ui-chrome/chrome-linux64/chrome",
    headless: true,
  });
  context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    const state = { credentialsDialogSeen: false };
    globalThis.__fleetDesktopQa = state;
    const observe = () => {
      const check = () => { if (document.querySelector("#noVNC_credentials_dlg.noVNC_open")) state.credentialsDialogSeen = true; };
      new MutationObserver(check).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
      check();
    };
    if (document.documentElement) observe();
    else document.addEventListener("DOMContentLoaded", observe, { once: true });
  });
  context.on("page", page => {
    records.set(page, { credentials: 0, latestSocket: null, socketUrl: null });
    page.on("pageerror", error => {
      counts.pageErrors++;
      if (diagnostics) {
        let message = String(error.message);
        for (const secret of [adminToken, credential.token, firstPassword, nextPassword]) message = message.replaceAll(secret, "[redacted]");
        console.error(`DIAG: ${JSON.stringify({ name: error.name, message: message.slice(0, 240) })}`);
      }
    });
    if (diagnostics) page.on("response", response => {
      const url = new URL(response.url());
      if (response.status() >= 400 && url.pathname.startsWith(`/profiles/${profileId}/desktop/`))
        console.error(`DIAG: ${JSON.stringify({ status: response.status(), resource: url.pathname.split("/").at(-1) })}`);
    });
    page.on("dialog", dialog => { counts.prompts++; void dialog.dismiss().catch(() => undefined); });
    page.on("request", request => {
      const url = request.url();
      if ([adminToken, credential.token, firstPassword, nextPassword].some(secret => url.includes(secret))) counts.secretUrls++;
      if (new URL(url).pathname.endsWith("/remote-desktop/password/reveal")) counts.manageReveal++;
      if (new URL(url).pathname === `/profiles/${profileId}/desktop/credentials`) { counts.credentials++; record(page).credentials++; }
    });
    page.on("websocket", socket => { record(page).latestSocket = socket; record(page).socketUrl = socket.url(); });
  });
  const appPage = await context.newPage();
  await appPage.goto(`${base}/profiles`);
  await appPage.getByLabel("平台访问令牌").fill(credential.token);
  await appPage.getByRole("button", { name: "安全登录", exact: true }).click();
  await appPage.getByRole("heading", { name: /^浏览器实例/ }).waitFor();
  const sessionInfo = await (await context.request.get(`${base}/api/v1/session`)).json();
  csrfToken = sessionInfo.data?.csrfToken;
  requireTrue(Boolean(csrfToken), "TEST_WEB_SESSION_REQUIRED");

  stage = "initial_autoconnect";
  const session = await manual();
  const desktopPage = await context.newPage();
  await desktopPage.goto(session.url);
  const initialMeta = await metadata(desktopPage);
  requireTrue(initialMeta.sessionId === session.id, "OWN_SESSION_CONTEXT_MISMATCH");
  await connected(desktopPage);
  requireTrue(record(desktopPage).credentials >= 1 && !record(desktopPage).latestSocket?.isClosed(), "FULL_RFB_AUTHENTICATION_REQUIRED");
  console.log("PASS: 独立短期凭证与合成实例，noVNC无密码交互完成真实RFB连接");

  stage = "refresh_autoconnect";
  const beforeRefresh = record(desktopPage).credentials;
  await desktopPage.reload();
  await connected(desktopPage);
  const refreshedMeta = await metadata(desktopPage);
  requireTrue(refreshedMeta.sessionId === initialMeta.sessionId && refreshedMeta.version === initialMeta.version && record(desktopPage).credentials > beforeRefresh, "REFRESH_AUTHENTICATION_REQUIRED");
  stage = "explicit_reconnect";
  await desktopPage.locator("#noVNC_disconnect_button").click();
  await disconnected(desktopPage);
  const beforeReconnect = record(desktopPage).credentials;
  await desktopPage.locator("#noVNC_connect_button").click();
  await connected(desktopPage);
  requireTrue(record(desktopPage).credentials > beforeReconnect, "RECONNECT_AUTHENTICATION_REQUIRED");
  console.log("PASS: 刷新和显式断开后重新连接均自动认证，URL/HTML/storage无密码且未调用manage reveal");

  stage = "embedded_autoconnect";
  await appPage.reload();
  await appPage.locator(".desktop-session-banner").getByRole("button", { name: "内嵌桌面", exact: true }).click();
  const iframe = appPage.locator('iframe[title="Chrome 实例远程桌面"]');
  await iframe.waitFor();
  const frame = await (await iframe.elementHandle()).contentFrame();
  requireTrue(Boolean(frame), "OWN_EMBEDDED_FRAME_REQUIRED");
  const frameMeta = await metadata(frame);
  requireTrue(frameMeta.sessionId === session.id && frameMeta.version === initialMeta.version, "EMBEDDED_CONTEXT_MISMATCH");
  await connected(frame);
  console.log("PASS: 管理页面的同源内嵌桌面使用同一人工会话自动认证");

  if (testClipboard) {
    stage = "clipboard_unicode_roundtrip";
    await clipboardChecks(desktopPage, frame, initialMeta);
  }

  stage = "lease_revocation";
  const popupSocket = record(desktopPage).latestSocket;
  const frameSocket = record(appPage).latestSocket;
  await api("DELETE", `/manual-sessions/${session.id}`);
  manualIds.delete(session.id);
  await disconnected(desktopPage);
  await disconnected(frame);
  await waitUntil(() => popupSocket?.isClosed() && frameSocket?.isClosed(), "LEASE_WEBSOCKETS_REMAIN_OPEN");
  await rejectedCredentials(initialMeta);
  if (testClipboard) await rejectedClipboard(initialMeta);
  await rejectedSocket(record(desktopPage).socketUrl);
  console.log("PASS: 结束人工租约关闭真实RFB/WebSocket，旧上下文无法再读取凭据或升级连接");

  stage = "rotation_invalidates_old_page";
  const rotationSession = await manual();
  await desktopPage.goto(rotationSession.url);
  const rotationMeta = await metadata(desktopPage);
  await connected(desktopPage);
  const oldSocket = record(desktopPage).latestSocket;
  const oldRequests = record(desktopPage).credentials;
  await api("PUT", `/profiles/${profileId}/remote-desktop/password`, { password: nextPassword });
  manualIds.delete(rotationSession.id);
  await disconnected(desktopPage);
  await waitUntil(() => oldSocket?.isClosed(), "ROTATED_WEBSOCKET_REMAINS_OPEN");
  await pause(1_500);
  requireTrue(record(desktopPage).credentials === oldRequests, "OLD_PAGE_REQUESTED_ROTATED_CREDENTIALS");
  await rejectedCredentials(rotationMeta);
  if (testClipboard) await rejectedClipboard(rotationMeta);
  await rejectedSocket(record(desktopPage).socketUrl);
  const freshSession = await manual();
  await desktopPage.goto(freshSession.url);
  const freshMeta = await metadata(desktopPage);
  requireTrue(freshMeta.sessionId !== rotationMeta.sessionId && freshMeta.version > rotationMeta.version, "FRESH_ROTATED_CONTEXT_REQUIRED");
  await connected(desktopPage);
  console.log("PASS: 轮换撤销旧页面权限且不自动取新密码，新人工会话可自动连接新版本");

  stage = "final_checks";
  requireTrue(counts.pageErrors === 0 && counts.prompts === 0 && counts.manageReveal === 0 && counts.secretUrls === 0, "BROWSER_ERRORS_OR_SECRET_DISCLOSURE");
  console.log(`PASS: connected=${counts.connected}, credentialRequests=${counts.credentials}, pageErrors=0, passwordPrompts=0, manageReveal=0`);
} catch (error) {
  failed = true;
  const code = error instanceof SafeFailure && /^[A-Z0-9_]{1,64}$/.test(error.message) ? error.message : "CHECK_FAILED";
  console.error(`FAIL: stage=${stage} code=${code}`);
} finally {
  stage = "cleanup";
  let cleanupFailed = false;
  for (const sessionId of manualIds) {
    try { await api("DELETE", `/manual-sessions/${sessionId}`, undefined, adminToken); }
    catch { cleanupFailed = true; }
  }
  if (context) {
    try {
      if (!csrfToken) {
        const session = await (await context.request.get(`${base}/api/v1/session`)).json();
        csrfToken = session.data?.authenticated ? session.data.csrfToken : undefined;
      }
      if (csrfToken) {
        const response = await context.request.delete(`${base}/api/v1/session`, { headers: { "x-csrf-token": csrfToken, origin: base } });
        if (![200, 401].includes(response.status())) cleanupFailed = true;
      }
    } catch { cleanupFailed = true; }
  }
  await browser?.close().catch(() => { cleanupFailed = true; });
  if (profileId && adminToken) {
    try {
      const owned = await api("GET", `/profiles/${profileId}`, undefined, adminToken);
      requireTrue(owned.id === profileId && owned.name === fixtureName, "OWN_CLEANUP_PROFILE_REQUIRED");
      if (owned.state !== "stopped") await done((await api("POST", `/profiles/${profileId}/stop`, { force: true }, adminToken)).jobId);
      if (!owned.archived) await done((await api("DELETE", `/profiles/${profileId}`, undefined, adminToken)).jobId);
      await api("POST", `/profiles/${profileId}/purge`, { confirmation: profileId }, adminToken);
    } catch { cleanupFailed = true; }
  }
  if (credential?.id && adminToken) {
    try { await api("DELETE", `/credentials/${credential.id}`, undefined, adminToken); }
    catch { cleanupFailed = true; }
  }
  if (cleanupFailed) { failed = true; console.error("FAIL: stage=cleanup code=OWN_FIXTURE_CLEANUP_FAILED"); }
  else if (profileId) console.log("PASS: 自有人工会话、Web会话、临时平台凭证与实例容器/状态已清理");
  if (failed) process.exitCode = 1;
}
