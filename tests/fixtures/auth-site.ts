/** Controlled acceptance site. Synthetic identities only; never connects to Google. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function createAuthSite() {
  const sessions = new Map<string, { identity: string; persistent: boolean }>();
  const counters = new Map<string, number>();
  const cookie = (request: IncomingMessage) => Object.fromEntries((request.headers.cookie ?? '').split(';').filter(v => v.includes('=')).map(v => { const at = v.indexOf('='); return [v.slice(0, at).trim(), decodeURIComponent(v.slice(at + 1))]; }));
  const json = (response: ServerResponse, code: number, value: unknown) => { response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.local');
    const sid = cookie(request).fixture_auth;
    const session = sid ? sessions.get(sid) : undefined;
    if (url.pathname === '/health') { json(response, 200, { ready: true }); return; }
    if (request.method === 'POST' && url.pathname === '/login') {
      const identity = url.searchParams.get('identity') ?? 'alice@example.test';
      if (!/^[a-zA-Z0-9._+@-]{1,100}$/.test(identity)) { json(response, 400, { code: 'INVALID_IDENTITY' }); return; }
      const persistent = url.searchParams.get('persistent') !== 'false';
      const token = randomBytes(24).toString('base64url'); sessions.set(token, { identity, persistent });
      response.setHeader('set-cookie', [`fixture_auth=${token}; HttpOnly; SameSite=Lax; Path=/${persistent ? '; Max-Age=86400' : ''}`, `fixture_session_marker=session-only; SameSite=Lax; Path=/`]);
      json(response, 200, { identity, persistent }); return;
    }
    if (request.method === 'POST' && url.pathname === '/revoke') {
      const identity = url.searchParams.get('identity');
      for (const [key, value] of sessions) if (!identity || value.identity === identity) sessions.delete(key);
      json(response, 200, { revoked: true }); return;
    }
    if (url.pathname === '/identity') { json(response, session ? 200 : 401, session ? { identity: session.identity, authenticated: true } : { authenticated: false, code: 'LOGIN_REQUIRED' }); return; }
    if (url.pathname === '/counter') {
      if (!session) { json(response, 401, { code: 'LOGIN_REQUIRED' }); return; }
      const count = counters.get(session.identity) ?? 0;
      if (request.method === 'POST') {
        counters.set(session.identity, count + 1);
        // Simulates an externally committed click followed by connection loss.
        if (url.searchParams.get('disconnect') === 'true') { response.socket?.destroy(); return; }
        json(response, 200, { count: count + 1 }); return;
      }
      json(response, 200, { count }); return;
    }
    if (url.pathname === '/' || url.pathname === '/app') {
      const safeIdentity = session?.identity ?? '';
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" });
      response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Chrome Fleet 合成账号验收站</title><body>
<h1>合成账号验收站</h1><p id="identity" data-authenticated="${!!session}">${safeIdentity || '未登录'}</p>
<form id="login"><label>测试身份<input name="identity" value="alice@example.test"></label><label>持久 Cookie<input name="persistent" type="checkbox" checked></label><button>登录</button></form>
<button id="logout">撤销服务器会话</button><button id="increment">计数加一</button><button id="disconnect">提交后断线</button><output id="count"></output>
<label>本地状态<input id="state-value" value="fixture-state"></label><button id="save-state">保存 localStorage 与 IndexedDB</button><output id="stored"></output>
<script>
const dbReady = new Promise((resolve,reject) => {const r=indexedDB.open('fleet-fixture',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
window.fixtureReadState=async()=>{const db=await dbReady;return new Promise((resolve,reject)=>{const r=db.transaction('state').objectStore('state').get('value');r.onsuccess=()=>resolve({localStorage:localStorage.getItem('fixture-state'),indexedDB:r.result});r.onerror=()=>reject(r.error);});};
document.querySelector('#login').onsubmit=async e=>{e.preventDefault();const form=new FormData(e.target);await fetch('/login?identity='+encodeURIComponent(form.get('identity'))+'&persistent='+String(form.has('persistent')),{method:'POST'});location.reload();};
document.querySelector('#logout').onclick=async()=>{await fetch('/revoke?identity='+encodeURIComponent(document.querySelector('#identity').textContent),{method:'POST'});location.reload();};
for(const [button,disconnect] of [['#increment',false],['#disconnect',true]])document.querySelector(button).onclick=async()=>{try{const r=await fetch('/counter?disconnect='+disconnect,{method:'POST'});document.querySelector('#count').textContent=JSON.stringify(await r.json());}catch{document.querySelector('#count').textContent='结果未知，请查询计数，不要再次点击';}};
document.querySelector('#save-state').onclick=async()=>{const value=document.querySelector('#state-value').value;localStorage.setItem('fixture-state',value);const db=await dbReady;await new Promise((resolve,reject)=>{const tx=db.transaction('state','readwrite');tx.objectStore('state').put(value,'value');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});document.querySelector('#stored').textContent=JSON.stringify(await window.fixtureReadState());};
</script></body></html>`); return;
    }
    json(response, 404, { code: 'NOT_FOUND' });
  });
  return { server, sessions, counters };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = createAuthSite();
  const host = process.env.FIXTURE_HOST ?? '127.0.0.1';
  const port = Number(process.env.FIXTURE_PORT ?? 8180);
  server.listen(port, host, () => process.stderr.write(`合成账号验收站：http://${host}:${port}\n`));
}
