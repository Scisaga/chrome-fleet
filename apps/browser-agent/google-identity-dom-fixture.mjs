/** Controlled DOM only: intercepted Google URLs are synthetic and prove no real Google login. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {readGoogleIdentity,readGoogleIdentityEvidence,googleIdentityFromEvidence} from './dist/google-identity.js';

const browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/usr/bin/google-chrome',headless:true,chromiumSandbox:true,args:['--password-store=gnome-libsecret'],ignoreDefaultArgs:['--password-store=basic','--use-mock-keychain','--disable-dev-shm-usage']});
const context=await browser.newContext();
await context.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Synthetic identity fixture</title><body></body>'}));
const page=await context.newPage();
const account=(email='fixture.owner@example.test',label='Google Account')=>`<header id="gb"><a role="button" aria-label="${label}: Fixture Person (${email})" href="https://accounts.google.com/SignOutOptions?hl=en">Avatar</a></header>`;
const inputs='<input id="email" type="email" data-email="fake.remembered@example.test" value="fake.remembered@example.test"><input id="password" type="password" value="SYNTHETIC-NOT-A-PASSWORD">';
const noReadScript=`<script>
window.fixtureReads={input:0,cookie:0};
for(const input of document.querySelectorAll('input'))Object.defineProperty(input,'value',{get(){window.fixtureReads.input++;throw new Error('Fixture forbids input value reads');}});
Object.defineProperty(document,'cookie',{get(){window.fixtureReads.cookie++;throw new Error('Fixture forbids cookie reads');}});
</script>`;
const guarded=new Proxy(page,{get(target,property){if(['goto','reload','screenshot','context'].includes(property))throw new Error('Detector attempted a forbidden operation');const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});
async function detect(html,url='https://myaccount.google.com/'){
  await page.goto(url,{waitUntil:'domcontentloaded'});
  await page.setContent(`<!doctype html><html><body>${html}${inputs}${noReadScript}</body></html>`);
  const before=createHash('sha256').update(await page.content()).digest('hex');
  const beforeUrl=page.url();const beforePages=context.pages().length;let requests=0;const requested=()=>requests++;page.on('request',requested);
  const result=await readGoogleIdentity([guarded]);
  page.off('request',requested);
  assert.equal(page.url(),beforeUrl);assert.equal(context.pages().length,beforePages);assert.equal(requests,0);
  assert.equal(createHash('sha256').update(await page.content()).digest('hex'),before);
  assert.deepEqual(await page.evaluate(()=>window.fixtureReads),{input:0,cookie:0});
  return result;
}
try{
  assert.deepEqual(await detect(account()),{status:'authenticated',identity:'fixture.owner@example.test'});
  assert.deepEqual(await detect(account('workspace.user@company.example','Google 帐号')),{status:'authenticated',identity:'workspace.user@company.example'});
  console.log('PASS 真实 DOM 英文/中文头像标记，仅返回邮箱；检测未导航、未截图、未读输入值或 Cookie');
  for(const style of ['display:none','visibility:hidden','opacity:0'])assert.equal((await detect(`<div style="${style}">${account()}</div>`)).status,'unknown');
  assert.equal((await detect('<main><button aria-label="Google Account: Wrong (wrong@example.test)">Content</button></main>')).status,'unknown');
  assert.equal((await detect(`<iframe srcdoc="${account().replaceAll('"','&quot;')}"></iframe>`)).status,'unknown');
  console.log('PASS 隐藏头像、正文与 iframe 内伪造身份均不绑定');
  assert.equal((await detect(account(),'https://accounts.google.com/AccountChooser?login_hint=ignored@example.test')).status,'needs_login');
  assert.equal((await detect(account(),'https://accounts.google.com/v3/signin/challenge/totp')).status,'needs_verification');
  assert.equal((await detect('<span data-email="remembered@example.test">remembered@example.test</span>','https://myaccount.google.com/?login_hint=hint@example.test')).status,'unknown');
  assert.equal((await detect(account(),'https://sites.google.com/view/synthetic')).status,'unknown');
  console.log('PASS 账号选择器、登录提示参数、data-email 与非白名单 Google 内容页不能证明登录');
  await detect(account());
  const other=await context.newPage();await other.goto('https://mail.google.com/mail/u/1/');await other.setContent(account('another@example.test'));
  const mixed=await readGoogleIdentity([page,other]);assert.equal(mixed.status,'unknown');assert.equal(mixed.identity,undefined);
  assert.equal(googleIdentityFromEvidence([await readGoogleIdentityEvidence(page)]).status,'authenticated');
  console.log('PASS 两个顶层页面出现不同 Google 账号时返回 unknown，不猜测主账号');
}finally{await browser.close();}
