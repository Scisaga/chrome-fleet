import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { startVncProxy, bypassVncProxy } from './vnc-proxy.js';

async function listen(server:http.Server|net.Server){server.listen(0,'127.0.0.1');await once(server,'listening');return (server.address() as net.AddressInfo).port;}
async function close(server:http.Server|net.Server){server.close();if(server instanceof http.Server)server.closeAllConnections();}
const fixtureOptions={lookup:async()=>[{address:'127.0.0.1',family:4}],allowedPrivateHosts:new Set(['fixture.test'])};
function get(proxy:string,url:string,headers:Record<string,string>={}):Promise<{status:number;body:string}>{
  const address=new URL(proxy);return new Promise((resolve,reject)=>{
    const req=http.get({host:address.hostname,port:address.port,path:url,headers,agent:false},res=>{let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode!,body}));});req.on('error',reject);req.setTimeout(3000,()=>req.destroy(new Error('FIXTURE_TIMEOUT')));
  });
}
async function connect(proxy:string,authority:string){
  const address=new URL(proxy);const socket=net.connect(Number(address.port),address.hostname);await once(socket,'connect');
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  let response=Buffer.alloc(0);while(!response.includes('\r\n\r\n')){const [chunk]=await once(socket,'data');response=Buffer.concat([response,chunk]);}
  return {socket,response:response.toString('utf8')};
}
test('native proxy enforces all resolved destination addresses and strips client proxy secrets',async()=>{
  let contacts=0;const origin=http.createServer((req,res)=>{contacts++;assert.equal(req.url,'/test?q=1');assert.equal(req.headers['proxy-authorization'],undefined);assert.match(req.headers.host!,/^fixture\.test:/);res.end('合成fixture');});
  const port=await listen(origin);const denied=await startVncProxy(undefined,{lookup:fixtureOptions.lookup});const allowed=await startVncProxy(undefined,fixtureOptions);
  const bypass=await startVncProxy({server:'http://127.0.0.1:1',bypass:'fixture.test'},fixtureOptions);
  try{
    assert.equal((await get(denied.server,`http://fixture.test:${port}/`)).status,403);assert.equal(contacts,0);
    assert.deepEqual(await get(allowed.server,`http://fixture.test:${port}/test?q=1`,{'proxy-authorization':'Basic synthetic'}),{status:200,body:'合成fixture'});
    assert.equal(contacts,1);
    assert.deepEqual(await get(bypass.server,`http://fixture.test:${port}/test?q=1`),{status:200,body:'合成fixture'});
    assert.equal(contacts,2,'explicit bypass must dial the checked IP, without resolving the synthetic host again');
  }finally{await denied.close();await allowed.close();await bypass.close();await close(origin);}
});
test('native HTTP upstream receives credentials only on proxy hop and the original domain after local DNS checks',async()=>{
  const checked:string[]=[];
  let contacts=0;const upstream=http.createServer((req,res)=>{contacts++;assert.equal(req.url,'http://fixture.test/path?q=1');assert.equal(req.headers.host,'fixture.test');assert.equal(req.headers['proxy-authorization'],'Basic '+Buffer.from('fixture:secret').toString('base64'));res.end('upstream');});
  const port=await listen(upstream);const proxy=await startVncProxy({server:`http://127.0.0.1:${port}`,username:'fixture',password:'secret'},{lookup:async host=>{checked.push(host);return[{address:host==='private-target.test'?'10.1.2.3':'93.184.216.34',family:4}];}});
  try{
    assert.deepEqual(await get(proxy.server,'http://fixture.test/path?q=1',{'proxy-authorization':'Basic wrong'}),{status:200,body:'upstream'});
    assert.equal(contacts,1);assert.deepEqual(checked,['fixture.test']);
    assert.equal((await get(proxy.server,'http://127.0.0.1/private')).status,403);
    assert.equal((await get(proxy.server,'http://private-target.test/private')).status,403);
    assert.deepEqual(checked,['fixture.test','private-target.test']);assert.equal(contacts,1,'private target DNS is rejected before reaching the trusted upstream');
  }finally{await proxy.close();await close(upstream);}
});
test('native HTTP CONNECT preserves the target domain, explicit port 80, proxy auth and bidirectional data',async()=>{
  const checked:string[]=[];
  let authority='';const upstream=http.createServer();upstream.on('connect',(req,socket)=>{authority=req.url!;assert.equal(req.headers.host,'fixture.test:80');assert.equal(req.headers['proxy-authorization'],'Basic '+Buffer.from('fixture:secret').toString('base64'));socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');socket.on('data',data=>socket.write(data));});
  const port=await listen(upstream);const proxy=await startVncProxy({server:`http://127.0.0.1:${port}`,username:'fixture',password:'secret'},{lookup:async host=>{checked.push(host);return[{address:'93.184.216.34',family:4}];}});
  let socket:net.Socket|undefined;try{const tunnel=await connect(proxy.server,'fixture.test:80');socket=tunnel.socket;assert.match(tunnel.response,/^HTTP\/1.1 200/);assert.equal(authority,'fixture.test:80');assert.deepEqual(checked,['fixture.test']);socket.write('合成隧道');const [data]=await once(socket,'data');assert.equal(data.toString(),'合成隧道');}finally{socket?.destroy();await proxy.close();await close(upstream);}
});
test('native proxy fails closed on upstream rejection',async()=>{
  const upstream=http.createServer();upstream.on('connect',(_req,socket)=>socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'));const port=await listen(upstream);
  const proxy=await startVncProxy({server:`http://127.0.0.1:${port}`},fixtureOptions);let socket:net.Socket|undefined;
  try{const result=await connect(proxy.server,'fixture.test:443');socket=result.socket;assert.match(result.response,/^HTTP\/1.1 502/);}finally{socket?.destroy();await proxy.close();await close(upstream);}
});
test('native SOCKS5 relay preserves the target domain after local DNS checks and carries HTTP streams',async()=>{
  const checked:string[]=[];
  let target='';const upstream=net.createServer(socket=>{
    let phase=0;let buffered=Buffer.alloc(0);socket.on('data',data=>{
      buffered=Buffer.concat([buffered,data]);
      if(phase===0&&buffered.length>=3){assert.deepEqual(buffered.subarray(0,3),Buffer.from([5,1,0]));buffered=buffered.subarray(3);socket.write(Buffer.from([5,0]));phase=1;}
      if(phase===1&&buffered.length>=5+buffered[4]!+2){assert.equal(buffered[3],3);const length=buffered[4]!;target=buffered.subarray(5,5+length).toString();buffered=buffered.subarray(7+length);socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,80]));phase=2;}
      if(phase===2&&buffered.includes('\r\n\r\n')){assert.match(buffered.toString(),/^GET \/synthetic HTTP\/1.1/);socket.end('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nsocks');phase=3;}
    });
  });const port=await listen(upstream);const proxy=await startVncProxy({server:`socks5://127.0.0.1:${port}`},{lookup:async host=>{checked.push(host);return[{address:'93.184.216.34',family:4}];}});
  try{assert.deepEqual(await get(proxy.server,'http://fixture.test/synthetic'),{status:200,body:'socks'});assert.equal(target,'fixture.test');assert.deepEqual(checked,['fixture.test']);}finally{await proxy.close();await close(upstream);}
});
test('native bypass uses same destination boundary and validates configuration',async()=>{
  assert.equal(bypassVncProxy('example.com',443,'*.example.com:443'),true);assert.equal(bypassVncProxy('x.example.com',80,'.example.com:443'),false);assert.equal(bypassVncProxy('localhost',80,'<local>'),true);
  await assert.rejects(startVncProxy({server:'socks5://127.0.0.1:1080',username:'fixture'}),{code:'SOCKS_AUTH_UNSUPPORTED'});
  await assert.rejects(startVncProxy({server:'http://embedded:secret@127.0.0.1:8888'}),{code:'PROXY_INVALID'});
});

test('closing native relay while destination DNS is pending prevents later upstream connections',async()=>{
  let contacts=0,release!:()=>void,entered!:()=>void;
  const waiting=new Promise<void>(resolve=>{entered=resolve;});
  const upstream=http.createServer((_req,res)=>{contacts++;res.end('synthetic');});
  const port=await listen(upstream);
  const proxy=await startVncProxy({server:`http://127.0.0.1:${port}`},{lookup:async()=>{entered();await new Promise<void>(resolve=>{release=resolve;});return[{address:'93.184.216.34',family:4}];}});
  const address=new URL(proxy.server);
  const request=http.get({host:address.hostname,port:address.port,path:'http://fixture.test/synthetic',agent:false});request.on('error',()=>{});
  try{
    await waiting;await proxy.close();release();
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(contacts,0,'DNS resolution must not reopen a closed relay');
  }finally{request.destroy();release?.();await proxy.close();await close(upstream);}
});

test('cancelled HTTP, CONNECT and WebSocket clients cannot open delayed upstream tunnels',async()=>{
  for(const kind of ['http','connect','upgrade']){
    let contacts=0,release!:()=>void,entered!:()=>void;
    const waiting=new Promise<void>(resolve=>{entered=resolve;});
    const connections=new Set<net.Socket>();
    const upstream=http.createServer((_req,res)=>{contacts++;res.end('synthetic');});
    upstream.on('connection',socket=>{connections.add(socket);socket.on('close',()=>connections.delete(socket));});
    upstream.on('connect',(_req,socket)=>{contacts++;socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');});
    const port=await listen(upstream);
    const proxy=await startVncProxy({server:`http://127.0.0.1:${port}`},{lookup:async()=>{entered();await new Promise<void>(resolve=>{release=resolve;});return[{address:'93.184.216.34',family:4}];}});
    const address=new URL(proxy.server);const client=net.connect(Number(address.port),address.hostname);client.on('error',()=>{});
    try{
      await once(client,'connect');
      client.write(kind==='connect'?'CONNECT fixture.test:443 HTTP/1.1\r\nHost: fixture.test:443\r\n\r\n':
        'GET http://fixture.test/synthetic HTTP/1.1\r\nHost: fixture.test\r\n'+(kind==='upgrade'?'Connection: Upgrade\r\nUpgrade: websocket\r\n':'Connection: close\r\n')+'\r\n');
      await waiting;client.destroy();
      // Let the remote EOF/close reach the relay before releasing its DNS wait.
      await new Promise(resolve=>setTimeout(resolve,25));release();
      await new Promise(resolve=>setTimeout(resolve,100));
      assert.equal(contacts,0,kind+' must not issue an upstream request after cancellation');
      assert.equal(connections.size,0,kind+' must not leave an upstream connection');
    }finally{client.destroy();release?.();await proxy.close();for(const socket of connections)socket.destroy();await close(upstream);}
  }
});

test('an HTTPS upstream with an invalid certificate fails HTTP and CONNECT without direct fallback',async()=>{
  const root=await mkdtemp(join(tmpdir(),'fleet-vnc-proxy-tls-'));
  let directContacts=0,proxyRequests=0;
  let upstream:https.Server|undefined,origin:http.Server|undefined,proxy:Awaited<ReturnType<typeof startVncProxy>>|undefined,client:net.Socket|undefined;
  try{
    const key=join(root,'key.pem'),cert=join(root,'cert.pem');
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-subj','/CN=localhost','-days','1'],{stdio:'ignore'});
    upstream=https.createServer({key:await readFile(key),cert:await readFile(cert)},(_req,res)=>{proxyRequests++;res.end('unexpected');});
    upstream.on('tlsClientError',()=>{});
    const proxyPort=await listen(upstream);
    origin=http.createServer((_req,res)=>{directContacts++;res.end('must-not-connect-directly');});const targetPort=await listen(origin);
    proxy=await startVncProxy({server:`https://127.0.0.1:${proxyPort}`},fixtureOptions);
    assert.equal((await get(proxy.server,`http://fixture.test:${targetPort}/synthetic`)).status,502);
    const tunnel=await connect(proxy.server,`fixture.test:${targetPort}`);client=tunnel.socket;
    assert.match(tunnel.response,/^HTTP\/1.1 502/);
    assert.equal(proxyRequests,0);assert.equal(directContacts,0);
  }finally{client?.destroy();await proxy?.close();if(upstream)await close(upstream);if(origin)await close(origin);await rm(root,{recursive:true,force:true});}
});
