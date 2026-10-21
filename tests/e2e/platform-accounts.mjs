import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { fixture, fixtureToken, eventually } from "../integration/helpers/fleet.ts";

// Disposable control plane and fake Runner. This test never requests Google or any external platform.
const port = Number(process.env.FLEET_PLATFORM_QA_PORT || 19483);
const origin = `http://127.0.0.1:${port}`;
const output = resolve(process.env.FLEET_PLATFORM_QA_OUTPUT || ".tools/manual-accounts-20261022/e2e");
mkdirSync(output, { recursive: true });
const f = await fixture({ port, publicUrl: origin, allowedOrigins: ["http://127.0.0.1:8080"], webRoot: resolve("apps/web/dist") });
const browser = await chromium.launch({ executablePath: process.env.FLEET_QA_CHROME || "/usr/bin/google-chrome", headless: true });
let page, timer;
const accountRequests = [], externalRequests = [], errors = [];
try {
  const owner = (await f.request("POST", "/api/v1/google-accounts", { email: "manual-owner@example.test", password: "synthetic-only-password" })).json().data;
  const profile = (await f.request("POST", "/api/v1/profiles", { name: "人工确认合成实例", browserMode: "vnc", accountAlias: owner.email })).json().data;
  const autoOwner = (await f.request("POST", "/api/v1/google-accounts", { email: "automation-owner@example.test", password: "synthetic-only-password" })).json().data;
  const automation = (await f.request("POST", "/api/v1/profiles", { name: "自动化人工确认实例", browserMode: "automation", accountAlias: autoOwner.email })).json().data;
  const legacy = f.service.db.list("accounts").find(row => row.profileId === automation.id);
  f.service.db.set("accounts", legacy.id, { ...legacy, authState: "needs_login", lastVerificationSource: "account_page", lastCheckedAt: "2026-10-01T00:00:00Z" });
  const agent = f.service.agent.bind(f.service);
  f.service.agent = async (p, path, body, token, timeout) => {
    if (path.startsWith("/accounts/")) { accountRequests.push(path); throw new Error("account browser access is forbidden"); }
    return agent(p, path, body, token, timeout);
  };
  await f.app.listen({ host: "127.0.0.1", port });
  timer = setInterval(() => void f.service.tick(), 30);
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN", reducedMotion: "reduce" });
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(origin + "/")) externalRequests.push(new URL(request.url()).origin); });
  await page.goto(`${origin}/platforms`);
  await page.getByLabel("平台访问令牌").fill(fixtureToken);
  await page.getByRole("button", { name: "安全登录", exact: true }).click();
  await page.getByRole("heading", { name: "平台管理", exact: true }).waitFor();
  await page.getByRole("button", { name: "新增平台", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "新增平台" });
  for (const [label, value] of [["平台名称", "合成视频平台"], ["平台首页", "https://platform.example.test/"], ["登录入口", "https://platform.example.test/login"], ["账户设置页", "https://platform.example.test/settings"]])
    await editor.getByLabel(label, { exact: true }).fill(value);
  assert.equal(await editor.getByText("身份读取规则", { exact: true }).count(), 0);
  await editor.getByRole("button", { name: "保存平台", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  const platform = f.service.platforms.list().find(row => row.name === "合成视频平台"); assert.ok(platform);
  await page.goto(`${origin}/profiles/${profile.id}/accounts`);
  await page.getByRole("button", { name: "登记关联平台", exact: true }).click();
  const link = page.getByRole("dialog", { name: "登记关联平台" });
  await link.getByLabel("关联平台", { exact: true }).selectOption(platform.id);
  await link.getByRole("checkbox").check();
  await link.getByRole("button", { name: "登记关联", exact: true }).click();
  await link.waitFor({ state: "hidden" });
  const row = page.locator(`.platform-account-row[data-platform-id="${platform.id}"]`);
  await row.getByText("待人工确认", { exact: true }).waitFor();
  await row.getByRole("button", { name: "确认已登录", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "人工确认平台登录" });
  await confirmation.getByLabel("平台账号 ID", { exact: true }).fill("uid-123");
  await confirmation.getByLabel("昵称（选填）", { exact: true }).fill("合成用户一");
  await confirmation.getByRole("checkbox").check();
  await confirmation.getByRole("button", { name: "保存人工确认", exact: true }).click();
  await confirmation.waitFor({ state: "hidden" });
  await row.getByText("已人工确认登录", { exact: true }).waitFor();
  await row.getByText("合成用户一", { exact: true }).waitFor();
  assert.equal(await row.getByRole("button", { name: "确认已登录", exact: true }).count(), 0);
  assert.equal(f.service.profile(profile.id).state, "stopped");
  assert.equal(f.service.db.list("jobs").length, 0);
  await row.getByRole("button", { name: "更新登录确认", exact: true }).click();
  await confirmation.waitFor();
  assert.equal(await confirmation.getByLabel("平台账号 ID", { exact: true }).getAttribute("readonly"), "");
  await confirmation.getByLabel("昵称（选填）", { exact: true }).fill("合成用户二");
  await confirmation.getByRole("checkbox").check();
  await confirmation.getByRole("button", { name: "保存人工确认", exact: true }).click();
  await confirmation.waitFor({ state: "hidden" });
  await row.getByText("合成用户二", { exact: true }).waitFor();
  await page.locator(".google-account-panel").getByRole("button", { name: "确认已登录", exact: true }).click();
  await eventually(() => f.service.google.binding(profile.id)?.confirmationState === "confirmed", "Google manually confirmed");
  await page.locator(".google-account-panel").getByRole("button", { name: "更新登录确认", exact: true }).waitFor();
  assert.equal(await page.locator(".google-account-panel").getByRole("button", { name: "确认已登录", exact: true }).count(), 0);
  await page.waitForFunction(() => [...document.querySelectorAll(".google-account-panel button")].some(button => button.textContent === "更新登录确认" && !button.disabled));
  for (const button of [row.getByRole("button", { name: "更新登录确认", exact: true }), page.locator(".google-account-panel").getByRole("button", { name: "更新登录确认", exact: true })]) {
    assert.equal(await button.evaluate(element => element.classList.contains("primary")), false, "confirmed actions are secondary");
    assert.notEqual(await button.evaluate(element => getComputedStyle(element).backgroundColor), "rgb(113, 96, 211)", "confirmed actions lose the primary background");
  }
  await page.screenshot({ path: `${output}/instance-manual-platforms.png`, fullPage: true });
  await page.goto(`${origin}/profiles/${automation.id}/accounts`);
  await page.locator(".google-account-panel").getByRole("button", { name: "确认已登录", exact: true }).click();
  await eventually(() => f.service.google.binding(automation.id)?.confirmationState === "confirmed", "automation also manual");
  assert.equal(f.service.db.get("accounts", legacy.id).historicalVerification.authState, "needs_login");
  await page.goto(`${origin}/accounts`);
  const directory = page.getByRole("article", { name: `账号 ${owner.email}`, exact: true });
  await directory.getByRole("button", { name: "更新登录确认", exact: true }).waitFor();
  assert.equal(await directory.getByRole("button", { name: "确认已登录", exact: true }).count(), 0);
  await directory.locator("summary").click();
  await directory.getByText("合成用户二", { exact: true }).waitFor();
  assert.equal(await directory.locator(".platform-account-row button").count(), 0, "platform confirmation lives only in instance details");
  await page.screenshot({ path: `${output}/directory-readonly-platforms.png`, fullPage: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const path of ["/platforms", "/profiles", `/profiles/${profile.id}/accounts`, `/profiles/${automation.id}/accounts`, "/accounts"]) {
      await page.goto(`${origin}${path}`);
      await page.locator("main h1").first().waitFor();
      assert.equal(await page.getByRole("button", { name: /检测账户登录|重新检测/ }).count(), 0);
      assert.equal(await page.getByText("Google · 需要登录", { exact: true }).count(), 0);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      assert.equal(overflow, false, `${width}px ${path}`);
      if (path === "/profiles") assert.equal(await page.locator(".profile-card .platform-account-actions button").count(), 0);
    }
    await page.screenshot({ path: `${output}/accounts-${width}.png`, fullPage: true });
  }
  // Manual confirmation is safe even while the person's desktop lease is active.
  const opened = await f.request("POST", `/api/v1/profiles/${profile.id}/platforms/${platform.id}/login`, {});
  assert.equal(opened.statusCode, 200, opened.body);
  await page.goto(`${origin}/profiles/${profile.id}/accounts`);
  await row.getByRole("button", { name: "更新登录确认", exact: true }).click();
  await confirmation.getByRole("checkbox").check();
  await confirmation.getByRole("button", { name: "保存人工确认", exact: true }).click();
  await confirmation.waitFor({ state: "hidden" });
  assert.equal(f.service.db.get("manual-sessions", opened.json().data.id).closed, false);
  const secondProfile = (await f.request("POST", "/api/v1/profiles", { name: "第二个人工接管实例", browserMode: "vnc" })).json().data;
  const secondOpened = await f.request("POST", `/api/v1/profiles/${secondProfile.id}/manual-sessions`, { explicitStart: true });
  assert.equal(secondOpened.statusCode, 201, secondOpened.body);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${origin}/profiles`);
    const panel = page.getByRole("region", { name: "人工接管信息", exact: true });
    await panel.locator(".desktop-session-banner").nth(1).waitFor();
    assert.equal(await panel.count(), 1);
    const rows = await panel.locator(".desktop-session-banner").evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { top: box.top, bottom: box.bottom, borderTop: style.borderTopWidth, marginBottom: style.marginBottom };
    }));
    assert.equal(rows.length, 2);
    assert.ok(Math.abs(rows[1].top - rows[0].bottom) < 1, "takeover rows share an edge without a gap");
    assert.equal(rows[0].borderTop, "0px");
    assert.equal(rows[1].borderTop, "1px");
    assert.ok(rows.every(row => row.marginBottom === "0px"));
    assert.equal(await panel.getByRole("button", { name: "结束人工接管", exact: true }).count(), 2);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${width}px grouped takeover panel`);
    await page.screenshot({ path: `${output}/takeover-panel-${width}.png`, fullPage: true });
  }
  await f.request("DELETE", `/api/v1/manual-sessions/${secondOpened.json().data.id}`);
  await f.request("DELETE", `/api/v1/manual-sessions/${opened.json().data.id}`);
  await page.goto(`${origin}/profiles/${profile.id}/accounts`);
  await row.getByRole("button", { name: "解除关联", exact: true }).waitFor();
  assert.equal(await page.locator(".desktop-session-panel").count(), 0, "no empty takeover panel after sessions close");
  await row.getByRole("button", { name: "解除关联", exact: true }).click();
  await page.getByText("尚未登记关联平台", { exact: true }).waitFor();
  for (const suffix of ["accounts/check", "google-login/check"]) assert.equal((await f.request("POST", `/api/v1/profiles/${automation.id}/${suffix}`, {})).statusCode, 410);
  assert.equal(f.service.profile(automation.id).state, "stopped");
  assert.equal(f.service.profile(profile.id).browserMode, "vnc");
  assert.equal(f.service.db.list("jobs").length, 0);
  assert.deepEqual(accountRequests, []); assert.deepEqual(externalRequests, []); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, scenarios: ["平台手动地址配置", "无检测规则", "VNC 关联登记", "人工填写唯一身份", "昵称更新", "原身份只读", "Google 双模式人工确认", "已确认按钮降级", "不启动浏览器或切换模式", "历史自动结果隔离", "账号目录与实例一致", "平台确认仅在详情页", "卡片无检测按钮", "1440/390px 布局", "人工租约不受确认影响", "多条接管共用面板与细分隔线", "无会话时隐藏面板", "解除关联", "旧检测接口停用", "零账号页面访问"], screenshots: output }));
} catch (error) {
  if (page) await page.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => {});
  throw error;
} finally {
  clearInterval(timer); await browser.close(); await f.close();
}
