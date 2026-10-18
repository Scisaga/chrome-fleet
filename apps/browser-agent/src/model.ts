import { z } from 'zod';

export class AgentError extends Error {
  constructor(public code: string, message: string, public statusCode = 400,public details?:unknown) { super(message); }
}
export const LocatorSchema = z.object({
  css: z.string().max(2000).optional(), role: z.string().max(100).optional(), name: z.string().max(1000).optional(),
  label: z.string().max(1000).optional(), text: z.string().max(1000).optional(), iframe: z.string().max(2000).optional(),
}).strict().refine(v => [v.css, v.role, v.label, v.text].filter(Boolean).length === 1, '定位器必须恰好指定一种定位方式');
export const StepSchema = z.object({
  action: z.enum(['goto','click','fill','press','select','waitFor','extractText','screenshot','pages','newPage','switchPage','assertText','upload','download','waitPopup']),
  locator: LocatorSchema.optional(), pageId: z.string().max(80).optional(), url: z.string().max(8000).optional(),
  value: z.string().max(2_000_000).optional(), text: z.string().max(10000).optional(), key: z.string().max(100).optional(),
  values: z.array(z.string().max(1000)).max(100).optional(), timeoutMs: z.number().int().min(1).max(120000).optional(),
  state: z.enum(['attached','detached','visible','hidden']).optional(), fullPage: z.boolean().optional(),
  artifactId: z.string().max(100).optional(), fileName: z.string().max(255).optional(), mimeType: z.string().max(100).optional(),
  base64: z.string().max(24_000_000).optional(),
}).strict();
export type Step = z.infer<typeof StepSchema>;
export type LocatorSpec = z.infer<typeof LocatorSchema>;
export const CookieSchema = z.object({
  name: z.string().min(1).max(4096), value: z.string().max(65536), domain: z.string().min(1).max(253),
  path: z.string().startsWith('/').default('/'), expires: z.number().finite().default(-1), httpOnly: z.boolean().default(false),
  secure: z.boolean().default(false), sameSite: z.enum(['Strict','Lax','None']).default('Lax'),
  partitionKey: z.string().url().optional(), _crHasCrossSiteAncestor:z.boolean().optional(),
}).strict();
export type Cookie = z.infer<typeof CookieSchema>;
export type ImportMode = 'merge' | 'replace' | 'replace_domains';
export const IndexedDbSchema=z.object({name:z.string().max(1000),version:z.number().int().positive(),stores:z.array(z.object({
  name:z.string().max(1000),autoIncrement:z.boolean(),keyPath:z.string().optional(),keyPathArray:z.array(z.string()).optional(),
  records:z.array(z.object({key:z.unknown().optional(),keyEncoded:z.unknown().optional(),value:z.unknown().optional(),valueEncoded:z.unknown().optional()}).strict()).max(100000),
  indexes:z.array(z.object({name:z.string(),keyPath:z.string().optional(),keyPathArray:z.array(z.string()).optional(),multiEntry:z.boolean(),unique:z.boolean()}).strict()).max(1000),
}).strict()).max(1000)}).strict();

export function domainMatches(domain: string, selected: string[]) {
  const normalized = domain.toLowerCase().replace(/^\./, '');
  return selected.some(d => normalized === d.toLowerCase().replace(/^\./, '') || normalized.endsWith('.' + d.toLowerCase().replace(/^\./, '')));
}

export function parseCookies(document: unknown): Cookie[] {
  let cookies: unknown = document;
  if (document && typeof document === 'object' && !Array.isArray(document)) {
    const obj = document as Record<string, unknown>;
    if (obj.format && obj.format !== 'chrome-fleet.cookies') throw new AgentError('COOKIE_FORMAT_UNSUPPORTED', '不支持此 Cookie 格式');
    if (obj.version !== undefined && obj.version !== 1) throw new AgentError('COOKIE_VERSION_UNSUPPORTED', '不支持此 Cookie 版本');
    cookies = obj.cookies;
  }
  const parsed = z.array(CookieSchema).max(10000).parse(cookies);
  const now = Date.now() / 1000;
  for (const cookie of parsed) {
    if (cookie.expires !== -1 && cookie.expires < now) throw new AgentError('COOKIE_EXPIRED', '导入包含已过期 Cookie，请先移除');
    if (cookie.sameSite === 'None' && !cookie.secure) throw new AgentError('COOKIE_INVALID', 'SameSite=None 必须启用 Secure');
    if (cookie.partitionKey && !cookie.secure) throw new AgentError('COOKIE_INVALID', '分区 Cookie 必须启用 Secure');
    if (cookie.name.startsWith('__Host-') && (!cookie.secure || cookie.path !== '/' || cookie.domain.startsWith('.'))) throw new AgentError('COOKIE_PREFIX_INVALID', '__Host- Cookie 属性不正确');
    if (cookie.name.startsWith('__Secure-') && !cookie.secure) throw new AgentError('COOKIE_PREFIX_INVALID', '__Secure- Cookie 必须启用 Secure');
    if (/[\s/\\:@]/.test(cookie.domain)) throw new AgentError('COOKIE_DOMAIN_INVALID', 'Cookie 域名格式无效');
  }
  return parsed;
}

/** Advance fences immediately, then wait for the previous holder's bounded operation to settle. */
export class FenceGate {
  constructor(private invalidate?:()=>Promise<void>){}
  token = 0;
  private running: Promise<unknown> | undefined;
  private cancelled = false;
  private advancing: Promise<void> | undefined;
  async advance(token: number) {
    if (!Number.isSafeInteger(token) || token < 1) throw new AgentError('FENCE_INVALID', '租约令牌无效');
    if (token < this.token) throw new AgentError('FENCE_STALE', '租约令牌已失效', 409);
    if (token === this.token) { await this.advancing; return; }
    this.token = token;
    this.cancelled = true;
    const previous = this.running;
    this.advancing = (async () => { if (previous) {await this.invalidate?.();await previous.catch(() => undefined);} this.cancelled = false; })();
    await this.advancing;
  }
  assert(token: number) {
    if (token !== this.token || token < 1) throw new AgentError('FENCE_STALE', '租约令牌已失效', 409);
    if (this.cancelled) throw new AgentError('OPERATION_CANCELLED', '任务已取消', 409);
  }
  async run<T>(token: number, operation: () => Promise<T>): Promise<T> {
    if(token!==this.token || token<1)throw new AgentError('FENCE_STALE','租约令牌已失效',409);
    await this.advancing;
    this.assert(token);
    if (this.running) throw new AgentError('PROFILE_BUSY', '实例正在执行其他操作', 409);
    const result = operation();
    this.running = result;
    try { return await result; } finally { if (this.running === result) this.running = undefined; this.cancelled = false; }
  }
  cancel(token: number) { this.assert(token); this.cancelled = true; if(this.running)void this.invalidate?.().catch(()=>undefined); }
  get busy() { return !!this.running; }
}
