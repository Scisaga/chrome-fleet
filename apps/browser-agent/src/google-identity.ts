import type { Page } from 'playwright';

/** Deliberately excludes user-published sites.google.com and Google-hosted arbitrary content. */
const identityHosts = new Set([
  'google.com','www.google.com','myaccount.google.com','mail.google.com','drive.google.com',
  'docs.google.com','calendar.google.com','photos.google.com','meet.google.com','contacts.google.com',
  'keep.google.com','maps.google.com','news.google.com','chat.google.com','gemini.google.com',
]);
export type GoogleIdentity = {
  status:'authenticated'|'needs_login'|'needs_verification'|'unknown';
  identity?:string;
  reason?:string;
};
export interface GoogleAvatarEvidence {
  kind:'button'|'anchor';
  inHeader:boolean;
  visible:boolean;
  ariaLabel?:string;
  title?:string;
  href?:string;
}
export interface GooglePageEvidence {
  /** Top-level URL captured with the DOM snapshot; query parameters never supply identity. */
  url:string;
  avatars:GoogleAvatarEvidence[];
  verificationVisible?:boolean;
  signInVisible?:boolean;
  unreadable?:boolean;
}

function trustedUrl(raw:string):URL|undefined {
  try {
    const url=new URL(raw);
    if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))return;
    if(url.hostname!=='accounts.google.com'&&!identityHosts.has(url.hostname))return;
    return url;
  }catch{return;}
}
export function isGoogleIdentityPage(raw:string){return !!trustedUrl(raw);}

const marker=/^(?:Google\s+Account|Google\s*账号|Google\s*帐号)\s*[:：]/iu;
const signedOut=/(?:\bsign(?:ed)?\s+(?:in|out)\b|\blog\s*in\b|登录|登入|已退出|未登录)/iu;
const email=/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+$/i;
function labelEmails(label:string):string[]|undefined {
  if(label.length>4096)return;
  // Tokenize before validating so a Unicode address cannot be truncated into an ASCII identity.
  const tokens=label.match(/[^\s()<>,;：:]+@[^\s()<>,;：:]+/gu)??[];
  if(tokens.some(value=>value.length>254||value.split('@')[0]!.length>64||!email.test(value)))return;
  return tokens.map(value=>value.toLowerCase());
}
function avatarTarget(href:string|undefined){
  if(!href)return false;
  const url=trustedUrl(href);if(!url)return false;
  return url.hostname==='myaccount.google.com'||(url.hostname==='accounts.google.com'&&/^\/SignOutOptions(?:\/|$)/i.test(url.pathname));
}

/** Pure decision function: no cookies, input values, data-email, URL identity hints or page body. */
export function googleIdentityFromEvidence(pages:readonly GooglePageEvidence[]):GoogleIdentity {
  const identities=new Set<string>();
  let needsLogin=false,needsVerification=false,ambiguous=false,unreadable=false;
  for(const page of pages){
    const url=trustedUrl(page.url);if(!url)continue;
    if(page.unreadable){unreadable=true;continue;}
    if(url.hostname==='accounts.google.com'){
      if(page.verificationVisible||/(?:^|\/)challenge(?:\/|$)/i.test(url.pathname))needsVerification=true;
      else needsLogin=true;
      // Account chooser entries and remembered email addresses remain visible after sign-out.
      continue;
    }
    if(page.verificationVisible){needsVerification=true;continue;}
    if(page.signInVisible)needsLogin=true;
    for(const avatar of page.avatars){
      if(!avatar.visible||!avatar.inHeader||(avatar.kind==='anchor'&&!avatarTarget(avatar.href)))continue;
      const labels=[avatar.ariaLabel??'',avatar.title??''];
      if(!labels.some(label=>marker.test(label)&&!signedOut.test(label)))continue;
      const extracted=labels.map(labelEmails);
      // A strong marker qualifies the avatar, but every email-bearing attribute must agree.
      if(extracted.some(value=>value===undefined)){ambiguous=true;continue;}
      const candidates=extracted.flatMap(value=>value??[]);
      if(new Set(candidates).size>1)ambiguous=true;
      for(const identity of candidates)identities.add(identity);
    }
  }
  if(ambiguous||identities.size>1)return{status:'unknown',reason:'Google 账号标记存在歧义或不支持的邮箱格式，请只保留目标账号的页面后重新检测'};
  // An unreadable trusted tab could contain a different account; do not silently pick another tab.
  if(unreadable)return{status:'unknown',reason:'部分 Google 页面暂时无法读取，请等待页面加载完成后重试'};
  if(needsVerification)return{status:'needs_verification',reason:'Google 正在要求验证码或二次验证，请通过桌面完成'};
  if(identities.size===1&&needsLogin)return{status:'unknown',reason:'已登录标记与登录页面同时存在，请完成或关闭登录页面后重新检测'};
  if(identities.size===1)return{status:'authenticated',identity:[...identities][0]!};
  if(needsLogin)return{status:'needs_login',reason:'请在桌面完成 Google 登录并等待跳转到账号页面'};
  return{status:'unknown',reason:'当前页面尚未提供可确认的 Google 已登录账号标记'};
}

/** Reads only top-level, visible Google account header attributes; never enters login/content iframes. */
export async function readGoogleIdentityEvidence(page:Page):Promise<GooglePageEvidence|undefined> {
  const before=page.url();if(!isGoogleIdentityPage(before))return;
  try {
    const pendingSnapshot=page.evaluate(():GooglePageEvidence=>{
      const visible=(element:Element)=>{
        if(element.getClientRects().length===0||element.closest('[hidden],[aria-hidden="true"]'))return false;
        for(let current:Element|null=element;current;current=current.parentElement){
          const style=getComputedStyle(current);
          if(style.visibility==='hidden'||style.visibility==='collapse'||style.display==='none'||Number(style.opacity)===0)return false;
        }
        return true;
      };
      const anyVisible=(selector:string)=>Array.from(document.querySelectorAll(selector)).some(visible);
      const avatars=Array.from(document.querySelectorAll('#gb button[aria-label],#gb button[title],#gb [role="button"][aria-label],#gb [role="button"][title],#gb a[aria-label],#gb a[title]')).slice(0,100).flatMap(element=>{
        const isButton=element.tagName==='BUTTON'||element.getAttribute('role')==='button';
        if(!isButton&&element.tagName!=='A')return[];
        return[{kind:element.tagName==='A'?'anchor' as const:'button' as const,inHeader:true,visible:visible(element),ariaLabel:(element.getAttribute('aria-label')??'').slice(0,4097),title:(element.getAttribute('title')??'').slice(0,4097),href:element.tagName==='A'?(element as HTMLAnchorElement).href:undefined}];
      });
      const signInVisible=Array.from(document.querySelectorAll('#gb a[href]')).some(element=>{
        if(!visible(element))return false;
        try{const url=new URL((element as HTMLAnchorElement).href);return url.protocol==='https:'&&url.hostname==='accounts.google.com'&&/^\/(?:ServiceLogin|(?:v\d+\/)?signin)(?:\/|$)/i.test(url.pathname);}catch{return false;}
      });
      return{url:location.href,avatars,signInVisible,verificationVisible:anyVisible('input[autocomplete="one-time-code"],input[name="totpPin"],input[name="idvPin"],iframe[src*="recaptcha"],iframe[src*="hcaptcha"]')};
    });
    // A busy renderer must not hold the profile gate beyond the controller's identity poll timeout.
    // The unfinished evaluation is strictly read-only and cannot replay an account action later.
    let timer:ReturnType<typeof setTimeout>|undefined;
    const snapshot=await Promise.race([pendingSnapshot,new Promise<GooglePageEvidence>((_done,reject)=>{timer=setTimeout(()=>reject(new Error('Google identity DOM timeout')),1500);})]).finally(()=>clearTimeout(timer));
    if(page.url()!==before||snapshot.url!==before)return{url:before,avatars:[],unreadable:true};
    return snapshot;
  }catch{return{url:before,avatars:[],unreadable:true};}
}

export async function readGoogleIdentity(pages:readonly Page[]):Promise<GoogleIdentity>{
  const snapshots=await Promise.all(pages.filter(page=>!page.isClosed()).map(readGoogleIdentityEvidence));
  return googleIdentityFromEvidence(snapshots.filter((snapshot):snapshot is GooglePageEvidence=>snapshot!==undefined));
}
