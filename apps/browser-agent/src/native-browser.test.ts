import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { AgentError } from './model.js';
import { NativeBrowser, nativeChromeArguments, nativeWindowIds, googleLoginUrl, type NativeBrowserDependencies } from './native-browser.js';

const options={userDataDir:'/synthetic/state/chrome',locale:'zh-CN',timezoneId:'Asia/Shanghai',viewport:{width:1440,height:900},proxyServer:'http://127.0.0.1:3129'};
test('native launch uses ordinary Chrome with no debug, automation, shell or proxy credentials',()=>{
  const args=nativeChromeArguments(options);
  assert.equal(args.at(-1),googleLoginUrl);
  assert.equal(args.includes('--password-store=gnome-libsecret'),true);
  assert.equal(args.includes('--no-first-run'),true);
  assert.equal(args.includes('--proxy-bypass-list=<-loopback>'),true);
  assert.equal(args.some(arg=>/debug|automation|headless|no-sandbox|webdriver|stealth|password-store=basic/i.test(arg)),false);
  for(const proxyServer of ['http://name:synthetic@127.0.0.1:3129','http://10.0.0.1:3129','socks5://127.0.0.1:3129','http://127.0.0.1:3129/path'])assert.throws(()=>nativeChromeArguments({...options,proxyServer}),{code:'NATIVE_BROWSER_CONFIG_INVALID'});
});
test('only valid X11 window IDs belonging to the launched Chrome PID can be closed',()=>{
  const listing='0x0400001  0 412 fixture-host synthetic private title\n0x0400002 0 999 other-host other application\n0x0400003 -1 412 fixture-host another browser window\n0x0400001 0 412 duplicate\nINVALID 0 412 rejected\n0x0400004 0 4120 rejected';
  assert.deepEqual(nativeWindowIds(listing,412),['0x0400001','0x0400003']);
});

function fixture(closeNormally=true){
  const child=Object.assign(new EventEmitter(),{pid:412,exitCode:null as number|null,signalCode:null as NodeJS.Signals|null,kill(){throw new Error('native Chrome must never be killed');}});
  const commands:{command:string;args:string[]}[]=[];
  let spawnedArgs:string[]=[],timezone='';
  const dependencies:NativeBrowserDependencies={
    spawn:(_command,args,env)=>{spawnedArgs=args;timezone=env.TZ??'';queueMicrotask(()=>child.emit('spawn'));return child as unknown as ChildProcess;},
    run:async(command,args)=>{
      commands.push({command,args});
      if(args[0]==='--version')return 'Google Chrome 155.0.8059.79';
      if(args[0]==='-lp')return '0x0400001 0 412 fixture-host test window\n0x0400002 0 999 other-host unrelated';
      if(args[0]==='-i'&&closeNormally)child.exitCode=0;
      return '';
    },
    wait:async()=>{},
  };
  return{child,commands,dependencies,spawned:()=>({args:spawnedArgs,timezone})};
}
test('normal shutdown sends a window-manager close only to its own browser and waits for clean process exit',async()=>{
  const state=fixture(),browser=await NativeBrowser.launch(options,state.dependencies);
  assert.equal(browser.version,'155.0.8059.79');assert.equal(browser.running,true);assert.equal(await browser.ready(),true);
  assert.equal(state.spawned().timezone,'Asia/Shanghai');assert.deepEqual(state.spawned().args,nativeChromeArguments(options));
  await browser.close();assert.equal(browser.running,false);
  assert.deepEqual(state.commands.filter(call=>call.args[0]==='-i'),[{command:'/usr/bin/wmctrl',args:['-i','-c','0x0400001']}]);
});
test('a close timeout preserves the live browser for human recovery; an explicit later retry can finish',async()=>{
  const state=fixture(false),browser=await NativeBrowser.launch(options,state.dependencies);
  await assert.rejects(browser.close(0),{code:'NATIVE_BROWSER_CLOSE_TIMEOUT'});
  assert.equal(browser.running,true);assert.equal(state.child.signalCode,null);
  state.child.exitCode=0;await browser.close();
});
test('an unaccepted first-run dialog or externally terminated browser is never reported as a confirmed normal shutdown',async()=>{
  for(const exit of [{exitCode:28,signalCode:null},{exitCode:null,signalCode:'SIGTERM' as const}]){
    const state=fixture(),browser=await NativeBrowser.launch(options,state.dependencies);
    Object.assign(state.child,exit);
    await assert.rejects(browser.close(),(error:unknown)=>error instanceof AgentError&&error.code==='NATIVE_BROWSER_EXIT_UNCONFIRMED');
  }
});
