import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { fixedNow as now, documentationJobs, filterDocumentationJobs, documentationDensity } from "./readme-screenshot-data.mjs";
import { localizeDocumentationPreview } from "./readme-screenshot-locales.mjs";

// Render the actual built UI with synthetic, read-only fixtures. Never reads a
// production database, Vault, credentials, browser session, or platform token.
// Prerequisites: Node 24, installed workspace dependencies, Playwright, a local
// Chromium installation, system browser libraries, and fonts supporting Chinese.
// From the repository root:
//   npm run build -w @chrome-fleet/web
//   npx playwright install chromium
//   node scripts/capture-readme-screenshots.mjs
// FLEET_QA_CHROME may select a local Chromium executable. An existing project
// .tools/ui-chrome/chrome-linux64/chrome is also recognized; otherwise Playwright
// selects its default Chromium. FONTCONFIG_FILE/LD_LIBRARY_PATH are inherited.
// This script accepts no service URL, token, external fixture, or CLI argument.
// Captures both Chinese UI and English documentation previews. The latter
// localize demo labels in the isolated page; this does not add a UI language setting.
assert.equal(process.argv.length, 2, "No arguments accepted: screenshots use local synthetic fixtures only");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleRoot = join(repoRoot, "apps/web/dist");
const outputRoot = join(repoRoot, "docs/images/screenshots");
const reportPath = join(repoRoot, ".tools/readme-screenshots-report.json");
const localChrome = join(repoRoot, ".tools/ui-chrome/chrome-linux64/chrome");
const exists = async file => access(file).then(() => true, () => false);
const executablePath = process.env.FLEET_QA_CHROME
  ? resolve(repoRoot, process.env.FLEET_QA_CHROME)
  : await exists(localChrome) ? localChrome : undefined;
assert.ok(await exists(join(bundleRoot, "index.html")), "Build the web workspace before capturing screenshots");
if (executablePath) assert.ok(await exists(executablePath), "FLEET_QA_CHROME must point to an existing local browser executable");
const pid = n => `cf_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const profileNames = { "zh-CN": ["市场调研", "运营工作台", "产品体验", "内容资料库"], en: ["Research", "Operations", "Product testing", "Content library"] };
const profileTags = { "zh-CN": [["调研", "日常工作"], ["运营"], ["测试验证"], ["资料整理"]], en: [["Research", "Daily work"], ["Operations"], ["Testing"], ["Content"]] };
const emails = ["research@example.test", "operations@example.test", "product@example.test", "content@example.test"];
const accounts = locale => emails.map((email, i) => ({
  id: `google_demo_${i + 1}`, email, recoveryEmail: "recovery@example.test",
  bindings: i < 3 ? [{ profileId: pid(i + 1), profileName: profileNames[locale][i] }] : [],
}));
const profiles = (locale = "zh-CN") => profileNames[locale].map((name, i) => ({
  id: pid(i + 1), name, tags: profileTags[locale][i],
  state: i === 2 ? "stopped" : "running", desiredState: i === 2 ? "stopped" : "running",
  browserMode: i === 1 ? "vnc" : "automation", startupPolicy: "on_demand", idleTimeoutMinutes: 15, headless: false,
  chromeVersion: "155.0.8059.79", playwrightVersion: "1.64.1", image: "chrome-fleet/browser:demo",
  imageDigest: `sha256:${"a".repeat(64)}`, createdAt: "2026-10-15T01:00:00.000Z", lastActivityAt: now,
  resources: { cpus: 2, memoryMb: 2048, pidsLimit: 512 },
  proxy: { enabled: true, scheme: "http", host: "proxy.example.test", port: 8080, bypass: "localhost,127.0.0.1", version: 2, appliedVersion: 2, hasCredentials: false },
  remoteDesktop: { passwordConfigured: true, version: 1, appliedVersion: 1 },
  health: { ready: true, sandboxEnabled: true, keyring: { unlocked: true, probeVerified: true } },
  metrics: { available: true, sampledAt: now, cpuPercent: [1.8, 0.6, 0, 2.4][i], memoryBytes: [608, 324, 0, 416][i] * 1024 ** 2, memoryLimitBytes: 2 * 1024 ** 3, pids: 34, diskBytes: 1024 ** 3 },
  accounts: i < 3 ? [{ id: `account_demo_${i + 1}`, provider: "google", alias: emails[i], expectedIdentity: emails[i], authState: i === 1 ? "unknown" : "manually_confirmed", boundAt: "2026-10-15T01:00:00.000Z", ...(i !== 1 ? { lastConfirmedAt: "2026-10-17T09:35:00.000Z" } : {}) }] : [],
  ...(i < 3 ? { googleBinding: { accountId: accounts(locale)[i].id, email: emails[i], confirmationState: i === 1 ? "unconfirmed" : "confirmed", ...(i !== 1 ? { lastConfirmedAt: "2026-10-17T09:35:00.000Z" } : {}) } } : {}),
}));
const jobs = documentationJobs(pid);
const versions = [
  { id: "version_demo_stable", version: "155.0.8059.79", chromeVersion: "155.0.8059.79", distribution: "google", validated: true, prepared: true },
  { id: "version_demo_candidate", version: "155.0.8059.84", chromeVersion: "155.0.8059.84", distribution: "google", validated: false, prepared: true },
];
const rejected = [], counts = new Map();
const json = (res, status, data) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(data)); };
function fixture(url, locale) {
  const path = url.pathname.slice("/api/v1".length);
  if (path === "/session") return { authenticated: true, csrfToken: "synthetic-documentation-fixture" };
  if (path === "/host-metrics") return { scope: "host", available: true, sampledAt: now, cpuPercent: 23.4, cpuCount: 8, memoryBytes: 10.5 * 1024 ** 3, memoryTotalBytes: 32 * 1024 ** 3, memoryPercent: 32.8125 };
  if (path === "/profiles") return { items: profiles(locale), total: 4 };
  if (path === "/google-accounts") return { items: accounts(locale), total: emails.length };
  if (path === "/manual-sessions") return { items: [], total: 0 };
  if (path === "/browser-versions") return { items: versions, total: versions.length };
  if (path === "/update-policy") return { mode: "auto", paused: false, checkIntervalHours: 24, maintenanceStart: "02:00", maintenanceEnd: "05:00" };
  if (path === "/updates") return { items: [], total: 0 };
  if (path === "/jobs") {
    const filtered = filterDocumentationJobs(jobs, url.searchParams);
    const offset = Number(url.searchParams.get("cursor") || 0), limit = Number(url.searchParams.get("limit") || 30);
    return { items: filtered.slice(offset, offset + limit), total: filtered.length, nextCursor: offset + limit < filtered.length ? String(offset + limit) : null };
  }
  if (path === "/jobs/density") {
    return documentationDensity(jobs, url.searchParams);
  }
  if (path.startsWith("/jobs/")) return jobs.find(job => path === `/jobs/${job.id}`);
  const match = path.match(/^\/profiles\/(cf_[a-f0-9-]+)(?:\/(accounts|snapshots))?$/);
  if (match) {
    const profile = profiles(locale).find(p => p.id === match[1]);
    if (!profile) return;
    if (match[2] === "accounts") return { items: profile.accounts, total: profile.accounts.length };
    if (match[2] === "snapshots") return { items: [{ id: "snapshot_demo", profileId: profile.id, createdAt: now, chromeVersion: profile.chromeVersion, sizeBytes: 128 * 1024 ** 2 }], total: 1 };
    return profile;
  }
}
const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method !== "GET") { rejected.push("WRITE_REQUEST"); return json(res, 405, { code: "READ_ONLY_DOCUMENTATION_FIXTURE" }); }
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) { rejected.push("MCP_EXECUTION"); return json(res, 405, { code: "NO_MCP_EXECUTION" }); }
    if (url.pathname.startsWith("/api/v1/")) {
      counts.set(url.pathname, (counts.get(url.pathname) || 0) + 1);
      const data = fixture(url, req.headers["accept-language"]?.startsWith("en") ? "en" : "zh-CN");
      if (data === undefined) { rejected.push(`UNKNOWN_API:${url.pathname}`); return json(res, 404, { code: "UNDEFINED_DOCUMENTATION_FIXTURE" }); }
      return json(res, 200, { data, requestId: "synthetic-documentation" });
    }
    const file = resolve(bundleRoot, extname(url.pathname) ? decodeURIComponent(url.pathname).replace(/^\/+/, "") : "index.html");
    if (!file.startsWith(bundleRoot + sep)) return json(res, 404, { code: "NOT_FOUND" });
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": contentTypes[extname(file)] || "application/octet-stream" }); res.end(body);
  } catch { json(res, 404, { code: "NOT_FOUND" }); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  await mkdir(outputRoot, { recursive: true });
  await mkdir(join(outputRoot, "en"), { recursive: true });
  await mkdir(dirname(reportPath), { recursive: true });
  browser = await chromium.launch({ executablePath, headless: true });
  const errors = [], results = [], untranslated = [];
  for (const locale of ["zh-CN", "en"]) {
    const context = await browser.newContext({ locale: locale === "en" ? "en-GB" : "zh-CN", timezoneId: "Asia/Shanghai", reducedMotion: "reduce", deviceScaleFactor: 1 });
    await context.addInitScript(({ fixedNow, english }) => {
      const NativeDate = Date;
      window.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [fixedNow])); }
        static now() { return new NativeDate(fixedNow).getTime(); }
      };
      if (english) {
        const NativeDateTimeFormat = Intl.DateTimeFormat;
        Intl.DateTimeFormat = class extends NativeDateTimeFormat {
          constructor(locales, options) { super(locales === "zh-CN" ? "en-GB" : locales, options); }
        };
      }
    }, { fixedNow: now, english: locale === "en" });
    await context.route("**/*", route => {
      if (new URL(route.request().url()).origin !== origin) { rejected.push("EXTERNAL_REQUEST"); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    page.on("pageerror", error => errors.push(error.message));
    const scenes = [
      { name: "browser-workspace", path: "/profiles", ready: ".host-metrics[data-host-metrics-state='live']", width: 1600, height: 960 },
      { name: "account-directory", path: "/accounts", ready: ".account-manager-row", width: 1440, height: 1020 },
      { name: "account-login", path: `/profiles/${pid(2)}/accounts`, ready: ".vnc-google-binding-panel", width: 1440, height: 980 },
      { name: "instance-settings", path: `/profiles/${pid(1)}/settings`, ready: ".settings-layout", width: 1440, height: 1080 },
      { name: "task-center", path: "/jobs", ready: "tbody tr", width: 1440, height: 1080 },
      { name: "mcp-integration", path: "/integrations/mcp", ready: ".mcp-page [data-mcp-tool]", width: 1440, height: 1080 },
      { name: "browser-updates", path: "/updates", ready: ".version-list", width: 1440, height: 980 },
    ];
    for (const scene of scenes) {
      await page.setViewportSize({ width: scene.width, height: scene.height });
      await page.goto(origin + scene.path, { waitUntil: "networkidle" });
      await page.locator(scene.ready).first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(150);
      if (locale === "en") {
        const strings = await localizeDocumentationPreview(page);
        if (strings.length) untranslated.push({ scene: scene.name, strings });
      }
      const document = await cdp.send("DOM.getDocument");
      const title = await cdp.send("DOM.querySelector", { nodeId: document.root.nodeId, selector: "h1" });
      const titleFonts = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: title.nodeId });
      assert.ok(titleFonts.fonts.some(font => font.glyphCount > 0), "Screenshot titles must have rendered glyphs; install fonts supporting Chinese");
      assert.equal(await page.locator('input[type="password"]').evaluateAll(inputs => inputs.some(input => input.value.length > 0)), false, "Screenshot passwords must remain empty and masked");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "Screenshot must not overflow horizontally");
      const screenshotText = await page.evaluate(() => document.body.innerText + "\n" + [...document.querySelectorAll("input,textarea")].map(input => input.value).join("\n"));
      const visibleEmails = [...screenshotText.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map(match => match[0]);
      const syntheticEmails = new Set([...emails, "recovery@example.test"]);
      assert.ok(visibleEmails.every(email => syntheticEmails.has(email)), "Only declared synthetic example.test accounts are allowed");
      if (scene.name === "task-center") {
        const columns = await page.locator(".job-density-column").evaluateAll(items => items.map(item => Number(item.dataset.total)));
        assert.equal(columns.reduce((sum, value) => sum + value, 0), jobs.length, "Histogram and task list must count the same records");
        assert.ok(new Set(columns).size > 12 && Math.max(...columns) >= 20, "Demo must contain varied hourly workloads, not equal-height spikes");
      }
      const filename = (locale === "en" ? "en/" : "") + scene.name + ".png";
      await page.screenshot({ path: join(outputRoot, filename), fullPage: false, animations: "disabled" });
      results.push({ file: filename, locale, localizedDocumentationPreview: locale === "en", route: scene.path, width: scene.width, height: scene.height, titleFonts: titleFonts.fonts.map(font => font.familyName), syntheticEmailsOnly: true, nonEmptyPasswordFields: 0 });
    }
    await context.close();
  }
  await writeFile(join(repoRoot, ".tools/readme-untranslated.json"), JSON.stringify(untranslated, null, 2) + "\n");
  assert.equal(untranslated.length, 0, "English previews must not retain Chinese UI labels; see .tools/readme-untranslated.json");
  assert.deepEqual(rejected, []); assert.deepEqual(errors, []);
  await writeFile(reportPath, JSON.stringify({ fixture: "synthetic-documentation", fixedTime: now, jobCount: jobs.length, scenes: results, writeRequests: 0, externalRequests: 0, browserErrors: 0, requests: [...counts.entries()] }, null, 2) + "\n");
  console.log(`PASS: ${results.length} actual-UI screenshots; synthetic accounts only; passwords empty; writes=0 external=0 browserErrors=0`);
} finally { await browser?.close(); await new Promise(done => server.close(done)); }
