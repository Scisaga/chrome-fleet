import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { AgentError, FenceGate } from './model.js';
import { NativeBrowser } from './native-browser.js';
import { X11Clipboard, validClipboardText } from './x11-clipboard.js';

const exec=promisify(execFile);
const TokenBody=z.object({fencingToken:z.number().int().positive()});
interface ManualAgentOptions {
  authToken:string;
  browser:Pick<NativeBrowser,'running'|'version'|'ready'|'close'>;
  proxyVersion:number;
  playwrightVersion:string;
  keyringHealth:()=>Promise<unknown>;
  desktopReady:()=>Promise<boolean>;
  closeProxy:()=>Promise<void>;
  clipboard?:Pick<X11Clipboard,'read'|'write'>;
  reloadVnc?:()=>Promise<void>;
}

/** VNC mode intentionally has no BrowserContext, Page, CDP or DOM capability. */
export function createManualAgent(options:ManualAgentOptions) {
  const app=Fastify({logger:false,bodyLimit:1024*1024});
  const gate=new FenceGate();
  const clipboard=options.clipboard??new X11Clipboard();
  let stopped=false,proxyClosed=false;
  const closeBrowser=async()=>{
    await options.browser.close();
    stopped=true;
    if(!proxyClosed){await options.closeProxy();proxyClosed=true;}
  };
  app.addHook('onRequest',async(req,reply)=>{
    const actual=Buffer.from(req.headers.authorization?.replace(/^Bearer /,'')??''),expected=Buffer.from(options.authToken);
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return reply.code(401).send({code:'UNAUTHORIZED',message:'Agent 身份验证失败'});
  });
  app.setErrorHandler((error,_req,reply)=>{
    const known=error instanceof AgentError,validation=error instanceof z.ZodError;
    return reply.code(known?error.statusCode:validation?400:500).send({
      code:known?error.code:validation?'VALIDATION_ERROR':'BROWSER_OPERATION_FAILED',
      message:known?error.message:validation?'请求参数不符合接口约定':'人工浏览器操作失败，请检查实例状态',
    });
  });
  app.get('/health',async()=>{
    const healthy=!stopped&&options.browser.running,desktopReady=await options.desktopReady();
    let windowReady=false;
    if(healthy)try{windowReady=await options.browser.ready();}catch{}
    return{browserMode:'vnc',automationAvailable:false,healthy,ready:healthy&&windowReady&&desktopReady,desktopReady,
      chromeVersion:options.browser.version,playwrightVersion:options.playwrightVersion,keyring:await options.keyringHealth(),
      sandboxEnabled:true,headless:false,proxyVersion:options.proxyVersion,fencingToken:gate.token,busy:gate.busy,
      pages:0,activeDownloads:null,downloadTrackingAvailable:false};
  });
  app.post('/fence',async req=>{
    const {token}=z.object({token:z.number().int().positive()}).strict().parse(req.body);await gate.advance(token);
    return{fencingToken:gate.token};
  });
  app.post('/desktop/clipboard',async req=>{
    const body=z.discriminatedUnion('action',[
      TokenBody.extend({action:z.literal('read')}).strict(),
      TokenBody.extend({action:z.literal('write'),text:z.string().max(128*1024).refine(validClipboardText)}).strict(),
    ]).parse(req.body);
    try{return await gate.run<{text:string}|{written:true}>(body.fencingToken,()=>body.action==='read'
      ?clipboard.read(()=>gate.assert(body.fencingToken)):clipboard.write(body.text,()=>gate.assert(body.fencingToken)));
    }finally{if(body.action==='write')body.text='';if(req.body&&typeof req.body==='object'&&'text' in req.body)(req.body as {text:string}).text='';}
  });
  app.post('/vnc/reload',async req=>{
    const body=TokenBody.strict().parse(req.body);
    return gate.run(body.fencingToken,async()=>{
      if(options.reloadVnc)await options.reloadVnc();else await exec('/usr/local/bin/fleet-vnc-reload',[],{timeout:10000});
      return{applied:true};
    });
  });
  app.post('/shutdown',async req=>{const body=TokenBody.strict().parse(req.body);return gate.run(body.fencingToken,async()=>{await closeBrowser();return{stopped:true};});});
  const unsupported=async()=>{throw new AgentError('VNC_MODE_UNSUPPORTED','此实例使用纯 VNC 浏览器；仅支持人工桌面和剪贴板，浏览器自动化功能不可用',409);};
  for(const path of ['/execute','/cancel','/self-test','/cookies/export','/cookies/import','/storage-state/export','/storage-state/import','/proxy/test'])app.post(path,unsupported);
  for(const path of ['/accounts/google-identity','/accounts/google-login','/accounts/google-autofill','/accounts/check','/accounts/open-login'])
    app.post(path,async()=>{throw new AgentError('ACCOUNT_CHECK_REMOVED','账号自动访问及检测已移除，请在桌面登录后人工确认',410);});
  // Reject future automation paths too, rather than silently falling through.
  app.setNotFoundHandler((_req,reply)=>reply.code(409).send({code:'VNC_MODE_UNSUPPORTED',message:'纯 VNC 模式不提供此浏览器自动化接口'}));
  const shutdown=async()=>{await closeBrowser();await app.close();};
  return{app,gate,shutdown};
}
