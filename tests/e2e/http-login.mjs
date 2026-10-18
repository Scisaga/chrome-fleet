/** Real LAN HTTP login, with no secure-context override and no saved credentials or screenshots. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const base = (process.env.FLEET_TEST_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
assert.equal(new URL(base).protocol, "http:");
assert.ok(
  !["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname),
  "此回归需真实LAN HTTP origin",
);
const token = readFileSync(
  process.env.FLEET_TEST_TOKEN_FILE || "/opt/chrome-fleet/secrets/admin-token",
  "utf8",
).trim();
const browser = await chromium.launch({
  executablePath:
    process.env.FLEET_QA_CHROME ||
    "/opt/chrome-fleet/.tools/ui-chrome/chrome-linux64/chrome",
  headless: true,
});
try {
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/accounts`);
  const capabilities = await page.evaluate(() => ({
    secureContext: isSecureContext,
    randomUUID: typeof globalThis.crypto?.randomUUID,
    getRandomValues: typeof globalThis.crypto?.getRandomValues,
  }));
  assert.deepEqual(capabilities, {
    secureContext: false,
    randomUUID: "undefined",
    getRandomValues: "function",
  });
  console.log(
    "PASS: 真实LAN HTTP未提供randomUUID，安全随机数getRandomValues仍可用",
  );
  await page.getByLabel("平台访问令牌").fill(token);
  if (process.argv.includes("--expect-original-error")) {
    await page.getByRole("button", { name: "安全登录" }).click();
    await page
      .getByText("crypto.randomUUID is not a function", { exact: true })
      .waitFor();
    console.log("REPRODUCED: 与用户截图一致的登录错误");
  } else {
    const response = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/session" &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "安全登录" }).click();
    const login = await response;
    assert.equal(login.status(), 200);
    const requestHeaders = await login.request().allHeaders();
    assert.match(
      requestHeaders["idempotency-key"],
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    await page.getByRole("heading", { name: /^账号管理/ }).waitFor();
    await assertRoute(page, "/accounts");
    await page.getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "浏览器实例", exact: false }).click();
    await page.getByRole("heading", { name: /^浏览器实例/ }).waitFor();
    await assertRoute(page, "/profiles");
    const logo = page.locator(".sidebar .brand-mark");
    assert.equal(
      await logo.evaluate((element) => getComputedStyle(element).borderRadius),
      "6px",
    );
    assert.equal(await logo.locator("svg circle").count(), 2);
    assert.equal(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
      0,
    );
    assert.ok(
      (await context.cookies()).some(
        (cookie) => cookie.name === "fleet_session" && cookie.httpOnly,
      ),
    );
    const catalog = await page.evaluate(async () => {
      const response = await fetch("/api/v1/google-accounts");
      const body = await response.json();
      return { status: response.status, count: body.data?.total };
    });
    assert.equal(catalog.status, 200);
    assert.ok(Number.isInteger(catalog.count) && catalog.count >= 0);
    const profileMetadata = () => page.evaluate(async () => {
      const profiles = [];
      let total = 0;
      do {
        const response = await fetch(`/api/v1/profiles?includeArchived=true&limit=100&offset=${profiles.length}`);
        if (!response.ok) throw new Error("读取实例元数据失败");
        const body = await response.json();
        const batch = body.data?.items || [];
        total = body.data?.total || 0;
        if (!batch.length) break;
        profiles.push(...batch);
      } while (profiles.length < total);
      return profiles.map((profile) => ({
        id: profile.id,
        state: profile.state,
        desiredState: profile.desiredState,
        archived: Boolean(profile.archived),
        headless: profile.headless,
        image: profile.image,
        imageDigest: profile.imageDigest,
        passwordVersion: profile.remoteDesktop?.version,
        appliedPasswordVersion: profile.remoteDesktop?.appliedVersion,
        proxyVersion: profile.proxy?.version,
        appliedProxyVersion: profile.proxy?.appliedVersion,
      })).sort((a, b) => a.id.localeCompare(b.id));
    });
    const beforeProfiles = await profileMetadata();
    for (const [path, label, heading] of [
      ["profiles", "浏览器实例", /^浏览器实例/],
      ["accounts", "账号管理", /^账号管理/],
      ["jobs", "任务中心", "任务中心"],
      ["updates", "更新管理", "浏览器更新"],
      ["guide", "使用指南", "让每个账号，各就其位"],
    ]) {
      await page.getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name: label, exact: path !== "profiles" }).click();
      await assertRoute(page, `/${path}`);
      await page.getByRole("heading", { name: heading }).first().waitFor();
      await page.reload();
      await assertRoute(page, `/${path}`);
      await page.getByRole("heading", { name: heading }).first().waitFor();
      await assertReadableLayout(page, `LAN desktop ${path}`);
    }
    await page.getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "账号管理", exact: true }).click();
    await assertRoute(page, "/accounts");
    await page.getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "任务中心", exact: true }).click();
    await assertRoute(page, "/jobs");
    await page.goBack();
    await assertRoute(page, "/accounts");
    await page.getByRole("heading", { name: /^账号管理/ }).waitFor();
    await page.goForward();
    await assertRoute(page, "/jobs");
    await page.getByRole("heading", { name: "任务中心", exact: true }).waitFor();
    await page.goto(`${base}/page-that-does-not-exist`);
    await page.getByRole("heading", { name: "页面不存在", exact: true }).waitFor();
    await assertRoute(page, "/page-that-does-not-exist");
    await page.getByRole("button", { name: "返回浏览器实例", exact: true }).click();
    await assertRoute(page, "/profiles");
    const missingProfileId = "cf_00000000-0000-4000-8000-000000000000";
    assert.ok(!beforeProfiles.some((profile) => profile.id === missingProfileId));
    await page.goto(`${base}/profiles/${missingProfileId}/settings`);
    await page.getByRole("heading", { name: "找不到这个实例", exact: true }).waitFor();
    await page.getByRole("button", { name: "返回浏览器实例", exact: true }).click();
    await assertRoute(page, "/profiles");
    const assertCreatePage = async () => {
      const createPage = page.locator("main.create-profile-page");
      await createPage.getByRole("heading", { name: "创建 Chrome 容器", exact: true }).waitFor();
      assert.ok((await page.getByRole("dialog").count()) === 0, "创建入口应打开标准页面");
      assert.ok((await page.locator(".modal-backdrop").count()) === 0, "标准创建页应无遮罩");
      return createPage;
    };
    assert.equal(await page.getByRole("button", { name: /创建 Chrome/ }).count(), 0, "实例列表不得提供独立创建入口");
    for (const path of ["/profiles/new", "/profiles/new?from=profiles", "/#create"]) {
      await page.goto(base + path);
      await page.getByRole("heading", { name: /^账号管理/ }).waitFor();
      await assertRoute(page, "/accounts");
      assert.equal(await page.locator(".create-profile-form").count(), 0);
    }
    console.log("PASS: 实例列表没有创建入口，无账号的旧创建链接返回账号管理");
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "账号管理", exact: true })
      .click();
    await page.getByRole("heading", { name: /^账号管理/ }).waitFor();
    await assertRoute(page, "/accounts");
    await page.waitForFunction(async () => {
      const response = await fetch("/api/v1/google-accounts?limit=100");
      const body = await response.json();
      const text = document.querySelector("main")?.textContent || "";
      return body.data.items.every((account) => text.includes(account.email));
    });
    console.log(
      "PASS: 单色Chrome品牌图标、6px底座圆角、账号管理入口及已导入账号展示",
    );
    const availableRows = page.locator(".account-manager-row").filter({ has: page.getByRole("button", { name: "创建 Chrome 实例", exact: true }) });
    let availableAccountId;
    if (await availableRows.count() > 0) {
      const accountRow = availableRows.first();
      await accountRow.waitFor();
      const accountId = await accountRow.getAttribute("data-account-id");
      assert.ok(Boolean(accountId), "账号行应具备稳定标识");
      availableAccountId = accountId;
      await accountRow.getByRole("button", { name: "创建 Chrome 实例", exact: true }).click();
      const accountCreatePage = await assertCreatePage();
      const accountCreatePath = `/profiles/new?from=accounts&account=${encodeURIComponent(accountId)}`;
      await assertRoute(page, accountCreatePath);
      await page.reload();
      await assertCreatePage();
      await assertRoute(page, accountCreatePath);
      await accountCreatePage.getByLabel("关联账号", { exact: true }).waitFor();
      assert.ok(await accountCreatePage.getByLabel("关联账号", { exact: true }).evaluate(input => input.readOnly));
      const prefilled = await page.evaluate(async (selectedId) => {
        let offset = 0;
        let total = 0;
        do {
          const response = await fetch(`/api/v1/google-accounts?limit=100&offset=${offset}`);
          if (!response.ok) return false;
          const body = await response.json();
          const batch = body.data?.items || [];
          total = body.data?.total || 0;
          const account = batch.find((entry) => entry.id === selectedId);
          if (account) {
            const form = document.querySelector("main.create-profile-page");
            const alias = form?.querySelector('input[name="accountAlias"]');
            const name = form?.querySelector('input[name="name"]');
            return Boolean(account.email && alias?.value === account.email && name?.value);
          }
          if (!batch.length) return false;
          offset += batch.length;
        } while (offset < total);
        return false;
      }, accountId);
      assert.ok(prefilled, "账号入口应预填所选邮箱与实例名称");
      await page.goBack();
      await assertRoute(page, "/accounts");
      await page.getByRole("heading", { name: /^账号管理/ }).waitFor();
      await page.goForward();
      await assertRoute(page, accountCreatePath);
      await assertCreatePage();
      await accountCreatePage.getByRole("button", { name: "返回创建来源", exact: true }).click();
      await page.getByRole("heading", { name: /^账号管理/ }).waitFor();
      await assertRoute(page, "/accounts");
      console.log("PASS: 账号创建入口为标准页面且预填匹配，返回账号管理未修改账号或实例");
    } else {
      console.log("SKIP: 无未关联账号，跳过账号创建页预填检查");
    }
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "浏览器实例", exact: false })
      .click();
    await page.getByRole("heading", { name: /^浏览器实例/ }).waitFor();
    if (beforeProfiles.some((profile) => !profile.archived)) {
      const openFirstSettings = async () => {
        await page.locator(".profile-card .profile-name button").first().click();
        const id = new URL(page.url()).pathname.split("/")[2];
        assert.match(id || "", /^cf_[0-9a-f-]{36}$/);
        await assertRoute(page, `/profiles/${id}/overview`);
        await page.getByRole("tab", { name: "实例设置", exact: true }).click();
        await assertRoute(page, `/profiles/${id}/settings`);
        await page.getByLabel("当前 VNC 密码", { exact: true }).waitFor();
      };
      const isPasswordEmpty = () => page.getByLabel("当前 VNC 密码", { exact: true })
        .evaluate((input) => input.value === "" && input.type === "password" && input.readOnly);
      const revealPassword = async () => {
        const response = page.waitForResponse((response) =>
          /\/api\/v1\/profiles\/cf_[0-9a-f-]+\/remote-desktop\/password\/reveal$/.test(new URL(response.url()).pathname) &&
          response.request().method() === "POST");
        await page.getByRole("button", { name: "查看 VNC 密码", exact: true }).click();
        assert.ok((await response).status() === 200, "主动查看已保存密码应成功");
        await page.getByRole("button", { name: "隐藏 VNC 密码", exact: true }).waitFor();
        assert.ok(
          await page.getByLabel("当前 VNC 密码", { exact: true }).evaluate((input) =>
            /^[\x21-\x7e]{8}$/.test(input.value) && input.type === "text" && input.readOnly),
          "主动查看应显示8个可见ASCII字符，只返回校验布尔值",
        );
      };
      await openFirstSettings();
      assert.ok(await isPasswordEmpty(), "设置页默认不应持有密码明文");
      await revealPassword();
      await page.getByRole("button", { name: "隐藏 VNC 密码", exact: true }).click();
      assert.ok(await isPasswordEmpty(), "隐藏后密码值应清空");
      await revealPassword();
      await page.getByRole("button", { name: "返回全部实例", exact: true }).click();
      await openFirstSettings();
      assert.ok(await isPasswordEmpty(), "离开实例再进入设置应默认清空密码");
      const inspectedId = new URL(page.url()).pathname.split("/")[2];
      for (const [tab, label] of [
        ["overview", "概览"], ["settings", "实例设置"],
        ["accounts", "账号状态"], ["tasks", "自动化任务"],
        ["sessions", "会话与备份"], ["updates", "浏览器更新"],
      ]) {
        await page.getByRole("tab", { name: label, exact: true }).click();
        await assertRoute(page, `/profiles/${inspectedId}/${tab}`);
        await page.reload();
        const activeTab = page.getByRole("tab", { name: label, exact: true });
        await activeTab.waitFor();
        assert.equal(await activeTab.getAttribute("aria-selected"), "true");
        await assertRoute(page, `/profiles/${inspectedId}/${tab}`);
        await assertReadableLayout(page, `LAN profile ${tab}`);
      }
      console.log("PASS: 现有实例密码默认空、主动查看格式有效、隐藏清空、离开再进清空；未创建/轮换/启动实例");
    } else {
      console.log("SKIP: 无未归档实例，跳过已有实例密码只读查看检查");
    }
    const existingJob = await page.evaluate(async () => {
      const response = await fetch("/api/v1/jobs?limit=1");
      if (!response.ok) throw new Error("读取任务元数据失败");
      const body = await response.json();
      const job = body.data?.items?.[0];
      return job ? { id: job.id, profileId: job.profileId } : undefined;
    });
    if (existingJob) {
      const taskPath = `/jobs?job=${encodeURIComponent(existingJob.id)}`;
      await page.goto(`${base}${taskPath}`);
      await page.getByRole("dialog").getByRole("heading", { name: "任务详情", exact: true }).waitFor();
      await assertRoute(page, taskPath);
      await page.reload();
      await page.getByRole("dialog").getByRole("heading", { name: "任务详情", exact: true }).waitFor();
      await assertRoute(page, taskPath);
      await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
      await assertRoute(page, "/jobs");
      console.log("PASS: 已有任务详情URL可直达/刷新，未提交或控制任务");
    } else console.log("SKIP: 无已有任务，任务详情URL由合成数据验收覆盖");
    await page.goto(`${base}/profiles`);
    await page.getByRole("heading", { name: /^浏览器实例/ }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await assertReadableLayout(page, "LAN 390px profiles");
    assert.equal(await page.getByRole("button", { name: /创建 Chrome/ }).count(), 0);
    if (availableAccountId) {
      const accountCreatePath = `/profiles/new?from=accounts&account=${encodeURIComponent(availableAccountId)}`;
      await page.goto(base + accountCreatePath);
      const mobileCreate = await assertCreatePage();
      await assertRoute(page, accountCreatePath);
      await page.reload();
      await assertCreatePage();
      await assertReadableLayout(page, "LAN 390px create");
      await mobileCreate.getByRole("button", { name: "取消创建", exact: true }).click();
      await assertRoute(page, "/accounts");
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    console.log("PASS: History页面/实例tab刷新直达、登录目标、前进后退、404与390px标准创建页和字号检查；不截图真实数据");
    const afterProfiles = await profileMetadata();
    assert.ok(
      JSON.stringify(beforeProfiles) === JSON.stringify(afterProfiles),
      "只读验收前后实例列表、状态及密码/代理/镜像版本应保持不变",
    );
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page.getByRole("heading", { name: "登录浏览器工作台" }).waitFor();
    assert.equal(
      (await context.cookies()).some(
        (cookie) => cookie.name === "fleet_session",
      ),
      false,
    );
    assert.ok(errors.length === 0, "浏览器不应出现未处理的页面错误");
    console.log(
      "PASS: 安全随机UUID幂等键、HTTP登录、HttpOnly会话、已导入账号目录及退出均通过；页面错误0",
    );
  }
  await context.close();
} catch (error) {
  console.error(String(error?.stack || error)
    .replaceAll(token, "[REDACTED]")
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]"));
  process.exitCode = 1;
} finally {
  await browser.close();
}

async function assertRoute(page, path) {
  await page.waitForFunction((expected) =>
    `${location.pathname}${location.search}` === expected && location.hash === "", path);
}

async function assertReadableLayout(page, label) {
  const result = await page.evaluate(() => {
    const visible = (element) => element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== "hidden" &&
      (element.matches("input,select,textarea,body") || element.textContent.trim());
    const undersized = (selector, minimum, allowIconOnly = false) => [...document.querySelectorAll(selector)]
      .filter(visible)
      // Existing mobile page-heading actions intentionally show only their SVG.
      // Their accessible text remains; font-size:0 is not visible small text.
      .filter((element) => !(allowIconOnly &&
        parseFloat(getComputedStyle(element).fontSize) === 0 &&
        element.matches(".page-heading > .button") &&
        element.querySelector("svg")?.getBoundingClientRect().width > 0 &&
        (element.getAttribute("aria-label") || element.textContent.trim())))
      .map((element) => ({
        selector: selector.split(",").filter((part) => element.matches(part)).join(","),
        tag: element.tagName.toLowerCase(),
        className: element.getAttribute("class") || "",
        size: parseFloat(getComputedStyle(element).fontSize),
        minimum,
      }))
      .filter((entry) => !Number.isFinite(entry.size) || entry.size < minimum);
    return {
      overflow: document.documentElement.scrollWidth > innerWidth,
      body: undersized('body,main .field>label>span,main input:not([type="checkbox"]):not([type="radio"]),main select,main textarea,main .empty p,main .guide-card p,main .capability-card p,main .google-login-progress p', 14),
      buttons: undersized("main .button", 13, true),
      helpers: undersized(".field>small,.page-heading p,.panel-heading p,.sub-heading p,main .notice>div,.eyebrow,.page-footer span,main small,.breadcrumbs", 12),
    };
  });
  assert.equal(result.overflow, false, `${label} 不应水平溢出`);
  assert.deepEqual(result.body, [], `${label} 正文和表单字号应至少14px`);
  assert.deepEqual(result.buttons, [], `${label} 按钮字号应至少13px`);
  assert.deepEqual(result.helpers, [], `${label} 辅助说明字号应至少12px`);
}
