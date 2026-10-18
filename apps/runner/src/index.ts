import Fastify from 'fastify';
import { readFile, writeFile, lstat, realpath, stat, mkdir, chmod, chown, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { timingSafeEqual, randomUUID, createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { Docker } from './docker.js';
import { Image, normalizeProxy, ProfileId, profilePath, RunnerError, StartBody } from './policy.js';
import { NetworkPolicy, NetworkPolicySync } from './network-policy.js';
import { MetricsSampler, MetricsRequests } from './metrics.js';

const dataRoot=process.env.DATA_ROOT??'/var/lib/chrome-fleet';
const controlNetwork=process.env.FLEET_CONTROL_NETWORK??'chrome-fleet-control';
const controlSubnet=process.env.FLEET_CONTROL_SUBNET??'172.30.0';
const repoRoot=resolve(process.env.BUILD_CONTEXT??process.cwd());
const docker=new Docker();
const locks=new Map<string,Promise<unknown>>();
const managedLabels={'chrome-fleet.managed':'true'};
const enc=encodeURIComponent;
const reservedControlAddresses=new Set<string>();
const reservedEgressSubnets=new Set<string>();
const validationProfiles=new Set<string>();
let allocationQueue:Promise<unknown>=Promise.resolve();
function allocate<T>(operation:()=>Promise<T>):Promise<T>{const result=allocationQueue.then(operation,operation);allocationQueue=result.then(()=>undefined,()=>undefined);return result;}

async function withLock<T>(key:string,operation:()=>Promise<T>):Promise<T>{
  if(locks.has(key))throw new RunnerError('PROFILE_BUSY','实例生命周期操作正在进行',409);
  const pending=operation();locks.set(key,pending);
  try{return await pending;}finally{if(locks.get(key)===pending)locks.delete(key);}
}
async function inspect(id:string,timeout=120000){
  const info=await docker.call('GET',`/containers/${enc(id)}/json`,undefined,timeout);
  if(info.Config?.Labels?.['chrome-fleet.managed']!=='true'||info.Config?.Labels?.['chrome-fleet.profile']!==id)throw new RunnerError('CONTAINER_FORBIDDEN','只能操作 Chrome Fleet 管理的目标实例',403);
  return info;
}
async function exists(id:string,timeout=120000){try{return await inspect(id,timeout);}catch(e){if(e instanceof RunnerError&&e.code==='DOCKER_NOT_FOUND')return undefined;throw e;}}
async function validateImage(image:string){
  Image.parse(image);
  const info=await docker.call('GET',`/images/${enc(image)}/json`);
  if(info.Config?.Labels?.['chrome-fleet.browser']!=='true')throw new RunnerError('IMAGE_NOT_APPROVED','镜像没有 Chrome Fleet 浏览器构建标记',403);
  if(info.Architecture!=='amd64')throw new RunnerError('ARCH_UNSUPPORTED','当前仅验证 Linux x86_64 官方 Chrome');
  return info;
}
async function checkFirewall(){
  if(process.env.FLEET_FIREWALL_REQUIRED==='false' && process.env.NODE_ENV==='test')return;
  try{
    const markerPath=process.env.FIREWALL_MARKER??'/run/chrome-fleet/firewall-ready.json';
    const metadata=await stat(markerPath);const marker=JSON.parse(await readFile(markerPath,'utf8'));
    const bootId=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
    if(metadata.uid!==0||(metadata.mode&0o022)!==0||marker.version!==1||marker.bootId!==bootId||marker.controlSubnet!==`${controlSubnet}.0/24`)throw new Error();
  }catch{throw new RunnerError('FIREWALL_NOT_READY','宿主机 Chrome Fleet 网络隔离策略未就绪，请运行 npm run init:firewall',503);}
}
async function checkDirectories(id:string){
  for(const child of ['state','secrets'] as const){
    const path=profilePath(dataRoot,id,child);const actual=await realpath(path);const metadata=await lstat(path);
    if(actual!==path||metadata.isSymbolicLink()||!metadata.isDirectory()||metadata.uid!==1000||(metadata.mode&0o077)!==0)throw new RunnerError('PROFILE_DIRECTORY_UNSAFE','实例目录必须是 UID 1000 所有、权限 0700 的真实目录',403);
  }
  for(const file of ['agent-token','keyring-password','vnc-password']){
    const path=resolve(profilePath(dataRoot,id,'secrets'),file);const metadata=await lstat(path);
    if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.uid!==1000||(metadata.mode&0o077)!==0)throw new RunnerError('SECRET_FILE_UNSAFE','实例秘密文件权限不正确',403);
    const secret=(await readFile(path,'utf8')).trim();
    if(file==='vnc-password'&&!/^[\x21-\x7e]{8}$/.test(secret))throw new RunnerError('VNC_PASSWORD_INVALID','VNCAuth 密码必须恰好 8 个可打印 ASCII 字符');
    if(file!=='vnc-password'&&secret.length<32)throw new RunnerError('SECRET_TOO_SHORT','实例秘密长度不足');
  }
}
async function controlAddress(){
  const network=await docker.call('GET',`/networks/${enc(controlNetwork)}`);
  const used=new Set(Object.values(network.Containers??{}).map((c:any)=>c.IPv4Address?.split('/')[0]));
  for(let octet=32;octet<251;octet++){const address=`${controlSubnet}.${octet}`;if(!used.has(address)&&!reservedControlAddresses.has(address)){reservedControlAddresses.add(address);return address;}}
  throw new RunnerError('INSTANCE_LIMIT','控制网络地址已耗尽',409);
}
async function ensureEgress(id:string){
  return allocate(async()=>{
  const name=`cf_egress_${id.slice(3)}`;
  try{return(await docker.call('GET',`/networks/${enc(name)}`)).Id;}catch(e){if(!(e instanceof RunnerError)||e.code!=='DOCKER_NOT_FOUND')throw e;}
  const all=await docker.call<any[]>('GET','/networks');
  const used=new Set(all.flatMap(n=>n.IPAM?.Config?.map((c:any)=>c.Subnet)??[]));
  let subnet='';for(let octet=1;octet<255;octet++){const candidate=`172.31.${octet}.0/24`;if(!used.has(candidate)&&!reservedEgressSubnets.has(candidate)){subnet=candidate;reservedEgressSubnets.add(candidate);break;}}
  if(!subnet)throw new RunnerError('NETWORK_LIMIT','实例出站网络地址已耗尽',409);
  const result=await docker.call('POST','/networks/create',{Name:name,Driver:'bridge',Internal:false,EnableIPv6:false,Labels:{...managedLabels,'chrome-fleet.profile':id},Options:{'com.docker.network.bridge.enable_icc':'false','com.docker.network.bridge.name':`cf${createHash('sha256').update(id).digest('hex').slice(0,12)}`},IPAM:{Driver:'default',Config:[{Subnet:subnet}]}}).finally(()=>reservedEgressSubnets.delete(subnet));
  return result.Id;
  });
}
async function ready(id:string,token:string){
  const url=`http://${id}:8092`;
  for(let attempt=0;attempt<90;attempt++){
    const state=await inspect(id);if(!state.State.Running)throw new RunnerError('BROWSER_START_FAILED','浏览器容器启动后退出，请查看脱敏诊断信息',502);
    try{const response=await fetch(`${url}/health`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(2000)});const health:any=await response.json();if(response.ok&&health.healthy&&health.ready&&health.keyring?.unlocked&&health.keyring?.probeVerified)return health;}catch{}
    await new Promise(r=>setTimeout(r,1000));
  }
  throw new RunnerError('BROWSER_START_TIMEOUT','等待 Chrome、keyring 和远程桌面就绪超时',504);
}
function runtime(info:any){return{profileId:info.Config.Labels['chrome-fleet.profile'],browserMode:info.Config.Labels['chrome-fleet.browser-mode']??'automation',status:info.State.Running?'running':'stopped',imageDigest:info.Image,image:info.Config.Image,agentUrl:`http://${info.Config.Labels['chrome-fleet.profile']}:8092`,desktopUrl:`http://${info.Config.Labels['chrome-fleet.profile']}:6080`,startedAt:info.State.StartedAt,exitCode:info.State.ExitCode};}

export async function startRunner(){
  const token=(await readFile(process.env.RUNNER_TOKEN_FILE??'/run/secrets/runner-token','utf8')).trim();
  if(token.length<32)throw new RunnerError('SECRET_INVALID','Runner 凭据长度不足');
  const app=Fastify({logger:false,bodyLimit:1024*1024,requestTimeout:0});
  const networkPolicy=new NetworkPolicy(docker,dataRoot,controlNetwork);
  const metricsSampler=new MetricsSampler();
  const metricsRequests=new MetricsRequests();
  const policyTimer=setInterval(()=>{void networkPolicy.refresh().catch(()=>undefined);},60_000);policyTimer.unref();
  app.addHook('onClose',async()=>{clearInterval(policyTimer);});
  app.addHook('onRequest',async(req,reply)=>{const actual=Buffer.from(req.headers.authorization?.replace(/^Bearer /,'')??'');const expected=Buffer.from(token);if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return reply.code(401).send({code:'UNAUTHORIZED',message:'Runner 身份验证失败'});});
  app.setErrorHandler((error,_req,reply)=>reply.code(error instanceof RunnerError?error.statusCode:error instanceof z.ZodError?400:500).send({code:error instanceof RunnerError?error.code:error instanceof z.ZodError?'VALIDATION_ERROR':'RUNNER_FAILED',message:error instanceof RunnerError?error.message:error instanceof z.ZodError?'请求参数不符合 Runner 约定':'Runner 操作失败，请检查配置和 Docker 状态',details:error instanceof RunnerError?error.details:undefined}));
  app.get('/health',async()=>{const info=await docker.call('GET','/version');let firewallReady=false;try{await checkFirewall();firewallReady=true;}catch{}return{healthy:true,dockerVersion:info.Version,firewallReady,networkPolicy:{pending:networkPolicy.pending,lastErrorCode:networkPolicy.lastErrorCode}};});
  app.post('/network-policy/sync',async req=>{await checkFirewall();return networkPolicy.sync(NetworkPolicySync.parse(req.body));});
  app.get('/containers',async()=>{
    const containers=await docker.call<any[]>('GET',`/containers/json?all=true&filters=${enc(JSON.stringify({label:['chrome-fleet.managed=true']}))}`);
    return{containers:containers.map(c=>({profileId:c.Labels['chrome-fleet.profile'],status:c.State,image:c.Image,imageDigest:c.ImageID}))};
  });
  app.get('/profiles/:id/status',async req=>{
    const id=ProfileId.parse((req.params as any).id);
    return metricsRequests.run(id,async()=>{
    const current=await exists(id,1000);
    if(!current)return{profileId:id,status:'stopped',containerExists:false,metrics:metricsSampler.unavailable(id,'PROFILE_NOT_RUNNING')};
    let metrics;
    if(current.State.Running){
      try{const stats=await docker.call('GET',`/containers/${enc(current.Id)}/stats?stream=false&one-shot=true`,undefined,1000);metrics=metricsSampler.sample(id,current.Id,current.State.StartedAt,stats);}
      catch{metrics=metricsSampler.unavailable(id);}
    }else metrics=metricsSampler.unavailable(id,'PROFILE_NOT_RUNNING');
    return{...runtime(current),containerExists:true,metrics};
    });
  });
  app.post('/profiles/:id/start',async req=>{
    const id=ProfileId.parse((req.params as any).id);const body=StartBody.parse(req.body);normalizeProxy(body.config);
    return withLock(id,async()=>{
      await checkFirewall();await checkDirectories(id);const image=await validateImage(body.expectedDigest??body.image);
      await networkPolicy.ensureProfile(id,body.config);
      const prior=await exists(id);if(prior?.State.Running){if(prior.Image!==image.Id)throw new RunnerError('IMAGE_CONFLICT','运行中的实例镜像与请求不一致',409);if((prior.Config.Labels['chrome-fleet.browser-mode']??'automation')!==body.config.browserMode)throw new RunnerError('BROWSER_MODE_CONFLICT','运行中的浏览器模式不一致，请正常停止后切换',409);await networkPolicy.refresh();return runtime(prior);}
      if(prior)await docker.call('DELETE',`/containers/${enc(id)}?v=false`);
      const configFile=resolve(profilePath(dataRoot,id,'secrets'),'agent.json');
      await writeFile(configFile,JSON.stringify(body.config),{mode:0o600});await chmod(configFile,0o600);await chown(configFile,1000,1000);
      const egress=await ensureEgress(id);
      const seccomp=JSON.parse(await readFile(resolve(repoRoot,'docker/browser/seccomp.json'),'utf8'));
      const r=body.resources;
      await allocate(async()=>{
        const address=await controlAddress();
        try{
      await docker.call('POST',`/containers/create?name=${enc(id)}`,{
        Image:image.Id,Hostname:id,User:'1000:1000',Labels:{...managedLabels,'chrome-fleet.profile':id,'chrome-fleet.browser-mode':body.config.browserMode,...(validationProfiles.has(id)?{'chrome-fleet.validation':'true'}:{})},
        Env:['DISPLAY=:99','HOME=/home/fleet','XDG_DATA_HOME=/state','XDG_RUNTIME_DIR=/tmp/fleet-runtime','AGENT_CONFIG_FILE=/run/fleet/agent.json','STATE_ROOT=/state',`FLEET_ALLOWED_PRIVATE_HOSTS=${process.env.FLEET_ALLOWED_PRIVATE_HOSTS??''}`],
        StopSignal:'SIGTERM',StopTimeout:45,ExposedPorts:{'8092/tcp':{},'6080/tcp':{}},
        HostConfig:{Init:true,NetworkMode:controlNetwork,ReadonlyRootfs:true,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true',`seccomp=${JSON.stringify(seccomp)}`],
          Binds:[`${profilePath(dataRoot,id,'state')}:/state:rw`,`${profilePath(dataRoot,id,'secrets')}:/run/fleet:ro`],
          Tmpfs:{'/tmp':'rw,nosuid,nodev,size=268435456,mode=1777','/home/fleet/.cache':'rw,nosuid,nodev,size=134217728,uid=1000,gid=1000'},
          Memory:r.memoryMb*1024*1024,MemorySwap:r.memoryMb*1024*1024,NanoCpus:Math.floor(r.cpus*1e9),PidsLimit:r.pidsLimit,ShmSize:r.shmMb*1024*1024,
          RestartPolicy:{Name:'no'},LogConfig:{Type:'json-file',Config:{'max-size':'5m','max-file':'2'}},PortBindings:{},PublishAllPorts:false,IpcMode:'private',Sysctls:{'net.ipv6.conf.all.disable_ipv6':'1','net.ipv6.conf.default.disable_ipv6':'1'}},
        NetworkingConfig:{EndpointsConfig:{[controlNetwork]:{IPAMConfig:{IPv4Address:address},Aliases:[id]}}},
      });
      await docker.call('POST',`/networks/${enc(egress)}/connect`,{Container:id,EndpointConfig:{GwPriority:1}});
      await docker.call('POST',`/containers/${enc(id)}/start`);
        }finally{reservedControlAddresses.delete(address);}
      });
      try{await networkPolicy.ensureProfile(id,body.config);await networkPolicy.refresh();}catch(error){await docker.call('POST',`/containers/${enc(id)}/stop?t=10`).catch(()=>undefined);await networkPolicy.refresh().catch(()=>undefined);throw error;}
      const agentToken=(await readFile(resolve(profilePath(dataRoot,id,'secrets'),'agent-token'),'utf8')).trim();
      const health=await ready(id,agentToken);
      return{...runtime(await inspect(id)),chromeVersion:health.chromeVersion,playwrightVersion:health.playwrightVersion,keyring:health.keyring};
    });
  });
  app.post('/profiles/:id/stop',async req=>{const id=ProfileId.parse((req.params as any).id);const body=z.object({force:z.boolean().default(false)}).strict().parse(req.body??{});return withLock(id,async()=>{
    const current=await exists(id);
    if(current?.State.Running){
      if(!body.force){
        const agentToken=(await readFile(resolve(profilePath(dataRoot,id,'secrets'),'agent-token'),'utf8')).trim();
        const headers={authorization:`Bearer ${agentToken}`,'content-type':'application/json'};
        let health:any;try{const response=await fetch(`http://${id}:8092/health`,{headers,signal:AbortSignal.timeout(3000)});if(!response.ok)throw new Error();health=await response.json();}catch{throw new RunnerError('AGENT_UNAVAILABLE','Agent 不可达，无法确认正常退出；请先检查或显式强制停止',409);}
        if(health.busy)throw new RunnerError('PROFILE_BUSY','实例仍有操作，请先排空任务或显式强制停止',409);
        if(health.healthy){
          let fencingToken=health.fencingToken;
          if(fencingToken<1){await fetch(`http://${id}:8092/fence`,{method:'POST',headers,body:JSON.stringify({token:1}),signal:AbortSignal.timeout(3000)});fencingToken=1;}
          const response=await fetch(`http://${id}:8092/shutdown`,{method:'POST',headers,body:JSON.stringify({fencingToken}),signal:AbortSignal.timeout(35000)});
          if(!response.ok)throw new RunnerError('BROWSER_SHUTDOWN_FAILED','Chrome 未确认正常退出，拒绝继续快照或更新',409);
        }
      }
      await docker.call('POST',`/containers/${enc(id)}/stop?t=${body.force?10:45}`);
    }
    await networkPolicy.refresh();
    return{profileId:id,status:'stopped'};
  });});
  app.delete('/profiles/:id/container',async req=>{const id=ProfileId.parse((req.params as any).id);return withLock(id,async()=>{const current=await exists(id);if(current?.State.Running)throw new RunnerError('PROFILE_RUNNING','先正常停止实例再移除容器',409);if(current)await docker.call('DELETE',`/containers/${enc(id)}?v=false`);try{const network=await docker.call('GET',`/networks/${enc(`cf_egress_${id.slice(3)}`)}`);if(network.Labels?.['chrome-fleet.profile']===id)await docker.call('DELETE',`/networks/${enc(network.Id)}`);}catch(e){if(!(e instanceof RunnerError)||e.code!=='DOCKER_NOT_FOUND')throw e;}await networkPolicy.refresh();return{removed:true,dataRetained:true};});});
  app.post('/images/prepare',async req=>{
    const body=z.object({version:z.string().regex(/^\d+\.\d+\.\d+\.\d+$/),distribution:z.enum(['google','cft','google-chrome','chrome-for-testing'])}).strict().parse(req.body);
    const distribution=['google','google-chrome'].includes(body.distribution)?'google':'cft';
    return withLock('__image_build__',async()=>{
      const image=`chrome-fleet/browser:${distribution}-${body.version}`;
      await runBuild(image,body.version,distribution);
      const info=await validateImage(image);return{image,imageDigest:info.Id,version:body.version,distribution,prepared:true};
    });
  });
  app.post('/images/validate',async req=>{
    const body=z.object({image:Image}).strict().parse(req.body);const info=await validateImage(body.image);
    return withLock('__image_validation__',async()=>{
      await checkFirewall();
      const id=`cf_${randomUUID()}`;const root=resolve(dataRoot,'profiles',id);const secrets=profilePath(dataRoot,id,'secrets');const agentToken=randomBytes(32).toString('hex');const proof=randomBytes(32).toString('hex');
      validationProfiles.add(id);
      await mkdir(root,{recursive:true,mode:0o700});await chown(root,1000,1000);
      for(const child of ['state','secrets'] as const){const path=profilePath(dataRoot,id,child);await mkdir(path,{mode:0o700});await chown(path,1000,1000);}
      for(const [name,value] of Object.entries({'agent-token':agentToken,'keyring-password':randomBytes(32).toString('hex'),'vnc-password':randomBytes(6).toString('base64')})){const path=resolve(secrets,name);await writeFile(path,value,{mode:0o600});await chown(path,1000,1000);}
      const internal=async(method:'POST'|'DELETE',path:string,payload?:Record<string,unknown>)=>{
        const response=await app.inject({method,url:path,headers:{authorization:`Bearer ${token}`},payload});const result=response.json();
        if(response.statusCode>=400)throw new RunnerError(result.code??'VALIDATION_FAILED',result.message??'隔离镜像验证失败',502);
        return result;
      };
      const agent=async(path:string,payload:unknown)=>{const response=await fetch(`http://${id}:8092${path}`,{method:'POST',headers:{authorization:`Bearer ${agentToken}`,'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(90000)});const result:any=await response.json();if(!response.ok)throw new RunnerError(result.code??'VALIDATION_FAILED',result.message??'浏览器兼容性验证失败',502,result.details);return result;};
      try{
        const start={image:body.image,config:{headless:false,locale:'zh-CN',timezoneId:'Asia/Shanghai',viewport:{width:1280,height:800},proxyVersion:0}};
        await internal('POST',`/profiles/${id}/start`,start);await agent('/fence',{token:1});
        const first=await agent('/self-test',{fencingToken:1,mode:'write',proof});
        await internal('POST',`/profiles/${id}/stop`,{});await internal('DELETE',`/profiles/${id}/container`);
        await internal('POST',`/profiles/${id}/start`,start);await agent('/fence',{token:2});
        const rebuilt=await agent('/self-test',{fencingToken:2,mode:'read',proof});
        return{image:body.image,imageDigest:info.Id,valid:true,compatible:true,chromeVersion:rebuilt.chromeVersion,playwrightVersion:rebuilt.playwrightVersion,checks:{...first.checks,keyringKeyStable:rebuilt.checks.keyringKeyStable,containerRecreation:true,keyringPersistence:true},validatedAt:new Date().toISOString()};
      }finally{
        await internal('POST',`/profiles/${id}/stop`,{}).catch(()=>undefined);
        await internal('DELETE',`/profiles/${id}/container`).catch(()=>undefined);
        // Only the generated, unshared temporary profile is removed; real account data is never used.
        const remaining=await exists(id).catch(()=>true);if(!remaining)await rm(root,{recursive:true,force:true});validationProfiles.delete(id);
      }
    });
  });
  // Previous temporary validation runs contain generated blank state only, identified by an internal-only label.
  const abandoned=await docker.call<any[]>('GET',`/containers/json?all=true&filters=${enc(JSON.stringify({label:['chrome-fleet.managed=true','chrome-fleet.validation=true']}))}`);
  for(const container of abandoned){const id=container.Labels?.['chrome-fleet.profile'];if(!ProfileId.safeParse(id).success)continue;await inspect(id);if(container.State==='running')await docker.call('POST',`/containers/${enc(id)}/stop?t=45`);await docker.call('DELETE',`/containers/${enc(id)}?v=false`);try{const network=await docker.call('GET',`/networks/${enc(`cf_egress_${id.slice(3)}`)}`);if(network.Labels?.['chrome-fleet.profile']===id)await docker.call('DELETE',`/networks/${enc(network.Id)}`);}catch{}await rm(resolve(dataRoot,'profiles',id),{recursive:true,force:true});}
  await app.listen({host:process.env.RUNNER_HOST??'0.0.0.0',port:Number(process.env.RUNNER_PORT??8091)});return app;
}

async function runBuild(image:string,version:string,distribution:string){
  await new Promise<void>((resolveBuild,reject)=>{
    const child=spawn('docker',['build','--pull=false','--file','docker/browser/Dockerfile','--tag',image,'--build-arg',`CHROME_VERSION=${version}`,'--build-arg',`CHROME_DISTRIBUTION=${distribution}`,'.'],{cwd:repoRoot,stdio:['ignore','pipe','pipe']});
    // Build logs may include proxy credentials from apt. Keep only bounded diagnostics in memory.
    let bytes=0;for(const stream of [child.stdout,child.stderr])stream.on('data',(chunk:Buffer)=>{bytes+=chunk.length;});
    const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new RunnerError('IMAGE_BUILD_TIMEOUT','镜像构建超时，保留现有镜像',504));},20*60*1000);
    child.once('error',()=>{clearTimeout(timer);reject(new RunnerError('IMAGE_BUILD_UNAVAILABLE','Runner 中 Docker 构建命令不可用',503));});
    child.once('exit',code=>{clearTimeout(timer);if(code===0)resolveBuild();else reject(new RunnerError('IMAGE_BUILD_FAILED','镜像构建失败，保留现有镜像；请手动运行受控构建查看诊断',502));});
  });
}
if(process.argv[1]&&import.meta.url===new URL(`file://${resolve(process.argv[1])}`).href)startRunner().catch(()=>{process.stderr.write('Runner 启动失败，请检查 secret 文件和配置\n');process.exitCode=1;});
