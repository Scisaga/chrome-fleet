import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// --serve 只创建一次性测试控制服务，故意不启动队列 worker 或更新调度器。
if (process.argv.includes("--serve")) {
  const url = new URL(process.env.FLEET_QA_URL || "http://127.0.0.1:18880");
  assert.ok(
    url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname),
    "独立 UI 测试服务只允许监听本机 HTTP loopback",
  );
  const { createApp } = await import("../../apps/control-plane/src/app.ts");
  const { loadConfig } = await import("../../apps/control-plane/src/config.ts");
  const { id, now } = await import("@chrome-fleet/core");
  const root = mkdtempSync(join(tmpdir(), "chrome-fleet-ui-qa-"));
  mkdirSync(join(root, "secrets"), { mode: 0o700 });
  for (const [name, content] of [
    ["master.key", randomBytes(32)],
    ["admin-token", randomBytes(32).toString("base64url")],
    ["runner-token", randomBytes(32).toString("base64url")],
  ]) {
    writeFileSync(join(root, "secrets", name), content, { mode: 0o600 });
  }
  const { app, service, auth } = await createApp(
    loadConfig({
      FLEET_DATA_ROOT: root,
      FLEET_PORT: url.port || "18880",
      FLEET_PUBLIC_URL: url.origin,
      FLEET_WEB_ROOT: resolve("apps/web/dist"),
      // An unreachable fallback plus deny stubs keeps this fixture independent
      // of any real Runner accidentally listening on the host.
      RUNNER_URL: "http://127.0.0.1:1",
    }),
  );
  const catalogPath = join(root, "google-accounts-fixture.txt");
  writeFileSync(
    catalogPath,
    [
      `qa-google-a@example.test\t${randomBytes(24).toString("base64url")}\tqa-recovery-a@example.test`,
      `qa-google-b@example.test\t${randomBytes(24).toString("base64url")}\tqa-recovery-b@example.test`,
    ].join("\n"),
    { mode: 0o600 },
  );
  service.google.importFile(catalogPath);
  const googleIdentities = new Map();
  const googleNavigations = new Map();
  const googlePasswordPages = new Set();
  let rejectedRuntimeCalls = 0;
  const rejectRuntime = () => {
    rejectedRuntimeCalls++;
    throw new Error("UI_QA_RUNTIME_DISABLED");
  };
  service.runner.call = async (path) => {
    if (path === "/network-policy/sync") return { applied: true };
    return rejectRuntime();
  };
  service.agent = async (profile, path, body) => {
    if (path === "/accounts/google-login") {
      assert.deepEqual(body, {}, "固定 Google 导航请求不应包含凭据");
      googlePasswordPages.delete(profile.id);
      googleNavigations.set(
        profile.id,
        (googleNavigations.get(profile.id) || 0) + 1,
      );
      return { opened: true };
    }
    if (path === "/accounts/google-autofill") {
      assert.deepEqual(Object.keys(body).sort(), ["email", "password"]);
      assert.equal(typeof body.email, "string");
      assert.equal(typeof body.password, "string");
      assert.ok(body.email.endsWith("@example.test") && body.password.length > 0);
      return {
        stage: googlePasswordPages.has(profile.id) ? "password_filled" : "email_filled",
      };
    }
    if (path === "/accounts/google-identity")
      return googleIdentities.get(profile.id) || { status: "needs_login" };
    return rejectRuntime();
  };
  const googleTimer = setInterval(() => service.google.poll(), 250);
  googleTimer.unref();
  app.get("/__ui_qa__", async () => ({
    kind: "chrome-fleet-ui-qa",
    workerStarted: false,
    runnerIsolated: true,
    agentIsolated: true,
    rejectedRuntimeCalls,
  }));
  app.post("/__ui_qa__/google-identity", async (request) => {
    const principal = auth.authenticate(request);
    auth.require(principal, "admin");
    const profile = service.profile(request.body.profileId);
    assert.ok(
      [
        "authenticated",
        "unknown",
        "needs_login",
        "needs_verification",
      ].includes(request.body.status),
    );
    googleIdentities.set(profile.id, {
      status: request.body.status,
      identity: request.body.identity,
    });
    return { configured: true };
  });
  app.get("/__ui_qa__/google-navigation/:profileId", async (request) => {
    auth.require(auth.authenticate(request), "admin");
    return { count: googleNavigations.get(request.params.profileId) || 0 };
  });
  // Complete only the synthetic takeover; this fixture never contacts a Runner.
  app.post("/__ui_qa__/complete-takeover", async (request) => {
    auth.require(auth.authenticate(request), "admin");
    const job = service.job(request.body.jobId);
    assert.equal(job.kind, "browser_mode");
    assert.equal(job.payload.browserMode, "automation");
    assert.ok(job.payload.googleAccountId);
    assert.equal(job.status, "queued");
    const profile = service.profile(job.profileId);
    profile.browserMode = "automation"; profile.state = "running";
    profile.lastActivityAt = now(); service.saveProfile(profile);
    job.status = "succeeded"; job.finishedAt = now(); service.saveJob(job);
    return { completed: true };
  });
  // Simulates the person clicking email Next in the synthetic desktop only.
  app.post("/__ui_qa__/google-password-page", async (request) => {
    auth.require(auth.authenticate(request), "admin");
    const profile = service.profile(request.body.profileId);
    googlePasswordPages.add(profile.id);
    return { advanced: true };
  });
  // 仅在一次性测试服务中建立人工会话元数据，用于验证刷新恢复与结束租约。
  // 同时模拟运行状态以满足真实会话授权校验；不会启动浏览器或证明登录有效。
  app.post("/__ui_qa__/manual-session", async (request) => {
    const principal = auth.authenticate(request);
    auth.require(principal, "admin");
    const profile = service.profile(request.body.profileId);
    profile.state = "running";
    profile.desiredState = "running";
    service.saveProfile(profile);
    const sid = id("manual");
    const fencingToken = service.db.acquire(profile.id, sid, 120_000);
    assert.notEqual(fencingToken, undefined);
    const session = {
      id: sid,
      profileId: profile.id,
      principal: principal.id,
      fencingToken,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      closed: false,
      createdAt: now(),
    };
    service.db.set("manual-sessions", sid, session);
    return { created: true, sessionId: sid };
  });
  await app.listen({ host: url.hostname, port: Number(url.port || 18880) });
  console.log(`独立 UI 测试服务：${url.origin}`);
  console.log(`FLEET_QA_TOKEN_FILE=${join(root, "secrets", "admin-token")}`);
  console.log("未启动 worker；退出时会删除该服务的一次性数据。");
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(googleTimer);
    await app.close();
    service.close();
    rmSync(root, { recursive: true, force: true });
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
} else {
  await runUiChecks();
}

async function runUiChecks() {
  const baseUrl = process.env.FLEET_QA_URL?.replace(/\/+$/, "");
  const tokenFile = process.env.FLEET_QA_TOKEN_FILE;
  const executablePath = process.env.FLEET_QA_CHROME;
  assert.ok(baseUrl, "请设置 FLEET_QA_URL，指向 --serve 启动的独立测试服务");
  assert.ok(tokenFile, "请设置 FLEET_QA_TOKEN_FILE，勿在命令行填写真实令牌");
  assert.ok(
    executablePath,
    "请设置 FLEET_QA_CHROME，指向官方 Chrome 或显式 CfT",
  );
  const artifactDir = resolve(
    process.env.FLEET_QA_ARTIFACT_DIR || ".tools/ui-qa-artifacts",
  );
  const token = readFileSync(tokenFile, "utf8").trim();
  assert.ok(token.length >= 32, "测试管理员令牌文件无效");
  const { chromium } = await import("playwright");
  let browser;
  try {
    const marker = await fetch(`${baseUrl}/__ui_qa__`).then((r) => r.json());
    assert.equal(
      marker.kind,
      "chrome-fleet-ui-qa",
      "拒绝在生产服务上运行 UI 写入测试",
    );
    assert.equal(
      marker.workerStarted,
      false,
      "UI 检查要求测试队列不被后台 worker 执行",
    );
    assert.equal(marker.runnerIsolated, true, "UI 检查要求显式隔离真实 Runner");
    assert.equal(marker.agentIsolated, true, "UI 检查要求显式隔离真实浏览器 Agent");
    assert.equal(marker.rejectedRuntimeCalls, 0);
    mkdirSync(artifactDir, { recursive: true });
    browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1040 },
      locale: "zh-CN",
    });
    await context.addInitScript(() => {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        configurable: true,
        value: undefined,
      });
    });
    // 不启动浏览器容器；桌面只提供无网络的测试画布，REST API 均调用真实控制服务。
    await context.route("**/profiles/*/desktop", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="zh-CN"><title>UI QA 桌面画布</title><body>此画布不连接真实 VNC 或 Google。</body></html>',
      }),
    );
    const page = await context.newPage();
    const screenshot = async (filename) => {
      assert.equal(
        await page.getByRole("button", { name: "隐藏 VNC 密码", exact: true }).count(),
        0,
        "截图前必须先隐藏 VNC 密码",
      );
      const displayed = page.getByLabel("当前 VNC 密码", { exact: true });
      if (await displayed.count())
        assert.ok(
          /^(?:[●•*]{8})?$/.test(await displayed.inputValue()),
          "截图不能包含已查看的 VNC 密码",
        );
      await page.screenshot({ path: join(artifactDir, filename), fullPage: true });
    };
    const pageErrors = [];
    const apiErrors = [];
    const expectedApiErrors = new Set();
    const postKeys = [];
    const mutations = [];
    const uuidV4 =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && path.startsWith("/api/v1/"))
        mutations.push({ path, method: request.method() });
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname.startsWith("/api/v1/")
      )
        postKeys.push({
          path: new URL(request.url()).pathname,
          key: request.headers()["idempotency-key"],
        });
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      if (response.url().includes("/api/v1/") && response.status() >= 400) {
        const failure = `${response.status()} ${new URL(response.url()).pathname}`;
        if (!expectedApiErrors.has(failure)) apiErrors.push(failure);
      }
    });
    const name = `UI QA ${Date.now()}`;
    const renamed = `${name} · 已命名`;
    await page.goto(`${baseUrl}/accounts`);
    assert.deepEqual(
      await page.evaluate(() => ({
        randomUUID: typeof crypto.randomUUID,
        getRandomValues: typeof crypto.getRandomValues,
        secureContext: isSecureContext,
      })),
      {
        randomUUID: "undefined",
        getRandomValues: "function",
        secureContext: true,
      },
      "只移除 randomUUID，不应篡改 loopback 的安全上下文标志",
    );
    await page.getByRole("heading", { name: "登录浏览器工作台" }).waitFor();
    await page.getByLabel("平台访问令牌").fill(token);
    await page.getByRole("button", { name: "安全登录" }).click();
    await page.getByRole("heading", { name: /^账号管理/ }).waitFor();
    await assertRoute(page, "/accounts");
    const globalPages = [
      ["profiles", "浏览器实例", /^浏览器实例/],
      ["accounts", "账号管理", /^账号管理/],
      ["jobs", "任务中心", "任务中心"],
      ["updates", "更新管理", "浏览器更新"],
      ["guide", "使用指南", "让每个账号，各就其位"],
    ];
    for (const [path, label, heading] of globalPages) {
      await page.getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name: label, exact: path !== "profiles" }).click();
      await assertRoute(page, `/${path}`);
      await page.getByRole("heading", { name: heading }).first().waitFor();
      await page.reload();
      await assertRoute(page, `/${path}`);
      await page.getByRole("heading", { name: heading }).first().waitFor();
      await assertReadableLayout(page, `desktop ${path}`);
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
    await page.goto(`${baseUrl}/profiles`);
    await page.getByRole("heading", { name: /^浏览器实例/ }).waitFor();
    await assertRoute(page, "/profiles");
    assert.equal(await page.evaluate(() => localStorage.length), 0);
    assert.equal(await page.evaluate(() => sessionStorage.length), 0);
    const cookie = (await context.cookies()).find(
      (c) => c.name === "fleet_session",
    );
    assert.ok(cookie?.httpOnly);
    const catalog = (
      await (
        await context.request.get(`${baseUrl}/api/v1/google-accounts`)
      ).json()
    ).data.items;
    assert.equal(catalog.length, 2, "一次性 QA 应仅包含两条合成账号");
    assert.ok(
      catalog.every(
        (account) =>
          !Object.hasOwn(account, "password") &&
          !Object.hasOwn(account, "credentialsRef"),
      ),
    );
    const accountA = catalog.find(
      (account) => account.email === "qa-google-a@example.test",
    );
    const accountB = catalog.find(
      (account) => account.email === "qa-google-b@example.test",
    );
    assert.ok(accountA && accountB);
    const openAccounts = async () => {
      await page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name: "账号管理", exact: true })
        .click();
      await page
        .getByRole("heading", { name: /^账号管理/ })
        .waitFor();
      await assertRoute(page, "/accounts");
    };
    const accountRows = page.locator(".account-manager-row");
    const accountRow = (account) =>
      page.locator(`.account-manager-row[data-account-id="${account.id}"]`);
    const waitForAccountCount = async (count) => {
      await page.waitForFunction(
        (expected) =>
          document.querySelectorAll(".account-manager-row").length === expected,
        count,
      );
      assert.equal(await accountRows.count(), count);
    };
    const emptyProfiles = (
      await (await context.request.get(`${baseUrl}/api/v1/profiles`)).json()
    ).data.items;
    assert.equal(emptyProfiles.length, 0, "账号页验收必须在首个实例创建前进行");
    assert.equal(await page.getByRole("button", { name: /创建 Chrome/ }).count(), 0, "实例列表及空状态不得提供独立创建入口");
    await page.getByRole("button", { name: "前往账号管理", exact: true }).click();
    await assertRoute(page, "/accounts");
    for (const path of ["/profiles/new", "/profiles/new?from=profiles", "/#create", "/profiles#create?from=profiles"]) {
      await page.goto(baseUrl + path);
      await page.getByRole("heading", { name: /^账号管理/ }).waitFor();
      await assertRoute(page, "/accounts");
      assert.equal(await page.locator(".create-profile-form").count(), 0, "无账号的旧创建链接应返回账号管理");
    }
    await openAccounts();
    await waitForAccountCount(2);
    await accountRow(accountA)
      .getByText(accountA.email, { exact: true })
      .waitFor();
    await accountRow(accountB)
      .getByText(accountB.email, { exact: true })
      .waitFor();
    await accountRow(accountA)
      .getByText("未绑定 Chrome", { exact: true })
      .waitFor();
    await screenshot("accounts-no-profiles.png");
    const accountSearch = page.getByLabel("搜索邮箱或辅助邮箱");
    const accountFilter = page.getByLabel("按绑定状态筛选");
    await accountSearch.fill(accountA.email);
    await waitForAccountCount(1);
    await accountRow(accountA).waitFor();
    await accountSearch.fill("qa-recovery-b@example.test");
    await waitForAccountCount(1);
    await accountRow(accountB).waitFor();
    await accountSearch.fill("");
    await accountFilter.selectOption("bound");
    await waitForAccountCount(0);
    await accountFilter.selectOption("unbound");
    await waitForAccountCount(2);
    await accountFilter.selectOption("all");
    await accountRow(accountA)
      .getByRole("button", { name: "创建 Chrome 实例", exact: true })
      .click();
    const createPage = page.locator("main.create-profile-page");
    const assertCreatePage = async () => {
      await createPage
        .getByRole("heading", { name: "创建 Chrome 容器", exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole("dialog").count(),
        0,
        "创建实例应使用标准页面",
      );
      assert.equal(await page.locator(".modal-backdrop").count(), 0);
    };
    await assertCreatePage();
    const accountCreatePath = `/profiles/new?from=accounts&account=${encodeURIComponent(accountA.id)}`;
    await assertRoute(page, accountCreatePath);
    await page.reload();
    await assertCreatePage();
    await assertRoute(page, accountCreatePath);
    assert.equal(
      await createPage
        .getByLabel("关联账号", { exact: true })
        .inputValue(),
      accountA.email,
      "从全局账号创建实例应预填所选邮箱",
    );
    assert.ok(await createPage.getByLabel("关联账号", { exact: true }).evaluate(input => input.readOnly), "创建关联账号应只读");
    await page.goBack();
    await assertRoute(page, "/accounts");
    await page.getByRole("heading", { name: /^账号管理/ }).waitFor();
    await page.goForward();
    await assertRoute(page, accountCreatePath);
    await assertCreatePage();
    assert.equal(await createPage.getByLabel("关联账号", { exact: true }).inputValue(), accountA.email);
    await createPage
      .getByRole("button", { name: "取消创建", exact: true })
      .click();
    await page.getByRole("heading", { name: /^账号管理/ }).waitFor();
    await assertRoute(page, "/accounts");
    await waitForAccountCount(2);
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "浏览器实例", exact: false })
      .click();
    await page.getByRole("heading", { name: /^浏览器实例/ }).waitFor();
    await assertRoute(page, "/profiles");
    assert.equal(await page.getByRole("button", { name: /创建 Chrome/ }).count(), 0);
    await page.getByRole("button", { name: "前往账号管理", exact: true }).click();
    await accountRow(accountA).getByRole("button", { name: "创建 Chrome 实例", exact: true }).click();
    await assertCreatePage();
    await assertRoute(page, accountCreatePath);
    await assertReadableLayout(page, "desktop create");
    await screenshot("create-page.png");
    assert.equal(await createPage.getByLabel("浏览器模式", { exact: false }).inputValue(), "vnc", "新建应默认普通Chrome VNC模式");
    // The original automation regression remains explicit; VNC is exercised separately below.
    await createPage.getByLabel("浏览器模式", { exact: false }).selectOption("automation");
    await page.getByLabel("实例名称", { exact: true }).fill(name);
    // Even a modified DOM value must not change the account selected in the directory.
    await createPage.getByLabel("关联账号", { exact: true }).evaluate(input => { input.value = "unselected@example.test"; });
    await page.getByLabel("标签", { exact: true }).fill("工作, UI验收");
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/profiles") &&
        response.request().method() === "POST" &&
        response.status() === 201,
    );
    await page.getByRole("button", { name: "创建实例", exact: true }).click();
    const createdResponse = await created;
    assert.equal(createdResponse.request().postDataJSON().accountAlias, accountA.email, "创建必须使用目录所选账号");
    assert.ok(
      createdResponse.request().headers()["x-csrf-token"],
      "POST 回退仍须携带 CSRF 令牌",
    );
    const profile = (await createdResponse.json()).data;
    assert.equal(profile.state, "stopped");
    assert.equal(profile.browserMode, "automation");
    const assertNoPassword = (document, passwords = []) => {
      const forbidden = new Set([
        "password", "vncPassword", "oncePassword", "vncSecretRef",
        "keyringSecretRef", "agentTokenRef",
      ]);
      const visit = (value) => {
        if (!value || typeof value !== "object") return;
        for (const [key, item] of Object.entries(value)) {
          assert.ok(!forbidden.has(key), "普通实例 API 不应返回密码或凭证引用");
          visit(item);
        }
      };
      visit(document);
      const serialized = JSON.stringify(document);
      assert.ok(
        passwords.every((password) => !serialized.includes(password)),
        "普通实例 API 不应包含 VNC 密码值",
      );
    };
    await page
      .getByRole("heading", { name, exact: true })
      .waitFor();
    await assertRoute(page, `/profiles/${profile.id}/accounts`);
    await page.locator(".profile-confirmation-summary").getByText("待人工确认登录", { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("dialog").count(),
      0,
      "创建成功应进入实例详情，无一次性密码弹窗",
    );
    assert.equal(
      postKeys.filter((entry) => entry.path.endsWith("/password/reveal")).length,
      0,
      "创建实例不应自动请求密码明文",
    );
    for (const [tab, label] of [
      ["overview", "概览"], ["settings", "实例设置"],
      ["accounts", "账号状态"], ["tasks", "自动化任务"],
      ["sessions", "会话与备份"], ["updates", "浏览器更新"],
    ]) {
      await page.getByRole("tab", { name: label, exact: true }).click();
      await assertRoute(page, `/profiles/${profile.id}/${tab}`);
      await page.reload();
      await page.getByRole("heading", { name, exact: true }).waitFor();
      await assertRoute(page, `/profiles/${profile.id}/${tab}`);
      assert.equal(await page.getByRole("tab", { name: label, exact: true }).getAttribute("aria-selected"), "true");
      await assertReadableLayout(page, `desktop profile ${tab}`);
    }
    await page.getByRole("button", { name: "返回全部实例", exact: true }).click();
    await assertRoute(page, "/profiles");
    await page.getByRole("button", { name, exact: true }).waitFor();
    await screenshot("desktop.png");
    await page.getByRole("button", { name: `设置 ${name}`, exact: true }).click();
    await assertRoute(page, `/profiles/${profile.id}/settings`);
    await page.getByRole("button", { name: "返回全部实例", exact: true }).click();
    await page.getByRole("button", { name, exact: true }).click();
    await assertRoute(page, `/profiles/${profile.id}/overview`);
    await page.getByRole("tab", { name: "实例设置" }).click();
    await assertRoute(page, `/profiles/${profile.id}/settings`);
    await page.getByLabel("实例名称", { exact: true }).fill(renamed);
    await page.getByRole("button", { name: "保存基本设置" }).click();
    await page.getByRole("heading", { name: renamed, exact: true }).waitFor();
    await page.getByLabel("启用代理", { exact: true }).check();
    await page
      .getByLabel("代理地址", { exact: true })
      .fill("http://proxy.example.test:8081");
    await page.getByLabel("代理用户名", { exact: false }).fill("test-user");
    await page
      .getByLabel("代理密码", { exact: true })
      .fill("test-only-credential");
    await page.getByRole("button", { name: "保存代理配置" }).click();
    await page.getByText("认证凭证已设置", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("代理密码", { exact: true }).inputValue(),
      "",
    );
    const revealPath = `/api/v1/profiles/${profile.id}/remote-desktop/password/reveal`;
    const passwordField = page.getByLabel("当前 VNC 密码", { exact: true });
    const assertPasswordHidden = async () => {
      await page.getByRole("button", { name: "查看 VNC 密码", exact: true }).waitFor();
      assert.equal(
        await page.getByRole("button", { name: "隐藏 VNC 密码", exact: true }).count(),
        0,
      );
      if (await passwordField.count())
        assert.ok(
          /^(?:[●•*]{8})?$/.test(await passwordField.inputValue()),
          "隐藏后应清除密码明文并恢复掩码",
        );
    };
    const revealPassword = async () => {
      const revealed = page.waitForResponse(
        (response) =>
          response.url().endsWith(revealPath) &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "查看 VNC 密码", exact: true }).click();
      const response = await revealed;
      assert.equal(response.status(), 200);
      assert.ok(
        JSON.stringify(response.request().postDataJSON()) === "{}",
        "查看已保存密码应只提交空对象",
      );
      const saved = (await response.json()).data;
      assert.ok(/^[\x21-\x7e]{8}$/.test(saved.password), "VNC 密码格式应有效");
      await page.getByRole("button", { name: "隐藏 VNC 密码", exact: true }).waitFor();
      await passwordField.waitFor();
      assert.ok(
        (await passwordField.inputValue()) === saved.password,
        "设置页显示值应与主动查询的已保存密码一致",
      );
      assert.ok(await passwordField.evaluate((input) => input.readOnly));
      await page.getByRole("button", { name: "复制 VNC 密码", exact: true }).waitFor();
      return saved;
    };
    await assertPasswordHidden();
    const firstPassword = await revealPassword();
    if (profile.oncePassword)
      assert.ok(
        firstPassword.password === profile.oncePassword,
        "主动查看值应与创建时保存的生成密码一致",
      );
    await page.getByRole("button", { name: "隐藏 VNC 密码", exact: true }).click();
    await assertPasswordHidden();
    await revealPassword();
    await page.getByRole("button", { name: "返回全部实例", exact: true }).click();
    await page.getByRole("button", { name: renamed, exact: true }).click();
    await page.getByRole("tab", { name: "实例设置" }).click();
    await assertPasswordHidden();
    const persistedPassword = await revealPassword();
    assert.ok(
      persistedPassword.password === firstPassword.password,
      "离开实例再进入设置后应仍可主动查询已保存的生成密码",
    );
    await page.getByRole("tab", { name: "账号状态" }).click();
    await page.getByRole("tab", { name: "实例设置" }).click();
    await assertPasswordHidden();
    await revealPassword();
    const rotated = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/profiles/${profile.id}/remote-desktop/password`) &&
        response.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "更新桌面密码" }).click();
    const rotatedResponse = await rotated;
    assert.equal(rotatedResponse.status(), 200);
    await assertPasswordHidden();
    assert.equal(await page.getByRole("dialog").count(), 0);
    const rotatedPassword = await revealPassword();
    assert.ok(
      rotatedPassword.password !== firstPassword.password,
      "轮换后必须主动查看新密码，旧值应失效",
    );
    assert.ok(rotatedPassword.version > firstPassword.version);
    const verifiedPassword = await context.request.post(`${baseUrl}${revealPath}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {},
    });
    assert.ok(verifiedPassword.ok());
    assert.ok(
      (await verifiedPassword.json()).data.password === rotatedPassword.password,
      "轮换后设置页展示值应与后端已保存密码一致",
    );
    await page.getByRole("button", { name: "隐藏 VNC 密码", exact: true }).click();
    await assertPasswordHidden();
    for (const path of [
      "/api/v1/profiles",
      `/api/v1/profiles/${profile.id}`,
      `/api/v1/profiles/${profile.id}/remote-desktop`,
    ]) {
      const response = await context.request.get(`${baseUrl}${path}`);
      assert.ok(response.ok());
      assertNoPassword((await response.json()).data, [
        firstPassword.password,
        rotatedPassword.password,
      ]);
    }
    await page.getByRole("tab", { name: "账号状态" }).click();
    await page
      .getByText(accountA.email, { exact: true })
      .first()
      .waitFor();
    await page.getByRole("button", { name: "绑定期望账号" }).click();
    await page.getByLabel("站点 / 提供商").fill("example.test");
    await page.getByLabel("账号别名", { exact: true }).fill("测试站点");
    await page.getByLabel("期望账号身份", { exact: true }).fill("ui-user");
    await page.getByRole("button", { name: "绑定账号", exact: true }).click();
    await page.getByText("测试站点", { exact: true }).waitFor();
    await page.getByRole("tab", { name: "自动化任务", exact: true }).click();
    await assertRoute(page, `/profiles/${profile.id}/tasks`);
    await page.getByRole("button", { name: "提交任务", exact: true }).click();
    const jobCreated = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/v1/jobs" &&
      response.request().method() === "POST" && response.status() === 202);
    await page
      .getByRole("button", { name: "提交任务", exact: true })
      .last()
      .click();
    const jobId = (await (await jobCreated).json()).data.jobId;
    assert.ok(jobId);
    await page
      .getByRole("button", { name: "浏览器自动化", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "浏览器自动化", exact: true }).click();
    const profileJobPath = `/profiles/${profile.id}/tasks?job=${encodeURIComponent(jobId)}`;
    await assertRoute(page, profileJobPath);
    await page.reload();
    await page.getByRole("dialog").getByRole("heading", { name: "任务详情", exact: true }).waitFor();
    await assertRoute(page, profileJobPath);
    await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
    await assertRoute(page, `/profiles/${profile.id}/tasks`);
    await page.getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "任务中心", exact: true }).click();
    await assertRoute(page, "/jobs");
    await page.getByRole("button", { name: "浏览器自动化", exact: true }).click();
    const globalJobPath = `/jobs?job=${encodeURIComponent(jobId)}`;
    await assertRoute(page, globalJobPath);
    await page.reload();
    await page.getByRole("dialog").getByRole("heading", { name: "任务详情", exact: true }).waitFor();
    await assertRoute(page, globalJobPath);
    await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
    await assertRoute(page, "/jobs");
    await page.goBack();
    await assertRoute(page, globalJobPath);
    await page.getByRole("dialog").getByRole("heading", { name: "任务详情", exact: true }).waitFor();
    await page.goForward();
    await assertRoute(page, "/jobs");
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page.goto(`${baseUrl}/profiles/${profile.id}/tasks`);
    await page.getByRole("heading", { name: renamed, exact: true }).waitFor();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByText("已取消", { exact: true }).waitFor();
    await page.getByRole("tab", { name: "会话与备份" }).click();
    await assertRoute(page, `/profiles/${profile.id}/sessions`);
    await page
      .getByRole("heading", { name: "完整会话快照", exact: true })
      .waitFor();
    await page.getByRole("tab", { name: "浏览器更新" }).click();
    await assertRoute(page, `/profiles/${profile.id}/updates`);
    await page.getByRole("button", { name: "保存更新策略" }).click();
    await page
      .getByText(
        "更新策略已保存。仅已通过兼容验证的版本可在维护窗口自动应用。",
        { exact: true },
      )
      .waitFor();
    await screenshot("settings.png");
    const fixture = await context.request.post(
      `${baseUrl}/__ui_qa__/manual-session`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { profileId: profile.id },
      },
    );
    assert.ok(fixture.ok());
    await page.reload();
    await page.locator(".desktop-session-banner").waitFor();
    await page
      .locator(".desktop-session-banner")
      .getByRole("button", { name: "结束人工接管" })
      .click();
    await page
      .locator(".desktop-session-banner")
      .waitFor({ state: "detached" });
    const sessions = (
      await (
        await context.request.get(`${baseUrl}/api/v1/manual-sessions`)
      ).json()
    ).data;
    assert.equal(sessions.items.length, 0);
    const reacquired = await context.request.post(
      `${baseUrl}/__ui_qa__/manual-session`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { profileId: profile.id },
      },
    );
    assert.ok(reacquired.ok(), "结束人工会话后，实例租约应允许新持有者领取");
    const renewed = (
      await (
        await context.request.get(`${baseUrl}/api/v1/manual-sessions`)
      ).json()
    ).data;
    assert.equal(renewed.items.length, 1);
    const closed = await context.request.delete(
      `${baseUrl}/api/v1/manual-sessions/${renewed.items[0].id}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    assert.ok(closed.ok());
    const googleFixture = await context.request.post(
      `${baseUrl}/__ui_qa__/manual-session`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { profileId: profile.id },
      },
    );
    assert.ok(googleFixture.ok());
    const googleSessionId = (await googleFixture.json()).sessionId;
    const card = page.locator(".profile-card").filter({
      has: page.getByRole("button", { name: renamed, exact: true }),
    });
    await openAccounts();
    assert.equal(await accountRow(accountB).getByRole("button", { name: "Google 登录", exact: true }).count(), 0, "未关联账号应先创建或绑定实例");
    assert.equal(await accountRow(accountA).getByRole("button", { name: "创建 Chrome 实例", exact: true }).count(), 0, "创建成功后不能为同一账号重复创建");
    await accountRow(accountA)
      .getByRole("button", { name: "Google 登录", exact: true })
      .click();
    const loginDialog = page.getByRole("dialog");
    await loginDialog
      .getByRole("heading", { name: "选择登录实例", exact: true })
      .waitFor();
    assert.equal(
      await loginDialog.locator('input[type="password"]').count(),
      0,
      "Google 登录流程不能索要网站密码",
    );
    await loginDialog
      .getByLabel("目标 Chrome 实例")
      .selectOption(profile.id);
    const openedGoogle = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/profiles/${profile.id}/google-login`) &&
        response.request().method() === "POST",
    );
    const popupCreated = context.waitForEvent("page");
    await loginDialog
      .getByRole("button", { name: "Google 登录", exact: true })
      .click();
    const openedGoogleResponse = await openedGoogle;
    assert.equal(openedGoogleResponse.status(), 201, "合成Google会话应成功打开");
    const openedSession = (await openedGoogleResponse.json()).data;
    assert.equal(openedSession.googleLogin.autofill.stage, "email_filled");
    assert.deepEqual(Object.keys(openedSession.googleLogin.autofill).sort(), ["message", "stage"]);
    await page.locator(".desktop-session-banner")
      .getByText("邮箱已填好，请点击下一步", { exact: true }).waitFor();
    const advanced = await context.request.post(`${baseUrl}/__ui_qa__/google-password-page`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { profileId: profile.id },
    });
    assert.ok(advanced.ok());
    await page.locator('.desktop-session-banner [data-autofill-stage="password_filled"]').waitFor();
    await page.locator(".desktop-session-banner")
      .getByText("密码已填好，等待你提交", { exact: true }).waitFor();
    assert.equal(
      openedSession.id,
      googleSessionId,
      "Google 登录应复用已有人工会话与租约",
    );
    const desktopPage = await popupCreated;
    await desktopPage.waitForURL(`${baseUrl}/profiles/${profile.id}/desktop`);
    await page
      .locator(".desktop-session-banner .google-login-progress.waiting")
      .waitFor();
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "浏览器实例", exact: false })
      .click();
    await card.waitFor();
    const pageCount = context.pages().length;
    await card
      .locator(".card-actions")
      .getByRole("button", { name: "打开桌面", exact: true })
      .click();
    assert.equal(
      context.pages().length,
      pageCount,
      "普通桌面入口仍应复用原窗口",
    );
    const ordinaryDesktop = await context.request.get(
      `${baseUrl}/__ui_qa__/google-navigation/${profile.id}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(
      (await ordinaryDesktop.json()).count,
      1,
      "普通桌面入口不能触发 Google 导航",
    );
    const beforeConfirmationEntry = mutations.length;
    await card.locator(".card-account-entry").getByText("待人工确认登录", { exact: true }).waitFor();
    await card.locator(".card-account-entry").click();
    await assertRoute(page, `/profiles/${profile.id}/accounts`);
    assert.equal(mutations.length, beforeConfirmationEntry, "查看确认状态不应打开桌面或提交登录请求");
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page.locator(".detail-heading .google-login-button").click();
    await page
      .getByRole("dialog")
      .getByLabel("待绑定 Google 账号")
      .selectOption(accountA.id);
    const reopenedGoogle = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/profiles/${profile.id}/google-login`) &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Google 登录", exact: true })
      .click();
    assert.equal(
      (await (await reopenedGoogle).json()).data.id,
      googleSessionId,
    );
    assert.equal(
      context.pages().length,
      pageCount,
      "重复 Google 登录应复用已有桌面窗口",
    );
    const navigation = await context.request.get(
      `${baseUrl}/__ui_qa__/google-navigation/${profile.id}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(
      (await navigation.json()).count,
      2,
      "复用桌面时仍应向同一实例发起固定 Google 导航",
    );
    const identity = (email) =>
      context.request.post(`${baseUrl}/__ui_qa__/google-identity`, {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          profileId: profile.id,
          status: "authenticated",
          identity: email,
        },
      });
    assert.ok((await identity(accountA.email)).ok());
    await page
      .locator(".desktop-session-banner .google-login-progress.bound")
      .waitFor({ timeout: 20_000 });
    const bindings = async () =>
      (
        await (
          await context.request.get(
            `${baseUrl}/api/v1/profiles/${profile.id}/accounts`,
          )
        ).json()
      ).data.items;
    assert.ok(
      (await bindings()).some(
        (account) =>
          account.expectedIdentity === accountA.email &&
          account.authState === "authenticated",
      ),
      "后台轮询应在没有点击重新检测时自动识别并绑定",
    );
    await openAccounts();
    await accountFilter.selectOption("bound");
    await waitForAccountCount(1);
    await accountRow(accountA).waitFor();
    await accountRow(accountA)
      .getByText("已验证登录", { exact: true })
      .first()
      .waitFor();
    await screenshot("accounts-bound.png");
    assert.equal(await accountRow(accountA).getByRole("button", { name: "创建 Chrome 实例", exact: true }).count(), 0);
    assert.equal(await accountRow(accountA).getByRole("button", { name: "绑定到现有 Chrome", exact: true }).count(), 0);
    const duplicateCreatePage = await context.newPage();
    duplicateCreatePage.on("pageerror", error => pageErrors.push(error.message));
    await duplicateCreatePage.goto(baseUrl + accountCreatePath);
    await duplicateCreatePage.getByRole("heading", { name: "该账号已关联 Chrome 实例", exact: true }).waitFor();
    assert.equal(await duplicateCreatePage.locator(".create-profile-form").count(), 0, "刷新创建链接不得重复创建已关联账号的实例");
    await duplicateCreatePage.getByRole("button", { name: `查看实例 ${renamed}`, exact: true }).click();
    await assertRoute(duplicateCreatePage, `/profiles/${profile.id}/accounts`);
    await duplicateCreatePage.close();
    await page.bringToFront();
    await accountFilter.selectOption("unbound");
    await waitForAccountCount(1);
    await accountRow(accountB).waitFor();
    await accountFilter.selectOption("all");
    await waitForAccountCount(2);
    await accountRow(accountA)
      .getByRole("button", { name: `查看实例 ${renamed}`, exact: true })
      .click();
    await page.getByRole("heading", { name: renamed, exact: true }).waitFor();
    await assertRoute(page, `/profiles/${profile.id}/accounts`);
    await page.getByRole("tab", { name: "账号状态" }).click();
    await page
      .locator(".google-account-panel")
      .getByLabel("待绑定 Google 账号")
      .selectOption(accountB.id);
    const mismatchOpen = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/profiles/${profile.id}/google-login`) &&
        response.request().method() === "POST",
    );
    await page
      .locator(".google-account-panel")
      .getByRole("button", { name: "Google 登录", exact: true })
      .click();
    assert.equal((await (await mismatchOpen).json()).data.id, googleSessionId);
    await page
      .locator(".desktop-session-banner .google-login-progress.mismatch")
      .waitFor({ timeout: 20_000 });
    assert.ok(
      !(await bindings()).some(
        (account) => account.expectedIdentity === accountB.email,
      ),
      "身份不一致时不能创建所选账号的绑定",
    );
    assert.ok(
      (await bindings()).some(
        (account) =>
          account.expectedIdentity === accountA.email &&
          account.authState === "authenticated",
      ),
      "身份不一致时不能覆盖已有绑定",
    );
    assert.ok((await identity(accountB.email)).ok());
    await page
      .locator(".desktop-session-banner")
      .getByRole("button", { name: "重新检测", exact: true })
      .click();
    await page
      .locator(".desktop-session-banner .google-login-progress.bound")
      .waitFor();
    assert.ok(
      (await bindings()).some(
        (account) =>
          account.expectedIdentity === accountB.email &&
          account.authState === "authenticated",
      ),
    );
    await page
      .locator(".account-row")
      .filter({ hasText: accountB.email })
      .waitFor();
    await screenshot("google-bound.png");
    const desktopClosed = desktopPage.waitForEvent("close");
    await page
      .locator(".desktop-session-banner")
      .getByRole("button", { name: "结束人工接管", exact: true })
      .click();
    await desktopClosed;
    await page
      .locator(".desktop-session-banner")
      .waitFor({ state: "detached" });
    await page
      .getByRole("button", { name: "返回全部实例", exact: true })
      .click();
    await assertRoute(page, "/profiles");
    const createVncAccount = async (email) => {
      const response = await context.request.post(`${baseUrl}/api/v1/google-accounts`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { email, password: randomBytes(24).toString("base64url") },
      });
      assert.equal(response.status(), 201);
      return (await response.json()).data;
    };
    const vncAccountA = await createVncAccount("qa-vnc-a@example.test");
    const vncAccountB = await createVncAccount("qa-vnc-b@example.test");
    const vncName = `${name} · VNC`;
    assert.equal(await page.getByRole("button", { name: /创建 Chrome/ }).count(), 0, "有实例时列表同样不得提供独立创建入口");
    await openAccounts();
    await accountRow(vncAccountA).getByRole("button", { name: "创建 Chrome 实例", exact: true }).click();
    await assertCreatePage();
    assert.equal(await createPage.getByLabel("浏览器模式", { exact: false }).inputValue(), "vnc");
    await createPage.getByLabel("实例名称", { exact: true }).fill(vncName);
    const vncCreated = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/profiles" && response.request().method() === "POST" && response.status() === 201);
    await createPage.getByRole("button", { name: "创建实例", exact: true }).click();
    const vncProfile = (await (await vncCreated).json()).data;
    assert.equal(vncProfile.browserMode, "vnc");
    assert.equal(vncProfile.googleBinding.accountId, vncAccountA.id, "普通 Chrome 创建时应已关联所选账号");
    await page.getByRole("heading", { name: vncName, exact: true }).waitFor();
    await assertRoute(page, `/profiles/${vncProfile.id}/accounts`);
    await page.getByRole("tab", { name: "实例设置", exact: true }).click();
    assert.ok(await page.getByRole("button", { name: "测试浏览器出口", exact: true }).isDisabled());
    await page.getByRole("tab", { name: "自动化任务", exact: true }).click();
    assert.ok(await page.getByRole("button", { name: "提交任务", exact: true }).isDisabled());
    await page.getByRole("tab", { name: "会话与备份", exact: true }).click();
    for (const button of await page.getByRole("button", { name: /^(导入|导出)$/ }).all()) assert.ok(await button.isDisabled());
    await page.getByRole("button", { name: "创建完整快照", exact: true }).waitFor();
    await page.getByRole("tab", { name: "账号状态", exact: true }).click();
    const bindingPanel = page.locator(".vnc-google-binding-panel");
    await bindingPanel.getByRole("heading", { name: "Google 账号绑定与登录确认", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "检测登录状态", exact: true }).count(), 0, "VNC应使用目录绑定而非旧检测表单");
    await page.getByRole("button", { name: "返回全部实例", exact: true }).click();
    const vncCard = page.locator(".profile-card").filter({ has: page.getByRole("button", { name: vncName, exact: true }) });
    await vncCard.locator(".card-account-entry").getByText("待人工确认登录", { exact: true }).waitFor();
    assert.equal(await vncCard.getByRole("button", { name: /Google 登录/ }).count(), 0);
    assert.equal(await vncCard.getByRole("button", { name: /绑定账号/ }).count(), 0, "通过账号创建的 Chrome 已有关联账号");
    await vncCard.locator(".card-account-entry").click();
    await assertRoute(page, `/profiles/${vncProfile.id}/accounts`);
    const vncProfileData = async () => (await (await context.request.get(`${baseUrl}/api/v1/profiles/${vncProfile.id}`)).json()).data;
    const noVncSessions = async () => {
      const sessions = (await (await context.request.get(`${baseUrl}/api/v1/manual-sessions?profileId=${vncProfile.id}`)).json()).data.items;
      assert.equal(sessions.length, 0, "保存绑定与人工确认均不应创建桌面会话");
    };
    const metadataMutationsStart = mutations.length;
    await bindingPanel.getByRole("button", { name: "换绑账号", exact: true }).click();
    assert.ok(await bindingPanel.locator(`option[value="${accountA.id}"]`).evaluate(option => option.disabled), "其他实例的账号不可选");
    await bindingPanel.getByLabel("待绑定 Google 账号", { exact: false }).selectOption(vncAccountA.id);
    assert.ok(await bindingPanel.getByRole("button", { name: "保存换绑", exact: true }).isDisabled(), "当前关联账号不应重复保存");
    await bindingPanel.getByText(`已绑定账号：${vncAccountA.email}`, { exact: true }).waitFor();
    await bindingPanel.getByText("已绑定，待人工确认", { exact: true }).waitFor();
    await noVncSessions();
    assert.equal((await vncProfileData()).state, "stopped", "保存metadata不应启动Chrome");
    await bindingPanel.getByLabel("待绑定 Google 账号", { exact: false }).selectOption(vncAccountB.id);
    const rebound = page.waitForResponse((response) => response.url().endsWith(`/profiles/${vncProfile.id}/google-binding`) && response.request().method() === "PUT");
    await bindingPanel.getByRole("button", { name: "保存换绑", exact: true }).click();
    const reboundResponse = await rebound;
    assert.equal(reboundResponse.status(), 200);
    assert.deepEqual(reboundResponse.request().postDataJSON(), { accountId: vncAccountB.id });
    assert.equal((await reboundResponse.json()).data.confirmationState, "unconfirmed");
    await bindingPanel.getByText(`已绑定账号：${vncAccountB.email}`, { exact: true }).waitFor();
    await page.goto(`${baseUrl}/profiles`);
    await vncCard.locator(".card-account-entry").click();
    await assertRoute(page, `/profiles/${vncProfile.id}/accounts`);
    await page.locator(".detail-heading .google-login-button").click();
    const vncDialog = page.getByRole("dialog");
    await vncDialog.getByRole("button", { name: "打开VNC登录", exact: true }).waitFor();
    assert.equal(await vncDialog.locator("select").count(), 0);
    await vncDialog.getByText(vncAccountB.email, { exact: true }).waitFor();
    const vncSession = await context.request.post(`${baseUrl}/__ui_qa__/manual-session`, { headers: { Authorization: `Bearer ${token}` }, data: { profileId: vncProfile.id } });
    assert.ok(vncSession.ok());
    const vncOpened = page.waitForResponse((response) => response.url().endsWith(`/profiles/${vncProfile.id}/google-login`) && response.request().method() === "POST");
    const vncPopupCreated = context.waitForEvent("page");
    await vncDialog.getByRole("button", { name: "打开VNC登录", exact: true }).click();
    const vncOpenResponse = await vncOpened;
    assert.equal(vncOpenResponse.status(), 201);
    const vncState = (await vncOpenResponse.json()).data.googleLogin;
    assert.equal(vncState.browserMode, "vnc"); assert.equal(vncState.expectedEmail, vncAccountB.email);
    assert.equal(vncState.autofill, undefined);
    const vncPopup = await vncPopupCreated;
    await vncPopup.waitForURL(`${baseUrl}/profiles/${vncProfile.id}/desktop`);
    const vncProgress = page.locator(".desktop-session-banner .google-login-progress");
    await vncProgress.getByText(`已绑定账号：${vncAccountB.email}`, { exact: true }).waitFor();
    const vncNavigation = await context.request.get(`${baseUrl}/__ui_qa__/google-navigation/${vncProfile.id}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await vncNavigation.json()).count, 0);
    const confirmResponse = page.waitForResponse((response) => response.url().endsWith(`/profiles/${vncProfile.id}/google-login/confirm`) && response.request().method() === "POST");
    const popupClosed = vncPopup.waitForEvent("close");
    await vncProgress.getByRole("button", { name: "确认已登录", exact: true }).click();
    const confirmedResponse = await confirmResponse; assert.equal(confirmedResponse.status(), 200);
    const confirmed = (await confirmedResponse.json()).data;
    assert.ok(confirmed.takeoverJobId); assert.ok(confirmed.lastConfirmedAt);
    await popupClosed; await noVncSessions();
    const completeTakeover = async (jobId) => {
      const result = await context.request.post(`${baseUrl}/__ui_qa__/complete-takeover`, { headers: { Authorization: `Bearer ${token}` }, data: { jobId } });
      assert.ok(result.ok());
    };
    await completeTakeover(confirmed.takeoverJobId);
    await page.getByText("已启用自动化接管，空闲自动关闭将按实例设置生效。", { exact: true }).waitFor();
    assert.equal((await vncProfileData()).browserMode, "automation");
    await page.goto(`${baseUrl}/profiles/${vncProfile.id}/tasks`);
    await page.getByRole("button", { name: "提交任务", exact: true }).waitFor();
    assert.ok(await page.getByRole("button", { name: "提交任务", exact: true }).isEnabled());
    await page.reload();
    assert.equal((await vncProfileData()).googleBinding.lastConfirmedAt, confirmed.lastConfirmedAt);
    await screenshot("vnc-automation-takeover.png");

    await page.goto(`${baseUrl}/profiles`);
    await vncCard.locator(".card-account-entry").getByText("已人工确认登录", { exact: true }).waitFor();
    const beforeConfirmedEntry = mutations.length;
    await vncCard.locator(".card-account-entry").click();
    await assertRoute(page, `/profiles/${vncProfile.id}/accounts`);
    const confirmationRecord = page.locator(".profile-confirmation-summary");
    await confirmationRecord.getByText("已人工确认登录", { exact: true }).waitFor();
    await confirmationRecord.getByText("人工确认时间", { exact: true }).waitFor();
    assert.equal(mutations.length, beforeConfirmedEntry, "已确认卡片只应查看持久确认记录");

    // Directory confirmation also starts takeover without any desktop session.
    const secondCreated = await context.request.post(`${baseUrl}/api/v1/profiles`, { headers: { Authorization: `Bearer ${token}` }, data: { name: `${vncName} directory`, vncPassword: "fixture1" } });
    const secondVnc = (await secondCreated.json()).data;
    const secondBound = await context.request.put(`${baseUrl}/api/v1/profiles/${secondVnc.id}/google-binding`, { headers: { Authorization: `Bearer ${token}` }, data: { accountId: vncAccountA.id } });
    assert.ok(secondBound.ok());
    await openAccounts();
    const manualBinding = accountRow(vncAccountA).locator(".account-manager-binding").filter({ has: page.getByText(secondVnc.name, { exact: true }) });
    const directoryConfirmed = page.waitForResponse((response) => response.url().endsWith(`/profiles/${secondVnc.id}/google-login/confirm`) && response.request().method() === "POST");
    await accountRow(vncAccountA).locator(".account-manager-actions").getByRole("button", { name: "确认已登录", exact: true }).click();
    const directoryResponse = await directoryConfirmed; assert.equal(directoryResponse.status(), 200);
    const directoryState = (await directoryResponse.json()).data; assert.ok(directoryState.takeoverJobId);
    await completeTakeover(directoryState.takeoverJobId);
    await page.getByText("已启用自动化接管，空闲自动关闭将按实例设置生效。", { exact: true }).waitFor();
    const secondVisible = (await (await context.request.get(`${baseUrl}/api/v1/profiles/${secondVnc.id}`)).json()).data;
    assert.equal(secondVisible.browserMode, "automation");
    const secondSessions = (await (await context.request.get(`${baseUrl}/api/v1/manual-sessions?profileId=${secondVnc.id}`)).json()).data.items;
    assert.equal(secondSessions.length, 0);
    assert.ok(mutations.slice(metadataMutationsStart).some(entry => entry.path.endsWith("/google-login/confirm")));
    await page.goto(`${baseUrl}/profiles/${vncProfile.id}/settings`);
    const modePanel = page.locator(".browser-mode-settings");
    await modePanel.getByLabel("浏览器模式", { exact: false }).selectOption("vnc");
    const modeQueued = page.waitForResponse((response) => response.url().endsWith(`/profiles/${vncProfile.id}/browser-mode`) && response.request().method() === "PUT");
    await modePanel.getByRole("button", { name: "切换为 VNC 模式", exact: true }).click();
    const modeResponse = await modeQueued;
    assert.equal(modeResponse.status(), 202);
    assert.deepEqual(modeResponse.request().postDataJSON(), { browserMode: "vnc" });
    assert.ok((await modeResponse.json()).data.jobId);
    await page.goto(`${baseUrl}/profiles`);
    await page.getByRole("heading", { name: /^浏览器实例/ }).waitFor();
    await page.goto(`${baseUrl}/page-that-does-not-exist`);
    await page.getByRole("heading", { name: "页面不存在", exact: true }).waitFor();
    await assertRoute(page, "/page-that-does-not-exist");
    await page.getByRole("button", { name: "返回浏览器实例", exact: true }).click();
    await assertRoute(page, "/profiles");
    const missingId = "cf_00000000-0000-4000-8000-000000000000";
    expectedApiErrors.add(`404 /api/v1/profiles/${missingId}`);
    await page.goto(`${baseUrl}/profiles/${missingId}/settings`);
    await page.getByRole("heading", { name: "找不到这个实例", exact: true }).waitFor();
    await assertRoute(page, `/profiles/${missingId}/settings`);
    await page.getByRole("button", { name: "返回浏览器实例", exact: true }).click();
    await assertRoute(page, "/profiles");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("heading", { name: /^浏览器实例/ }).waitFor();
    await assertReadableLayout(page, "390px profiles");
    await screenshot("mobile.png");
    // This shortcut is intentionally visible only at max-width:470px.
    await page.getByRole("button", { name: `查看 ${renamed} 的任务`, exact: true }).click();
    await assertRoute(page, `/profiles/${profile.id}/tasks`);
    await page.getByRole("tab", { name: "自动化任务", exact: true }).waitFor();
    await page.getByRole("button", { name: "返回全部实例", exact: true }).click();
    await assertRoute(page, "/profiles");
    const mobileAccount = await createVncAccount("qa-mobile-create@example.test");
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await openAccounts();
    await accountRow(mobileAccount).getByRole("button", { name: "创建 Chrome 实例", exact: true }).click();
    await assertCreatePage();
    const mobileCreatePath = `/profiles/new?from=accounts&account=${mobileAccount.id}`;
    await assertRoute(page, mobileCreatePath);
    await page.reload();
    await assertCreatePage();
    await assertReadableLayout(page, "390px create");
    await screenshot("create-mobile.png");
    await createPage.getByRole("button", { name: "取消创建", exact: true }).click();
    await assertRoute(page, "/accounts");
    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: "任务中心", exact: false }).click();
    await page
      .getByRole("heading", { name: "任务中心", exact: true })
      .waitFor();
    await assertRoute(page, "/jobs");
    await assertReadableLayout(page, "390px jobs");
    assert.deepEqual(pageErrors, [], "浏览器出现未处理的页面错误");
    assert.deepEqual(apiErrors, [], "关键界面发出了失败的 API 请求");
    const finalMarker = await fetch(`${baseUrl}/__ui_qa__`).then((response) => response.json());
    assert.equal(finalMarker.rejectedRuntimeCalls, 0, "UI 功能流程不应尝试调用未声明的运行时操作");
    assert.ok(
      postKeys.some((entry) => entry.path === "/api/v1/session"),
      "应实际完成登录 POST",
    );
    assert.ok(
      postKeys.some((entry) => entry.path === "/api/v1/profiles"),
      "应实际完成带幂等键的实例创建 POST",
    );
    for (const entry of postKeys)
      assert.match(
        entry.key || "",
        uuidV4,
        `${entry.path} 应携带符合版本与 variant 位约束的 UUID v4`,
      );
    assert.equal(
      new Set(postKeys.map((entry) => entry.key)).size,
      postKeys.length,
      "不同 POST 应使用不同幂等键",
    );
    console.log(
      "通过：绑定与换绑、固定账号VNC登录、确认后释放桌面并显示自动化接管结果、网页任务启用、确认时间持久化、目录无桌面接管；默认VNC/模式切换、路由与390px布局、密码和自动化兼容流程均通过。接管完成由隔离夹具模拟，未调用真实Runner。",
    );
    console.log(`页面错误 0；失败 API 请求 0。截图：${artifactDir}`);
  } catch (error) {
    console.error(
      String(error?.stack || error).replaceAll(token, "[REDACTED]"),
    );
    process.exitCode = 1;
  } finally {
    await browser?.close();
  }
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
