/** Real headless Chrome + local route fulfillment only. Never contacts or submits to Google. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { GoogleAutofill } from '../../apps/browser-agent/dist/google-autofill.js';

const email='autofill-fixture@example.test';
const other='other-fixture@example.test';
const password='synthetic-password-never-google';
const base='https://accounts.google.com';
const helper=new GoogleAutofill();
let browser,stage='setup',cases=0,fulfilled=0;
const expect=(condition)=>assert.ok(condition,'fixture check failed');
const style='<style>body{font:16px sans-serif;padding:30px}input,button,[data-identifier],#profileIdentifier{display:block;margin:14px;width:340px;min-height:32px}</style>';
const passwordCounters='window.passwordNext=0;window.submissions=0;document.querySelector("#passwordNext button").onclick=()=>window.passwordNext++;document.querySelector("form").onsubmit=e=>{e.preventDefault();window.submissions++;};';
const passwordMarkup=(scenario)=>{
  let chip='<div id="profileIdentifier">'+email+'</div>';
  if(scenario==='chip')chip='<div data-identifier="'+email+'">'+email+'</div>';
  if(scenario==='mismatch')chip='<div id="profileIdentifier">'+other+'</div>';
  if(scenario==='ambiguous')chip='<div data-identifier="'+email+'">'+email+'</div><div data-identifier="'+other+'">'+other+'</div>';
  if(scenario==='missing')chip='';
  if(scenario==='hidden-chip')chip='<div id="profileIdentifier" style="display:none">'+email+'</div>';
  if(scenario==='new-attempt')chip='<div id="profileIdentifier">'+other+'</div>';
  const field='<input name="Passwd" type="password"'+(scenario==='hidden-field'?' style="display:none"':'')+'>';
  if(scenario==='iframe')return style+'<iframe src="'+base+'/fixture-frame"></iframe>';
  return style+chip+'<form>'+field+'<div id="passwordNext"><button type="button">Password Next</button></div></form>';
};
const passwordPage=(scenario)=>passwordMarkup(scenario)+(scenario==='iframe'?'':'<script>'+passwordCounters+'</script>');
const identifier=(scenario)=>{
  const nextAction=scenario==='stuck'?'':scenario==='spa'
    ? `history.pushState({},'', '/v3/signin/challenge/pwd?fixture=spa');document.body.innerHTML=${JSON.stringify(passwordMarkup('normal'))};${passwordCounters}`
    : `location.assign('/v3/signin/challenge/pwd?fixture=${scenario}')`;
  return `${style}<form><input id="identifierId" name="identifier" type="email"><div id="identifierNext"><button type="button">Next</button></div></form><script>window.emailNext=0;window.identifierSubmissions=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.identifierSubmissions++;};document.querySelector('#identifierNext button').onclick=()=>{window.emailNext++;${nextAction}};</script>`;
};
try{
  expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED!=='0');
  browser=await chromium.launch({executablePath:process.env.FLEET_QA_CHROME||'/opt/chrome-fleet/.tools/ui-chrome/chrome-linux64/chrome',headless:true});
  const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    const scenario=url.searchParams.get('fixture')||'normal';
    if(!['accounts.google.com','accounts.google.com.evil.test'].includes(url.hostname)){await route.abort();return;}
    let body;
    if(url.pathname==='/v3/signin/identifier')body=identifier(scenario);
    else if(url.pathname==='/v3/signin/challenge/pwd')body=passwordPage(scenario);
    else if(url.pathname==='/v3/signin/challenge/totp')body=style+'<div id="profileIdentifier">'+email+'</div><input name="Passwd" type="password"><input autocomplete="one-time-code">';
    else if(url.pathname==='/AccountChooser')body=style+'<button data-identifier="'+email+'">'+email+'</button>';
    else if(url.pathname==='/fixture-frame')body=passwordPage('normal');
    else{await route.abort();return;}
    fulfilled++;await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body,headers:{'cache-control':'no-store'}});
  });
  const page=await context.newPage();
  stage='human_next_cross_document_navigation';
  await page.goto(base+'/v3/signin/identifier?fixture=normal');
  expect((await helper.fill(page,email,password,()=>{})).stage==='email_filled');
  expect(await page.locator('#identifierId').evaluate((input,value)=>input.value===value,email));
  for(let index=0;index<4;index++)expect((await helper.fill(page,email,password,()=>{})).stage==='email_filled');
  expect(await page.evaluate(()=>window.emailNext===0&&window.identifierSubmissions===0));
  expect(page.url().includes('/v3/signin/identifier?'));
  await page.evaluate(()=>{window.fixtureDocumentMarker='before-navigation';});
  // Explicit test action stands for the human's click; the Agent only fills inputs.
  await page.locator('#identifierNext button').click();
  await page.waitForURL('**/v3/signin/challenge/pwd?fixture=normal');
  expect(!page.isClosed());
  expect(await page.evaluate(()=>window.fixtureDocumentMarker===undefined));
  expect((await helper.fill(page,email,password,()=>{})).stage==='password_filled');
  expect(await page.locator('input[name=Passwd]').evaluate((input,value)=>input.value===value,password));
  await page.locator('input[name=Passwd]').evaluate(input=>{input.value='manual-edit';});
  expect((await helper.fill(page,email,'replacement-not-used',()=>{})).stage==='password_filled');
  expect(await page.locator('input[name=Passwd]').evaluate(input=>input.value==='manual-edit'));
  expect(await page.evaluate(()=>window.passwordNext===0&&window.submissions===0));cases++;
  stage='identifier_poll_never_clicks_next';
  const stuck=await context.newPage();await stuck.goto(base+'/v3/signin/identifier?fixture=stuck');
  expect((await helper.fill(stuck,email,password,()=>{})).stage==='email_filled');
  for(let index=0;index<4;index++)expect((await helper.fill(stuck,email,password,()=>{})).stage==='email_filled');
  expect(await stuck.evaluate(()=>window.emailNext===0&&window.identifierSubmissions===0));cases++;
  stage='human_next_spa_navigation';
  const spa=await context.newPage();await spa.goto(base+'/v3/signin/identifier?fixture=spa');
  for(let index=0;index<5;index++)expect((await helper.fill(spa,email,password,()=>{})).stage==='email_filled');
  expect(await spa.evaluate(()=>window.emailNext===0&&window.identifierSubmissions===0));
  await spa.evaluate(()=>{window.fixtureDocumentMarker='same-document';});
  await spa.locator('#identifierNext button').click();
  await spa.waitForURL('**/v3/signin/challenge/pwd?fixture=spa');
  expect(await spa.evaluate(()=>window.emailNext===1&&window.fixtureDocumentMarker==='same-document'));
  expect((await helper.fill(spa,email,password,()=>{})).stage==='password_filled');
  expect(await spa.locator('input[name=Passwd]').evaluate((input,value)=>input.value===value,password));
  expect(await spa.evaluate(()=>window.passwordNext===0&&window.submissions===0));cases++;
  stage='preserve_human_identifier';
  const typed=await context.newPage();await typed.goto(base+'/v3/signin/identifier?fixture=stuck');
  await typed.locator('#identifierId').fill(other);
  expect((await helper.fill(typed,email,password,()=>{})).stage==='account_mismatch');
  expect(await typed.evaluate(value=>document.querySelector('#identifierId').value===value&&window.emailNext===0,other));cases++;
  for(const [scenario,expected]of [['chip','password_filled'],['mismatch','account_mismatch'],['ambiguous','account_mismatch'],['missing','manual_required'],['hidden-chip','manual_required'],['hidden-field','manual_required'],['iframe','manual_required']]){
    stage='password_evidence_'+scenario;
    const candidate=await context.newPage();await candidate.goto(base+'/v3/signin/challenge/pwd?fixture='+scenario+'&login_hint='+encodeURIComponent(email));
    expect((await helper.fill(candidate,email,password,()=>{})).stage===expected);
    if(expected!=='password_filled')expect(await candidate.locator('input[name=Passwd]').evaluateAll(inputs=>inputs.every(input=>input.value==='')));
    if(scenario==='iframe')expect(await candidate.frames()[1].locator('input[name=Passwd]').evaluate(input=>input.value===''));
    cases++;
  }
  stage='preserve_human_password';
  const typedPassword=await context.newPage();await typedPassword.goto(base+'/v3/signin/challenge/pwd?fixture=normal');
  await typedPassword.locator('input[name=Passwd]').fill('human-password');
  expect((await helper.fill(typedPassword,email,password,()=>{})).stage==='manual_required');
  expect(await typedPassword.locator('input[name=Passwd]').evaluate(input=>input.value==='human-password'));cases++;
  for(const url of [base+'/v3/signin/challenge/totp',base+'/AccountChooser','https://accounts.google.com.evil.test/v3/signin/identifier','http://accounts.google.com/v3/signin/identifier']){
    stage='deny_challenge_chooser_or_origin';
    const denied=await context.newPage();await denied.goto(url);
    expect(['manual_required','unsupported'].includes((await helper.fill(denied,email,password,()=>{})).stage));
    expect(await denied.locator('input').evaluateAll(inputs=>inputs.every(input=>input.value==='')));cases++;
  }
  stage='new_page_new_attempt';
  const next=await context.newPage();await next.goto(base+'/v3/signin/challenge/pwd?fixture=new-attempt');
  expect((await helper.fill(next,other,password,()=>{})).stage==='password_filled');cases++;
  stage='fence_before_write';
  const fenced=await context.newPage();await fenced.goto(base+'/v3/signin/challenge/pwd?fixture=normal');
  let checks=0,revoked=false;
  try{await helper.fill(fenced,email,password,()=>{if(++checks>=2)throw new Error('revoked');});}catch{revoked=true;}
  expect(revoked);expect(await fenced.locator('input[name=Passwd]').evaluate(input=>input.value===''));cases++;
  console.log(`PASS: realChromeFixtureCases=${cases}, locallyFulfilledDocuments=${fulfilled}, identifierPollClicks=0, passwordSubmissions=0, realGoogleRequests=0`);
}catch{
  console.error(`FAIL: stage=${stage} code=FIXTURE_CHECK_FAILED`);process.exitCode=1;
}finally{await browser?.close();}
