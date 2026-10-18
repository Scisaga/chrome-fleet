import test from 'node:test';
import assert from 'node:assert/strict';
import { googleIdentityFromEvidence, readGoogleIdentityEvidence, type GooglePageEvidence, type GoogleAvatarEvidence } from './google-identity.js';

const avatar=(label='Google Account: Example (owner@example.com)'):GoogleAvatarEvidence=>({kind:'anchor',inHeader:true,visible:true,ariaLabel:label,href:'https://accounts.google.com/SignOutOptions?hl=en'});
const page=(label?:string,url='https://myaccount.google.com/'):GooglePageEvidence=>({url,avatars:[avatar(label)]});
const detect=(...pages:GooglePageEvidence[])=>googleIdentityFromEvidence(pages);

test('Google account header requires an explicit authenticated marker and extracts only the email',()=>{
  assert.deepEqual(detect(page()),{status:'authenticated',identity:'owner@example.com'});
  assert.deepEqual(detect(page('Google 帐号：测试用户\n(Owner@Example.com)')),{status:'authenticated',identity:'owner@example.com'});
  assert.deepEqual(detect(page('Google 账号：测试用户 (user@work.example)')),{status:'authenticated',identity:'user@work.example'});
  const titled=avatar();delete titled.ariaLabel;titled.title='Google Account: Name (title@example.com)';
  assert.deepEqual(detect({url:'https://mail.google.com/mail/u/0/',avatars:[titled]}),{status:'authenticated',identity:'title@example.com'});
  const result=detect(page('Google Account: Very private name (owner@example.com)'));
  assert.equal(JSON.stringify(result).includes('Very private'),false);
});

test('remembered accounts, chooser entries and sign-in URL hints never prove authentication',()=>{
  for(const url of [
    'https://accounts.google.com/AccountChooser?Email=owner@example.com',
    'https://accounts.google.com/v3/signin/identifier?login_hint=owner@example.com',
    'https://accounts.google.com/ServiceLogin',
  ])assert.equal(detect(page(undefined,url)).status,'needs_login');
  for(const url of ['https://www.google.com/?login_hint=owner@example.com','https://myaccount.google.com/?Email=owner@example.com']){
    assert.equal(detect({url,avatars:[]}).status,'unknown');
  }
  assert.equal(detect({url:'https://myaccount.google.com/',avatars:[{...avatar(),ariaLabel:'owner@example.com',title:'Choose an account'}]}).status,'unknown');
  assert.equal(detect(page('Google Account: Sign in (owner@example.com)')).status,'unknown');
});

test('only exact trusted HTTPS Google service origins are eligible',()=>{
  for(const url of [
    'http://myaccount.google.com/',
    'https://myaccount.google.com.evil.test/',
    'https://evilgoogle.com/',
    'https://myaccount.google.com:8443/',
    'https://owner@example.test/',
    'https://owner@myaccount.google.com/',
    'https://sites.google.com/view/attacker-content',
    'https://example.googleusercontent.com/',
    'data:text/html,Google Account',
  ])assert.equal(detect(page(undefined,url)).status,'unknown',url);
});

test('hidden, non-header or unrelated-link labels cannot cause a binding',()=>{
  for(const change of [{visible:false},{inHeader:false},{href:'https://accounts.google.com/AccountChooser'},{href:'https://evil.test/'}]){
    assert.equal(detect({url:'https://myaccount.google.com/',avatars:[{...avatar(),...change}]}).status,'unknown');
  }
  assert.equal(detect({url:'https://myaccount.google.com/',avatars:[{...avatar(),kind:'button',href:undefined}]}).status,'authenticated');
});

test('different account emails in labels or tabs are ambiguous, with no identity in the output',()=>{
  const multiple=detect(page(),page('Google Account: Other (other@example.com)','https://mail.google.com/mail/u/1/'));
  assert.equal(multiple.status,'unknown');assert.equal(multiple.identity,undefined);
  assert.equal(detect(page('Google Account: owner@example.com and other@example.com')).status,'unknown');
  assert.equal(detect({url:'https://myaccount.google.com/',avatars:[{...avatar(),title:'Google Account: Other (other@example.com)'}]}).status,'unknown');
  assert.equal(detect(page(),page('Google Account: OWNER@EXAMPLE.COM')).status,'authenticated');
});

test('a qualified avatar rejects conflicting bare attributes and mixed unsupported email tokens',()=>{
  const conflicting=detect({url:'https://myaccount.google.com/',avatars:[{...avatar(),title:'other@example.com'}]});
  assert.equal(conflicting.status,'unknown');assert.equal(conflicting.identity,undefined);
  const mixed=detect(page('Google Account: owner@example.com (用户other@example.com)'));
  assert.equal(mixed.status,'unknown');assert.equal(mixed.identity,undefined);
});

test('verification, mixed login and unreadable trusted pages prevent automatic account selection',()=>{
  assert.equal(detect(page(undefined,'https://accounts.google.com/v3/signin/challenge/totp')).status,'needs_verification');
  assert.equal(detect({...page(),verificationVisible:true}).status,'needs_verification');
  assert.equal(detect(page(),{url:'https://accounts.google.com/AccountChooser',avatars:[]}).status,'unknown');
  assert.equal(detect(page(),{url:'https://mail.google.com/',avatars:[],unreadable:true}).status,'unknown');
  assert.equal(detect({url:'https://www.google.com/',avatars:[],signInVisible:true}).status,'needs_login');
});

test('email parsing refuses a truncated Unicode identity and unsupported labels',()=>{
  for(const label of ['Google Account: 用户owner@example.com','Other account: owner@example.com','Google Account: owner@localhost','Google Account: name only']){
    assert.equal(detect(page(label)).status,'unknown');
  }
});

test('page collector skips untrusted content and marks a navigation race unreadable',async()=>{
  let evaluated=false;
  const untrusted={url:()=> 'https://evil.test/',evaluate:async()=>{evaluated=true;return page();}};
  assert.equal(await readGoogleIdentityEvidence(untrusted as unknown as Parameters<typeof readGoogleIdentityEvidence>[0]),undefined);
  assert.equal(evaluated,false);
  let calls=0;
  const changing={url:()=>++calls===1?'https://myaccount.google.com/':'https://evil.test/',evaluate:async()=>page()};
  assert.equal((await readGoogleIdentityEvidence(changing as unknown as Parameters<typeof readGoogleIdentityEvidence>[0]))?.unreadable,true);
});

test('an unresponsive trusted renderer yields unknown without holding the polling gate indefinitely',async()=>{
  const unresponsive={url:()=> 'https://myaccount.google.com/',evaluate:()=>new Promise<never>(()=>{})};
  const began=Date.now();
  const evidence=await readGoogleIdentityEvidence(unresponsive as unknown as Parameters<typeof readGoogleIdentityEvidence>[0]);
  assert.equal(evidence?.unreadable,true);assert.equal(detect(evidence!).status,'unknown');
  assert.ok(Date.now()-began<3000);
});
