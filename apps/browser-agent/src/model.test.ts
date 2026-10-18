import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentError, FenceGate, parseCookies, StepSchema } from './model.js';

test('fencing advances immediately, drains prior holder, and rejects stale writes',async()=>{
  const gate=new FenceGate();await gate.advance(1);
  let unblock!:()=>void;const blocked=new Promise<void>(done=>{unblock=done;});let oldStopped=false;
  const old=gate.run(1,async()=>{await blocked;assert.throws(()=>gate.assert(1),(e:unknown)=>e instanceof AgentError&&e.code==='FENCE_STALE');oldStopped=true;});
  // run yields while checking an earlier fencing advance.
  await new Promise(done=>setImmediate(done));
  let advanced=false;const takeover=gate.advance(2).then(()=>{advanced=true;});
  assert.equal(gate.token,2);assert.equal(advanced,false);assert.equal(oldStopped,false);
  await assert.rejects(gate.run(1,async()=>true));
  unblock();await Promise.all([old,takeover]);assert.equal(oldStopped,true);assert.equal(advanced,true);
  assert.equal(await gate.run(2,async()=>42),42);
});
test('concurrent calls cannot mutate one persistent profile',async()=>{
  const gate=new FenceGate();await gate.advance(7);let done!:()=>void;
  const first=gate.run(7,()=>new Promise<void>(r=>{done=r;}));await new Promise(r=>setImmediate(r));
  await assert.rejects(gate.run(7,async()=>true),(e:unknown)=>e instanceof AgentError&&e.code==='PROFILE_BUSY');done();await first;
});
test('Cookie round trip preserves HttpOnly, session expiry and partition fields',()=>{
  const cookies=[{name:'partitioned',value:'fixture',domain:'example.test',path:'/',expires:-1,httpOnly:true,secure:true,sameSite:'None',partitionKey:'https://top.example',_crHasCrossSiteAncestor:true}];
  assert.deepEqual(parseCookies({format:'chrome-fleet.cookies',version:1,cookies}),cookies);
  assert.throws(()=>parseCookies({...{cookies},version:99}));
  assert.throws(()=>parseCookies([{...cookies[0],unexpected:'must not silently drop'}]));
});
test('arbitrary evaluation and host upload paths are excluded from declarative steps',()=>{
  assert.equal(StepSchema.safeParse({action:'eval',expression:'process.exit()'}).success,false);
  assert.equal(StepSchema.safeParse({action:'upload',path:'/etc/passwd'}).success,false);
  assert.equal(StepSchema.safeParse({action:'click',locator:{css:'#x',text:'ambiguous'}}).success,false);
});
