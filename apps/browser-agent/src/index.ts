import Fastify from 'fastify';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { timingSafeEqual, createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP, connect } from 'node:net';
import { basename, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { AgentError, CookieSchema, domainMatches, FenceGate, IndexedDbSchema, parseCookies, StepSchema, type LocatorSpec, type Step } from './model.js';
import { readGoogleIdentity } from './google-identity.js';
import { GoogleAutofill } from './google-autofill.js';
import { X11Clipboard, validClipboardText } from './x11-clipboard.js';
import { NativeBrowser } from './native-browser.js';
import { createManualAgent } from './manual-agent.js';
import { startVncProxy } from './vnc-proxy.js';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const playwrightVersion = (require('playwright/package.json') as {version:string}).version;
const ConfigSchema = z.object({
  browserMode:z.enum(['automation','vnc']).default('automation'),
  headless: z.boolean().default(false), locale: z.string().default('zh-CN'), timezoneId: z.string().default('Asia/Shanghai'),
  viewport: z.object({width:z.number().int().min(320).max(7680),height:z.number().int().min(240).max(4320)}).default({width:1440,height:900}),
  proxy: z.object({ server:z.string().max(2048), username:z.string().optional(),password:z.string().optional(),bypass:z.string().optional() }).optional(),
  proxyVersion:z.number().int().nonnegative().default(0),
}).strict();
const TokenBody = z.object({fencingToken:z.number().int().positive()});
const stateRoot = process.env.STATE_ROOT ?? '/state';
const allowedPrivateHosts = new Set((process.env.FLEET_ALLOWED_PRIVATE_HOSTS ?? '').split(',').filter(Boolean));

function privateAddress(address: string): boolean {
  const ip = address.toLowerCase();
  if (ip.includes(':')) return ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:') || ip.startsWith('::ffff:') || ip.startsWith('ff');
  const [a,b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 100 && b! >= 64 && b! <= 127);
}
export async function guardUrl(raw: string) {
  if (raw === 'about:blank') return;
  let url: URL;
  try { url = new URL(raw); } catch { throw new AgentError('URL_INVALID','网页地址无效'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new AgentError('URL_FORBIDDEN','只允许不包含凭据的 HTTP/HTTPS 网页地址');
  const host = url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if (allowedPrivateHosts.has(host)) return;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) throw new AgentError('NETWORK_PRIVATE_DENIED','默认禁止访问内部网络');
  const addresses = isIP(host) ? [{address:host}] : await lookup(host,{all:true});
  if (!addresses.length || addresses.some(item => privateAddress(item.address))) throw new AgentError('NETWORK_PRIVATE_DENIED','默认禁止访问控制面、私有地址和元数据服务');
}

function networkErrorCode(error:unknown){return error instanceof Error?error.message.match(/\bnet::(ERR_[A-Z0-9_]{1,80})\b/)?.[1]:undefined;}
function safeError(error:unknown) {
  if (error instanceof AgentError) return {code:error.code,message:error.message,details:error.details};
  if (error instanceof z.ZodError) return {code:'VALIDATION_ERROR',message:'请求参数不符合接口约定'};
  // Playwright error messages include filled values, page content and sensitive URLs.
  if (error instanceof Error && error.name === 'TimeoutError') return {code:'BROWSER_TIMEOUT',message:'浏览器操作超时；动作结果可能未知，请人工检查'};
  return {code:'BROWSER_OPERATION_FAILED',message:'浏览器操作失败；动作结果可能未知，请检查实例状态',networkCode:networkErrorCode(error)};
}

async function keyringHealth() {
  try {
    const {stdout} = await exec('gdbus',['call','--session','--dest','org.freedesktop.secrets','--object-path','/org/freedesktop/secrets/collection/login','--method','org.freedesktop.DBus.Properties.Get','org.freedesktop.Secret.Collection','Locked'],{timeout:3000});
    const {stdout:probe} = await exec('secret-tool',['lookup','chrome-fleet','probe'],{timeout:3000});
    return {backend:'gnome-libsecret',available:true,unlocked:stdout.includes('false'),probeVerified:probe.trim()==='chrome-fleet-keyring-ready'};
  } catch { return {backend:'gnome-libsecret',available:false,unlocked:false,probeVerified:false}; }
}

async function portReady(port:number) {return new Promise<boolean>(done=>{const socket=connect({host:'127.0.0.1',port});socket.setTimeout(500);socket.once('connect',()=>{socket.destroy();done(true);});socket.once('error',()=>done(false));socket.once('timeout',()=>{socket.destroy();done(false);});});}

export async function startAgent() {
  if (process.getuid?.() === 0) throw new AgentError('ROOT_BROWSER_FORBIDDEN','浏览器必须使用固定非 root 用户运行');
  const config = ConfigSchema.parse(JSON.parse(await readFile(process.env.AGENT_CONFIG_FILE ?? '/run/fleet/config.json','utf8')));
  const authToken = (await readFile(process.env.AGENT_TOKEN_FILE ?? '/run/fleet/agent-token','utf8')).trim();
  if (authToken.length < 32) throw new AgentError('SECRET_INVALID','Agent 凭据长度不足');
  const backend = await keyringHealth();
  if (!backend.available || !backend.unlocked || !backend.probeVerified) throw new AgentError('KEYRING_UNAVAILABLE','密钥存储不可用，拒绝启动以防回退到明文存储');
  await mkdir(resolve(stateRoot,'downloads'),{recursive:true,mode:0o700});
  if(config.browserMode==='vnc'){
    const proxy=await startVncProxy(config.proxy);
    let browser:NativeBrowser;
    try{browser=await NativeBrowser.launch({userDataDir:resolve(stateRoot,'chrome'),locale:config.locale,timezoneId:config.timezoneId,viewport:config.viewport,proxyServer:proxy.server});}
    catch(error){await proxy.close();throw error;}
    const manual=createManualAgent({authToken,browser,proxyVersion:config.proxyVersion,playwrightVersion,keyringHealth,
      desktopReady:async()=>await portReady(6080)&&await portReady(5900),closeProxy:()=>proxy.close()});
    const signalShutdown=()=>{void manual.shutdown().catch(()=>{process.stderr.write('Chrome 尚未确认正常退出；实例数据未声明保存完成，请通过桌面检查\n');});};
    process.once('SIGTERM',signalShutdown);process.once('SIGINT',signalShutdown);
    await manual.app.listen({host:process.env.AGENT_HOST??'0.0.0.0',port:Number(process.env.AGENT_PORT??8092)});
    return{...manual,context:undefined};
  }
  const context = await chromium.launchPersistentContext(resolve(stateRoot,'chrome'),{
    executablePath:process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless:config.headless, chromiumSandbox:true,
    locale:config.locale,timezoneId:config.timezoneId, viewport:config.viewport, proxy:config.proxy,
    acceptDownloads:true, downloadsPath:resolve(stateRoot,'downloads'), timeout:60000,
    args:['--password-store=gnome-libsecret',`--window-size=${config.viewport.width},${config.viewport.height}`],
    ignoreDefaultArgs:['--disable-dev-shm-usage','--password-store=basic','--use-mock-keychain'],
  });
  context.setDefaultTimeout(15000);
  context.setDefaultNavigationTimeout(30000);
  await context.route('**/*',async route => {
    try { await guardUrl(route.request().url()); await route.continue(); }
    catch { await route.abort('blockedbyclient').catch(()=>undefined); }
  });
  const ids = new WeakMap<Page,string>();
  let serial = 0;
  let activeDownloads = 0;
  let active: Page = context.pages()[0] ?? await context.newPage();
  let closed = false;
  let executingPage:Page|undefined;
  let googleLoginPage:Page|undefined;
  const googleAutofill=new GoogleAutofill();
  const desktopClipboard=new X11Clipboard();
  const gate = new FenceGate(async()=>{
    if(executingPage){const previous=executingPage;await previous.close({runBeforeUnload:false}).catch(()=>undefined);if(active===previous)active=context.pages()[0]??await context.newPage();}
    else await context.close().catch(()=>undefined);
  });
  const pageId = (page:Page) => { let id=ids.get(page); if(!id){id=`page_${++serial}`;ids.set(page,id);page.on('download',download=>{activeDownloads++;void download.path().catch(()=>null).finally(()=>{activeDownloads=Math.max(0,activeDownloads-1);});});} return id; };
  for (const page of context.pages()) pageId(page);
  context.on('page',page=>pageId(page));
  context.on('close',()=>{closed=true;});
  const pickPage = (id?:string) => {
    const page = id ? context.pages().find(p=>pageId(p)===id) : active;
    if(!page || page.isClosed()) throw new AgentError('PAGE_NOT_FOUND','页面不存在或已关闭',404);
    return page;
  };
  const locate = (page:Page,spec?:LocatorSpec):Locator => {
    if (!spec) throw new AgentError('LOCATOR_REQUIRED','此操作需要页面定位器');
    const scope = spec.iframe ? page.frameLocator(spec.iframe) : page;
    if (spec.css) return scope.locator(spec.css);
    if (spec.role) return scope.getByRole(spec.role as Parameters<Page['getByRole']>[0],{name:spec.name,exact:true});
    if (spec.label) return scope.getByLabel(spec.label,{exact:true});
    return scope.getByText(spec.text!,{exact:true});
  };
  const pages = async () => Promise.all(context.pages().map(async p=>({pageId:pageId(p),url:p.url(),title:await p.title().catch(()=>''),active:p===active})));
  const humanEvidence = async(page:Page) => {
    const url = page.url();
    if (/accounts\.google\.[^/]+\/(?:v\d+\/signin|signin|ServiceLogin|challenge)/i.test(url)) return {reason:'google_login',message:'Google 登录或重新验证需要人工接管'};
    if (await page.locator('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],input[autocomplete="one-time-code"],input[name="totpPin"]').count()) return {reason:'verification',message:'检测到验证码或二次验证，请人工接管'};
    return undefined;
  };
  const app = Fastify({logger:false,bodyLimit:32*1024*1024,requestTimeout:0});
  app.addHook('onRequest',async(req,reply)=>{
    const provided=Buffer.from(req.headers.authorization?.replace(/^Bearer /,'')??'');
    const expected=Buffer.from(authToken);
    if(provided.length!==expected.length || !timingSafeEqual(provided,expected)) return reply.code(401).send({code:'UNAUTHORIZED',message:'Agent 身份验证失败'});
  });
  app.setErrorHandler((error,_req,reply)=>reply.code(error instanceof AgentError?error.statusCode:error instanceof z.ZodError?400:500).send(safeError(error)));
  app.get('/health',async()=>{const desktopReady=await portReady(6080)&&await portReady(5900);return{browserMode:'automation',automationAvailable:true,healthy:!closed,ready:!closed&&desktopReady,desktopReady,chromeVersion:context.browser()?.version()??'unknown',playwrightVersion,keyring:await keyringHealth(),sandboxEnabled:true,headless:config.headless,proxyVersion:config.proxyVersion,fencingToken:gate.token,busy:gate.busy,activeDownloads,pages:context.pages().length};});
  app.post('/fence',async req=>{const {token}=z.object({token:z.number().int().positive()}).strict().parse(req.body);await gate.advance(token);if(closed)throw new AgentError('FENCE_RESTART_REQUIRED','旧租约操作已终止，需要受控重启浏览器后接管',409);return{fencingToken:gate.token};});
  app.post('/self-test',async req=>{
    const body=TokenBody.extend({mode:z.enum(['write','read']),proof:z.string().min(32).max(100)}).strict().parse(req.body);
    return gate.run(body.fencingToken,async()=>{
      const validationUrl='https://fleet-validation.invalid/';
      const page=await context.newPage();
      await page.route('https://fleet-validation.invalid/**',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Chrome Fleet 隔离验证</title><main id="identity">验证页面</main>'}));
      try{
        await page.goto(validationUrl,{timeout:10000,waitUntil:'domcontentloaded'});
        if(body.mode==='write'){
          await context.addCookies([{name:'fleet-persistence-proof',value:body.proof,domain:'fleet-validation.invalid',path:'/',expires:Math.floor(Date.now()/1000)+86400,httpOnly:true,secure:true,sameSite:'Lax'},
            {name:'fleet-partition-proof',value:body.proof,domain:'fleet-validation.invalid',path:'/',expires:Math.floor(Date.now()/1000)+86400,httpOnly:true,secure:true,sameSite:'None',partitionKey:'https://top.example'}]);
          await page.evaluate(async proof=>{
            localStorage.setItem('fleet-proof',proof);
            const db=await new Promise<IDBDatabase>((done,fail)=>{const req=indexedDB.open('fleet-validation',1);req.onupgradeneeded=()=>req.result.createObjectStore('proofs');req.onsuccess=()=>done(req.result);req.onerror=()=>fail(req.error);});
            await new Promise<void>((done,fail)=>{const tx=db.transaction('proofs','readwrite');tx.objectStore('proofs').put(proof,'proof');tx.oncomplete=()=>done();tx.onerror=()=>fail(tx.error);});db.close();
          },body.proof);
          const exported=await context.storageState({indexedDB:true});
          const origin=exported.origins.find(o=>o.origin===validationUrl.slice(0,-1)) as {indexedDB?:unknown[]}|undefined;
          if(!origin?.indexedDB?.length)throw new AgentError('INDEXEDDB_EXPORT_FAILED','IndexedDB 导出验证失败');
          await context.setStorageState(exported);
        }
        await page.reload({timeout:10000});
        const values=await page.evaluate(async()=>{
          const db=await new Promise<IDBDatabase>((done,fail)=>{const req=indexedDB.open('fleet-validation',1);req.onupgradeneeded=()=>req.result.createObjectStore('proofs');req.onsuccess=()=>done(req.result);req.onerror=()=>fail(req.error);});
          const indexed=await new Promise<unknown>((done,fail)=>{const req=db.transaction('proofs').objectStore('proofs').get('proof');req.onsuccess=()=>done(req.result);req.onerror=()=>fail(req.error);});db.close();return{local:localStorage.getItem('fleet-proof'),indexed};
        });
        const cookie=(await context.cookies(validationUrl)).find(c=>c.name==='fleet-persistence-proof');
        const partitioned=(await context.cookies()).find(c=>c.name==='fleet-partition-proof');
        if(cookie?.value!==body.proof||values.local!==body.proof||values.indexed!==body.proof)throw new AgentError('PERSISTENCE_TEST_FAILED','Cookie、localStorage 或 IndexedDB 恢复验证失败',409,{cookie:cookie?.value===body.proof,localStorage:values.local===body.proof,indexedDB:values.indexed===body.proof});
        if(partitioned?.value!==body.proof||partitioned.partitionKey!=='https://top.example')throw new AgentError('PARTITION_COOKIE_TEST_FAILED','分区 Cookie 属性往返验证失败');
        const chromeSecret=await exec('secret-tool',['lookup','application','chrome'],{timeout:5000}).catch(()=>({stdout:''}));
        if(!chromeSecret.stdout.trim())throw new AgentError('CHROME_KEYRING_NOT_USED','Chrome 未创建 libsecret 加密密钥，拒绝批准此镜像');
        const keyHash=createHash('sha256').update(chromeSecret.stdout.trim()).digest('hex');
        const keyHashPath=resolve(stateRoot,'validation-key-hash');
        if(body.mode==='write')await writeFile(keyHashPath,keyHash,{mode:0o600});
        else if((await readFile(keyHashPath,'utf8')).trim()!==keyHash)throw new AgentError('KEYRING_KEY_CHANGED','容器重建后 Chrome 密钥不匹配');
        const sandboxPage=await context.newPage();let sandboxText='';
        try{await sandboxPage.goto('chrome://sandbox');sandboxText=await sandboxPage.locator('body').innerText();}finally{await sandboxPage.close();}
        if(!sandboxText.includes('adequately sandboxed')||/SUID Sandbox\s+No[\s\S]*Namespace Sandbox\s+No/.test(sandboxText))throw new AgentError('SANDBOX_TEST_FAILED','Chrome sandbox 运行验证失败');
        return{passed:true,checks:{chrome:true,sandbox:true,keyring:true,keyringKeyStable:body.mode==='read',persistentCookie:true,httpOnly:true,partitionedCookie:true,localStorage:true,indexedDB:true,storageStateRoundTrip:body.mode==='write'},chromeVersion:context.browser()?.version(),playwrightVersion};
      }finally{await page.close();}
    });
  });
  app.post('/cancel',async req=>{const b=TokenBody.parse(req.body);gate.cancel(b.fencingToken);return{cancelRequested:true,busy:gate.busy};});
  app.post('/execute',async req=>{
    const body=z.object({fencingToken:z.number().int().positive(),steps:z.array(StepSchema).min(1).max(200),timeoutMs:z.number().int().min(1).max(900000).default(120000),resumeFrom:z.number().int().min(0).default(0)}).strict().parse(req.body);
    return gate.run(body.fencingToken,async()=>{
      const results:unknown[]=[];
      const artifacts:{type:string,mimeType:string,base64:string,fileName?:string}[]=[];
      const deadline=Date.now()+body.timeoutMs;
      let completedSteps=body.resumeFrom;
      for(let index=body.resumeFrom;index<body.steps.length;index++) {
        const step=body.steps[index]!;
        let sideEffectStarted=false;
        try {
          gate.assert(body.fencingToken);
          const timeout=Math.min(step.timeoutMs??30000,deadline-Date.now());
          if(timeout<=0) return {status:'timed_out',results,artifacts,completedSteps,error:{code:'JOB_TIMEOUT',message:'任务超时'}};
          const page=pickPage(step.pageId);executingPage=page;
          const pre=await humanEvidence(page);
          if(pre && !['pages','screenshot','extractText'].includes(step.action)) return {status:'waiting_for_human',results,artifacts,completedSteps,evidence:pre};
          page.setDefaultTimeout(timeout);page.setDefaultNavigationTimeout(timeout);
          let result:unknown={};
          switch(step.action) {
            case 'pages': result=await pages();break;
            case 'newPage': {const p=await context.newPage();active=p; if(step.url){await guardUrl(step.url);sideEffectStarted=true;await p.goto(step.url,{timeout,waitUntil:'domcontentloaded'});} result={pageId:pageId(p)};break;}
            case 'switchPage': active=pickPage(step.pageId??step.value);await active.bringToFront();result={pageId:pageId(active)};break;
            case 'goto': if(!step.url)throw new AgentError('URL_REQUIRED','导航需要网页地址');await guardUrl(step.url);sideEffectStarted=true;await page.goto(step.url,{timeout,waitUntil:'domcontentloaded'});result={pageId:pageId(page),url:page.url()};break;
            case 'click': sideEffectStarted=true;await locate(page,step.locator).click({timeout});break;
            case 'fill': if(step.value===undefined)throw new AgentError('VALUE_REQUIRED','填写操作需要 value');sideEffectStarted=true;await locate(page,step.locator).fill(step.value,{timeout});break;
            case 'press': if(!step.key)throw new AgentError('KEY_REQUIRED','按键操作需要 key');sideEffectStarted=true;await locate(page,step.locator).press(step.key,{timeout});break;
            case 'select': sideEffectStarted=true;result=await locate(page,step.locator).selectOption(step.values??step.value??[],{timeout});break;
            case 'waitFor': await locate(page,step.locator).waitFor({state:step.state??'visible',timeout});break;
            case 'extractText': result={text:(await locate(page,step.locator).innerText({timeout})).slice(0,1_000_000)};break;
            case 'assertText': {const wanted=step.text??step.value;if(wanted===undefined)throw new AgentError('TEXT_REQUIRED','断言需要 text');await locate(page,step.locator).filter({hasText:wanted}).waitFor({state:'visible',timeout});result={matched:true};break;}
            case 'screenshot': {if(await humanEvidence(page))throw new AgentError('HUMAN_CAPTURE_FORBIDDEN','人工验证期间禁止自动截图');const bytes=await page.screenshot({type:'png',fullPage:step.fullPage??false,timeout});artifacts.push({type:'screenshot',mimeType:'image/png',base64:bytes.toString('base64')});result={artifactIndex:artifacts.length-1};break;}
            case 'upload': {if(!step.artifactId || !step.base64)throw new AgentError('ARTIFACT_REQUIRED','上传必须使用控制服务授权的 artifact');const bytes=Buffer.from(step.base64,'base64');if(bytes.length>16*1024*1024)throw new AgentError('ARTIFACT_TOO_LARGE','上传文件超出限制');sideEffectStarted=true;await locate(page,step.locator).setInputFiles({name:basename(step.fileName??'upload.bin'),mimeType:step.mimeType??'application/octet-stream',buffer:bytes},{timeout});result={uploaded:true,size:bytes.length};break;}
            case 'download': {sideEffectStarted=!!step.locator;const [download]=await Promise.all([page.waitForEvent('download',{timeout}),step.locator?locate(page,step.locator).click({timeout}):Promise.resolve()]);const cancelTimer=setTimeout(()=>{void download.cancel();},timeout);try{const path=await download.path();if(!path)throw new AgentError('DOWNLOAD_FAILED','下载未生成文件');const file=await stat(path);if(file.size>16*1024*1024)throw new AgentError('ARTIFACT_TOO_LARGE','下载文件超出限制');artifacts.push({type:'download',mimeType:'application/octet-stream',base64:(await readFile(path)).toString('base64'),fileName:basename(download.suggestedFilename())});await download.delete();result={artifactIndex:artifacts.length-1};}finally{clearTimeout(cancelTimer);}break;}
            case 'waitPopup': {sideEffectStarted=!!step.locator;const [popup]=await Promise.all([page.waitForEvent('popup',{timeout}),step.locator?locate(page,step.locator).click({timeout}):Promise.resolve()]);active=popup;result={pageId:pageId(popup),url:popup.url()};break;}
          }
          gate.assert(body.fencingToken);
          completedSteps=index+1;results.push({index,action:step.action,result});
          const evidence=await humanEvidence(active);
          if(evidence) return{status:'waiting_for_human',results,artifacts,completedSteps,evidence};
        } catch(error) {
          const safe=safeError(error);
          return{status:sideEffectStarted?'outcome_unknown':safe.code==='OPERATION_CANCELLED'?'cancelled':safe.code==='BROWSER_TIMEOUT'?'timed_out':'failed',results,artifacts,completedSteps,error:{...safe,step:index}};
        }finally{executingPage=undefined;}
      }
      return{status:'succeeded',results,artifacts,completedSteps};
    });
  });

  const ImportSchema=TokenBody.extend({document:z.unknown(),mode:z.enum(['merge','replace','replace_domains']).default('merge'),domains:z.array(z.string().min(1).max(253)).min(1).max(100).optional(),dryRun:z.boolean().default(false)}).strict();
  app.post('/cookies/export',async req=>{
    const body=TokenBody.extend({urls:z.array(z.string().url()).max(100).optional(),domains:z.array(z.string()).max(100).optional()}).strict().parse(req.body);
    return gate.run(body.fencingToken,async()=>{let cookies=await context.cookies(body.urls);if(body.domains)cookies=cookies.filter(c=>domainMatches(c.domain,body.domains!));return{document:{format:'chrome-fleet.cookies',version:1,exportedAt:new Date().toISOString(),cookies},count:cookies.length,scope:'cookies_only'};});
  });
  app.post('/cookies/import',async req=>{
    const body=ImportSchema.parse(req.body);
    const cookies=parseCookies(body.document);
    if(body.mode!=='merge'&&!body.domains)throw new AgentError('DOMAINS_REQUIRED','替换导入必须显式指定 domains，不允许默认清空整个实例');
    if(body.domains&&cookies.some(c=>!domainMatches(c.domain,body.domains!)))throw new AgentError('COOKIE_SCOPE_MISMATCH','Cookie 超出所选域名范围');
    return gate.run(body.fencingToken,async()=>{
      if(body.dryRun)return{valid:true,count:cookies.length,dryRun:true,loginStatus:'unknown',unsupported:[]};
      const before=await context.cookies();
      const retained=body.mode!=='merge'?before.filter(c=>!domainMatches(c.domain,body.domains!)):before;
      const results=cookies.map((_cookie,index)=>({index,status:'not_attempted'}));let failedIndex:number|undefined;
      try {
        if(body.mode!=='merge'){await context.clearCookies();await context.addCookies(retained);}
        for(let index=0;index<cookies.length;index++){failedIndex=index;gate.assert(body.fencingToken);await context.addCookies([cookies[index]!]);results[index]!.status='imported';}
        return{imported:cookies.length,results,loginStatus:'unknown',message:'Cookie 写入成功，账号身份仍需站点检测',unsupported:[]};
      }catch{
        if(failedIndex!==undefined&&results[failedIndex]!.status!=='imported')results[failedIndex]!.status='failed';
        let rollbackSucceeded=false;try{await context.clearCookies();await context.addCookies(before);rollbackSucceeded=true;}catch{}
        throw new AgentError('COOKIE_IMPORT_FAILED',rollbackSucceeded?'Cookie 导入失败，已恢复导入前的 Cookie':'Cookie 导入及恢复失败，当前部分写入结果未知，请停止任务并人工检查',409,{results,failedIndex,appliedCount:results.filter(r=>r.status==='imported').length,rollbackSucceeded,outcomeUnknown:!rollbackSucceeded});
      }
    });
  });
  app.post('/storage-state/export',async req=>{
    const body=TokenBody.extend({domains:z.array(z.string()).max(100).optional()}).strict().parse(req.body);
    return gate.run(body.fencingToken,async()=>{
      const state=await context.storageState({indexedDB:true});
      if(body.domains){state.cookies=state.cookies.filter(c=>domainMatches(c.domain,body.domains!));state.origins=state.origins.filter(o=>domainMatches(new URL(o.origin).hostname,body.domains!));}
      return{document:{format:'chrome-fleet.storage-state',version:1,playwrightVersion,state},scope:['cookies','localStorage','indexedDB'],excluded:['sessionStorage','cache','serviceWorkers','opfs','credentials']};
    });
  });
  app.post('/storage-state/import',async req=>{
    const body=ImportSchema.parse(req.body);
    const doc=z.object({format:z.literal('chrome-fleet.storage-state').optional(),version:z.literal(1).optional(),playwrightVersion:z.string().optional(),state:z.unknown().optional(),cookies:z.unknown().optional(),origins:z.unknown().optional()}).strict().parse(body.document);
    const raw=doc.state??{cookies:doc.cookies,origins:doc.origins};
    const state=z.object({cookies:z.array(CookieSchema).max(10000),origins:z.array(z.object({origin:z.string().url(),localStorage:z.array(z.object({name:z.string(),value:z.string()}).strict()).max(10000),indexedDB:z.array(IndexedDbSchema).optional()}).strict()).max(1000)}).strict().parse(raw);
    parseCookies(state.cookies);
    for(const origin of state.origins){const parsed=new URL(origin.origin);if(!['http:','https:'].includes(parsed.protocol)||parsed.origin!==origin.origin)throw new AgentError('ORIGIN_INVALID','站点状态必须使用 HTTP/HTTPS origin');}
    if(body.mode!=='merge'&&!body.domains)throw new AgentError('DOMAINS_REQUIRED','替换导入必须显式指定 domains，不允许默认清空整个实例');
    if(body.domains&&(state.cookies.some(c=>!domainMatches(c.domain,body.domains!))||state.origins.some(o=>!domainMatches(new URL(o.origin).hostname,body.domains!))))throw new AgentError('STORAGE_SCOPE_MISMATCH','站点状态超出所选域名范围');
    return gate.run(body.fencingToken,async()=>{
      const before=await context.storageState({indexedDB:true,opfs:true,credentials:true});
      const extended=before as unknown as {credentials?:unknown[],origins:({origin:string,localStorage:{name:string,value:string}[],indexedDB?:Record<string,unknown>[],opfs?:unknown[]})[]};
      if(extended.credentials?.length||extended.origins.some(o=>o.opfs?.length))throw new AgentError('STORAGE_EXISTING_SCOPE_UNSUPPORTED','当前实例包含 OPFS 或虚拟 passkey；此导入无法无损保留这些数据，请使用完整快照恢复');
      if(body.dryRun)return{valid:true,dryRun:true,cookies:state.cookies.length,origins:state.origins.length,supportsIndexedDB:true,loginStatus:'unknown'};
      let merged:typeof before;
      {
        const importedKeys=new Set(state.cookies.map(c=>`${c.name}|${c.domain}|${c.path}|${c.partitionKey??''}`));
        const importedOrigins=new Set(state.origins.map(o=>o.origin));
        const cookies=before.cookies.filter(c=>!importedKeys.has(`${c.name}|${c.domain}|${c.path}|${'partitionKey' in c?c.partitionKey:''}`)&&!(body.mode!=='merge'&&domainMatches(c.domain,body.domains!)));
        const origins=before.origins.filter(o=>!importedOrigins.has(o.origin)&&!(body.mode!=='merge'&&domainMatches(new URL(o.origin).hostname,body.domains!)));
        const imports=state.origins.map(origin=>{
          if(body.mode!=='merge')return origin;
          const current=extended.origins.find(o=>o.origin===origin.origin);if(!current)return origin;
          const local=new Map(current.localStorage.map(entry=>[entry.name,entry]));for(const entry of origin.localStorage)local.set(entry.name,entry);
          const databases=new Map((current.indexedDB??[]).map(db=>[db.name,db]));
          for(const db of origin.indexedDB??[]){const existing=databases.get(db.name);if(existing&&JSON.stringify(existing)!==JSON.stringify(db))throw new AgentError('INDEXEDDB_MERGE_CONFLICT','IndexedDB 数据库已存在且内容不同；请显式选择按域替换');databases.set(db.name,db);}
          return{...origin,localStorage:[...local.values()],indexedDB:[...databases.values()]};
        });
        merged={cookies:[...cookies,...state.cookies],origins:[...origins,...imports] as typeof before.origins};
      }
      try{await context.setStorageState(merged);}catch{let rollbackSucceeded=false;try{await context.setStorageState(before);rollbackSucceeded=true;}catch{}throw new AgentError('STORAGE_IMPORT_FAILED',rollbackSucceeded?'站点状态导入失败，已恢复导入前状态':'站点状态导入及恢复失败，当前结果未知，请人工检查',409,{rollbackSucceeded,outcomeUnknown:!rollbackSucceeded});}
      return{imported:true,cookies:state.cookies.length,origins:state.origins.length,loginStatus:'unknown',scope:['cookies','localStorage','indexedDB'],message:'已导入；页面请重新加载，登录状态仍需检测'};
    });
  });
  app.post('/accounts/google-identity',async req=>{
    const body=TokenBody.strict().parse(req.body);
    return gate.run(body.fencingToken,()=>readGoogleIdentity(context.pages()));
  });
  app.post('/accounts/google-login',async req=>{
    const body=TokenBody.strict().parse(req.body);
    return gate.run(body.fencingToken,async()=>{
      const page=await context.newPage();active=page;googleLoginPage=page;
      try{
        await page.bringToFront();
        const url='https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmyaccount.google.com%2F';
        await guardUrl(url);
        await page.goto(url,{timeout:15000,waitUntil:'domcontentloaded'});
        return{opened:true,pageId:pageId(page)};
      }catch(error){
        throw new AgentError('GOOGLE_LOGIN_NAVIGATION_FAILED','Google 登录页暂未完成加载，浏览器窗口已保留，可通过桌面继续或重试',502,{opened:!page.isClosed(),pageId:pageId(page),retriable:true,networkCode:networkErrorCode(error)});
      }
    });
  });
  app.post('/accounts/google-autofill',async req=>{
    const body=TokenBody.extend({email:z.string().trim().email().max(254),password:z.string().min(1).max(4096)}).strict().parse(req.body);
    try{return await gate.run(body.fencingToken,async()=>{
      const page=googleLoginPage;
      executingPage=page;
      try{return await googleAutofill.fill(page,body.email,body.password,()=>gate.assert(body.fencingToken));}
      finally{executingPage=undefined;}
    });}finally{body.password='';if(req.body&&typeof req.body==='object'&&'password' in req.body)(req.body as {password:string}).password='';}
  });
  app.post('/desktop/clipboard',async req=>{
    const text=z.string().max(128*1024).refine(validClipboardText);
    const body=z.discriminatedUnion('action',[
      TokenBody.extend({action:z.literal('read')}).strict(),
      TokenBody.extend({action:z.literal('write'),text}).strict(),
    ]).parse(req.body);
    try{return await gate.run<{text:string}|{written:true}>(body.fencingToken,()=>body.action==='read'
      ? desktopClipboard.read(()=>gate.assert(body.fencingToken))
      : desktopClipboard.write(body.text,()=>gate.assert(body.fencingToken)));
    }finally{if(body.action==='write')body.text='';if(req.body&&typeof req.body==='object'&&'text' in req.body)(req.body as {text:string}).text='';}
  });
  app.post('/accounts/check',async req=>{
    const body=TokenBody.extend({accounts:z.array(z.object({id:z.string().optional(),provider:z.string(),expectedIdentity:z.string().optional(),site:z.string().optional(),verificationUrl:z.string().url().optional(),identityLocator:LocatorSchemaOptional(),expectedText:z.string().optional(),detector:z.object({url:z.string().url(),identityLocator:LocatorSchemaOptional(),verificationLocator:LocatorSchemaOptional()}).optional()}).passthrough()).max(100)}).strict().parse(req.body);
    return gate.run(body.fencingToken,async()=>{
      const results=[];
      for(const account of body.accounts){
        gate.assert(body.fencingToken);
        if(account.provider.toLowerCase()==='google'&&!account.verificationUrl&&!account.detector){
          const google=await readGoogleIdentity(context.pages());
          const matched=google.status==='authenticated'&&!!account.expectedIdentity&&google.identity===account.expectedIdentity.trim().toLowerCase();
          results.push({id:account.id,provider:account.provider,status:google.status==='authenticated'?(matched?'authenticated':account.expectedIdentity?'needs_login':'unknown'):google.status,evidence:google.status==='authenticated'?(matched?'Google 已登录账号头像身份与预期一致':'Google 已登录账号身份与预期不一致，请人工检查'):google.reason,checkedAt:new Date().toISOString()});
          continue;
        }
        const checkUrl=account.verificationUrl??account.detector?.url;const identityLocator=account.identityLocator??account.detector?.identityLocator;
        if(!checkUrl||!identityLocator||!account.expectedIdentity){results.push({id:account.id,provider:account.provider,status:'unsupported',evidence:'此站点尚未配置验证页面与身份定位器'});continue;}
        const page=await context.newPage();
        try{
          await guardUrl(checkUrl);
          const response=await page.goto(checkUrl,{timeout:30000,waitUntil:'domcontentloaded'});
          const human=await humanEvidence(page);
          if(human){results.push({id:account.id,status:human.reason==='verification'?'needs_verification':'needs_login',evidence:human.message});continue;}
          if(response&&[401,403].includes(response.status())){results.push({id:account.id,status:'needs_login',evidence:'验证站点拒绝当前会话'});continue;}
          if(account.detector?.verificationLocator&&await locate(page,account.detector.verificationLocator).isVisible()){results.push({id:account.id,status:'needs_verification',evidence:'验证页面显示二次验证提示'});continue;}
          const identity=await locate(page,identityLocator).innerText({timeout:5000});
          const match=identity.trim()===(account.expectedText??account.expectedIdentity).trim();
          results.push({id:account.id,status:match?'authenticated':'needs_login',evidence:match?'验证页面身份与预期一致':'验证页面身份与预期不一致',checkedAt:new Date().toISOString()});
        }catch{results.push({id:account.id,status:'unknown',evidence:'验证页面不可达或未提供明确身份信息'});}finally{await page.close();}
      }
      return{accounts:results};
    });
  });
  app.post('/proxy/test',async req=>{
    const body=TokenBody.parse(req.body);
    return gate.run(body.fencingToken,async()=>{
      const checks=[];
      for(const url of ['http://api.ipify.org?format=json','https://api.ipify.org?format=json']){
        const page=await context.newPage();const began=Date.now();
        try{await guardUrl(url);const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});const text=await page.locator('body').innerText({timeout:5000});let ip:string|undefined;try{const parsed=JSON.parse(text);if(typeof parsed.ip==='string'&&isIP(parsed.ip))ip=parsed.ip;}catch{}checks.push({protocol:new URL(url).protocol.slice(0,-1),success:response?.ok()??false,status:response?.status(),latencyMs:Date.now()-began,ip});}
        catch(error){checks.push({protocol:new URL(url).protocol.slice(0,-1),success:false,latencyMs:Date.now()-began,error:'目标浏览器连接失败，未切换到直连',networkCode:networkErrorCode(error)});}finally{await page.close();}
      }
      return{checks,proxyVersion:config.proxyVersion,checkedAt:new Date().toISOString(),scope:'browser_http_https',success:checks.every(c=>c.success)};
    });
  });
  app.post('/vnc/reload',async req=>{
    const body=TokenBody.parse(req.body);
    return gate.run(body.fencingToken,async()=>{await exec('/usr/local/bin/fleet-vnc-reload',[],{timeout:10000});return{applied:true};});
  });
  app.post('/shutdown',async req=>{const body=TokenBody.parse(req.body);return gate.run(body.fencingToken,async()=>{await context.close();return{stopped:true};});});
  const shutdown=async()=>{await context.close().catch(()=>undefined);await app.close();};
  process.once('SIGTERM',()=>{void shutdown();});process.once('SIGINT',()=>{void shutdown();});
  await app.listen({host:process.env.AGENT_HOST??'0.0.0.0',port:Number(process.env.AGENT_PORT??8092)});
  return{app,context,gate,shutdown};
}

// Reuse the strict locator contract without allowing JavaScript expressions.
function LocatorSchemaOptional() { return z.object({css:z.string().optional(),role:z.string().optional(),name:z.string().optional(),label:z.string().optional(),text:z.string().optional(),iframe:z.string().optional()}).strict().refine(v=>[v.css,v.role,v.label,v.text].filter(Boolean).length===1).optional(); }

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  startAgent().catch(error=>{process.stderr.write(JSON.stringify(safeError(error))+'\n');process.exitCode=1;});
}
