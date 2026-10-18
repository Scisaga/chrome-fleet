/** Destructive only to generated empty test profiles. Run inside the Runner container. */
import { randomBytes, randomUUID, createCipheriv } from 'node:crypto';
import { mkdir, writeFile, chown, chmod, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

const exec=promisify(execFile);
const root=process.env.DATA_ROOT??'/var/lib/chrome-fleet';
const runnerUrl=process.env.RUNNER_URL??'http://127.0.0.1:8091';
const token=(await readFile(process.env.RUNNER_TOKEN_FILE??'/run/secrets/runner-token','utf8')).trim();
const image=process.env.FLEET_TEST_IMAGE??'chrome-fleet/browser:google-155.0.8059.79';
const profiles:{id:string,agentToken:string,password:string,proof:string}[]=[];
async function json(url:string,credential:string,method='GET',body?:unknown){const response=await fetch(url,{method,headers:{authorization:`Bearer ${credential}`,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(180000)});const result:any=await response.json();if(!response.ok)throw new Error(`${response.status} ${result.code}: ${result.message}`);return result;}
const runner=(path:string,body?:unknown,method=body===undefined?'GET':'POST')=>json(runnerUrl+path,token,method,body);
const agent=(p:typeof profiles[number],path:string,body:Record<string,unknown>)=>json(`http://${p.id}:8092${path}`,p.agentToken,'POST',body);
async function rfbAuthenticate(id:string,password:string):Promise<boolean>{
  const socket=new WebSocket(`ws://${id}:6080/websockify`,['binary']);socket.binaryType='arraybuffer';
  let pending=Buffer.alloc(0);let receiver:(()=>void)|undefined;let failed=false;
  socket.addEventListener('message',event=>{pending=Buffer.concat([pending,Buffer.from(event.data as ArrayBuffer)]);receiver?.();});
  socket.addEventListener('error',()=>{failed=true;receiver?.();});socket.addEventListener('close',()=>{failed=true;receiver?.();});
  const read=async(size:number):Promise<Buffer>=>{const deadline=Date.now()+10000;while(pending.length<size){if(failed)throw new Error('RFB connection closed');if(Date.now()>deadline)throw new Error('RFB timeout');await new Promise<void>(done=>{const timer=setTimeout(()=>{receiver=undefined;done();},200);receiver=()=>{clearTimeout(timer);receiver=undefined;done();};});}const result=pending.subarray(0,size);pending=pending.subarray(size);return result;};
  try{
    const protocol=await read(12);assert.match(protocol.toString(),/^RFB 003\./);socket.send(Buffer.from('RFB 003.008\n'));
    const count=(await read(1))[0]!;if(count===0)return false;const types=await read(count);assert(types.includes(2)&&!types.includes(1),'VNCAuth is required; unauthenticated access must not be offered');socket.send(Uint8Array.of(2));
    const challenge=await read(16);
    const reverse=(value:number)=>{let out=0;for(let b=0;b<8;b++)out=(out<<1)|((value>>>b)&1);return out;};
    const key=Buffer.from(password,'ascii').map(reverse);const triple=Buffer.concat([key,key,key]);const cipher=createCipheriv('des-ede3',triple,null);cipher.setAutoPadding(false);socket.send(Buffer.concat([cipher.update(challenge),cipher.final()]));
    return(await read(4)).readUInt32BE(0)===0;
  }finally{socket.close();}
}
async function create(){
  const p={id:`cf_${randomUUID()}`,agentToken:randomBytes(32).toString('hex'),password:randomBytes(6).toString('base64'),proof:randomBytes(32).toString('hex')};profiles.push(p);
  const base=resolve(root,'profiles',p.id);await mkdir(base,{mode:0o700});await chown(base,1000,1000);
  for(const folder of ['state','secrets']){const path=resolve(base,folder);await mkdir(path,{mode:0o700});await chown(path,1000,1000);}
  for(const [name,value]of Object.entries({'agent-token':p.agentToken,'keyring-password':randomBytes(32).toString('hex'),'vnc-password':p.password})){const path=resolve(base,'secrets',name);await writeFile(path,value,{mode:0o400});await chown(path,1000,1000);}
  await runner(`/profiles/${p.id}/start`,{image,config:{headless:false,locale:'zh-CN',timezoneId:'Asia/Shanghai',viewport:{width:1280,height:800},proxyVersion:0}});
  await agent(p,'/fence',{token:1});return p;
}
try{
  const validation=await runner('/images/validate',{image});assert.equal(validation.valid,true);console.log('PASS 镜像兼容性、sandbox、keyring、Cookie/IndexedDB往返及容器重建');
  // Creation overlaps intentionally to exercise IP/subnet reservation under concurrency.
  const creations=await Promise.allSettled([create(),create(),create()]);for(const result of creations)if(result.status==='rejected')throw result.reason;
  for(const p of profiles)assert.equal((await agent(p,'/self-test',{fencingToken:1,mode:'write',proof:p.proof})).passed,true);
  for(const p of profiles){const out=await agent(p,'/cookies/export',{fencingToken:1});assert.equal(out.document.cookies.find((c:any)=>c.name==='fleet-persistence-proof')?.value,p.proof);}
  console.log('PASS 3 个真实 Chrome 容器的同站点 Cookie/localStorage/IndexedDB 隔离');
  for(let i=0;i<profiles.length;i++){const p=profiles[i]!;assert.equal(await rfbAuthenticate(p.id,p.password),true);assert.equal(await rfbAuthenticate(p.id,profiles[(i+1)%profiles.length]!.password),false);}
  console.log('PASS 3 个独立 VNC 密码：正确密码通过，其他实例密码拒绝');
  const p=profiles[0]!;const replacement=randomBytes(6).toString('base64');const passwordPath=resolve(root,'profiles',p.id,'secrets','vnc-password');await chmod(passwordPath,0o600);await writeFile(passwordPath,replacement);await chmod(passwordPath,0o400);await agent(p,'/vnc/reload',{fencingToken:1});await new Promise(done=>setTimeout(done,500));assert.equal(await rfbAuthenticate(p.id,p.password),false);assert.equal(await rfbAuthenticate(p.id,replacement),true);p.password=replacement;
  console.log('PASS VNC 密码轮换后拒绝旧密码，接受新密码');
  for(const p of profiles){
    await exec('docker',['exec',p.id,'node','-e',"fetch('http://172.30.0.2:8080/health',{signal:AbortSignal.timeout(1500)}).then(()=>process.exit(1)).catch(()=>process.exit(0))"],{timeout:10000});
    await exec('docker',['exec',p.id,'node','-e',"fetch('http://169.254.169.254/latest/meta-data/',{signal:AbortSignal.timeout(1500)}).then(()=>process.exit(1)).catch(()=>process.exit(0))"],{timeout:10000});
  }
  console.log('PASS 浏览器网络命名空间实际拒绝控制服务和云元数据地址');
  await runner(`/profiles/${p.id}/stop`,{});await runner(`/profiles/${p.id}/container`,undefined,'DELETE');await runner(`/profiles/${p.id}/start`,{image,config:{headless:false,proxyVersion:0}});await agent(p,'/fence',{token:2});assert.equal((await agent(p,'/self-test',{fencingToken:2,mode:'read',proof:p.proof})).passed,true);assert.equal(await rfbAuthenticate(p.id,p.password),true);
  console.log('PASS 停止、删除并重建后登录状态测试数据及轮换后的 VNC 密码保留');
}finally{
  for(const p of profiles){let removed=false;try{await runner(`/profiles/${p.id}/stop`,{});await runner(`/profiles/${p.id}/container`,undefined,'DELETE');removed=true;}catch{}if(removed)await rm(resolve(root,'profiles',p.id),{recursive:true,force:true});}
}
