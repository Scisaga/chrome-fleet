import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { fixture, fixtureToken } from "../integration/helpers/fleet.ts";

// Real API + disposable SQLite + real built UI; no worker or browser containers.
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const f = await fixture({ allowedOrigins: [origin], webRoot: resolve("apps/web/dist") });
const fixedTime = Date.parse("2026-10-18T06:00:00.000Z");
const artifacts = resolve(".tools/job-history-qa-20261018");
let browser, stage = "setup";
try {
  const p = await f.create("密度图测试实例"), other = await f.create("另一个测试实例");
  const allJobs = [];
  const seed = (id, profileId, createdAt, kind = "automation", status = "succeeded") => {
    const job = { id, profileId, kind, createdAt, status, progress: 100, payload: {} };
    f.service.db.set("jobs", id, job); allJobs.push(job); return job;
  };
  for (let i = 0; i < 145; i++) seed(`job_recent_${String(i).padStart(4, "0")}`, p.id, new Date(fixedTime - i * 20 * 60_000).toISOString(), ["automation", "start", "stop", "browser_mode", "update_apply"][i % 5], i === 45 ? "running" : "succeeded");
  for (let i = 0; i < 20; i++) seed(`job_old_${String(i).padStart(4, "0")}`, p.id, new Date(fixedTime - 20 * 86_400_000 - i * 60_000).toISOString(), "snapshot");
  seed("job_other_1", other.id, new Date(fixedTime).toISOString(), "restart");
  seed("job_other_2", other.id, new Date(fixedTime - 60_000).toISOString(), "restart");
  await f.app.listen({ host: "127.0.0.1", port });
  browser = await chromium.launch({ executablePath: resolve(process.env.FLEET_QA_CHROME || ".tools/ui-chrome/chrome-linux64/chrome"), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, locale: "zh-CN", reducedMotion: "reduce" });
  const page = await context.newPage();
  const browserErrors = [], requests = [];
  let networkWrites = 0;
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/jobs") requests.push(url);
    if (url.pathname.startsWith("/api/v1/") && request.method() !== "GET" && url.pathname !== "/api/v1/session") networkWrites++;
  });
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.clock.setFixedTime(new Date(fixedTime));
  await page.goto(`${origin}/jobs`);
  await page.getByLabel("平台访问令牌").fill(fixtureToken);
  await page.getByRole("button", { name: "安全登录", exact: true }).click();
  const rows = page.locator(".job-history-table tbody tr");
  const waitRows = count => page.waitForFunction(count => document.querySelectorAll(".job-history-table tbody tr").length === count, count);
  const waitTotal = count => page.waitForFunction(count => document.querySelector(".job-density-total strong")?.textContent === String(count), count);
  const summary = () => page.locator(".job-history-summary").innerText();
  stage = "default-range-and-full-density";
  await waitRows(30); await waitTotal(147);
  assert.equal(await page.getByLabel("日期范围", { exact: true }).inputValue(), "7");
  assert.equal(await page.getByLabel("开始日期", { exact: true }).inputValue(), "2026-10-12");
  assert.equal(await page.getByLabel("结束日期", { exact: true }).inputValue(), "2026-10-18");
  assert.ok((await summary()).includes("30 / 147"));
  assert.equal(await page.locator(".job-density-column").count(), 168);
  await page.getByText("每小时汇总 · 按任务类型分色", { exact: true }).waitFor();
  assert.equal(await page.locator(".job-density-column").evaluateAll(columns => columns.reduce((sum, column) => sum + Number(column.dataset.total), 0)), 147);
  assert.equal(requests.some(url => url.searchParams.get("cursor")), false);
  await page.locator('.job-density-column:not([data-total="0"])').first().hover();
  await page.getByRole("tooltip").waitFor();
  const colors = await page.locator(".job-density-legend i").evaluateAll(items => items.map(item => getComputedStyle(item).backgroundColor));
  assert.equal(new Set(colors).size, colors.length);
  stage = "infinite-scroll";
  await page.locator(".job-history-footer").scrollIntoViewIfNeeded();
  await waitRows(60);
  assert.ok(requests.some(url => url.searchParams.get("cursor")));
  const oldIds = await rows.evaluateAll(rows => rows.map(row => row.dataset.jobId));
  assert.equal(new Set(oldIds).size, 60, "synthetic IDs should render distinctly");
  stage = "refresh-preserves-pages-and-catches-burst";
  const running = f.service.job("job_recent_0045"); running.status = "succeeded"; f.service.saveJob(running);
  for (let i = 0; i < 65; i++) seed(`job_new_${String(i).padStart(4, "0")}`, p.id, new Date(fixedTime + (i + 1) * 1000).toISOString(), "start");
  await waitRows(125); await waitTotal(212);
  assert.ok((await summary()).includes("125 / 212"));
  assert.equal(await rows.getByRole("button", { name: "取消", exact: true }).count(), 0, "older running tasks must refresh too");
  assert.equal(await rows.evaluateAll(rows => new Set(rows.map(row => row.dataset.jobId)).size), 125);
  stage = "load-more-retry";
  let failedOnce = false;
  await page.route("**/api/v1/jobs?*", route => {
    if (!failedOnce && new URL(route.request().url()).searchParams.has("cursor")) {
      failedOnce = true;
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "SYNTHETIC_FAILURE", message: "合成加载失败" }) });
    }
    return route.continue();
  });
  await page.locator(".job-history-footer").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "重试加载", exact: true }).waitFor();
  assert.equal(await rows.count(), 125);
  await page.getByRole("button", { name: "重试加载", exact: true }).click();
  await waitRows(155);
  stage = "range-reset-and-stale-responses";
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByLabel("日期范围", { exact: true }).selectOption("30");
  await waitRows(30); await waitTotal(232);
  assert.equal(await page.locator(".job-density-column").count(), 720);
  assert.ok((await summary()).includes("30 / 232"));
  let delayed;
  await page.route("**/api/v1/jobs?*", async route => {
    if (new URL(route.request().url()).searchParams.get("createdFrom") === "2026-10-11T16:00:00.000Z") {
      delayed = true; await new Promise(resolve => setTimeout(resolve, 500));
    }
    return route.fallback();
  });
  await page.getByLabel("日期范围", { exact: true }).selectOption("7");
  await page.waitForFunction(() => document.querySelector('input[aria-label="开始日期"]').value === "2026-10-12");
  await page.getByLabel("日期范围", { exact: true }).selectOption("1");
  const todayCount = allJobs.filter(job => Date.parse(job.createdAt) >= Date.parse("2026-10-17T16:00:00.000Z")).length;
  await waitTotal(todayCount); await waitRows(30);
  await page.waitForTimeout(700);
  assert.equal(delayed, true);
  assert.ok((await summary()).includes(`30 / ${todayCount}`));
  assert.equal(await page.locator(".job-density-column").count(), 24);
  stage = "empty-and-invalid-ranges";
  await page.getByLabel("开始日期", { exact: true }).fill("2026-10-01");
  await page.getByLabel("结束日期", { exact: true }).fill("2026-10-01");
  await waitTotal(0); await waitRows(0);
  await page.getByLabel("开始日期", { exact: true }).fill("2026-10-02");
  await page.getByRole("alert").filter({ hasText: "开始日期不能晚于结束日期" }).waitFor();
  assert.equal(await page.locator(".job-density-total strong").innerText(), "0");
  stage = "responsive-layout";
  await page.getByLabel("日期范围", { exact: true }).selectOption("7");
  await waitTotal(212); await waitRows(30);
  await mkdir(artifacts, { recursive: true });
  for (const width of [1920, 1440, 768, 390, 360]) {
    await page.setViewportSize({ width, height: width <= 390 ? 844 : 1080 });
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${width}: page overflow`);
    assert.equal(await page.locator(".job-range-dates").evaluate(element => [...element.querySelectorAll("input")].every(input => input.getBoundingClientRect().right <= element.getBoundingClientRect().right + 1)), true, `${width}: date overflow`);
    assert.equal(await page.locator(".job-density-columns").evaluate(element => [...element.children].every((column, index, columns) => {
      const bar = column.querySelector(".job-density-stack").getBoundingClientRect(), cell = column.getBoundingClientRect();
      return Math.abs(bar.width - cell.width) < 0.1 && (!index || Math.abs(columns[index - 1].getBoundingClientRect().right - cell.left) < 0.1);
    })), true, `${width}: hourly bars should fill adjoining columns`);
    assert.equal(await page.locator(".job-density-tick").evaluateAll(labels => labels.every((label, index) => !index || labels[index - 1].getBoundingClientRect().right <= label.getBoundingClientRect().left)), true, `${width}: time labels should not overlap`);
    await page.locator('.job-density-column:not([data-total="0"])').last().focus();
    assert.equal(await page.getByRole("tooltip").evaluate(element => {
      const tooltip = element.getBoundingClientRect(), panel = element.closest(".job-timeline").getBoundingClientRect();
      return tooltip.left >= panel.left && tooltip.right <= panel.right;
    }), true, `${width}: tooltip overflow`);
    await page.locator(".job-timeline-heading h2").click();
    if (width === 1440 || width === 390) await page.screenshot({ path: resolve(artifacts, `${width}-jobs.png`) });
  }
  stage = "profile-scope-and-out-of-range-detail";
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.goto(`${origin}/profiles/${p.id}/tasks`);
  await waitRows(30); await waitTotal(210);
  assert.equal(await page.locator(".job-history-table thead th").count(), 4);
  await page.goto(`${origin}/jobs?job=job_old_0000`);
  await page.getByRole("dialog").waitFor();
  await page.getByRole("dialog").getByText("2026年9月28日", { exact: false }).waitFor();
  await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  assert.equal(new URL(page.url()).searchParams.has("job"), false);
  assert.deepEqual(browserErrors, []);
  assert.equal(networkWrites, 0);
  console.log(JSON.stringify({ passed: true, realApi: true, maxLoaded: 155, burstInsert: 65, dateSwitchRace: true, retry: true, fullDensity: true, profileScope: true, outOfRangeDetail: true, responsiveWidths: [1920, 1440, 768, 390, 360], browserErrors: 0 }));
} catch (error) {
  console.error(`FAIL job-history stage=${stage}`); throw error;
} finally {
  await browser?.close(); await f.close();
}
