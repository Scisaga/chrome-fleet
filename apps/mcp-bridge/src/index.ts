import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod/v3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiCall, HttpMethod } from '@chrome-fleet/sdk';
export type { ApiCall } from '@chrome-fleet/sdk';

const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/, '必须是平台标识');
const profile = { profileId: identifier };
const idem = { idempotencyKey: z.string().min(1).max(128).optional() };
const expectedAccount = { expectedAccountId: identifier.optional() };
const duration = { timeoutMs: z.number().int().min(1000).max(900_000).optional() };
const startupPolicy = z.enum(['on_demand', 'manual', 'always']);
const locator = z.object({
  css: z.string().max(2000).optional(), role: z.string().max(100).optional(), name: z.string().max(1000).optional(),
  label: z.string().max(1000).optional(), text: z.string().max(1000).optional(), iframe: z.string().max(2000).optional(),
}).strict().refine(v => [v.css, v.role, v.label, v.text].filter(Boolean).length === 1, '定位器必须恰好指定一种定位方式');
const browserStep = z.object({
  action: z.enum(['goto', 'click', 'fill', 'press', 'select', 'waitFor', 'extractText', 'screenshot', 'pages', 'newPage', 'switchPage', 'assertText', 'upload', 'download', 'waitPopup']),
  locator: locator.optional(), pageId: z.string().max(80).optional(), url: z.string().url().max(8000).optional(),
  value: z.string().max(100_000).optional(), text: z.string().max(10000).optional(), key: z.string().max(100).optional(),
  values: z.array(z.string().max(1000)).max(100).optional(), timeoutMs: z.number().int().min(1).max(120000).optional(),
  state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional(), fullPage: z.boolean().optional(),
  artifactId: identifier.optional(),
}).strict();
const proxy = {
  enabled: z.boolean(), scheme: z.enum(['http', 'https', 'socks5']).optional(), host: z.string().min(1).max(253).optional(),
  port: z.number().int().min(1).max(65535).optional(), secretRef: identifier.optional(),
  bypass: z.string().max(1024).optional(),
};
const output = {
  ok: z.boolean(), data: z.unknown().optional(), requestId: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
};
type Input = Record<string, unknown>;
type ToolDefinition = {
  name: string; description: string; schema: z.ZodRawShape; scope: string;
  readonly?: boolean; destructive?: boolean; idempotent?: boolean; openWorld?: boolean;
  invoke: (args: Input, call: ApiCall) => ReturnType<ApiCall>;
};
function path(profileId: unknown, suffix = '') { return `/api/v1/profiles/${encodeURIComponent(String(profileId))}${suffix}`; }
function rest(method: HttpMethod, target: string | ((a: Input) => string), select?: (a: Input) => unknown): ToolDefinition['invoke'] {
  return (args, call) => call(method, typeof target === 'string' ? target : target(args), select?.(args), { idempotencyKey: args.idempotencyKey as string | undefined });
}
function bodyWithout(args: Input, ...keys: string[]) { return Object.fromEntries(Object.entries(args).filter(([key]) => ![...keys, 'idempotencyKey'].includes(key))); }
function singleStep(action: string, fields: string[]): ToolDefinition['invoke'] {
  return (args, call) => {
    const step = { action, ...Object.fromEntries(fields.filter(key => args[key] !== undefined).map(key => [key, args[key]])) };
    return call('POST', '/api/v1/jobs', { profileId: args.profileId, steps: [step], ...(args.expectedAccountId ? { expectedAccountId: args.expectedAccountId } : {}), ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}) }, { idempotencyKey: args.idempotencyKey as string | undefined });
  };
}
const tools: ToolDefinition[] = [
  { name: 'profiles_list', description: '分页查询实例，含脱敏运行与账号状态。权限：read。', scope: 'read', readonly: true, idempotent: true, schema: { limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional(), search: z.string().max(200).optional(), state: z.string().max(40).optional(), archived: z.boolean().optional() }, invoke: rest('GET', a => { const q = new URLSearchParams(Object.entries(a).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])); return `/api/v1/profiles${q.size ? `?${q}` : ''}`; }) },
  { name: 'profiles_get', description: '查询实例详情；不会返回密码或 Cookie。权限：read。', scope: 'read', readonly: true, idempotent: true, schema: profile, invoke: rest('GET', a => path(a.profileId)) },
  { name: 'profiles_create', description: '创建独立实例配置，默认 stopped；密码仅允许已存在的 secret 引用。权限：manage。', scope: 'manage', schema: { name: z.string().min(1).max(80), tags: z.array(z.string().max(40)).max(20).optional(), startupPolicy: startupPolicy.optional(), idleTimeoutMinutes: z.number().int().min(0).max(10080).optional(), vncSecretRef: identifier.optional(), proxy: z.object(proxy).strict().optional(), headless: z.boolean().optional(), timezoneId: z.string().max(100).optional(), locale: z.string().max(40).optional(), ...idem }, invoke: rest('POST', '/api/v1/profiles', a => bodyWithout(a)) },
  { name: 'profiles_start', description: '提交启动任务。返回 jobId，使用 jobs_get 查询。权限：manage。', scope: 'manage', schema: { ...profile, ...idem }, invoke: rest('POST', a => path(a.profileId, '/start'), () => ({})) },
  { name: 'profiles_stop', description: '提交关闭任务并保留会话；force 可能导致动作结果未知。默认暂停自动唤起。权限：manage。', scope: 'manage', destructive: true, schema: { ...profile, force: z.boolean().optional(), ...idem }, invoke: rest('POST', a => path(a.profileId, '/stop'), a => bodyWithout(a, 'profileId')) },
  { name: 'profiles_restart', description: '排空任务后受控重启，保留用户目录。权限：manage。', scope: 'manage', destructive: true, schema: { ...profile, ...idem }, invoke: rest('POST', a => path(a.profileId, '/restart'), () => ({})) },
  { name: 'profiles_runtime_policy_set', description: '设置启动及空闲关闭策略。权限：manage。', scope: 'manage', idempotent: true, schema: { ...profile, startupPolicy: startupPolicy.optional(), autoWakePaused: z.boolean().optional(), idleTimeoutMinutes: z.number().int().min(0).max(10080).optional() }, invoke: rest('PATCH', a => path(a.profileId, '/runtime-policy'), a => bodyWithout(a, 'profileId')) },
  { name: 'profiles_proxy_get', description: '查询脱敏代理与生效版本，不读取认证秘密。权限：read。', scope: 'read', readonly: true, idempotent: true, schema: profile, invoke: rest('GET', a => path(a.profileId, '/proxy')) },
  { name: 'profiles_proxy_set', description: '设置独立代理，认证仅接收 secretRef。运行实例需受控应用；认证 SOCKS5 不支持。权限：manage。', scope: 'manage', destructive: true, schema: { ...profile, ...proxy }, invoke: (a, call) => a.enabled === false ? call('DELETE', path(a.profileId, '/proxy')) : rest('PUT', a => path(a.profileId, '/proxy'), a => bodyWithout(a, 'profileId'))(a, call) },
  { name: 'profiles_proxy_test', description: '提交目标实例实际浏览器 HTTP/HTTPS 出口测试，可按策略唤起。权限：automate。', scope: 'automate', openWorld: true, schema: { ...profile, ...idem }, invoke: rest('POST', a => path(a.profileId, '/proxy/test'), () => ({})) },
  { name: 'profiles_vnc_password_set', description: '通过既有 secretRef 轮换该实例 VNC 密码并撤销旧桌面会话；禁止传入真实密码。权限：manage。', scope: 'manage', destructive: true, schema: { ...profile, secretRef: identifier }, invoke: rest('PUT', a => path(a.profileId, '/remote-desktop/password'), a => ({ secretRef: a.secretRef })) },
  { name: 'accounts_check', description: '提交站点身份检测，Cookie 存在不代表已登录；不支持的站点返回 unsupported。权限：automate。', scope: 'automate', openWorld: true, schema: { ...profile, accountId: identifier.optional(), ...idem }, invoke: rest('POST', a => path(a.profileId, '/accounts/check'), a => bodyWithout(a, 'profileId')) },
  { name: 'manual_session_open', description: '申请有期限人工租约与受保护桌面入口；人工操作同一 Chrome。权限：automate。', scope: 'automate', schema: { ...profile, durationSeconds: z.number().int().min(60).max(3600).optional(), explicitStart: z.boolean().optional(), ...idem }, invoke: rest('POST', a => path(a.profileId, '/manual-sessions'), a => bodyWithout(a, 'profileId')) },
  { name: 'manual_session_close', description: '关闭人工接管、撤销桌面权限并释放租约。权限：automate。', scope: 'automate', idempotent: true, schema: { sessionId: identifier }, invoke: rest('DELETE', a => `/api/v1/manual-sessions/${a.sessionId}`) },
  { name: 'jobs_submit', description: '向持久化队列提交声明式步骤。所有页面操作持有实例租约；不会自动重放有副作用的动作。禁止填写网站密码，敏感输入通过人工桌面完成。权限：automate。', scope: 'automate', openWorld: true, destructive: true, schema: { ...profile, steps: z.array(browserStep).min(1).max(100), expectedAccountId: identifier.optional(), ...duration, ...idem }, invoke: rest('POST', '/api/v1/jobs', a => bodyWithout(a)) },
  { name: 'jobs_get', description: '查询任务状态、进度、结果与脱敏错误；waiting_for_human 需人工接管，outcome_unknown 需核查且不自动重放。权限：read。', scope: 'read', readonly: true, idempotent: true, schema: { jobId: identifier }, invoke: rest('GET', a => `/api/v1/jobs/${a.jobId}`) },
  { name: 'jobs_cancel', description: '请求取消任务。已经发生的网页动作无法撤回。权限：automate。', scope: 'automate', destructive: true, idempotent: true, schema: { jobId: identifier }, invoke: rest('POST', a => `/api/v1/jobs/${a.jobId}/cancel`, () => ({})) },
  { name: 'jobs_resume', description: '人工完成验证后恢复等待任务；不用于重放结果未知的动作。权限：automate。', scope: 'automate', openWorld: true, schema: { jobId: identifier }, invoke: rest('POST', a => `/api/v1/jobs/${a.jobId}/resume`, () => ({})) },
  { name: 'browser_pages_list', description: '将页面列表操作提交到同一队列，返回 jobId。权限：automate。', scope: 'automate', schema: { ...profile, ...expectedAccount, ...duration, ...idem }, invoke: singleStep('pages', []) },
  { name: 'browser_navigate', description: '提交页面导航；导航也可能产生副作用，不自动重试。权限：automate。', scope: 'automate', openWorld: true, destructive: true, schema: { ...profile, ...expectedAccount, pageId: z.string().max(80).optional(), url: z.string().url().max(8000), ...duration, ...idem }, invoke: singleStep('goto', ['pageId', 'url']) },
  { name: 'browser_click', description: '提交定位器点击，返回 jobId。权限：automate。', scope: 'automate', openWorld: true, destructive: true, schema: { ...profile, ...expectedAccount, pageId: z.string().max(80).optional(), locator, ...duration, ...idem }, invoke: singleStep('click', ['pageId', 'locator']) },
  { name: 'browser_fill', description: '提交表单输入；不要通过工具填写真实网站密码或平台秘密，登录请使用人工桌面。权限：automate。', scope: 'automate', openWorld: true, destructive: true, schema: { ...profile, ...expectedAccount, pageId: z.string().max(80).optional(), locator, value: z.string().max(100_000), ...duration, ...idem }, invoke: singleStep('fill', ['pageId', 'locator', 'value']) },
  { name: 'browser_extract', description: '提交文本提取，结果通过 jobs_get 获取；页面文本可能敏感。权限：automate。', scope: 'automate', openWorld: true, schema: { ...profile, ...expectedAccount, pageId: z.string().max(80).optional(), locator: locator.optional(), ...duration, ...idem }, invoke: singleStep('extractText', ['pageId', 'locator']) },
  { name: 'browser_screenshot', description: '提交截图操作，返回 artifact 引用；人工登录期间不允许截图。权限：automate。', scope: 'automate', schema: { ...profile, ...expectedAccount, pageId: z.string().max(80).optional(), fullPage: z.boolean().optional(), ...duration, ...idem }, invoke: singleStep('screenshot', ['pageId', 'fullPage']) },
];
for (const [prefix, route] of [['cookies', 'cookies'], ['storage_state', 'storage-state']] as const) {
  tools.push({ name: `${prefix}_export`, description: '提交加密会话导出，只返回任务与 artifact 标识，不返回 Cookie 或状态正文。权限：session:read。', scope: 'session:read', schema: { ...profile, domains: z.array(z.string().min(1).max(253)).max(100).optional(), ...idem }, invoke: rest('POST', a => path(a.profileId, `/${route}/export`), a => bodyWithout(a, 'profileId')) });
  tools.push({ name: `${prefix}_import`, description: '从授权 artifact 提交会话导入。导入成功不代表登录成功。replace 会清除选定范围。权限：session:write。', scope: 'session:write', destructive: true, schema: { ...profile, artifactId: identifier, mode: z.enum(['merge', 'replace', 'replace_domains']).optional(), domains: z.array(z.string().min(1).max(253)).max(100).optional(), ...idem }, invoke: rest('POST', a => path(a.profileId, `/${route}/import`), a => bodyWithout(a, 'profileId')) });
}
tools.push(
  { name: 'profiles_backup', description: '提交停机一致性加密备份，包含 profile 与 keyring，返回 jobId。权限：backup。', scope: 'backup', schema: { ...profile, ...idem }, invoke: rest('POST', a => path(a.profileId, '/snapshots'), () => ({})) },
  { name: 'profiles_restore', description: '恢复匹配版本的完整快照，覆盖当前本地状态，要求实例停止。权限：backup。', scope: 'backup', destructive: true, schema: { ...profile, snapshotId: identifier, ...idem }, invoke: rest('POST', a => path(a.profileId, '/restore'), a => ({ snapshotId: a.snapshotId })) },
  { name: 'artifacts_get', description: '读取有权限的 artifact 元数据；不下载正文，也不提供带凭证链接。权限：read 及 artifact 所需范围。', scope: 'read', readonly: true, idempotent: true, schema: { artifactId: identifier }, invoke: rest('GET', a => `/api/v1/artifacts/${a.artifactId}`) },
  { name: 'browser_versions_list', description: '查询 Chrome 当前、候选及已验证版本。权限：read。', scope: 'read', readonly: true, idempotent: true, schema: {}, invoke: rest('GET', '/api/v1/browser-versions') },
  { name: 'browser_updates_check', description: '从官方发布源提交版本检查。权限：update。', scope: 'update', openWorld: true, schema: idem, invoke: rest('POST', '/api/v1/updates/check', () => ({})) },
  { name: 'browser_updates_apply', description: '提交已验证镜像的受控升级；先快照后逐个实例应用。权限：update。', scope: 'update', destructive: true, openWorld: true, schema: { versionId: z.string().max(160).optional(), profileIds: z.array(identifier).max(100).optional(), ...idem }, invoke: rest('POST', '/api/v1/updates/apply', a => bodyWithout(a)) },
  { name: 'browser_updates_rollback', description: '提交旧镜像与升级前 profile/keyring 配对回滚，会舍弃恢复点之后的本地状态。权限：update。', scope: 'update', destructive: true, schema: { updateId: identifier, ...idem }, invoke: rest('POST', a => `/api/v1/updates/${a.updateId}/rollback`, () => ({})) },
);

/** Defense in depth: MCP never exposes cookie documents, passwords or raw uploads. */
export function redactMcp(value: unknown, depth = 0): unknown {
  if (depth > 30) return '[截断]';
  if (typeof value === 'string') return value.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@').replace(/([?&#](?:token|access_token|refresh_token|id_token|password|key|api_key|signature|code|authorization|session|credential)=)[^&#\s]*/gi, '$1[已隐藏]');
  if (Array.isArray(value)) return value.map(v => redactMcp(v, depth + 1));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(password|vncPassword|proxyPassword|username|authorization|token|accessToken|refreshToken|idToken|cookie|cookies|cookieHeader|setCookie|storageState|contentBase64|base64|downloadUrl|signedUrl|params|steps|parameters|requestBody|payload|oncePassword|keyringPassword|apiKey|secret|clientSecret|document)$/i.test(key.replace(/[-_]/g, ''))) continue;
      result[key] = redactMcp(item, depth + 1);
    }
    return result;
  }
  return value;
}
export function createMcpServer(callApi: ApiCall): McpServer {
  const server = new McpServer({ name: 'chrome-fleet', version: '0.1.0' }, { capabilities: { tools: { listChanged: false } } });
  for (const tool of tools) {
    server.registerTool(tool.name, {
      description: tool.description, inputSchema: z.object(tool.schema).strict(), outputSchema: output,
      annotations: { readOnlyHint: tool.readonly ?? false, destructiveHint: tool.destructive ?? false, idempotentHint: tool.idempotent ?? false, openWorldHint: tool.openWorld ?? false },
      _meta: { 'chrome-fleet/scopes': [tool.scope] },
    }, async (args) => {
      try {
        const response = await tool.invoke(args as Input, callApi);
        const result = { ok: true, data: redactMcp(response.data), requestId: response.requestId };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        const failure = error as { code?: unknown; requestId?: unknown };
        const result = { ok: false, error: { code: typeof failure.code === 'string' && /^[A-Z_0-9]+$/.test(failure.code) ? failure.code : 'API_ERROR', message: '操作失败；请按错误代码和请求标识查询控制服务，避免重放结果未知的动作。' }, ...(typeof failure.requestId === 'string' ? { requestId: failure.requestId } : {}) };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      }
    });
  }
  return server;
}

export interface McpHttpOptions {
  path?: string;
  /** Must validate the incoming platform bearer on EVERY request, including initialization. */
  authorize?: (request: FastifyRequest) => boolean | Promise<boolean>;
  /** Exact authorities, including port. Defaults permit only standard local names and any port. */
  allowedHosts?: string[];
  /** Exact origins. Defaults require a loopback origin with the same Host authority. */
  allowedOrigins?: string[];
}
function localHost(host: string) { return /^(127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(host); }
function originAllowed(request: FastifyRequest, options: McpHttpOptions) {
  const origin = request.headers.origin;
  if (origin === undefined) return true; // Non-browser MCP clients commonly omit Origin.
  try { const url = new URL(origin); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.origin === origin && (options.allowedOrigins ? options.allowedOrigins.includes(origin) : localHost(url.host)) && url.host === request.headers.host; } catch { return false; }
}
/**
 * Stateless, JSON-response Streamable HTTP transport. Each request gets its own
 * server/client identity; MCP session IDs can never substitute for authentication.
 * Bind to loopback or explicitly allowed trusted network authorities.
 */
export async function installMcpHttp(app: FastifyInstance, callApiForRequest: (request: FastifyRequest) => ApiCall, options: McpHttpOptions = {}): Promise<void> {
  for (const host of options.allowedHosts ?? []) {
    if (host.includes('*') || new URL(`http://${host}`).host !== host || ['0.0.0.0', '[::]'].includes(host)) throw new Error('MCP Host 必须为精确实际主机，禁止通配符');
  }
  for (const origin of options.allowedOrigins ?? []) {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || parsed.hostname.includes('*') || ['0.0.0.0', '[::]'].includes(parsed.hostname)) throw new Error('MCP Origin 必须为精确 HTTP(S) 来源，禁止通配符');
  }
  app.route({
    method: ['POST', 'GET', 'DELETE'], url: options.path ?? '/mcp',
    handler: async (request, reply) => {
      const host = request.headers.host ?? '';
      if (!(options.allowedHosts ? options.allowedHosts.includes(host) : localHost(host)) || !originAllowed(request, options)) return reply.code(403).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Host 或 Origin 不被允许' }, id: null });
      if (!/^Bearer [^\s]+$/i.test(request.headers.authorization ?? '')) return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ jsonrpc: '2.0', error: { code: -32000, message: '需要平台 Bearer 凭证' }, id: null });
      const call = callApiForRequest(request);
      let authorized = false;
      try { authorized = options.authorize ? await options.authorize(request) : !!(await call('GET', '/api/v1/profiles?limit=1')); } catch { /* Errors do not reveal a token or auth internals. */ }
      if (!authorized) return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ jsonrpc: '2.0', error: { code: -32000, message: '平台凭证无效或权限不足' }, id: null });
      if (request.method !== 'POST') return reply.code(405).header('Allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: '此无状态 MCP 入口仅使用 POST，不提供持久 SSE 会话' }, id: null });
      const server = createMcpServer(call);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      reply.hijack();
      reply.raw.once('close', () => { void transport.close(); void server.close(); });
      try { await transport.handleRequest(request.raw, reply.raw, request.body); }
      catch { if (!reply.raw.headersSent) reply.raw.writeHead(500, { 'content-type': 'application/json' }); if (!reply.raw.writableEnded) reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'MCP 请求处理失败' }, id: null })); }
    },
  });
}
