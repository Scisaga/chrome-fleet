import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve, join } from "node:path";
import { chromium } from "playwright";

// Run against a fresh, disposable `tests/e2e/web.mjs --serve` service.
// The marker prevents writes against an ordinary deployment.
const base = process.env.FLEET_QA_URL;
assert.ok(base && process.env.FLEET_QA_TOKEN_FILE && process.env.FLEET_QA_CHROME);
const marker = await fetch(`${base}/__ui_qa__`).then(response => response.json());
assert.equal(marker.kind, "chrome-fleet-ui-qa");
assert.equal(marker.workerStarted, false);
assert.equal(marker.runnerIsolated, true);
assert.equal(marker.agentIsolated, true);
const browser = await chromium.launch({ executablePath: resolve(process.env.FLEET_QA_CHROME), headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1040 }, locale: "zh-CN", permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors = [];
  const disclosures = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.url().endsWith("/password/reveal")) disclosures.push(request.url()); });
  await page.goto(`${base}/accounts`);
  await page.getByLabel("平台访问令牌").fill(readFileSync(process.env.FLEET_QA_TOKEN_FILE, "utf8").trim());
  await page.getByRole("button", { name: "安全登录", exact: true }).click();
  await page.getByRole("heading", { name: /^账号管理/ }).waitFor();
  await page.locator(".account-manager-row").first().waitFor();
  assert.equal(disclosures.length, 0, "加载目录不应读取密码");
  const initial = (await (await context.request.get(`${base}/api/v1/google-accounts`)).json()).data;
  const imported = page.locator(`[data-account-id="${initial.items[0].id}"]`);
  await imported.getByRole("button", { name: "查看密码", exact: true }).click();
  await imported.getByRole("button", { name: "隐藏密码", exact: true }).waitFor();
  assert.ok((await imported.locator(".account-password input").inputValue()).length > 0);
  await imported.getByRole("button", { name: "隐藏密码", exact: true }).click();

  const email = `qa-managed-${Date.now()}@example.test`;
  const original = randomBytes(24).toString("base64url") + " 空格 ";
  const replacement = randomBytes(24).toString("base64url");
  const openCreate = () => page.locator(".account-manager-heading-actions").getByRole("button", { name: "新增账号", exact: true }).click();
  await openCreate();
  let dialog = page.getByRole("dialog", { name: "新增账号", exact: true });
  await dialog.getByLabel("账号邮箱", { exact: true }).fill(email);
  await dialog.getByLabel("密码", { exact: true }).fill(original);
  await dialog.getByRole("button", { name: "显示输入密码", exact: true }).click();
  assert.equal(await dialog.locator('input[name="password"]').getAttribute("type"), "text");
  await dialog.getByRole("button", { name: "隐藏输入密码", exact: true }).click();
  await dialog.getByRole("button", { name: "新增账号", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const row = page.getByRole("article", { name: `账号 ${email}`, exact: true });
  await row.waitFor();
  const saved = (await (await context.request.get(`${base}/api/v1/google-accounts`)).json()).data;
  assert.equal(saved.total, initial.total + 1);
  assert.ok(saved.items.every(account => !Object.hasOwn(account, "password") && !Object.hasOwn(account, "credentialsRef")));
  const account = saved.items.find(entry => entry.email === email);
  const field = row.getByLabel(`账号密码 ${email}`, { exact: true });
  assert.equal(await field.inputValue(), "");
  await row.getByRole("button", { name: "查看密码", exact: true }).click();
  await row.getByRole("button", { name: "隐藏密码", exact: true }).waitFor();
  assert.equal(await field.inputValue(), original);
  await row.getByRole("button", { name: "复制密码", exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), original);
  await row.getByRole("button", { name: "隐藏密码", exact: true }).click();
  assert.equal(await field.inputValue(), "");

  await openCreate();
  dialog = page.getByRole("dialog", { name: "新增账号", exact: true });
  await dialog.getByLabel("账号邮箱", { exact: true }).fill(email.toUpperCase());
  await dialog.getByLabel("密码", { exact: true }).fill("must-not-overwrite");
  await dialog.getByRole("button", { name: "新增账号", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "此邮箱已存在" }).waitFor();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();

  // Bind a stopped synthetic profile, so editing credentials also exercises a real mapping.
  const session = (await (await context.request.get(`${base}/api/v1/session`)).json()).data;
  const headers = { "x-csrf-token": session.csrfToken };
  const profileResponse = await context.request.post(`${base}/api/v1/profiles`, { headers, data: { name: "账号编辑 UI 夹具", browserMode: "vnc" } });
  assert.equal(profileResponse.status(), 201);
  const profile = (await profileResponse.json()).data;
  assert.equal((await context.request.put(`${base}/api/v1/profiles/${profile.id}/google-binding`, { headers, data: { accountId: account.id } })).status(), 200);
  const beforeProfile = (await (await context.request.get(`${base}/api/v1/profiles/${profile.id}`)).json()).data;

  async function edit(password, recovery) {
    await row.getByRole("button", { name: "编辑账号", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "编辑账号", exact: true });
    assert.ok(await editor.getByLabel("账号邮箱", { exact: true }).evaluate(input => input.readOnly));
    if (password !== undefined) await editor.getByLabel("新密码", { exact: true }).fill(password);
    await editor.getByLabel("辅助邮箱（选填）", { exact: true }).fill(recovery);
    await editor.getByRole("button", { name: "保存修改", exact: true }).click();
    await editor.waitFor({ state: "detached" });
  }
  await edit(undefined, "qa-edited-recovery@example.test");
  await row.getByRole("button", { name: "查看密码", exact: true }).click();
  await row.getByRole("button", { name: "隐藏密码", exact: true }).waitFor();
  assert.equal(await field.inputValue(), original, "密码留空应保留原值");
  await edit(replacement, "");
  assert.equal(await field.inputValue(), "", "保存后应清除旧明文");
  await row.getByRole("button", { name: "查看密码", exact: true }).click();
  await row.getByRole("button", { name: "隐藏密码", exact: true }).waitFor();
  assert.equal(await field.inputValue(), replacement);
  const afterProfile = (await (await context.request.get(`${base}/api/v1/profiles/${profile.id}`)).json()).data;
  assert.deepEqual(afterProfile.googleBinding, beforeProfile.googleBinding);
  assert.equal(afterProfile.state, "stopped");
  await row.getByRole("button", { name: "隐藏密码", exact: true }).click();
  await page.reload();
  await row.waitFor();
  await row.getByRole("button", { name: "查看密码", exact: true }).click();
  await row.getByRole("button", { name: "隐藏密码", exact: true }).waitFor();
  assert.equal(await field.inputValue(), replacement, "刷新后应读取持久保存的新密码");
  await row.getByRole("button", { name: "隐藏密码", exact: true }).click();

  // A disclosure finishing after navigation must not reappear when returning.
  let release, received;
  const gate = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { received = resolve; });
  const revealUrl = `${base}/api/v1/google-accounts/${account.id}/password/reveal`;
  await page.route(revealUrl, async route => {
    const response = await route.fetch();
    received();
    await gate;
    await route.fulfill({ response });
  });
  await row.getByRole("button", { name: "查看密码", exact: true }).click();
  await requested;
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "任务中心", exact: true }).click();
  await page.getByRole("heading", { name: "任务中心", exact: true }).waitFor();
  release();
  await page.unrouteAll({ behavior: "wait" });
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "账号管理", exact: true }).click();
  await row.waitFor();
  assert.equal(await field.inputValue(), "");
  const storage = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  assert.ok(!storage.includes(original) && !storage.includes(replacement));

  const artifactDir = resolve(process.env.FLEET_QA_ARTIFACT_DIR || ".tools/account-management-artifacts");
  mkdirSync(artifactDir, { recursive: true });
  for (const [name, width, height] of [["desktop", 1440, 1040], ["mobile", 390, 844]]) {
    await page.setViewportSize({ width, height });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} 目录不应横向溢出`);
    assert.ok(await page.locator(".account-manager-actions > button").evaluateAll(buttons => buttons.every(button => button.scrollWidth <= button.clientWidth)), `${name} 操作按钮文字不应溢出`);
    assert.equal(await page.getByRole("button", { name: "隐藏密码", exact: true }).count(), 0);
    await page.screenshot({ path: join(artifactDir, `accounts-${name}.png`), fullPage: true, animations: "disabled" });
    await openCreate();
    dialog = page.getByRole("dialog", { name: "新增账号", exact: true });
    await dialog.waitFor();
    assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), `${name} 表单不应横向溢出`);
    await page.screenshot({ path: join(artifactDir, `account-editor-${name}.png`), fullPage: true, animations: "disabled" });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
  }
  assert.deepEqual(errors, []);
  const finalMarker = await fetch(`${base}/__ui_qa__`).then(response => response.json());
  assert.equal(finalMarker.rejectedRuntimeCalls, 0);
  console.log("PASS: account creation, duplicate handling, imported/new password reveal, clipboard, edits, blank-password preservation, persistence, mapping preservation, late-response cleanup, desktop/mobile layout; pageErrors=0, browser runtime calls=0");
} finally { await browser.close(); }
