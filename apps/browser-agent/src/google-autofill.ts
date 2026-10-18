import type { Page } from 'playwright';
import { createHash } from 'node:crypto';

export type GoogleAutofillStage = 'waiting'|'email_filled'|'password_filled'|'manual_required'|'account_mismatch'|'unsupported';
export type GoogleAutofillResult = {stage:GoogleAutofillStage;message:string};
export interface GoogleAutofillEvidence {
  url:string; identifierCount:number; passwordCount:number;
  identifierValue:'empty'|'expected'|'other'; passwordEmpty:boolean;
  identity:'match'|'mismatch'|'ambiguous'|'missing'; challenge:boolean; chooser:boolean;
}
const messages:Record<GoogleAutofillStage,string> = {
  waiting:'正在等待 Google 登录页面就绪，请稍候',
  email_filled:'邮箱已填好，请在桌面手动点击下一步；进入密码页后才会自动填写密码',
  password_filled:'本次密码填写已完成，请在桌面确认后手动提交；验证码和二次验证由你完成',
  manual_required:'此步骤需要人工操作，请在桌面继续；不会自动提交密码或处理验证',
  account_mismatch:'页面账号与所选账号不一致或存在歧义，已停止自动填写，请重新打开目标账号登录',
  unsupported:'当前不是支持的 Google 顶层登录页面，请通过 Google 登录入口重新打开',
};
const result=(stage:GoogleAutofillStage):GoogleAutofillResult=>({stage,message:messages[stage]});
const identifierPaths=new Set(['/ServiceLogin','/signin/identifier','/v2/identifier','/v2/signin/identifier','/v3/signin/identifier','/signin/v2/identifier','/signin/v3/identifier']);
const passwordPaths=new Set(['/signin/challenge/pwd','/v2/signin/challenge/pwd','/v3/signin/challenge/pwd','/signin/v2/challenge/pwd','/signin/v3/challenge/pwd']);
export function googleAutofillPageKind(raw:string):'identifier'|'password'|'manual'|'waiting'|'unsupported' {
  if(raw==='about:blank')return 'waiting';
  let url:URL;try{url=new URL(raw);}catch{return 'unsupported';}
  if(url.origin!=='https://accounts.google.com'||url.username||url.password)return 'unsupported';
  if(identifierPaths.has(url.pathname))return 'identifier';
  if(passwordPaths.has(url.pathname))return 'password';
  if(/(?:^|\/)(?:challenge|AccountChooser|accountchooser|recovery|signinchooser)(?:\/|$)/i.test(url.pathname))return 'manual';
  return 'unsupported';
}
export function googleAutofillDecision(evidence:GoogleAutofillEvidence):'identifier'|'password'|GoogleAutofillStage {
  const kind=googleAutofillPageKind(evidence.url);
  if(kind==='waiting'||kind==='unsupported')return kind;
  if(kind==='manual'||evidence.challenge||evidence.chooser)return 'manual_required';
  if(evidence.identifierCount>1||evidence.passwordCount>1)return 'manual_required';
  if(kind==='password'){
    if(evidence.identity==='mismatch'||evidence.identity==='ambiguous')return 'account_mismatch';
    if(evidence.identity!=='match'||evidence.passwordCount!==1||!evidence.passwordEmpty)return 'manual_required';
    return 'password';
  }
  if(evidence.passwordCount)return 'manual_required';
  if(evidence.identifierCount===0)return 'waiting';
  if(evidence.identifierValue==='other')return 'account_mismatch';
  return 'identifier';
}

type DomAction='fill_email'|'fill_password';
interface DomArguments {email:string;action?:DomAction;password?:string;expectedUrl?:string}
interface DomResult {evidence:GoogleAutofillEvidence;performed?:boolean}
/** Fixed, internal DOM program. A write and all its guards run in one renderer task. */
function googleAutofillDom(args:DomArguments):DomResult {
  const visible=(element:Element)=>{
    if(element.getClientRects().length===0||element.closest('[hidden],[aria-hidden="true"]'))return false;
    for(let current:Element|null=element;current;current=current.parentElement){const style=getComputedStyle(current);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return false;}
    const bounds=element.getBoundingClientRect(),x=bounds.x+bounds.width/2,y=bounds.y+bounds.height/2;
    if(x<0||y<0||x>=innerWidth||y>=innerHeight)return false;
    const hit=document.elementFromPoint(x,y);return !!hit&&(element===hit||element.contains(hit));
  };
  const inputs=(selector:string)=>Array.from(document.querySelectorAll<HTMLInputElement>(selector)).filter(input=>visible(input)&&!input.disabled&&!input.readOnly);
  const identifiers=inputs('input#identifierId,input[name="identifier"]').filter(input=>['email','text'].includes(input.type));
  const passwords=inputs('input[name="Passwd"]').filter(input=>input.type==='password');
  const challenge=Array.from(document.querySelectorAll('input[autocomplete="one-time-code"],input[name="totpPin"],input[name="idvPin"],input[name="Pin"],input[name="knowledgePreregisteredEmailResponse"],input[name="knowledgePreregisteredPhoneResponse"],iframe[src*="recaptcha"],iframe[src*="hcaptcha"],#captchaimg')).some(visible);
  const chipElements=Array.from(document.querySelectorAll('#profileIdentifier,#identifierLink,[data-identifier]')).filter(visible).slice(0,30);
  const labels=chipElements.flatMap(element=>[element.textContent??'',element.getAttribute('aria-label')??'',element.getAttribute('data-identifier')??'',element.getAttribute('data-email')??'']);
  const form=passwords.length===1?passwords[0]!.closest('form'):null;
  if(form)for(const element of Array.from(form.querySelectorAll<HTMLInputElement>('input[name="identifier"]')))labels.push(element.value);
  const candidates=new Set<string>();let ambiguous=false;
  const emailPattern=/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+$/i;
  for(const label of labels){if(label.length>4096){ambiguous=true;continue;}for(const token of label.match(/[^\s()<>,;：:]+@[^\s()<>,;：:]+/gu)??[]){if(token.length>254||token.split('@')[0]!.length>64||!emailPattern.test(token))ambiguous=true;else candidates.add(token.toLowerCase());}}
  const identity=ambiguous||candidates.size>1?'ambiguous':candidates.size===0?'missing':candidates.has(args.email)?'match':'mismatch';
  const passwordPage=/(?:^|\/)challenge\/pwd$/.test(location.pathname);
  const chooser=/AccountChooser|accountchooser|signinchooser/.test(location.pathname)||(!passwordPage&&identifiers.length===0&&chipElements.some(element=>element.hasAttribute('data-identifier')));
  const evidence:GoogleAutofillEvidence={url:location.href,identifierCount:identifiers.length,passwordCount:passwords.length,identifierValue:!identifiers[0]?.value?'empty':identifiers[0]!.value.trim().toLowerCase()===args.email?'expected':'other',passwordEmpty:passwords.length===1&&passwords[0]!.value==='',identity,challenge,chooser};
  if(!args.action)return{evidence};
  if(location.origin!=='https://accounts.google.com'||location.href!==args.expectedUrl||challenge||chooser)return{evidence,performed:false};
  const assign=(input:HTMLInputElement,value:string)=>{
    if(input.value!=='')return false;
    input.focus();if(input.value!=='')return false;
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;if(!setter)return false;
    setter.call(input,value);
    input.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:null}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  };
  if(args.action==='fill_email'&&identifiers.length===1&&passwords.length===0&&evidence.identifierValue==='empty')return{evidence,performed:assign(identifiers[0]!,args.email)};
  if(args.action==='fill_password'&&passwords.length===1&&identity==='match'&&evidence.passwordEmpty&&typeof args.password==='string')return{evidence,performed:assign(passwords[0]!,args.password)};
  return{evidence,performed:false};
}

interface Attempt {identityHash:string;emailAttempted:boolean;emailReady:boolean;passwordAttempted:boolean;terminal?:GoogleAutofillStage}
export class GoogleAutofill {
  private attempts=new WeakMap<Page,Attempt>();
  private async dom(page:Page,args:DomArguments) {
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([page.evaluate(googleAutofillDom,args),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('AUTOFILL_TIMEOUT')),1500);})]);}
    catch(error){
      // A delayed renderer action must never run after the gate has been released.
      if(args.action&&error instanceof Error&&error.message==='AUTOFILL_TIMEOUT')await page.close({runBeforeUnload:false}).catch(()=>undefined);
      throw error;
    }finally{if(timer)clearTimeout(timer);args.password=undefined;}
  }
  async fill(page:Page|undefined,email:string,password:string,assertLease:()=>void):Promise<GoogleAutofillResult>{
    const expected=email.trim().toLowerCase();
    if(!page||page.isClosed())return result('manual_required');
    if(!/^[\x21-\x7e]+@[^@]+\.[^@]+$/.test(expected))return result('unsupported');
    const identityHash=createHash('sha256').update(expected).digest('hex');
    let attempt=this.attempts.get(page);
    if(!attempt){attempt={identityHash,emailAttempted:false,emailReady:false,passwordAttempted:false};this.attempts.set(page,attempt);}
    if(attempt.identityHash!==identityHash)return result('account_mismatch');
    if(attempt.terminal)return result(attempt.terminal);
    try{
      assertLease();
      const before=page.url();
      const initialKind=googleAutofillPageKind(before);
      if(initialKind==='unsupported')return result('unsupported');
      if(initialKind==='waiting')return result('waiting');
      if(initialKind==='manual'){attempt.terminal='manual_required';return result('manual_required');}
      const snapshot=await this.dom(page,{email:expected});
      if(snapshot.evidence.url!==before||page.url()!==before)return result('waiting');
      const decision=googleAutofillDecision(snapshot.evidence);
      if(decision!=='identifier'&&decision!=='password'){
        if(['manual_required','account_mismatch'].includes(decision))attempt.terminal=decision;
        return result(decision);
      }
      if(decision==='password'){
        if(attempt.passwordAttempted)return result('manual_required');
        assertLease();attempt.passwordAttempted=true;
        const applied=await this.dom(page,{email:expected,password,action:'fill_password',expectedUrl:before});
        attempt.terminal=applied.performed?'password_filled':'manual_required';
        return result(attempt.terminal);
      }
      if(!attempt.emailReady){
        if(snapshot.evidence.identifierValue==='expected'){attempt.emailReady=true;return result('email_filled');}
        if(attempt.emailAttempted){attempt.terminal='manual_required';return result('manual_required');}
        assertLease();attempt.emailAttempted=true;
        const applied=await this.dom(page,{email:expected,action:'fill_email',expectedUrl:before});
        if(!applied.performed){attempt.terminal='manual_required';return result('manual_required');}
        attempt.emailReady=true;return result('email_filled');
      }
      return result('email_filled');
    }catch{
      // Never propagate Playwright call logs, filled values, URLs or renderer HTML.
      assertLease();
      attempt.terminal='manual_required';return result('manual_required');
    }finally{password='';}
  }
}
