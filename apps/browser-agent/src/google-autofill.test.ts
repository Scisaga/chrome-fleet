import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { GoogleAutofill, googleAutofillDecision, googleAutofillPageKind, type GoogleAutofillEvidence } from './google-autofill.js';

const evidence=(changes:Partial<GoogleAutofillEvidence>={}):GoogleAutofillEvidence=>({url:'https://accounts.google.com/v3/signin/challenge/pwd',identifierCount:0,passwordCount:1,identifierValue:'empty',passwordEmpty:true,identity:'match',challenge:false,chooser:false,...changes});
test('Google autofill accepts only exact HTTPS login endpoints and treats non-password challenges as manual',()=>{
  for(const url of ['http://accounts.google.com/v3/signin/identifier','https://accounts.google.com.evil.test/v3/signin/identifier','https://user@accounts.google.com/v3/signin/identifier','https://accounts.google.com:444/v3/signin/identifier','https://accounts.google.com/signup','https://myaccount.google.com/'])assert.equal(googleAutofillPageKind(url),'unsupported');
  assert.equal(googleAutofillPageKind('https://accounts.google.com/v3/signin/identifier'),'identifier');
  assert.equal(googleAutofillPageKind('https://accounts.google.com/v3/signin/challenge/pwd'),'password');
  assert.equal(googleAutofillPageKind('https://accounts.google.com/v3/signin/challenge/totp'),'manual');
  assert.equal(googleAutofillPageKind('https://accounts.google.com/AccountChooser'),'manual');
});
test('password permission requires one empty field and unambiguous DOM-associated expected identity',()=>{
  assert.equal(googleAutofillDecision(evidence()),'password');
  for(const value of [evidence({passwordEmpty:false}),evidence({identity:'missing'}),evidence({passwordCount:2}),evidence({passwordCount:0}),evidence({challenge:true}),evidence({chooser:true})])assert.equal(googleAutofillDecision(value),'manual_required');
  for(const identity of ['mismatch','ambiguous'] as const)assert.equal(googleAutofillDecision(evidence({identity})),'account_mismatch');
  assert.equal(googleAutofillDecision(evidence({url:'https://accounts.google.com/v3/signin/challenge/pwd?login_hint=expected@example.test',identity:'missing'})),'manual_required');
  assert.equal(googleAutofillDecision(evidence({url:'https://evil.test/',challenge:true})),'unsupported');
});
test('identifier decision never authorizes a different existing value or mixed password/chooser form',()=>{
  const identifier=evidence({url:'https://accounts.google.com/v3/signin/identifier',identifierCount:1,passwordCount:0});
  assert.equal(googleAutofillDecision(identifier),'identifier');
  assert.equal(googleAutofillDecision({...identifier,identifierValue:'other'}),'account_mismatch');
  assert.equal(googleAutofillDecision({...identifier,passwordCount:1}),'manual_required');
  assert.equal(googleAutofillDecision({...identifier,chooser:true}),'manual_required');
});
test('identifier polling fills once and waits for a human transition before the password write',async()=>{
  let current=evidence({url:'https://accounts.google.com/v3/signin/identifier',identifierCount:1,passwordCount:0});
  const actions:string[]=[];
  const page={isClosed:()=>false,url:()=>current.url,evaluate:async(_program:unknown,args:{action?:string})=>{
    if(args.action){actions.push(args.action);if(args.action==='fill_email')current={...current,identifierValue:'expected'};}
    return{evidence:current,performed:true};
  }} as unknown as Page;
  const helper=new GoogleAutofill();
  for(let index=0;index<5;index++)assert.equal((await helper.fill(page,'expected@example.test','synthetic-secret',()=>{})).stage,'email_filled');
  assert.deepEqual(actions,['fill_email']);
  current=evidence(); // Only the human's navigation changes the visible page.
  assert.equal((await helper.fill(page,'expected@example.test','synthetic-secret',()=>{})).stage,'password_filled');
  assert.deepEqual(actions,['fill_email','fill_password']);
});
test('the email write rechecks the fence and does not begin after revocation',async()=>{
  const identifier=evidence({url:'https://accounts.google.com/v3/signin/identifier',identifierCount:1,passwordCount:0});
  let writes=0,checks=0;
  const page={isClosed:()=>false,url:()=>identifier.url,evaluate:async(_program:unknown,args:{action?:string})=>{if(args.action)writes++;return{evidence:identifier};}} as unknown as Page;
  const error=Object.assign(new Error('lease revoked'),{code:'FENCE_STALE'});
  await assert.rejects(new GoogleAutofill().fill(page,'expected@example.test','synthetic-secret',()=>{if(++checks>=2)throw error;}),{code:'FENCE_STALE'});
  assert.equal(writes,0);
});
test('fence is rechecked immediately before password write and the pending renderer never receives it after revocation',async()=>{
  const calls:unknown[]=[];
  const page={isClosed:()=>false,url:()=>evidence().url,evaluate:async(_program:unknown,args:unknown)=>{calls.push(args);return{evidence:evidence()};}} as unknown as Page;
  let checks=0;
  const error=Object.assign(new Error('lease revoked'),{code:'FENCE_STALE'});
  await assert.rejects(new GoogleAutofill().fill(page,'expected@example.test','synthetic-secret',()=>{if(++checks>=2)throw error;}),{code:'FENCE_STALE'});
  assert.equal(calls.length,1);
  assert.equal(JSON.stringify(calls).includes('synthetic-secret'),false);
});
test('one page attempt is bound to one expected identity and a successful password fill is never repeated',async()=>{
  let writes=0;
  const page={isClosed:()=>false,url:()=>evidence().url,evaluate:async(_program:unknown,args:{action?:string})=>{if(args.action)writes++;return{evidence:evidence(),performed:true};}} as unknown as Page;
  const helper=new GoogleAutofill();
  assert.equal((await helper.fill(page,'expected@example.test','synthetic-secret',()=>{})).stage,'password_filled');
  assert.equal((await helper.fill(page,'expected@example.test','different-secret',()=>{})).stage,'password_filled');
  assert.equal((await helper.fill(page,'other@example.test','different-secret',()=>{})).stage,'account_mismatch');
  assert.equal(writes,1);
});
