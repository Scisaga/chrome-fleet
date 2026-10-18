import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

// Visual UI coverage only: all API responses below are synthetic, and no mutations
// are allowed. Reuse `web.mjs --serve` for the isolated static frontend host.
const baseUrl = process.env.FLEET_QA_URL?.replace(/\/+$/, "");
assert.ok(baseUrl && ["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname));
assert.ok(process.env.FLEET_QA_CHROME);
assert.equal((await (await fetch(`${baseUrl}/__ui_qa__`)).json()).kind, "chrome-fleet-ui-qa");
const artifactDir = resolve(process.env.FLEET_QA_ARTIFACT_DIR || ".tools/ui-qa-artifacts");
mkdirSync(artifactDir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.FLEET_QA_CHROME, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1040 }, locale: "zh-CN" });
  const page = await context.newPage();
  const errors = [];
  const unexpectedRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const samples = [
    { name: "实时 · CPU 空闲", cpuPercent: 0, memoryBytes: 512 * 1024 ** 2 },
    { name: "实时 · 多核 CPU", cpuPercent: 200.5, memoryBytes: 1.5 * 1024 ** 3 },
    { name: "首次 CPU 采样", cpuPercent: null, memoryBytes: 256 * 1024 ** 2 },
    { name: "停止 · 隐藏旧采样", state: "stopped", cpuPercent: 88.8, memoryBytes: 999 * 1024 ** 2 },
    { name: "过期 · 隐藏旧采样", stale: true, cpuPercent: 77.7, memoryBytes: 888 * 1024 ** 2 },
    { name: "失败 · 不冒充零用量", available: false, cpuPercent: 66.6, memoryBytes: 777 * 1024 ** 2 },
  ];
  const profiles = () => samples.map((sample, index) => ({
    id: `cf_00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: sample.name, tags: [], state: sample.state || "running", desiredState: sample.state || "running", browserMode: "vnc",
    startupPolicy: "on_demand", idleTimeoutMinutes: 15, chromeVersion: "QA synthetic", accounts: [],
    resources: { cpus: 2, memoryMb: 2048, pidsLimit: 512 },
    googleBinding: { accountId: "google_qa", email: "long.synthetic.account.for.mobile.layout.review@example.test", confirmationState: "unconfirmed" },
    metrics: { available: sample.available ?? true, sampledAt: new Date(Date.now() - (sample.stale ? 20_000 : 0)).toISOString(), cpuPercent: sample.cpuPercent, memoryBytes: sample.memoryBytes, memoryLimitBytes: 2 * 1024 ** 3 },
  }));
  await context.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") { unexpectedRequests.push(`${request.method()} ${path}`); return route.abort(); }
    let data;
    if (path === "/api/v1/session") data = { authenticated: true, csrfToken: "synthetic-ui-only" };
    else if (path === "/api/v1/profiles") data = { items: profiles(), total: samples.length };
    else if (path.startsWith("/api/v1/profiles/")) data = profiles().find((profile) => path === `/api/v1/profiles/${profile.id}`);
    else if (path === "/api/v1/manual-sessions") data = { items: [], total: 0 };
    if (!data) { unexpectedRequests.push(`GET ${path}`); return route.abort(); }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data, requestId: "synthetic-ui" }) });
  });
  const card = (name) => page.locator(".profile-card").filter({ has: page.getByRole("button", { name, exact: true }) });
  await page.goto(`${baseUrl}/profiles`);
  await card(samples[0].name).locator('.resource-metrics[data-metrics-state="live"]').waitFor();
  assert.match(await card(samples[0].name).locator(".resource-metrics").textContent(), /0\.0%.*512 MiB \/ 2 GiB/);
  assert.match(await card(samples[1].name).locator(".resource-metrics").textContent(), /200\.5%.*1\.5 GiB \/ 2 GiB/);
  assert.match(await card(samples[2].name).locator(".resource-metrics").textContent(), /CPU采样中.*256 MiB \/ 2 GiB/);
  for (const [index, state, forbidden] of [[3, "stopped", "88.8%"], [4, "stale", "77.7%"], [5, "unavailable", "66.6%"]]) {
    await card(samples[index].name).locator(`.resource-metrics[data-metrics-state="${state}"]`).waitFor();
    assert.ok(!(await card(samples[index].name).locator(".resource-metrics").textContent()).includes(forbidden));
  }
  await page.screenshot({ path: join(artifactDir, "resources-desktop.png"), fullPage: true });
  await card(samples[1].name).getByRole("button", { name: samples[1].name, exact: true }).click();
  await page.locator(".resource-metrics-detail").getByText("200.5%", { exact: true }).waitFor();
  await page.locator(".resource-metrics-detail").getByText(/单核 100%/).waitFor();
  await page.locator(".resource-metrics-detail time").waitFor();
  await page.screenshot({ path: join(artifactDir, "resources-detail.png"), fullPage: true });
  await page.getByRole("tab", { name: "账号状态", exact: true }).click();
  const binding = page.locator(".vnc-google-binding-panel");
  const progress = binding.locator(".google-login-progress");
  const confirm = progress.getByRole("button", { name: "确认已登录", exact: true });
  const actionBox = await binding.locator(":scope > .heading-actions").boundingBox();
  const progressBox = await progress.boundingBox();
  const confirmBox = await confirm.boundingBox();
  const explanationBox = await progress.locator(":scope > p").first().boundingBox();
  assert.ok(actionBox.y - (progressBox.y + progressBox.height) >= 15, "外部操作与状态块应留出16px间距");
  assert.ok(confirmBox.y - (explanationBox.y + explanationBox.height) >= 11, "确认按钮与说明应留出12px间距");
  await page.screenshot({ path: join(artifactDir, "binding-spacing-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector(".sidebar").getBoundingClientRect().right <= 0);
  await page.getByRole("button", { name: "换绑账号", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "390px长账号绑定页不得水平溢出");
  await page.screenshot({ path: join(artifactDir, "binding-spacing-mobile.png"), fullPage: true });
  await page.goto(`${baseUrl}/profiles`);
  await card(samples[0].name).locator(".resource-metrics").waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "390px资源卡片不得水平溢出");
  await page.screenshot({ path: join(artifactDir, "resources-mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpectedRequests, []);
  console.log(`通过：CPU零值/多核、首帧保留内存、停止/过期/失败隐藏旧读数、详情时间与单位、390px长账号无溢出及确认区间距。纯合成截图：${artifactDir}`);
} finally { await browser.close(); }
