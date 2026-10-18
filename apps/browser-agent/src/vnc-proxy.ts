import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import net, { type Socket } from 'node:net';
import tls from 'node:tls';
import { lookup } from 'node:dns/promises';
import { AgentError } from './model.js';

export interface VncProxyConfig { server:string; username?:string; password?:string; bypass?:string }
interface Address { address:string; family:number }
interface ProxyOptions {
  /** Only for isolated fixtures or the same explicit host policy as the Agent. */
  allowedPrivateHosts?:Set<string>;
  lookup?:(host:string)=>Promise<Address[]>;
}
const timeout=10_000;
const error=()=>new AgentError('VNC_PROXY_UNAVAILABLE','浏览器代理连接失败，未切换为直连',502);
const unbracket=(host:string)=>host.replace(/^\[|\]$/g,'').toLowerCase();
export function privateProxyAddress(address:string):boolean {
  const ip=address.toLowerCase();
  if(ip.includes(':'))return ip==='::1'||ip==='::'||ip.startsWith('fc')||ip.startsWith('fd')||ip.startsWith('fe80:')||ip.startsWith('::ffff:')||ip.startsWith('ff');
  const [a,b]=ip.split('.').map(Number);
  return a===0||a===10||a===127||a!>=224||(a===169&&b===254)||(a===172&&b!>=16&&b!<=31)||(a===192&&b===168)||(a===100&&b!>=64&&b!<=127);
}
export function bypassVncProxy(host:string,port:number,raw=''):boolean {
  return raw.split(',').map(value=>value.trim().toLowerCase()).filter(Boolean).some(value=>{
    if(value==='*')return true;
    if(value==='<local>')return !host.includes('.')&&!host.includes(':');
    const match=value.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
    if(!match||(match[2]&&Number(match[2])!==port))return false;
    const name=unbracket(match[1]!);
    return name.startsWith('*.')||name.startsWith('.')
      ? host===name.replace(/^\*?\./,'')||host.endsWith('.'+name.replace(/^\*?\./,''))
      : host===name;
  });
}
function headers(original:IncomingHttpHeaders,host:string,upgrade=false):http.OutgoingHttpHeaders {
  const result:{[key:string]:string|string[]|undefined}={};
  const hop=new Set(['proxy-authorization','proxy-authenticate','proxy-connection','connection','keep-alive','te','trailer','transfer-encoding','upgrade']);
  for(const name of String(original.connection||'').split(','))hop.add(name.trim().toLowerCase());
  for(const [name,value]of Object.entries(original))if(!hop.has(name.toLowerCase())&&name!=='host')result[name]=value;
  result.host=host;
  result.connection=upgrade?'Upgrade':'close';
  if(upgrade)result.upgrade=String(original.upgrade||'websocket');
  return result;
}
/** Local HTTP/CONNECT proxy keeps the URL/DNS boundary without a DevTools connection. */
export async function startVncProxy(config?:VncProxyConfig,options:ProxyOptions={}):Promise<{server:string;close():Promise<void>}> {
  let upstream:URL|undefined;
  if(config){
    try{upstream=new URL(config.server);}catch{throw error();}
    if(!['http:','https:','socks5:'].includes(upstream.protocol)||upstream.username||upstream.password||(upstream.pathname!==''&&upstream.pathname!=='/')||upstream.search||upstream.hash)
      throw new AgentError('PROXY_INVALID','代理配置无效，未启动浏览器',400);
    if(upstream.protocol==='socks5:'&&(config.username||config.password))
      throw new AgentError('SOCKS_AUTH_UNSUPPORTED','不支持带认证的SOCKS5代理',400);
  }
  const allowed=options.allowedPrivateHosts??new Set((process.env.FLEET_ALLOWED_PRIVATE_HOSTS||'').split(',').map(unbracket).filter(Boolean));
  const resolveHost=options.lookup??(host=>lookup(host,{all:true}));
  let closed=false;
  const assertOpen=()=>{if(closed)throw error();};
  const sockets=new Set<Socket>();
  const track=(socket:Socket)=>{
    if(closed){socket.destroy();return socket;}
    sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>socket.destroy());return socket;
  };
  async function target(raw:string,connectRequest=false){
    assertOpen();
    let url:URL;
    try{url=new URL(connectRequest?'http://'+raw:raw);}catch{throw error();}
    if(url.protocol==='ws:')url.protocol='http:';
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||
      (connectRequest&&(url.pathname!=='/'||url.search||!/^\[[0-9a-f:]+\]:\d+$|^[a-z0-9.-]+:\d+$/i.test(raw))))throw error();
    const host=unbracket(url.hostname),port=connectRequest?Number(raw.slice(raw.lastIndexOf(':')+1)):Number(url.port||(url.protocol==='https:'?443:80));
    if(!host||port<1||port>65535)throw error();
    const addresses=net.isIP(host)?[{address:host,family:net.isIP(host)}]:await resolveHost(host);
    assertOpen();
    if(!addresses.length||(!allowed.has(host)&&(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.internal')||addresses.some(item=>privateProxyAddress(item.address)))))
      throw new AgentError('NETWORK_PRIVATE_DENIED','默认禁止访问控制面、私网及元数据地址',403);
    return{url,host,port,address:addresses.find(item=>item.family===4)??addresses[0]!};
  }
  async function dial(host:string,port:number,secure=false):Promise<Socket>{
    assertOpen();
    return new Promise((resolve,reject)=>{
      const socket=track(secure?tls.connect({host,port,servername:net.isIP(host)?undefined:host,rejectUnauthorized:true}):net.connect({host,port}));
      const timer=setTimeout(()=>{socket.destroy();reject(error());},timeout);
      socket.once('error',()=>{clearTimeout(timer);reject(error());});
      socket.once('close',()=>{clearTimeout(timer);reject(error());});
      socket.once(secure?'secureConnect':'connect',()=>{clearTimeout(timer);socket.pause();resolve(socket);});
    });
  }
  async function take(socket:Socket,size:number|Buffer):Promise<Buffer>{
    return new Promise((resolve,reject)=>{
      let data=Buffer.alloc(0);
      const clean=()=>{clearTimeout(timer);socket.removeListener('data',receive);socket.removeListener('error',failed);socket.removeListener('end',failed);socket.removeListener('close',failed);socket.pause();};
      const failed=()=>{clean();reject(error());};
      const receive=(chunk:Buffer)=>{
        data=Buffer.concat([data,chunk]);
        const length=typeof size==='number'?(data.length>=size?size:-1):(()=>{const at=data.indexOf(size);return at<0?-1:at+size.length;})();
        if(data.length>64*1024){failed();socket.destroy();return;}
        if(length>=0){clean();const extra=data.subarray(length);if(extra.length)socket.unshift(extra);resolve(data.subarray(0,length));}
      };
      const timer=setTimeout(()=>{failed();socket.destroy();},timeout);
      socket.on('data',receive);socket.once('error',failed);socket.once('end',failed);socket.once('close',failed);socket.resume();
    });
  }
  const proxyAuthorization=upstream&&(config?.username||config?.password)
    ? 'Basic '+Buffer.from((config.username||'')+':'+(config.password||''),'utf8').toString('base64'):undefined;
  async function tunnel(destination:Awaited<ReturnType<typeof target>>,assertClient:()=>void=assertOpen):Promise<Socket>{
    assertClient();
    if(!upstream||bypassVncProxy(destination.host,destination.port,config?.bypass)){
      const socket=await dial(destination.address.address,destination.port);
      try{assertClient();return socket;}catch{socket.destroy();throw error();}
    }
    const socket=await dial(unbracket(upstream.hostname),Number(upstream.port||(upstream.protocol==='https:'?443:upstream.protocol==='socks5:'?1080:80)),upstream.protocol==='https:');
    try{
      assertClient();
      if(upstream.protocol==='socks5:'){
        socket.write(Buffer.from([5,1,0]));
        const hello=await take(socket,2);assertClient();if(hello[0]!==5||hello[1]!==0)throw error();
        // Local DNS has already passed the destination policy. A configured
        // upstream resolves the original host so domain-routed proxies work.
        const name=Buffer.from(destination.host,'ascii');if(name.length>255)throw error();
        socket.write(Buffer.concat([Buffer.from([5,1,0,3,name.length]),name,Buffer.from([destination.port>>8,destination.port&255])]));
        const response=await take(socket,4);assertClient();if(response[0]!==5||response[1]!==0)throw error();
        if(response[3]===1)await take(socket,6);
        else if(response[3]===4)await take(socket,18);
        else if(response[3]===3){const size=(await take(socket,1))[0]!;await take(socket,size+2);}
        else throw error();
      }else{
        const host=destination.host;
        const authority=(host.includes(':')?'['+host+']':host)+':'+destination.port;
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${proxyAuthorization?'Proxy-Authorization: '+proxyAuthorization+'\r\n':''}Connection: keep-alive\r\n\r\n`);
        const response=await take(socket,Buffer.from('\r\n\r\n'));assertClient();
        if(!/^HTTP\/1\.[01] 200(?: |\r)/.test(response.toString('latin1')))throw error();
      }
      assertClient();return socket;
    }catch{socket.destroy();throw error();}
  }
  function responseError(response:http.ServerResponse,status=502){if(response.destroyed)return;if(!response.headersSent)response.writeHead(status,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});response.end('浏览器网络请求未完成');}
  async function forward(req:http.IncomingMessage,res:http.ServerResponse){
    let request:http.ClientRequest|undefined;
    let cancelled=req.aborted||res.destroyed;
    const cancel=()=>{cancelled=true;request?.destroy();};
    req.once('aborted',cancel);req.once('error',cancel);res.once('close',cancel);
    const assertClient=()=>{assertOpen();if(cancelled||res.destroyed)throw error();};
    try{
      const destination=await target(req.url||'');
      assertClient();
      if(destination.url.protocol!=='http:')throw error();
      const direct=!upstream||bypassVncProxy(destination.host,destination.port,config?.bypass);
      const plainProxy=!direct&&upstream?.protocol!=='socks5:';
      const forwarded=headers(req.headers,destination.url.host);
      if(plainProxy){
        if(proxyAuthorization)forwarded['proxy-authorization']=proxyAuthorization;
        const transport=upstream!.protocol==='https:'?https:http;
        request=transport.request(upstream!,{method:req.method,path:destination.url.href,headers:forwarded,agent:false,rejectUnauthorized:true});
      }else{
        request=http.request({host:destination.host,port:destination.port,method:req.method,path:destination.url.pathname+destination.url.search,headers:forwarded,
          createConnection:(_opts,callback)=>{void tunnel(destination,assertClient).then(socket=>{callback!(null,socket);socket.resume();},()=>callback!(error(),undefined as any));return undefined as any;}});
      }
      request.on('socket',socket=>track(socket));
      request.setTimeout(timeout,()=>request?.destroy(error()));
      request.on('error',()=>responseError(res));
      request.on('response',up=>{
        if(closed||cancelled||res.destroyed){up.destroy();request?.destroy();return;}
        const clean=headers(up.headers,String(up.headers.host||destination.url.host));delete clean.host;
        res.writeHead(up.statusCode||502,clean);up.pipe(res);up.on('error',()=>res.destroy());
      });
      req.pipe(request);
    }catch(error){responseError(res,error instanceof AgentError&&error.code==='NETWORK_PRIVATE_DENIED'?403:502);}
  }
  const server=http.createServer({maxHeaderSize:16*1024},(req,res)=>{void forward(req,res);});
  server.on('connection',socket=>track(socket));
  server.on('clientError',(_error,socket)=>socket.destroy());
  server.on('connect',(req,client,head)=>{void(async()=>{
    let remote:Socket|undefined;
    let cancelled=client.destroyed;
    const cancel=()=>{cancelled=true;remote?.destroy();client.destroy();};
    client.once('close',cancel);client.once('end',cancel);
    const assertClient=()=>{assertOpen();if(cancelled||client.destroyed)throw error();};
    try{
      const destination=await target(req.url||'',true);
      assertClient();remote=await tunnel(destination,assertClient);assertClient();
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head.length)remote.write(head);
      remote.pipe(client);client.pipe(remote);remote.resume();
      remote.once('close',()=>client.destroy());
    }catch{remote?.destroy();if(!client.destroyed)client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');}
  })();});
  // A WebSocket over HTTPS uses CONNECT above. Plain WebSocket upgrades are
  // forwarded through a validated tunnel without buffering application data.
  server.on('upgrade',(req,client,head)=>{void(async()=>{
    let remote:Socket|undefined;
    let cancelled=client.destroyed;
    const cancel=()=>{cancelled=true;remote?.destroy();client.destroy();};
    client.once('close',cancel);client.once('end',cancel);
    const assertClient=()=>{assertOpen();if(cancelled||client.destroyed)throw error();};
    try{
      const destination=await target(req.url||'');assertClient();remote=await tunnel(destination,assertClient);assertClient();
      const outgoing=headers(req.headers,destination.url.host,true);
      remote.write(`${req.method||'GET'} ${destination.url.pathname+destination.url.search} HTTP/1.1\r\n`+Object.entries(outgoing).flatMap(([key,value])=>Array.isArray(value)?value.map(item=>`${key}: ${item}\r\n`):value===undefined?[]:[`${key}: ${value}\r\n`]).join('')+'\r\n');
      if(head.length)remote.write(head);
      remote.pipe(client);client.pipe(remote);remote.resume();
      remote.once('close',()=>client.destroy());
    }catch{remote?.destroy();if(!client.destroyed)client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');}
  })();});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
  const address=server.address();if(!address||typeof address==='string')throw error();
  return{server:`http://127.0.0.1:${address.port}`,close:async()=>{
    if(closed)return;closed=true;
    for(const socket of sockets)socket.destroy();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }};
}
