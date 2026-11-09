// Runs against an isolated static frontend. All API, previews and desktops are synthetic.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';

const base = process.env.FLEET_QA_URL || 'http://127.0.0.1:18886';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const artifacts = resolve(process.env.FLEET_QA_ARTIFACT_DIR || '.tools/desktop-workspace-qa');
mkdirSync(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.FLEET_QA_CHROME || resolve('.tools/ui-chrome/chrome-linux64/chrome'), headless: true, args: ['--no-sandbox'] });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN' });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [], unexpected = [], mutations = [], loads = new Map(), previewReads = new Map();
  const sessions = new Map(), cached = new Set();
  const thumbnails = new Map();
  let sequence = 0;
  let denyManual = false;
  const profileRows = ['A', 'B', 'C', 'D'].map((name, i) => ({
    id: `cf_00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, name: `测试桌面 ${name}`, browserMode: 'vnc', state: 'running', tags: [],
    startupPolicy: 'on_demand', idleTimeoutMinutes: 15, headless: false, accounts: [],
    googleBinding: { accountId: `google_${i}`, email: `synthetic-${name.toLowerCase()}@example.test`, confirmationState: 'unconfirmed' },
    platformAccounts: [{ id: `link_${i}`, profileId: `cf_00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, platformId: 'github', platformName: 'GitHub', googleAccountId: `google_${i}`, enabled: true, confirmationState: 'unconfirmed', expectedIdentity: '', loginUrl: 'https://example.test/login', accountUrl: 'https://example.test/account' }],
    health: { browserMode: 'vnc', desktopPreviewAvailable: true, ready: true },
    metrics: { available: true, sampledAt: new Date().toISOString(), cpuPercent: 2.5, memoryBytes: 256 * 1024 ** 2, memoryLimitBytes: 2 * 1024 ** 3 },
  }));
  const createSession = profile => {
    let session = [...sessions.values()].find(session => session.profileId === profile.id);
    if (!session) {
      session = { id: `manual_00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`, profileId: profile.id,
        desktopPath: `/profiles/${profile.id}/desktop`, expiresAt: new Date(Date.now() + 900000).toISOString() };
      sessions.set(session.id, session);
    }
    return session;
  };
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    if (method !== 'GET') mutations.push(`${method} ${path}`);
    let data;
    if (path === '/api/v1/session') data = { authenticated: true, csrfToken: 'synthetic-workspace' };
    else if (path === '/api/v1/profiles') data = { items: profileRows, total: profileRows.length };
    else if (path === '/api/v1/manual-sessions') {
      if (denyManual) return route.fulfill({ status: 403, json: { code: 'SCOPE_DENIED', message: 'synthetic scope revoked' } });
      data = { items: [...sessions.values()], total: sessions.size };
    }
    else if (path === '/api/v1/host-metrics') data = { scope: 'host', available: false };
    else if (path === '/api/v1/google-accounts') data = { items: profileRows.map((profile, i) => ({ id: `google_${i}`, email: profile.googleBinding.email, bindings: [{ profileId: profile.id, profileName: profile.name }] })), total: profileRows.length };
    else if (path === '/api/v1/platforms') data = { items: [{ id: 'github', name: 'GitHub', enabled: true, homeUrl: 'https://example.test/', loginUrl: 'https://example.test/login', accountUrl: 'https://example.test/account' }], total: 1 };
    else if (path.startsWith('/api/v1/jobs/')) data = { id: path.split('/').at(-1), status: 'succeeded' };
    else if (path === '/api/v1/jobs') data = { items: [], total: 0 };
    else if (path.startsWith('/api/v1/manual-sessions/') && method === 'DELETE') { sessions.delete(path.split('/').at(-1)); data = { closed: true }; }
    else {
      const match = path.match(/^\/api\/v1\/profiles\/([^/]+)(.*)$/);
      const profile = profileRows.find(profile => profile.id === match?.[1]);
      const action = match?.[2];
      if (profile && !action) data = profile;
      else if (profile && method === 'POST' && ['/manual-sessions', '/google-login', '/platforms/github/login'].includes(action)) {
        profile.state = 'running'; data = createSession(profile);
        if (action === '/google-login') data.googleLogin = { status: 'waiting', browserMode: 'vnc', expectedEmail: profile.googleBinding.email };
      } else if (profile && method === 'PUT' && action === '/browser-mode') {
        profile.browserMode = 'vnc'; profile.health.browserMode = 'vnc'; data = { id: 'job_mode', status: 'queued' };
      } else if (profile && method === 'POST' && action === '/stop') {
        assert.ok(![...sessions.values()].some(session => session.profileId === profile.id), 'stop must release the caller’s manual lease first');
        profile.state = 'stopped'; data = { id: 'job_stop', status: 'queued' };
      } else if (profile && ['/jobs', '/accounts', '/snapshots', '/updates'].includes(action)) data = { items: [], total: 0 };
    }
    if (data === undefined) { unexpected.push(`${method} ${path}`); return route.fulfill({ status: 404, json: { message: 'synthetic route missing' } }); }
    return route.fulfill({ status: method === 'POST' ? 201 : 200, contentType: 'application/json', body: JSON.stringify({ data, requestId: 'synthetic-ui' }) });
  });
  await context.route('**/profiles/*/desktop/preview', async route => {
    const id = new URL(route.request().url()).pathname.split('/')[2];
    const profile = profileRows.find(profile => profile.id === id);
    previewReads.set(id, (previewReads.get(id) || 0) + 1);
    if (profile.health.desktopPreviewAvailable !== true) return route.fulfill({ status: 503, json: { code: 'DESKTOP_PREVIEW_UNAVAILABLE' } });
    if (profile.state === 'running') cached.add(id);
    if (!cached.has(id)) return route.fulfill({ status: 503, json: { code: 'DESKTOP_PREVIEW_UNAVAILABLE' } });
    return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'x-fleet-preview-sampled-at': new Date().toISOString(), 'cache-control': 'no-store' }, body: thumbnails.get(id) || png });
  });
  await context.route(/\/profiles\/[^/]+\/desktop$/, async route => {
    const id = new URL(route.request().url()).pathname.split('/')[2];
    const session = [...sessions.values()].find(session => session.profileId === id);
    loads.set(id, (loads.get(id) || 0) + 1);
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><style>body{margin:0;background:#e9edf5;font:18px system-ui;color:#293246}header{padding:18px;background:#fff;border-bottom:1px solid #d5dbe7}main{padding:40px}section{padding:20px;background:white;max-width:600px;border-radius:10px}textarea{width:95%;height:80px}</style><body><header>Chrome · 隔离合成桌面</header><main><section><h1>${profileRows.find(profile => profile.id === id).name}</h1><p>当前页面只包含测试内容。</p><input aria-label="远程输入" placeholder="远程键盘焦点测试"><div id="clipboard" hidden><h2>桌面剪贴板</h2><textarea aria-label="剪贴板文本"></textarea></div></section></main><script>
      window.inputEnabled=false;
      const framebuffer=document.createElement('canvas');framebuffer.width=1440;framebuffer.height=900;framebuffer.hidden=true;
      const pixels=framebuffer.getContext('2d');pixels.fillStyle='#edf0f7';pixels.fillRect(0,0,1440,900);pixels.fillStyle='#7160d3';pixels.font='48px sans-serif';pixels.fillText('Synthetic VNC framebuffer',100,160);document.body.append(framebuffer);
      function state(){parent.postMessage({type:'fleet-desktop-state',profileId:'${id}',sessionId:'${session.id}',state:'connected'},location.origin)}
      addEventListener('message',event=>{const data=event.data;if(event.origin!==location.origin||event.source!==parent||data.profileId!=='${id}'||data.sessionId!=='${session.id}')return;
        if(data.action==='activate'){window.inputEnabled=data.active;document.documentElement.dataset.active=String(data.active);if(!data.active){document.activeElement.blur();document.getElementById('clipboard').hidden=true;document.querySelector('textarea').value='';}}
        if(data.action==='clipboard'&&window.inputEnabled)document.getElementById('clipboard').hidden=false;
        if(data.action==='reconnect')state();});state();
    </script></body></html>` });
  });
  const card = index => page.locator(`#profile-card-${profileRows[index].id}`);
  const workspace = page.getByRole('region', { name: '远程桌面工作区' });
  const visibleFrame = () => page.locator('.desktop-workspace iframe:not([hidden])');
  const frame = index => page.frameLocator(`iframe[data-session-id="${[...sessions.values()].find(session => session.profileId === profileRows[index].id)?.id}"]`);
  const expand = async index => { await card(index).getByRole('button', { name: '打开桌面', exact: true }).click(); await visibleFrame().waitFor(); await workspace.getByRole('button', { name: '剪贴板', exact: true }).waitFor({ state: 'visible' }); };
  const thumbnailPage = await context.newPage();
  await thumbnailPage.setViewportSize({ width: 640, height: 400 });
  for (const profile of profileRows) {
    await thumbnailPage.setContent(`<style>body{margin:0;background:#edf0f7;color:#30384e;font:14px system-ui}header{padding:12px 20px;background:#dce1ee}nav{padding:10px 22px;background:white;color:#9299ac}main{padding:35px}article{padding:26px;border:1px solid #e1e5ef;border-radius:12px;background:white}h1{color:#7160d3;font-size:27px;margin:8px 0}p{color:#9098a9}small{color:#399779}</style><header>◉　Chrome　 ·　${profile.name}</header><nav>←　→　↻　　workspace.example.test</nav><main><article><small>●　普通 Chrome · 合成验收页面</small><h1>${profile.name}</h1><p>${profile.googleBinding.email}</p><p>独立浏览器环境 · 页面内桌面</p></article></main>`);
    thumbnails.set(profile.id, await thumbnailPage.screenshot());
  }
  await thumbnailPage.close();
  await page.goto(`${base}/profiles`);
  await card(0).locator('[data-preview-state="live"]').waitFor();
  assert.equal(mutations.length, 0, 'viewing previews must never acquire a lease');
  await page.screenshot({ path: join(artifacts, 'cards.png'), fullPage: true });
  await expand(0); const aSession = [...sessions.values()][0].id;
  await frame(0).getByRole('heading', { name: '测试桌面 A' }).waitFor();
  await workspace.getByRole('button', { name: '缩回卡片' }).click();
  await card(0).waitFor({ state: 'visible' }); assert.equal(sessions.size, 1); assert.ok(sessions.has(aSession));
  await card(0).getByText(/人工接管中/).waitFor();
  const firstOpenMutations = mutations.length;
  await expand(0);
  assert.equal(mutations.length, firstOpenMutations, 'reopening a valid instance reuses its session');
  await workspace.getByRole('button', { name: '缩回卡片' }).click();
  await expand(1); await workspace.getByRole('tab', { name: '测试桌面 A' }).click();
  await frame(0).locator('html[data-active="true"]').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.desktop-workspace iframe').length === 2);
  await frame(1).locator('html[data-active="false"]').waitFor({ state: 'attached' });
  assert.equal(loads.get(profileRows[0].id), 1, 'switching tabs must not reload retained iframes');
  await workspace.getByRole('button', { name: '剪贴板', exact: true }).click();
  await frame(0).getByRole('heading', { name: '桌面剪贴板' }).waitFor();
  await page.screenshot({ path: join(artifacts, 'workspace.png') });
  await page.locator('.sidebar').getByRole('button', { name: '账号管理' }).click();
  await page.getByRole('heading', { name: /^账号管理/ }).waitFor();
  assert.equal(sessions.size, 2); assert.equal(await workspace.getByRole('tab').count(), 2);
  await frame(0).locator('html[data-active="false"]').waitFor({ state: 'attached' });
  await workspace.getByRole('tab', { name: '测试桌面 A' }).click();
  await visibleFrame().waitFor(); await workspace.getByRole('button', { name: '缩回卡片' }).click();
  await expand(2); await workspace.getByRole('button', { name: '缩回卡片' }).click();
  await expand(3);
  await page.waitForFunction(() => document.querySelectorAll('.desktop-workspace iframe').length === 3);
  assert.equal(await workspace.getByRole('tab').count(), 4); assert.equal(sessions.size, 4);
  // B was least recently used; A was revisited from the global desktop strip.
  assert.equal(await page.locator(`iframe[data-session-id="${[...sessions.values()].find(session => session.profileId === profileRows[1].id).id}"]`).count(), 0);
  await workspace.getByRole('tab', { name: '测试桌面 B' }).click();
  await frame(1).getByRole('heading', { name: '测试桌面 B' }).waitFor();
  assert.equal(loads.get(profileRows[1].id), 2); assert.equal(sessions.size, 4);
  if (await workspace.getByRole('button', { name: '全屏', exact: true }).count()) {
    await workspace.getByRole('button', { name: '全屏', exact: true }).click();
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    await workspace.getByRole('button', { name: '退出全屏' }).click();
    await page.waitForFunction(() => !document.fullscreenElement);
  }
  await workspace.locator('summary').click();
  const popupOpened = context.waitForEvent('page');
  await workspace.getByRole('button', { name: '在新窗口打开' }).click();
  const popup = await popupOpened; await popup.close();
  assert.equal(sessions.size, 4, 'closing an external window does not release the session');
  await workspace.getByRole('button', { name: '折叠或展开导航' }).click();
  assert.equal(await page.locator('.sidebar').isVisible(), false);
  await workspace.getByRole('button', { name: '折叠或展开导航' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(artifacts, 'workspace-mobile.png') });
  await workspace.getByRole('button', { name: '缩回卡片' }).click();
  await card(1).waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(artifacts, 'cards-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await card(1).getByRole('button', { name: '关闭', exact: true }).click();
  await card(1).locator('[data-preview-state="stopped"] img').waitFor();
  assert.equal(sessions.size, 3, 'stopping a minimized instance releases its own manual session');
  assert.equal(await card(1).locator('img').count(), 1, 'stopped instance retains its last image');
  const beforeReload = mutations.length;
  await page.reload(); await workspace.getByRole('tab', { name: '测试桌面 A' }).waitFor();
  assert.equal(await page.locator('.desktop-workspace iframe').count(), 0, 'refresh restores tabs in minimized state');
  assert.equal(mutations.length, beforeReload);
  await workspace.getByRole('tab', { name: '测试桌面 A' }).click();
  await visibleFrame().waitFor();
  // Explicitly ending a session is the operation that releases it.
  await workspace.locator('summary').click();
  await workspace.getByRole('button', { name: '结束人工接管', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.desktop-workspace [role="tab"]').length === 2);
  assert.equal(sessions.size, 2);
  // Route all platform logins through the shared controller, including an old automation instance.
  await workspace.getByRole('button', { name: '缩回卡片' }).click();
  profileRows[0].browserMode = 'automation'; profileRows[0].health.browserMode = 'automation';
  await page.goto(`${base}/profiles/${profileRows[0].id}/accounts`);
  await page.locator('.platform-links-panel').getByRole('button', { name: '打开桌面登录' }).click();
  await visibleFrame().waitFor();
  const modeIndex = mutations.findIndex(value => value === `PUT /api/v1/profiles/${profileRows[0].id}/browser-mode`);
  const loginIndex = mutations.findIndex(value => value === `POST /api/v1/profiles/${profileRows[0].id}/platforms/github/login`);
  assert.ok(modeIndex >= 0 && loginIndex > modeIndex, 'ordinary Chrome mode must be confirmed before platform login opens');
  await workspace.getByRole('button', { name: '缩回卡片' }).click();
  await page.goto(`${base}/profiles/${profileRows[0].id}/accounts`);
  await page.locator('.detail-heading').getByRole('button', { name: 'Google 登录', exact: true }).click();
  await page.getByRole('button', { name: '打开VNC登录', exact: true }).click();
  await visibleFrame().waitFor();
  assert.ok(mutations.includes(`POST /api/v1/profiles/${profileRows[0].id}/google-login`));
  await page.locator('.sidebar').getByRole('button', { name: '账号管理' }).click();
  profileRows[0].googleBinding.confirmationState = 'confirmed';
  await page.reload();
  await page.locator('[data-account-id="google_0"]').getByRole('button', { name: '打开桌面', exact: true }).click();
  await visibleFrame().waitFor();
  // A legacy Agent has no preview endpoint. Existing VNC leases must still supply card frames.
  delete profileRows[0].health.desktopPreviewAvailable;
  profileRows[1].state = 'running'; delete profileRows[1].health.desktopPreviewAvailable;
  await workspace.getByRole('button', { name: '缩回卡片' }).click();
  await card(0).locator('[data-preview-source="vnc"] img').waitFor();
  assert.deepEqual(await card(0).locator('img').evaluate(image => [image.naturalWidth, image.naturalHeight]), [640, 400]);
  const beforeLegacyReload = mutations.length;
  const retainedSession = [...sessions.values()].find(session => session.profileId === profileRows[0].id).id;
  await page.reload();
  await card(0).locator('[data-preview-source="vnc"] img').waitFor();
  assert.equal(await page.locator('.desktop-workspace.is-expanded').count(), 0);
  assert.equal(await page.locator('.desktop-workspace iframe').count(), 1, 'only an existing legacy lease is restored for read-only preview');
  await frame(0).locator('html[data-active="false"]').waitFor({ state: 'attached' });
  assert.ok(sessions.has(retainedSession)); assert.equal(mutations.length, beforeLegacyReload, 'legacy thumbnails must never create or renew a lease');
  await card(1).getByText('旧镜像：打开桌面后可预览', { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, 'legacy-vnc-preview.png'), fullPage: true });
  assert.equal(context.pages().length, 1, 'all default entrances stay in the current page');
  const retiredUrl = await card(0).locator('img').getAttribute('src');
  denyManual = true;
  await card(0).locator('img').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.desktop-workspace iframe').count(), 0);
  assert.equal(await page.evaluate(async url => { try { await fetch(url); return false; } catch { return true; } }, retiredUrl), true, 'revoked desktop access must release cached pixels');
  await page.evaluate(() => window.dispatchEvent(new Event('fleet-session-expired')));
  await page.getByLabel('平台访问令牌').waitFor();
  assert.equal(await page.locator('.desktop-preview img').count(), 0);
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  console.log(`通过：卡片预览、多桌面与三连接LRU、缩回及导航保留租约、全屏/剪贴板/390px布局、旧镜像VNC缩略图与只读恢复、不创建租约、失权及退出清除画面。合成截图：${artifacts}`);
} finally { await browser.close(); }
