import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentError } from './model.js';

const exec = promisify(execFile);
export const googleLoginUrl = 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmyaccount.google.com%2F';
export interface NativeBrowserOptions {
  executablePath?: string;
  userDataDir: string;
  locale: string;
  timezoneId: string;
  viewport: {width:number;height:number};
  proxyServer: string;
  /** Internal fixture override only; the Agent never accepts a navigation URL. */
  initialUrl?: string;
}
export interface NativeBrowserDependencies {
  spawn(command:string,args:string[],env:NodeJS.ProcessEnv):ChildProcess;
  run(command:string,args:string[]):Promise<string>;
  wait(milliseconds:number):Promise<void>;
}
const operatingSystem:NativeBrowserDependencies = {
  spawn:(command,args,env)=>spawn(command,args,{env,stdio:'ignore'}),
  run:async(command,args)=>(await exec(command,args,{timeout:2000,maxBuffer:1024*1024})).stdout,
  wait:milliseconds=>new Promise(done=>setTimeout(done,milliseconds)),
};

/** Fixed ordinary Chrome arguments. No Playwright, DevTools or page overrides. */
export function nativeChromeArguments(options:NativeBrowserOptions):string[] {
  let proxy:URL,initial:URL;
  try { proxy=new URL(options.proxyServer);initial=new URL(options.initialUrl??googleLoginUrl); }
  catch { throw new AgentError('NATIVE_BROWSER_CONFIG_INVALID','人工浏览器配置无效'); }
  if(proxy.protocol!=='http:'||proxy.hostname!=='127.0.0.1'||!proxy.port||proxy.username||proxy.password||proxy.pathname!=='/'||proxy.search||proxy.hash)
    throw new AgentError('NATIVE_BROWSER_CONFIG_INVALID','人工浏览器必须使用实例内部的受限网络中继');
  if(!['http:','https:'].includes(initial.protocol)||initial.username||initial.password)
    throw new AgentError('NATIVE_BROWSER_CONFIG_INVALID','人工浏览器初始页面无效');
  return [
    `--user-data-dir=${options.userDataDir}`,
    '--password-store=gnome-libsecret',
    // Normal desktop setup only: show the requested page instead of the first-run dialog.
    '--no-first-run',
    `--lang=${options.locale}`,
    `--window-size=${options.viewport.width},${options.viewport.height}`,
    `--proxy-server=${proxy.origin}`,
    '--proxy-bypass-list=<-loopback>',
    initial.href,
  ];
}

/** wmctrl titles can contain private page data: extract only this process's IDs. */
export function nativeWindowIds(output:string,pid:number):string[] {
  return [...new Set(output.split('\n').flatMap(line=>{
    const match=/^\s*(0x[0-9a-f]+)\s+-?\d+\s+(\d+)(?:\s|$)/i.exec(line);
    return match&&Number(match[2])===pid?[match[1]!]:[];
  }))];
}

export class NativeBrowser {
  private closing:Promise<void>|undefined;
  private failed=false;
  private constructor(private child:ChildProcess,readonly version:string,private dependencies:NativeBrowserDependencies) {
    child.on('error',()=>{this.failed=true;});
  }
  static async launch(options:NativeBrowserOptions,dependencies=operatingSystem):Promise<NativeBrowser> {
    const args=nativeChromeArguments(options);
    const executable=options.executablePath??process.env.CHROME_PATH??'/usr/bin/google-chrome';
    let version:string;
    try {
      const output=await dependencies.run(executable,['--version']);
      const detected=/\b\d+\.\d+\.\d+\.\d+\b/.exec(output)?.[0];
      if(!detected)throw new Error();
      version=detected;
    } catch { throw new AgentError('NATIVE_BROWSER_VERSION_FAILED','无法确认人工浏览器版本',503); }
    let child:ChildProcess;
    try {
      child=dependencies.spawn(executable,args,{...process.env,TZ:options.timezoneId});
      const browser=new NativeBrowser(child,version,dependencies);
      await new Promise<void>((done,fail)=>{child.once('spawn',done);child.once('error',fail);});
      if(!child.pid)throw new Error();
      return browser;
    } catch { throw new AgentError('NATIVE_BROWSER_START_FAILED','人工浏览器启动失败，请检查实例运行环境',503); }
  }
  get running():boolean {return !this.failed&&this.child.exitCode===null&&this.child.signalCode===null;}
  private async windows():Promise<string[]> {
    try{return nativeWindowIds(await this.dependencies.run('/usr/bin/wmctrl',['-lp']),this.child.pid!);}
    catch{throw new AgentError('NATIVE_BROWSER_WINDOW_UNAVAILABLE','无法确认人工浏览器窗口状态',409);}
  }
  async ready():Promise<boolean> {return this.running&&(await this.windows()).length>0;}
  private confirmExit():void {
    if(this.failed||this.child.exitCode!==0||this.child.signalCode!==null)
      throw new AgentError('NATIVE_BROWSER_EXIT_UNCONFIRMED','无法确认 Chrome 已正常保存并退出，请人工检查后重试',409);
  }
  /** Ask the window manager to deliver WM_DELETE_WINDOW; never kill Chrome. */
  async close(timeoutMs=25000):Promise<void> {
    if(this.closing)return this.closing;
    const pending=this.closeNormally(timeoutMs);this.closing=pending;
    try{await pending;}finally{if(this.closing===pending)this.closing=undefined;}
  }
  private async closeNormally(timeoutMs:number):Promise<void> {
    const deadline=Date.now()+timeoutMs,sent=new Set<string>();
    while(this.running){
      for(const id of await this.windows()){
        if(sent.has(id))continue;
        if(!this.running)break;
        try{await this.dependencies.run('/usr/bin/wmctrl',['-i','-c',id]);sent.add(id);}
        catch{if(this.running)throw new AgentError('NATIVE_BROWSER_CLOSE_FAILED','Chrome 正常关闭请求未完成，请通过桌面检查',409);}
      }
      if(!this.running)break;
      if(Date.now()>=deadline)throw new AgentError('NATIVE_BROWSER_CLOSE_TIMEOUT','Chrome 尚未正常退出，请在桌面处理未完成的下载或确认提示后重试',409);
      await this.dependencies.wait(Math.min(100,Math.max(1,deadline-Date.now())));
    }
    this.confirmExit();
  }
}
