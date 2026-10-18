import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { chromium } from "playwright";

// Standalone, synthetic-only layout QA. This serves the real built frontend on
// an OS-assigned loopback port; it never starts a control plane, worker, Runner,
// Docker container, database, or Vault. No external service URL/token is accepted.
// Run after `npm run build -w @chrome-fleet/web`:
// env -u NODE_TLS_REJECT_UNAUTHORIZED FLEET_QA_CHROME=.tools/ui-chrome/chrome-linux64/chrome \
//   LD_LIBRARY_PATH=.tools/qa-libs/root/usr/lib/x86_64-linux-gnu \
//   FONTCONFIG_FILE=.tools/ui-fontconfig.xml node tests/e2e/layout.mjs
// Optional: FLEET_LAYOUT_SCREENSHOTS=1 saves synthetic pages with empty passwords.
const bundleRoot = resolve("apps/web/dist");
const artifactRoot = resolve(process.env.FLEET_LAYOUT_ARTIFACT_DIR || ".tools/layout-qa-artifacts");
const executablePath = resolve(process.env.FLEET_QA_CHROME || ".tools/ui-chrome/chrome-linux64/chrome");
const screenshots = process.env.FLEET_LAYOUT_SCREENSHOTS === "1";
const fixedTime = "2026-10-17T01:00:00.000Z";
const profileId = (n) => `cf_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const accounts = Array.from({ length: 6 }, (_, i) => ({
  id: `google_layout_${i + 1}`,
  email: i === 0 ? "long.synthetic.account.for.layout.review@example.test" : `layout-${i + 1}@example.test`,
  recoveryEmail: `synthetic-recovery-${i + 1}@example.test`,
  bindings: i < 5 ? [{ profileId: profileId(i + 1), profileName: `合成布局实例 ${i + 1}` }] : [],
}));
const profiles = () => Array.from({ length: 6 }, (_, i) => ({
  id: profileId(i + 1),
  name: i === 2 ? "合成布局实例 · 较长的项目名称用于检查换行和对齐" : `合成布局实例 ${i + 1}`,
  tags: i % 3 === 0 ? ["合成测试", "独立工作环境"] : i % 3 === 1 ? ["QA"] : [],
  state: i % 3 === 0 ? "running" : "stopped",
  desiredState: i % 3 === 0 ? "running" : "stopped",
  browserMode: i === 1 || i === 3 || i === 4 ? "automation" : "vnc",
  startupPolicy: "on_demand", idleTimeoutMinutes: 15, headless: i === 3,
  chromeVersion: "155.0.8059.79", playwrightVersion: "1.64.1",
  image: "chrome-fleet/browser:synthetic-layout", imageDigest: `sha256:${"a".repeat(64)}`,
  createdAt: fixedTime, lastActivityAt: fixedTime,
  resources: { cpus: 2, memoryMb: 2048, pidsLimit: 512 },
  proxy: { enabled: true, scheme: "http", host: "proxy.example.test", port: 8080, bypass: "", version: 2, appliedVersion: 2, hasCredentials: false },
  remoteDesktop: { passwordConfigured: true, version: 1, appliedVersion: 1 },
  health: { ready: true, sandboxEnabled: true, keyring: { unlocked: true, probeVerified: true } },
  metrics: { available: true, sampledAt: new Date().toISOString(), cpuPercent: i * 24.5, memoryBytes: (i + 1) * 128 * 1024 ** 2, memoryLimitBytes: 2 * 1024 ** 3, pids: 34, diskBytes: 1024 ** 3 },
  accounts: i < 5 ? [{ id: `account_layout_${i + 1}`, provider: "google", alias: accounts[i].email, expectedIdentity: accounts[i].email, authState: i === 1 || i === 2 ? "manually_confirmed" : i === 4 ? "authenticated" : "unknown", boundAt: fixedTime, ...(i === 1 || i === 2 ? { lastConfirmedAt: fixedTime } : {}) }] : [],
  ...(i < 5 ? { googleBinding: { accountId: accounts[i].id, email: accounts[i].email, confirmationState: i === 1 || i === 2 ? "confirmed" : "unconfirmed", ...(i === 1 || i === 2 ? { lastConfirmedAt: fixedTime } : {}) } } : {}),
}));
const jobs = ["succeeded", "waiting_for_human", "queued"].map((state, i) => ({
  id: `job_00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  profileId: profileId(2), kind: i === 0 ? "snapshot" : "automation", state,
  createdAt: fixedTime, finishedAt: i === 0 ? fixedTime : undefined,
  steps: [{ action: "goto", url: "https://example.test" }],
}));
const versions = [{ id: "version_layout", version: "155.0.8059.79", chromeVersion: "155.0.8059.79", distribution: "google", validated: true, prepared: true }];
const policy = { mode: "notify", paused: false, checkIntervalHours: 24, maintenanceStart: "02:00", maintenanceEnd: "05:00" };
const rejectedRequests = [];
const requestCounts = new Map();
const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};
function fixtureData(url) {
  const path = url.pathname.slice("/api/v1".length);
  if (path === "/session") return { authenticated: true, csrfToken: "synthetic-layout-only" };
  if (path === "/host-metrics") return { scope: "host", available: true, sampledAt: new Date().toISOString(), cpuPercent: 23.4, cpuCount: 8, memoryBytes: 10.5 * 1024 ** 3, memoryTotalBytes: 32 * 1024 ** 3, memoryPercent: 32.8125 };
  if (path === "/profiles") return { items: profiles(), total: 6 };
  if (path === "/google-accounts") return { items: accounts, total: accounts.length };
  if (path === "/manual-sessions") return { items: [], total: 0 };
  if (path === "/jobs") {
    const filtered = jobs.filter((job) => !url.searchParams.has("profileId") || job.profileId === url.searchParams.get("profileId"));
    return { items: filtered, total: filtered.length, nextCursor: null };
  }
  if (path === "/jobs/density") {
    const from = Date.parse(url.searchParams.get("createdFrom")), before = Date.parse(url.searchParams.get("createdBefore"));
    const intervalMs = 3_600_000;
    const filtered = jobs.filter(job => (!url.searchParams.has("profileId") || job.profileId === url.searchParams.get("profileId")) && Date.parse(job.createdAt) >= from && Date.parse(job.createdAt) < before);
    const buckets = Array.from({ length: Math.ceil((before - from) / intervalMs) }, (_, i) => ({ start: new Date(from + i * intervalMs).toISOString(), end: new Date(Math.min(before, from + (i + 1) * intervalMs)).toISOString(), total: 0, counts: {} }));
    const totals = {};
    for (const job of filtered) {
      const bucket = buckets[Math.floor((Date.parse(job.createdAt) - from) / intervalMs)];
      bucket.total++; bucket.counts[job.kind] = (bucket.counts[job.kind] || 0) + 1;
      totals[job.kind] = (totals[job.kind] || 0) + 1;
    }
    return { total: filtered.length, intervalMs, buckets, kinds: Object.keys(totals).map(kind => ({ kind, total: totals[kind] })) };
  }
  if (path.startsWith("/jobs/")) return jobs.find((job) => path === `/jobs/${job.id}`);
  if (path === "/browser-versions") return { items: versions, total: versions.length };
  if (path === "/update-policy") return policy;
  if (path === "/updates") return { items: [], total: 0 };
  const match = path.match(/^\/profiles\/(cf_[a-f0-9-]+)(?:\/(accounts|snapshots))?$/);
  if (match) {
    const profile = profiles().find((p) => p.id === match[1]);
    if (!profile) return undefined;
    if (match[2] === "accounts") return { items: profile.accounts, total: profile.accounts.length };
    if (match[2] === "snapshots") return { items: [{ id: "snapshot_layout_only", profileId: profile.id, createdAt: fixedTime, chromeVersion: profile.chromeVersion, sizeBytes: 123456 }], total: 1 };
    return profile;
  }
  return undefined;
}
const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const bundleHtml = await readFile(join(bundleRoot, "index.html"), "utf8");
const bundleAssets = [...bundleHtml.matchAll(/(?:src|href)="(\/assets\/[^"<>]+)"/g)].map((match) => match[1]);
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      rejectedRequests.push("MCP_PROTOCOL_FORBIDDEN");
      return json(res, 405, { code: "SYNTHETIC_MCP_PROTOCOL_FORBIDDEN" });
    }
    if (req.method !== "GET") {
      rejectedRequests.push("MUTATION_FORBIDDEN");
      return json(res, 405, { code: "SYNTHETIC_LAYOUT_READ_ONLY" });
    }
    if (url.pathname === "/__layout_qa__") return json(res, 200, { kind: "chrome-fleet-layout-synthetic", workerStarted: false, runnerAvailable: false });
    if (url.pathname.startsWith("/api/v1/")) {
      requestCounts.set(url.pathname, (requestCounts.get(url.pathname) || 0) + 1);
      const data = fixtureData(url);
      if (data === undefined) {
        rejectedRequests.push(`UNKNOWN_API:${url.pathname}`);
        return json(res, 404, { code: "SYNTHETIC_API_NOT_DEFINED" });
      }
      return json(res, 200, { data, requestId: "synthetic-layout" });
    }
    const pathname = decodeURIComponent(url.pathname);
    const relativeFile = extname(pathname) ? pathname.replace(/^\/+/, "") : "index.html";
    const file = resolve(bundleRoot, relativeFile);
    if (!file.startsWith(bundleRoot + sep)) return json(res, 404, { code: "NOT_FOUND" });
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": contentTypes[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    json(res, 404, { code: "SYNTHETIC_FILE_NOT_FOUND" });
  }
});
await new Promise((done, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", done);
});
const origin = `http://127.0.0.1:${server.address().port}`;
assert.equal((await (await fetch(`${origin}/__layout_qa__`)).json()).kind, "chrome-fleet-layout-synthetic");
const checks = [];
const failures = [];
let browser;
let stage = "launch";
try {
  await mkdir(artifactRoot, { recursive: true });
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ locale: "zh-CN", reducedMotion: "reduce" });
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      rejectedRequests.push("NON_LOOPBACK_FIXTURE_ORIGIN");
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", () => browserErrors.push("PAGE_ERROR"));
  const allScenarios = [
    { name: "profiles", path: "/profiles", ready: ".profile-card", cards: true },
    { name: "create-account", path: `/profiles/new?from=accounts&account=${accounts[5].id}`, ready: ".create-profile-form", create: true, prefilled: true },
    ...["overview", "settings", "accounts", "tasks", "sessions", "updates"].map((tab) => ({ name: `automation-${tab}`, path: `/profiles/${profileId(2)}/${tab}`, ready: tab === "settings" ? ".settings-layout" : ".detail-content > :first-child" })),
    ...["settings", "accounts"].map((tab) => ({ name: `vnc-${tab}`, path: `/profiles/${profileId(1)}/${tab}`, ready: tab === "settings" ? ".settings-layout" : ".vnc-google-binding-panel" })),
    { name: "accounts", path: "/accounts", ready: ".account-manager-row" },
    { name: "jobs", path: "/jobs", ready: "tbody tr" },
    { name: "updates", path: "/updates", ready: ".version-list" },
    { name: "guide", path: "/guide", ready: ".guide-card" },
    { name: "mcp", path: "/integrations/mcp", ready: ".mcp-page [data-mcp-tool]" },
  ];
  const requestedPages = process.env.FLEET_LAYOUT_PAGES?.split(",").filter(Boolean);
  if (requestedPages) assert.ok(requestedPages.every((name) => allScenarios.some((scenario) => scenario.name === name)), "布局页面筛选必须使用已定义的合成场景");
  const scenarios = requestedPages ? allScenarios.filter((scenario) => requestedPages.includes(scenario.name)) : allScenarios;
  for (const width of [1440, 1920, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1080 });
    for (const scenario of scenarios) {
      stage = `${width}:${scenario.name}`;
      await page.goto(origin + scenario.path, { waitUntil: "networkidle" });
      await page.locator(scenario.ready).first().waitFor();
      if (scenario.prefilled) {
        await page.waitForFunction((email) => document.querySelector('input[name="accountAlias"]')?.value === email, accounts[5].email);
      }
      if (scenario.create) {
        assert.equal(await page.getByRole("dialog").count(), 0, "创建应为标准页面");
        await page.getByLabel("启用代理", { exact: true }).check();
        await page.locator(".advanced-options > summary").click();
      }
      const mcp = scenario.name === "mcp" ? await checkMcpPage(page, origin) : undefined;
      const loginCredentials = scenario.name === "vnc-accounts" ? await checkLoginCredentials(page, origin) : undefined;
      const accountActions = scenario.name === "accounts" ? await checkAccountActions(page, origin) : undefined;
      const hostMetrics = scenario.name === "profiles" ? await checkHostMetrics(page, origin) : undefined;
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(80);
      const result = await measure(page, { cards: Boolean(scenario.cards), updates: scenario.name === "updates" || scenario.name === "automation-updates", search: scenario.name === "profiles" || scenario.name === "accounts" || scenario.name === "mcp" });
      if (scenario.cards) await checkProfileConfirmations(page, origin, width === 1440 || width === 390);
      checks.push({ viewport: width, page: scenario.name, ...result, ...(mcp ? { mcp } : {}), ...(loginCredentials ? { loginCredentials } : {}), ...(accountActions ? { accountActions } : {}), ...(hostMetrics ? { hostMetrics } : {}) });
      failures.push(...result.failures.map((code) => ({ viewport: width, page: scenario.name, code })));
      if (screenshots && ["profiles", "create-account", "automation-settings", "vnc-accounts", "accounts", "jobs", "updates", "guide", "mcp"].includes(scenario.name)) {
        assert.equal(await page.locator('input[type="password"]').evaluateAll((inputs) => inputs.some((input) => input.value.length > 0)), false, "截图前密码字段必须为空");
        await page.screenshot({ path: join(artifactRoot, `${width}-${scenario.name}.png`), fullPage: true });
      }
    }
    // Exercise narrow-screen navigation without opening any desktop or mutation.
    if (width === 390) {
      const menu = page.getByRole("button", { name: "打开导航", exact: true });
      if (await menu.count()) {
        await menu.click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "手机导航不得横溢");
      }
    }
  }
  assert.deepEqual(browserErrors, [], "真实 bundle 不应有浏览器运行错误");
  assert.deepEqual(rejectedRequests, [], "不得有未定义 API、写请求或外部请求");
  const report = { kind: "chrome-fleet-layout-synthetic", bundleAssets, scenarios: checks.length, viewports: [1440, 1920, 390], screenshots, checks, failures, apiRequests: [...requestCounts.values()].reduce((sum, n) => sum + n, 0), rejectedRequests: rejectedRequests.length, browserErrors: browserErrors.length };
  await writeFile(join(artifactRoot, "report.json"), JSON.stringify(report, null, 2) + "\n");
  assert.equal(failures.length, 0, `布局断言失败 ${failures.length} 项；详见合成 report.json`);
  console.log(`PASS layout: ${checks.length} synthetic pages; 1440/1920/390px; overflow/alignment/spacing; mutations=0 external=0 browserErrors=0`);
} catch (error) {
  // Only a fixed stage/code is printed. The fixture contains no credentials.
  console.error(`FAIL layout stage=${stage} code=${error?.code || error?.name || "CHECK_FAILED"}`);
  if (failures.length) {
    const counts = {};
    for (const failure of failures) {
      const code = failure.code.split(":")[0];
      counts[code] = (counts[code] || 0) + 1;
    }
    console.error(JSON.stringify({ failures: failures.length, counts, report: "report.json" }));
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}

async function checkProfileConfirmations(page, origin, navigate) {
  for (const profile of profiles()) {
    const card = page.locator(".profile-card").filter({ has: page.getByRole("button", { name: profile.name, exact: true }) });
    const entry = card.locator(".card-account-entry");
    const confirmed = profile.googleBinding?.confirmationState === "confirmed";
    const label = profile.googleBinding ? confirmed ? "已人工确认登录" : "待人工确认登录" : "账号关联待完善";
    await entry.getByText(label, { exact: true }).waitFor();
    assert.ok(await entry.isEnabled(), "查看账号确认记录不应受无头模式或运行状态限制");
    assert.equal(await card.getByRole("button", { name: /Google 登录/ }).count(), 0, "卡片主入口应基于人工确认状态");
    if (!navigate) continue;
    await entry.click();
    await page.waitForURL(`${origin}/profiles/${profile.id}/accounts`);
    if (profile.browserMode === "automation" && profile.googleBinding) {
      const summary = page.locator(".profile-confirmation-summary");
      await summary.getByText(label, { exact: true }).waitFor();
      await summary.getByText(profile.googleBinding.email, { exact: true }).waitFor();
      if (confirmed) await summary.getByText("人工确认时间", { exact: true }).waitFor();
      else await summary.getByRole("button", { name: "前往实例设置", exact: true }).waitFor();
    } else await page.locator(".vnc-google-binding-panel").waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0, "状态入口不得自动打开登录弹窗");
    await page.getByRole("button", { name: "返回全部实例", exact: true }).click();
    await page.waitForURL(`${origin}/profiles`);
    await page.locator(".profile-card").last().waitFor();
  }
}

async function checkMcpPage(page, origin) {
  const path = "/integrations/mcp";
  const nav = page.getByRole("navigation", { name: "主导航" });
  const mcpNav = nav.locator(".nav-item").filter({ hasText: /^MCP$/ });
  const tools = page.locator(".mcp-page [data-mcp-tool]");
  const assertSelected = async () => {
    assert.equal(new URL(page.url()).pathname, path, "MCP 管理页须使用独立地址");
    assert.ok((await mcpNav.getAttribute("class"))?.split(/\s+/).includes("active"), "MCP 主菜单应选中");
    assert.equal(await mcpNav.getAttribute("aria-current"), "page");
    await page.locator(".mcp-page h1").waitFor();
    assert.ok((await page.locator(".mcp-page h1").textContent())?.trim().startsWith("MCP"));
  };
  await assertSelected();
  assert.equal(await tools.count(), 35, "MCP 应展示全部 35 项工具");
  const address = page.getByLabel("MCP 服务地址", { exact: true });
  assert.equal(await address.inputValue(), `${origin}/mcp`, "服务地址仅由当前 origin 派生");
  assert.equal(await address.evaluate((input) => input.readOnly), true, "服务地址应只读");
  const search = page.getByLabel("搜索 MCP 功能", { exact: true });
  await search.fill("browser_fill");
  await page.waitForFunction(() => document.querySelectorAll(".mcp-page [data-mcp-tool]").length === 1);
  assert.equal(await tools.first().getAttribute("data-mcp-tool"), "browser_fill");
  await search.fill("");
  await page.waitForFunction(() => document.querySelectorAll(".mcp-page [data-mcp-tool]").length === 35);
  // Capture a synthetic origin string inside this page only; never write the
  // system clipboard or read any existing clipboard content.
  await page.evaluate(() => {
    window.__layoutClipboardWrites = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value) => { window.__layoutClipboardWrites.push(value); } },
    });
    document.execCommand = (command) => {
      if (command !== "copy") return false;
      const input = document.activeElement;
      if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return false;
      window.__layoutClipboardWrites.push(input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0));
      return true;
    };
  });
  await page.getByRole("button", { name: "复制地址", exact: true }).click();
  await page.waitForFunction(() => window.__layoutClipboardWrites.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__layoutClipboardWrites), [`${origin}/mcp`], "复制不得包含其它信息");
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".mcp-page").waitFor();
  await assertSelected();
  const clickNavigation = async (button) => {
    if (page.viewportSize().width < 760) await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await button.click();
  };
  await clickNavigation(nav.locator(".nav-item").filter({ hasText: /^浏览器实例/ }));
  await page.waitForURL(`${origin}/profiles`);
  await page.locator(".profile-card").first().waitFor();
  assert.ok(!(await mcpNav.getAttribute("class"))?.split(/\s+/).includes("active"));
  await clickNavigation(mcpNav);
  await page.waitForURL(`${origin}${path}`);
  await page.locator(".mcp-page").waitFor();
  await assertSelected();
  await page.goBack();
  await page.waitForURL(`${origin}/profiles`);
  await page.locator(".profile-card").first().waitFor();
  await page.goForward();
  await page.waitForURL(`${origin}${path}`);
  await page.locator(".mcp-page").waitFor();
  await assertSelected();
  assert.equal(await tools.count(), 35);
  if (page.viewportSize().width < 760) await page.waitForFunction(() => document.querySelector(".sidebar").getBoundingClientRect().right <= 0);
  return { tools: 35, filteredTools: 1, copiedAddressOnly: true, direct: true, refreshed: true, menuSelected: true, backForward: true };
}

async function checkHostMetrics(page, origin) {
  const panel = page.getByRole("region", { name: "宿主机资源使用", exact: true });
  const cpu = panel.locator(".host-metric strong").nth(0);
  const memory = panel.locator(".host-metric strong").nth(1);
  await page.waitForFunction(() => document.querySelector(".host-metrics")?.dataset.hostMetricsState === "live");
  assert.equal(await cpu.textContent(), "23.4%");
  assert.equal(await memory.textContent(), "32.8%");
  assert.ok((await panel.textContent()).includes("10.5 GiB / 32 GiB"));
  const endpoint = `${origin}/api/v1/host-metrics`;
  let mode = "zero", reads = 0;
  const handler = async route => {
    reads++;
    const value = { ...fixtureData(new URL(endpoint)), cpuPercent: mode === "zero" ? 0 : mode === "sampling" ? null : 23.4, memoryBytes: mode === "zero" ? 0 : 10.5 * 1024 ** 3, sampledAt: new Date(Date.now() - (mode === "stale" ? 20000 : 0)).toISOString() };
    return route.fulfill({ status: mode === "unavailable" ? 503 : 200, contentType: "application/json", body: JSON.stringify(mode === "unavailable" ? { code: "HOST_READ_FAILED", message: "synthetic-internal-diagnostic" } : { data: value }) });
  };
  await page.route(endpoint, handler);
  const refresh = async state => {
    const response = page.waitForResponse(endpoint);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await response;
    await page.waitForFunction(state => document.querySelector(".host-metrics")?.dataset.hostMetricsState === state, state);
  };
  try {
    // Wait for the real interval, without clicking or triggering a refresh event.
    await page.waitForResponse(endpoint, { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector(".host-metric strong")?.textContent === "0.0%");
    assert.equal(await memory.textContent(), "0.0%", "真实测得的零占用不能显示为不可用");
    mode = "sampling"; await refresh("sampling");
    assert.equal(await cpu.textContent(), "采样中");
    assert.equal(await memory.textContent(), "32.8%");
    mode = "stale"; await refresh("stale");
    assert.equal(await cpu.textContent(), "已过期");
    assert.equal(await memory.textContent(), "已过期");
    assert.ok(!(await panel.textContent()).includes("10.5 GiB"));
    mode = "unavailable"; await refresh("unavailable");
    assert.equal(await cpu.textContent(), "不可用");
    assert.ok(!(await panel.textContent()).includes("synthetic-internal-diagnostic"));
    mode = "live"; await refresh("live");
    assert.equal(await cpu.textContent(), "23.4%");
    return { intervalPolling: true, measuredZero: true, initialCpuSampling: true, staleAndFailureHideOldValues: true, recovered: true, reads };
  } finally { await page.unroute(endpoint, handler); }
}

async function checkAccountActions(page, origin) {
  const row = index => page.locator(`[data-account-id="${accounts[index].id}"]`);
  const assertActions = async () => {
    for (const index of [1, 2, 4]) {
      assert.equal(await row(index).getByRole("button", { name: "Google 登录", exact: true }).count(), 0, "已人工确认或已检测登录成功的账号不应显示登录入口");
      assert.equal(await row(index).getByRole("button", { name: "打开桌面", exact: true }).count(), 1);
    }
    assert.equal(await row(0).getByRole("button", { name: "Google 登录", exact: true }).count(), 1, "未确认账号保留登录入口");
    assert.equal(await row(0).getByRole("button", { name: "打开桌面", exact: true }).count(), 0);
    assert.equal(await row(3).getByRole("button", { name: "打开桌面", exact: true }).count(), 0, "无头实例不提供桌面入口");
    assert.equal(await row(5).getByRole("button", { name: "创建 Chrome 实例", exact: true }).count(), 1);
  };
  await assertActions();
  const requests = [];
  const endpoint = `${origin}/api/v1/profiles/*/manual-sessions`;
  const handler = async route => {
    assert.equal(route.request().method(), "POST");
    assert.deepEqual(route.request().postDataJSON(), { explicitStart: true });
    const pid = new URL(route.request().url()).pathname.split("/")[4];
    requests.push(pid);
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ data: {
      id: `manual_layout_${requests.length}`, profileId: pid,
      desktopPath: `/profiles/${pid}/desktop`, expiresAt: new Date(Date.now() + 600000).toISOString(),
    } }) });
  };
  await page.route(endpoint, handler);
  await page.evaluate(() => {
    window.__accountDesktopPaths = [];
    window.open = () => ({
      closed: false, document: { title: "", body: { textContent: "" } }, opener: null,
      location: { replace: path => window.__accountDesktopPaths.push(path) },
      focus() {}, close() { this.closed = true; },
    });
  });
  try {
    for (const index of [1, 2, 4]) {
      const path = `/profiles/${profileId(index + 1)}/desktop`;
      await row(index).getByRole("button", { name: "打开桌面", exact: true }).click();
      await page.waitForFunction(path => window.__accountDesktopPaths.includes(path), path);
      assert.equal(await page.getByRole("dialog").count(), 0, "打开已登录账号桌面不应再经过选择登录实例弹窗");
    }
    assert.deepEqual(requests, [profileId(2), profileId(3), profileId(5)], "桌面入口应打开账号对应的 Chrome，包含停止中的实例");
    await row(0).getByRole("button", { name: "Google 登录", exact: true }).click();
    await page.getByRole("dialog", { name: "选择登录实例", exact: true }).waitFor();
    await page.getByRole("button", { name: "取消", exact: true }).click();
  } finally {
    await page.unroute(endpoint, handler);
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(".account-manager-row").first().waitFor();
  }
  await assertActions();
  return { manualConfirmationInBothModes: true, authenticatedAccount: true, desktopRequests: requests.length, correctProfileAndNoLoginNavigation: true, unconfirmedLoginRetained: true };
}

async function checkLoginCredentials(page, origin) {
  const email = accounts[0].email;
  const password = " synthetic login password _Test9! ";
  const endpoint = `${origin}/api/v1/google-accounts/${accounts[0].id}/password/reveal`;
  const panel = page.getByRole("group", { name: "账号登录资料", exact: true });
  const field = panel.getByLabel(`账号密码 ${email}`, { exact: true });
  let disclosures = 0, denied = false;
  const handler = async route => {
    assert.equal(route.request().method(), "POST");
    assert.equal(route.request().headers()["x-csrf-token"], "synthetic-layout-only");
    disclosures++;
    return route.fulfill({ status: denied ? 403 : 200, contentType: "application/json", body: JSON.stringify(denied
      ? { code: "SCOPE_DENIED", message: "没有查看账号密码的权限" }
      : { data: { password } }) });
  };
  await page.route(endpoint, handler);
  try {
    assert.equal(await panel.getByLabel("账号邮箱", { exact: true }).inputValue(), email);
    assert.equal(await field.inputValue(), "", "加载账号状态页不应自动读取密码");
    assert.equal(await field.getAttribute("type"), "password");
    await page.evaluate(() => {
      window.__loginClipboardWrites = [];
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => window.__loginClipboardWrites.push(value) } });
      document.execCommand = command => {
        const input = document.activeElement;
        if (command !== "copy" || !(input instanceof HTMLInputElement)) return false;
        window.__loginClipboardWrites.push(input.value);
        return true;
      };
    });
    await panel.getByRole("button", { name: "复制账号邮箱", exact: true }).click();
    await panel.getByRole("button", { name: "查看密码", exact: true }).click();
    await panel.getByRole("button", { name: "隐藏密码", exact: true }).waitFor();
    assert.equal(disclosures, 1, "只能读取当前绑定账号的密码");
    assert.equal(await field.inputValue(), password);
    await panel.getByRole("button", { name: "复制密码", exact: true }).click();
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
    await panel.getByRole("button", { name: "复制账号邮箱", exact: true }).click();
    await panel.getByRole("button", { name: "复制密码", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__loginClipboardWrites), [email, password, email, password], "浏览器剪贴板和局域网 HTTP 回退均应复制完整原值");
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      delete document.visibilityState;
    });
    await page.waitForFunction(() => document.querySelector(".account-login-credentials .account-password input")?.value === "");
    assert.equal(await field.inputValue(), "", "切换后台应清除已显示密码");
    denied = true;
    await panel.getByRole("button", { name: "查看密码", exact: true }).click();
    await page.getByText("没有查看账号密码的权限", { exact: true }).waitFor();
    assert.equal(await field.inputValue(), "", "无查看权限时不显示密码");
    denied = false;
    await panel.getByRole("button", { name: "查看密码", exact: true }).click();
    await panel.getByRole("button", { name: "隐藏密码", exact: true }).waitFor();
    await panel.getByRole("button", { name: "隐藏密码", exact: true }).click();
    assert.equal(await field.inputValue(), "");
    await page.getByRole("button", { name: "关闭通知", exact: true }).click();
    assert.ok(!await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]).includes(" synthetic login password _Test9! ")));
    return { boundAccountOnly: true, revealAndHide: true, clipboardAndHttpFallback: true, visibilityCleanup: true, permissionErrorHandled: true };
  } finally {
    await page.unroute(endpoint, handler);
  }
}

async function measure(page, options) {
  return page.evaluate(({ cards, updates, search }) => {
    const failures = [];
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const controls = 'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]),select,textarea';
    const round = (n) => Math.round(n * 10) / 10;
    const docWidth = document.documentElement.scrollWidth;
    if (docWidth > innerWidth + 1) failures.push("DOCUMENT_HORIZONTAL_OVERFLOW");
    const overflowBoxes = docWidth > innerWidth + 1 ? [...document.querySelectorAll("main *")].filter((element) => visible(element) && element.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map((element) => ({ tag: element.tagName, className: typeof element.className === "string" ? element.className : "", right: round(element.getBoundingClientRect().right) })) : [];
    const searchTextGaps = [];
    for (const group of document.querySelectorAll("main .search-input,main .account-manager-search,main .mcp-search")) {
      const input = group.querySelector("input");
      const icon = group.querySelector("svg");
      if (!input || !icon || !visible(input) || !visible(icon)) continue;
      const style = getComputedStyle(input);
      const contentStart = input.getBoundingClientRect().left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
      const gap = round(contentStart - icon.getBoundingClientRect().right);
      searchTextGaps.push(gap);
      if (gap < 4) failures.push("SEARCH_TEXT_ICON_GAP");
    }
    if (search && searchTextGaps.length !== 1) failures.push("SEARCH_TEXT_ICON_GEOMETRY_MISSING");
    let fields = 0;
    let alignedRows = 0;
    for (const [i, field] of [...document.querySelectorAll("main .field")].entries()) {
      if (!visible(field)) continue;
      const control = field.querySelector(controls);
      if (!control || !visible(control)) continue;
      fields++;
      const box = field.getBoundingClientRect();
      const rect = control.getBoundingClientRect();
      if (rect.left < box.left - 1 || rect.right > box.right + 1) failures.push(`FIELD_CONTROL_BOUNDS:${i}`);
      if (rect.height < 32) failures.push(`FIELD_CONTROL_HEIGHT:${i}`);
      const label = field.querySelector(":scope > label > span:first-child");
      if (label && visible(label) && !label.contains(control)) {
        const labelRect = label.getBoundingClientRect();
        if (field.closest(".proxy-fields")) {
          const gap = rect.left - labelRect.right;
          const centers = Math.abs((rect.top + rect.bottom) / 2 - (labelRect.top + labelRect.bottom) / 2);
          if (gap < 8 || gap > 20 || centers > 2) failures.push(`HORIZONTAL_LABEL_CONTROL_ALIGNMENT:${i}`);
        } else {
          const gap = rect.top - labelRect.bottom;
          if (gap < 3 || gap > 12) failures.push(`LABEL_CONTROL_GAP:${i}`);
        }
      }
    }
    for (const [i, grid] of [...document.querySelectorAll("main .form-grid")].entries()) {
      const children = [...grid.children].filter((element) => element.matches(".field") && visible(element));
      for (let a = 0; a < children.length; a++) for (let b = a + 1; b < children.length; b++) {
        const left = children[a].getBoundingClientRect();
        const right = children[b].getBoundingClientRect();
        if (Math.abs(left.top - right.top) > 2 || left.right > right.left + 1) continue;
        const ca = children[a].querySelector(controls)?.getBoundingClientRect();
        const cb = children[b].querySelector(controls)?.getBoundingClientRect();
        if (ca && cb) {
          alignedRows++;
          if (Math.abs(ca.top - cb.top) > 2 || Math.abs(ca.height - cb.height) > 2) failures.push(`GRID_CONTROL_ALIGNMENT:${i}:${a}:${b}`);
        }
      }
    }
    let actionGroups = 0;
    for (const [i, group] of [...document.querySelectorAll("main .heading-actions,main .form-actions,main .create-profile-actions,main .vnc-password-controls,main .card-actions,main .account-manager-actions")].entries()) {
      const buttons = [...group.querySelectorAll(":scope > .button")].filter(visible);
      if (buttons.length < 2) continue;
      actionGroups++;
      for (let a = 0; a < buttons.length; a++) for (let b = a + 1; b < buttons.length; b++) {
        const first = buttons[a].getBoundingClientRect();
        const second = buttons[b].getBoundingClientRect();
        const overlapX = Math.min(first.right, second.right) - Math.max(first.left, second.left);
        const overlapY = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
        if (overlapX > 1 && overlapY > 1) failures.push(`ACTION_OVERLAP:${i}:${a}:${b}`);
        if (overlapY > 2 && Math.abs(first.height - second.height) > 2) failures.push(`ACTION_HEIGHT_ALIGNMENT:${i}:${a}:${b}`);
        if (overlapY > 2 && overlapX < 0 && -overlapX < 5) failures.push(`ACTION_HORIZONTAL_GAP:${i}:${a}:${b}`);
        if (overlapX > 2 && overlapY < 0 && -overlapY < 5) failures.push(`ACTION_VERTICAL_GAP:${i}:${a}:${b}`);
      }
    }
    // Prevent accidental density changes from shrinking readable text.
    const smallText = new Map();
    const compactActions = ".heading-actions,.panel-heading,.card-actions,.table-actions,.account-manager-actions,.account-manager-binding-heading,.account-row,.vnc-password-controls,.google-login-progress-actions,.google-login-progress-title";
    for (const [i, element] of [...document.querySelectorAll("main .field > label > span:first-child,main .field input:not([type='checkbox']):not([type='radio']),main .field select,main .field textarea,main .button,main .icon-button")].entries()) {
      if (!visible(element)) continue;
      const fontSize = parseFloat(getComputedStyle(element).fontSize);
      const button = element.matches("button");
      if (button && (!element.textContent.trim() || fontSize === 0)) {
        if (!element.getAttribute("aria-label")?.trim()) failures.push(`ICON_BUTTON_ACCESSIBLE_NAME:${i}`);
        continue;
      }
      // Main actions and editable text stay 14px; explicit compact secondary
      // controls retain the existing 13px hierarchy without hiding regressions.
      const minimum = button && element.closest(compactActions) ? 13 : 14;
      if (fontSize < minimum) {
        failures.push(`READABLE_TEXT_SIZE:${i}`);
        const key = `${element.tagName}.${element.className}:${fontSize}`;
        smallText.set(key, (smallText.get(key) || 0) + 1);
      }
    }
    const cardBoxes = cards ? [...document.querySelectorAll(".profile-card")].map((card) => ({ card: card.getBoundingClientRect(), footer: card.querySelector(".card-actions")?.getBoundingClientRect() })) : [];
    for (let i = 0; i < cardBoxes.length; i++) for (let j = i + 1; j < cardBoxes.length; j++) {
      const a = cardBoxes[i], b = cardBoxes[j];
      if (Math.abs(a.card.top - b.card.top) <= 2 && a.footer && b.footer && Math.abs(a.footer.bottom - b.footer.bottom) > 2) failures.push(`CARD_FOOTER_ALIGNMENT:${i}:${j}`);
    }
    const firstCardTop = cardBoxes[0]?.card.top;
    if (innerWidth >= 1200 && firstCardTop > 360) failures.push("LIST_TOP_DENSITY");
    const versionPanel = document.querySelector(".updates-stack > .updates-versions");
    const recoveryPanel = document.querySelector(".updates-stack > .updates-recovery");
    let updateStackGap;
    if (updates && (!versionPanel || !recoveryPanel)) failures.push("UPDATE_STACK_MISSING");
    if (versionPanel && recoveryPanel) {
      const versionBox = versionPanel.getBoundingClientRect();
      const recoveryBox = recoveryPanel.getBoundingClientRect();
      updateStackGap = round(recoveryBox.top - versionBox.bottom);
      if (Math.abs(updateStackGap - 16) > 1) failures.push("UPDATE_STACK_GAP");
      if (Math.abs(versionBox.left - recoveryBox.left) > 1 || Math.abs(versionBox.width - recoveryBox.width) > 1) failures.push("UPDATE_STACK_ALIGNMENT");
      // The right column must use its own content height; a tall policy panel
      // must not push recovery down to an unrelated grid row.
      const policyPanel = document.querySelector(".updates-policy");
      const policyBox = policyPanel?.getBoundingClientRect();
      if (innerWidth > 1100 && policyBox && Math.abs(versionBox.top - policyBox.top) > 1) failures.push("UPDATE_COLUMNS_TOP_ALIGNMENT");
    }
    for (const [i, column] of [...document.querySelectorAll(".settings-column")].entries()) {
      const panels = [...column.children].filter((element) => element.matches(".panel") && visible(element));
      for (let j = 1; j < panels.length; j++) {
        const gap = panels[j].getBoundingClientRect().top - panels[j - 1].getBoundingClientRect().bottom;
        if (Math.abs(gap - 16) > 1) failures.push(`SETTINGS_STACK_GAP:${i}:${j}`);
      }
    }
    const proxyNotice = document.querySelector(".settings-proxy form > .form-grid + .notice");
    let proxyNoticeGap;
    if (proxyNotice) {
      proxyNoticeGap = round(proxyNotice.getBoundingClientRect().top - proxyNotice.previousElementSibling.getBoundingClientRect().bottom);
      if (proxyNoticeGap < 10 || proxyNoticeGap > 20) failures.push("PROXY_NOTICE_GAP");
    }
    const idleNumber = document.querySelector('.settings-policy-controls input[name="idleTimeoutMinutes"]');
    const pauseCheckbox = document.querySelector('.settings-policy-controls input[name="autoWakePaused"]');
    let runtimeCenterDifference;
    if (innerWidth > 1100 && idleNumber && pauseCheckbox) {
      const numberBox = idleNumber.getBoundingClientRect();
      const checkboxBox = pauseCheckbox.getBoundingClientRect();
      runtimeCenterDifference = round(Math.abs(numberBox.top + numberBox.height / 2 - checkboxBox.top - checkboxBox.height / 2));
      if (runtimeCenterDifference > 1) failures.push("RUNTIME_CONTROL_CENTER_ALIGNMENT");
    }
    const detailBody = document.querySelector(".settings-layout,.detail-content .updates-layout");
    const detailTabs = document.querySelector(".detail-tabs");
    let detailRightDifference;
    let footerRightDifference;
    if (innerWidth > 1100 && detailBody && detailTabs) {
      detailRightDifference = round(Math.abs(detailBody.getBoundingClientRect().right - detailTabs.getBoundingClientRect().right));
      if (detailRightDifference > 1) failures.push("DETAIL_HEADER_CONTENT_RIGHT_ALIGNMENT");
      const footer = document.querySelector(".page-footer");
      if (footer) {
        footerRightDifference = round(Math.abs(detailBody.getBoundingClientRect().right - footer.getBoundingClientRect().right));
        if (footerRightDifference > 1) failures.push("DETAIL_FOOTER_CONTENT_RIGHT_ALIGNMENT");
      }
    }
    return { documentWidth: docWidth, fields, alignedRows, actionGroups, searchTextGaps, firstCardTop: firstCardTop === undefined ? undefined : round(firstCardTop), updateStackGap, proxyNoticeGap, runtimeCenterDifference, detailRightDifference, footerRightDifference, smallText: Object.fromEntries(smallText), overflowBoxes, failures };
  }, options);
}
