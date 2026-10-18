/** Ordinary Chrome only, isolated synthetic state, no Playwright/CDP or Google traffic. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, chmod, chown, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const exec=promisify(execFile);
const expect=condition=>assert.ok(condition,'synthetic native browser check failed');
const wait=milliseconds=>new Promise(done=>setTimeout(done,milliseconds));
const until=async(check,milliseconds=20000)=>{
  const deadline=Date.now()+milliseconds;
  while(Date.now()<deadline){if(await check())return;await wait(100);}
  throw new Error('FIXTURE_TIMEOUT');
};
let stage='setup';
const firstRunClose=process.env.FLEET_NATIVE_TEST_FIRST_RUN==='1';

async function command(command,args,input,discardOutput=false){
  return new Promise((done,fail)=>{
    const child=spawn(command,args,{stdio:['pipe','pipe','ignore']});
    const chunks=[];let size=0;
    const timer=setTimeout(()=>{child.kill('SIGKILL');fail(new Error('FIXTURE_COMMAND_TIMEOUT'));},10000);
    child.on('error',()=>{clearTimeout(timer);fail(new Error('FIXTURE_COMMAND_FAILED'));});
    child.stdout.on('data',chunk=>{if(discardOutput)return;size+=chunk.length;if(size>65536){child.kill('SIGKILL');fail(new Error('FIXTURE_COMMAND_TOO_LARGE'));}else chunks.push(chunk);});
    child.once('exit',code=>{clearTimeout(timer);if(code===0)done(Buffer.concat(chunks).toString());else fail(new Error('FIXTURE_COMMAND_FAILED'));});
    child.stdin.on('error',()=>undefined);child.stdin.end(input);
  });
}

async function inside(){
  expect(process.env.FLEET_NATIVE_FIXTURE==='1'&&process.getuid?.()===1000);
  const {NativeBrowser}=await import('/app/apps/browser-agent/dist/native-browser.js');
  const {startVncProxy}=await import('/app/apps/browser-agent/dist/vnc-proxy.js');
  const state='/fixture/state',runtime='/tmp/native-fixture-runtime';
  await mkdir(runtime,{recursive:true,mode:0o700});await mkdir(join(state,'keyrings'),{recursive:true,mode:0o700});
  // Start from a real blank profile: no First Run sentinel or preferences are preseeded.
  // The product's ordinary --no-first-run setting must expose the initial test page.
  await mkdir(join(state,'chrome'),{recursive:true,mode:0o700});
  process.env.XDG_RUNTIME_DIR=runtime;process.env.GNOME_KEYRING_CONTROL=join(runtime,'keyring');
  await mkdir(process.env.GNOME_KEYRING_CONTROL,{recursive:true,mode:0o700});
  stage='keyring';
  await command('gnome-keyring-daemon',['--unlock','--components=secrets','--control-directory='+process.env.GNOME_KEYRING_CONTROL],randomBytes(32).toString('base64url'));
  await command('secret-tool',['store','--label=Native Fixture','chrome-fleet','probe'],'chrome-fleet-keyring-ready');
  expect((await command('secret-tool',['lookup','chrome-fleet','probe'])).trim()==='chrome-fleet-keyring-ready');
  const xvfb=spawn('/usr/bin/Xvfb',[':97','-screen','0','1280x900x24','-nolisten','tcp','-ac'],{stdio:'ignore'});
  let wm,proxy,browser,server;
  try{
    stage='display_xvfb';
    await until(async()=>{try{await command('xdpyinfo',['-display',':97'],undefined,true);return true;}catch{return false;}},10000);
    stage='display_window_manager';
    wm=spawn('/usr/bin/openbox',[],{stdio:'ignore'});
    await until(async()=>{try{return(await command('/usr/bin/wmctrl',['-m'])).includes('Openbox');}catch{return false;}},10000);
    const proof=randomBytes(24).toString('hex');
    let written=false,restored=false,pageRequests=0,proofRequests=0,scriptFailed=false;
    let lastEvidence={cookie:false,ordinary:false,local:false,indexed:false};
    const pageProgram=mode=>`(async()=>{try{
      const proof=${JSON.stringify(proof)};
      const db=await new Promise((done,fail)=>{const req=indexedDB.open('native-fixture',1);req.onupgradeneeded=()=>req.result.createObjectStore('proofs');req.onsuccess=()=>done(req.result);req.onerror=()=>fail(new Error());});
      if(${JSON.stringify(mode)}==='write'){
        localStorage.setItem('proof',proof);
        await new Promise((done,fail)=>{const tx=db.transaction('proofs','readwrite');tx.objectStore('proofs').put(proof,'proof');tx.oncomplete=()=>done();tx.onerror=()=>fail(new Error());});
      }
      const indexed=await new Promise((done,fail)=>{const req=db.transaction('proofs').objectStore('proofs').get('proof');req.onsuccess=()=>done(req.result);req.onerror=()=>fail(new Error());});db.close();
      await fetch('/proof',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:${JSON.stringify(mode)},ordinary:navigator.webdriver===false,local:localStorage.getItem('proof')===proof,indexed:indexed===proof})});
    }catch{await fetch('/proof-failed',{method:'POST'});}})();`;
    server=createServer((req,res)=>{
      const pathname=new URL(req.url??'/','http://fixture.invalid').pathname;
      if(pathname==='/write'||pathname==='/read'){
        pageRequests++;
        const headers={'content-type':'text/html; charset=utf-8','cache-control':'no-store'};
        if(pathname==='/write')headers['set-cookie']='native-proof='+proof+'; Max-Age=86400; HttpOnly; SameSite=Lax; Path=/';
        res.writeHead(200,headers);res.end('<!doctype html><title>Synthetic Native Fixture</title><main>Local fixture</main><script>'+pageProgram(pathname.slice(1))+'</script>');return;
      }
      if(pathname==='/proof'){
        proofRequests++;
        const chunks=[];let size=0;
        req.on('data',chunk=>{size+=chunk.length;if(size<=2048)chunks.push(chunk);else req.destroy();});
        req.on('end',()=>{
          try{
            const evidence=JSON.parse(Buffer.concat(chunks).toString());
            lastEvidence={cookie:!!req.headers.cookie?.split(';').some(value=>value.trim()==='native-proof='+proof),ordinary:evidence.ordinary===true,local:evidence.local===true,indexed:evidence.indexed===true};
            const valid=Object.values(lastEvidence).every(value=>value===true);
            if(evidence.mode==='write')written=!!valid;if(evidence.mode==='read')restored=!!valid;
          }catch{}
          res.writeHead(204);res.end();
        });return;
      }
      if(pathname==='/proof-failed')scriptFailed=true;
      res.writeHead(404);res.end();
    });
    await new Promise(done=>server.listen(0,'127.0.0.1',done));
    const port=server.address().port;
    proxy=await startVncProxy(undefined,{allowedPrivateHosts:new Set(['127.0.0.1']),lookup:async()=>[{address:'127.0.0.1',family:4}]});
    const settings={userDataDir:join(state,'chrome'),locale:'zh-CN',timezoneId:'Asia/Shanghai',viewport:{width:1280,height:900},proxyServer:proxy.server};
    const open=async mode=>{
      const launched=await NativeBrowser.launch({...settings,initialUrl:'http://127.0.0.1:'+port+'/'+mode});
      await until(()=>launched.ready());
      // This is only the PID created by this fixture; never enumerate other processes.
      const args=(await readFile('/proc/'+launched.child.pid+'/cmdline','utf8')).split('\0');
      expect(!args.some(arg=>/--(?:remote-debugging|enable-automation|no-sandbox|headless)/.test(arg)));
      return launched;
    };
    stage='first_native_launch';browser=await open('write');
    if(firstRunClose){
      stage='first_run_window_close';
      let closeCode='NONE';
      try{await browser.close();}catch(error){closeCode=typeof error?.code==='string'&&/^[A-Z_]+$/.test(error.code)?error.code:'UNKNOWN';}
      const {exitCode,signalCode}=browser.child;
      expect(Number.isInteger(exitCode)||typeof signalCode==='string');
      expect(!browser.running);
      console.log('PASS: firstRunClose=true, exitCode='+exitCode+', signalCode='+signalCode+', closeCode='+closeCode+', pageRequests='+pageRequests);
      browser=undefined;return;
    }
    stage='first_page_evidence';
    try{await until(()=>written);}catch(error){stage=pageRequests===0?'first_page_no_document':scriptFailed?'first_page_script_failed':proofRequests===0?'first_page_no_signal':!lastEvidence.cookie?'first_page_cookie_missing':!lastEvidence.ordinary?'first_page_automation_flag':!lastEvidence.local?'first_page_local_storage_missing':'first_page_indexed_db_missing';throw error;}
    stage='first_window_close';await browser.close();expect(!browser.running);browser=undefined;
    const secret1=(await command('secret-tool',['lookup','application','chrome'])).trim();expect(secret1.length>0);
    const hash1=createHash('sha256').update(secret1).digest('hex');
    stage='second_native_launch';browser=await open('read');stage='second_page_evidence';await until(()=>restored);
    stage='second_window_close';await browser.close();expect(!browser.running);browser=undefined;
    const secret2=(await command('secret-tool',['lookup','application','chrome'])).trim();
    expect(createHash('sha256').update(secret2).digest('hex')===hash1);
    expect(pageRequests===2);
    console.log('PASS: ordinaryChrome=true, normalWindowCloses=2, persistentCookie=true, localStorage=true, indexedDB=true, keyringKeyStable=true, googleRequests=0');
  }finally{
    if(browser)await browser.close(3000).catch(()=>undefined);
    await proxy?.close();server?.closeAllConnections();if(server)await new Promise(done=>server.close(done));
    wm?.kill('SIGTERM');xvfb.kill('SIGTERM');
    await command('pkill',['-TERM','-u','1000','-x','gnome-keyring-d']).catch(()=>undefined);
  }
}

async function outside(){
  expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED!=='0');
  const runId=randomUUID(),name='cf-native-fixture-'+runId;
  const root=await mkdtemp(join(tmpdir(),'cf-native-fixture-'));
  try{
    const state=join(root,'state');await mkdir(state,{recursive:true,mode:0o700});
    await chmod(root,0o700);await chown(root,1000,1000);await chown(state,1000,1000);
    const image=process.env.FLEET_NATIVE_TEST_IMAGE??'chrome-fleet/browser:google-155.0.8059.79';
    stage='image';
    const inspected=(await exec('docker',['image','inspect','--format','{{.Id}} {{index .Config.Labels "chrome-fleet.browser"}}',image])).stdout.trim().split(' ');
    expect(/^sha256:[a-f0-9]{64}$/.test(inspected[0])&&inspected[1]==='true');
    const script=fileURLToPath(import.meta.url),seccomp=resolve('docker/browser/seccomp.json');
    stage='isolated_container';
    const args=['run','--rm','--name',name,'--label','chrome-fleet.fixture='+runId,'--network','none','--user','1000:1000','--read-only','--init','--cap-drop','ALL','--security-opt','no-new-privileges:true','--security-opt','seccomp='+seccomp,'--shm-size','512m','--memory','1536m','--pids-limit','512','--tmpfs','/tmp:rw,nosuid,nodev,size=256m,mode=1777','--tmpfs','/home/fleet/.cache:rw,nosuid,nodev,size=128m,uid=1000,gid=1000','--mount','type=bind,src='+root+',dst=/fixture','--mount','type=bind,src='+script+',dst=/fixtures/native-browser-fixture.mjs,readonly','--env','FLEET_NATIVE_FIXTURE=1','--env','FLEET_NATIVE_TEST_FIRST_RUN='+(firstRunClose?'1':'0'),'--env','DISPLAY=:97','--env','XDG_DATA_HOME=/fixture/state','--env','XDG_CONFIG_HOME=/fixture/state/config','--env','XDG_RUNTIME_DIR=/tmp/native-fixture-runtime','--entrypoint','/usr/bin/dbus-run-session',inspected[0],'--','node','/fixtures/native-browser-fixture.mjs','--inside'];
    await new Promise((done,fail)=>{
      const child=spawn('docker',args,{stdio:['ignore','pipe','pipe']});
      let passed=false,diagnostic='';
      child.stdout.on('data',chunk=>{for(const line of chunk.toString().split('\n')){if(line.startsWith('PASS: ordinaryChrome=true,')||(firstRunClose&&/^PASS: firstRunClose=true, exitCode=(?:null|\d+), signalCode=(?:null|SIG[A-Z]+), closeCode=[A-Z_]+, pageRequests=\d+$/.test(line))){passed=true;console.log(line);}}});
      child.stderr.on('data',chunk=>{
        diagnostic=(diagnostic+chunk.toString()).slice(-8192);
        const safe=/^FAIL: stage=([a-z_]+) code=NATIVE_FIXTURE_FAILED$/m.exec(diagnostic);
        if(safe)stage='inside_'+safe[1];
      });
      const timer=setTimeout(()=>{child.kill('SIGTERM');fail(new Error('FIXTURE_TIMEOUT'));},150000);
      child.once('error',()=>{clearTimeout(timer);fail(new Error('FIXTURE_START_FAILED'));});
      child.once('exit',code=>{clearTimeout(timer);if(code===0&&passed)done();else fail(new Error('FIXTURE_FAILED'));});
    });
  }finally{
    await exec('docker',['rm','-f',name]).catch(()=>undefined);
    await rm(root,{recursive:true,force:true});
  }
}
try{if(process.argv.includes('--inside'))await inside();else await outside();}
catch{console.error('FAIL: stage='+stage+' code=NATIVE_FIXTURE_FAILED');process.exitCode=1;}
