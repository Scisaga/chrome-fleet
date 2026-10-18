import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualAgent } from './manual-agent.js';
import { AgentError } from './model.js';

const authToken='synthetic-agent-token-with-at-least-32-characters';
const headers={authorization:`Bearer ${authToken}`};
function fixture(){
  let closes=0,proxyCloses=0;
  const browser={running:true,version:'155.0.8059.79',ready:async()=>true,close:async()=>{closes++;browser.running=false;}};
  const agent=createManualAgent({authToken,browser,proxyVersion:3,playwrightVersion:'1.64.1',keyringHealth:async()=>({backend:'gnome-libsecret',available:true,unlocked:true,probeVerified:true}),desktopReady:async()=>true,closeProxy:async()=>{proxyCloses++;},reloadVnc:async()=>{}});
  return{...agent,browser,closes:()=>closes,proxyCloses:()=>proxyCloses};
}
test('VNC health explicitly reports unavailable automation and rejects all browser inspection or mutation routes',async()=>{
  const state=fixture();
  try{
    assert.equal((await state.app.inject({method:'GET',url:'/health'})).statusCode,401);
    const health=(await state.app.inject({method:'GET',url:'/health',headers})).json();
    assert.equal(health.browserMode,'vnc');assert.equal(health.automationAvailable,false);assert.equal(health.ready,true);assert.equal(health.pages,0);assert.equal(health.activeDownloads,null);
    for(const url of ['/execute','/cancel','/self-test','/cookies/export','/cookies/import','/storage-state/export','/storage-state/import','/accounts/google-identity','/accounts/google-login','/accounts/google-autofill','/accounts/check','/proxy/test']){
      const response=await state.app.inject({method:'POST',url,headers,payload:{fencingToken:1}});
      assert.equal(response.statusCode,409);assert.equal(response.json().code,'VNC_MODE_UNSUPPORTED');
    }
    assert.equal(state.closes(),0);
  }finally{await state.app.close();}
});
test('shutdown is fenced and closes the network relay only after confirmed normal browser exit',async()=>{
  const state=fixture();
  try{
    assert.equal((await state.app.inject({method:'POST',url:'/shutdown',headers,payload:{fencingToken:1}})).statusCode,409);
    await state.app.inject({method:'POST',url:'/fence',headers,payload:{token:2}});
    assert.equal((await state.app.inject({method:'POST',url:'/shutdown',headers,payload:{fencingToken:1}})).json().code,'FENCE_STALE');
    state.browser.close=async()=>{throw new AgentError('NATIVE_BROWSER_CLOSE_TIMEOUT','合成关闭超时',409);};
    assert.equal((await state.app.inject({method:'POST',url:'/shutdown',headers,payload:{fencingToken:2}})).json().code,'NATIVE_BROWSER_CLOSE_TIMEOUT');
    assert.equal(state.proxyCloses(),0);assert.equal(state.browser.running,true);
    state.browser.close=async()=>{state.browser.running=false;};
    assert.equal((await state.app.inject({method:'POST',url:'/shutdown',headers,payload:{fencingToken:2}})).json().stopped,true);
    assert.equal(state.proxyCloses(),1);
    assert.equal((await state.app.inject({method:'GET',url:'/health',headers})).json().healthy,false);
  }finally{await state.app.close();}
});
test('fence revocation drains clipboard transfer without closing the manual browser or returning old clipboard text',async()=>{
  let release!:()=>void,started!:()=>void;
  const transferring=new Promise<void>(done=>{started=done;}),blocked=new Promise<void>(done=>{release=done;});
  let closed=false;
  const agent=createManualAgent({authToken,browser:{running:true,version:'155.0.8059.79',ready:async()=>true,close:async()=>{closed=true;}},proxyVersion:0,playwrightVersion:'1.64.1',keyringHealth:async()=>({}),desktopReady:async()=>true,closeProxy:async()=>{},
    clipboard:{read:async assertLease=>{assertLease();started();await blocked;assertLease();return{text:'must not be returned after revocation'};},write:async(_text,assertLease)=>{assertLease();return{written:true};}}});
  try{
    await agent.app.inject({method:'POST',url:'/fence',headers,payload:{token:1}});
    const read=agent.app.inject({method:'POST',url:'/desktop/clipboard',headers,payload:{fencingToken:1,action:'read'}});
    void read.then(()=>undefined);await transferring;
    const advance=agent.gate.advance(2);release();await advance;
    const response=await read;assert.equal(response.json().code,'FENCE_STALE');assert.equal(response.body.includes('must not be returned'),false);assert.equal(closed,false);
  }finally{await agent.app.close();}
});
