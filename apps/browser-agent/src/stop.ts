import { readFile } from 'node:fs/promises';
/** Signal bridge: close Chrome over the same authenticated Agent before stopping Secret Service. */
async function stop(){
  const token=(await readFile(process.env.AGENT_TOKEN_FILE??'/run/fleet/agent-token','utf8')).trim();
  const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
  const root=`http://127.0.0.1:${process.env.AGENT_PORT??8092}`;
  const request=async(path:string,body?:unknown)=>{const response=await fetch(root+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error();return response.json() as Promise<any>;};
  let health=await request('/health');if(!health.healthy)return;
  let fencingToken=health.fencingToken;
  if(fencingToken<1){await request('/fence',{token:1});fencingToken=1;}
  if(health.busy){await request('/cancel',{fencingToken});const deadline=Date.now()+20000;while(health.busy&&Date.now()<deadline){await new Promise(done=>setTimeout(done,100));health=await request('/health');}}
  await request('/shutdown',{fencingToken});
}
stop().catch(()=>{process.stderr.write('浏览器正常退出请求未完成，容器将继续执行终止流程\n');process.exitCode=1;});
