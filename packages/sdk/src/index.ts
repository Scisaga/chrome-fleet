/** Chrome Fleet REST client. No mutating request is automatically replayed. */
import type { Platform, PlatformInput, PlatformAccount } from '@chrome-fleet/contracts';
export type { Platform, PlatformInput, PlatformAccount } from '@chrome-fleet/contracts';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface Envelope<T> { data: T; requestId: string }
export interface Page<T> { items: T[]; total: number; nextCursor?: string | null }
export interface RequestOptions { idempotencyKey?: string; signal?: AbortSignal }
export type ApiCall = (method: HttpMethod, path: string, body?: unknown, options?: RequestOptions) => Promise<Envelope<unknown>>;
export interface FleetClientOptions {
  baseUrl?: string;
  token?: string | (() => string | Promise<string>);
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
export type ProfileState = 'stopped' | 'starting' | 'running' | 'stopping' | 'updating' | 'error';
export interface RuntimePolicy { startupPolicy?: 'on_demand' | 'manual' | 'always'; autoWakePaused?: boolean; idleTimeoutMinutes?: number }
export interface ProxyConfig {
  enabled: boolean; scheme?: 'http' | 'https' | 'socks5'; host?: string; port?: number;
  secretRef?: string; bypass?: string;
}
export interface BrowserProfile {
  id: string; name: string; state: ProfileState; tags?: string[];
  startupPolicy?: RuntimePolicy['startupPolicy']; archived?: boolean;
  platformAccounts?: PlatformAccount[];
  [key: string]: unknown;
}
export interface CreateProfile {
  name: string; tags?: string[]; startupPolicy?: RuntimePolicy['startupPolicy'];
  idleTimeoutMinutes?: number; vncSecretRef?: string;
  proxy?: ProxyConfig; headless?: boolean; timezoneId?: string; locale?: string;
  [key: string]: unknown;
}
export interface Locator { css?: string; role?: string; name?: string; label?: string; text?: string; iframe?: string }
export interface BrowserStep {
  action: 'goto' | 'click' | 'fill' | 'press' | 'select' | 'waitFor' | 'extractText' | 'screenshot' | 'pages' | 'newPage' | 'switchPage' | 'assertText' | 'upload' | 'download' | 'waitPopup' | 'requireHuman';
  pageId?: string; locator?: Locator; url?: string; value?: string; key?: string;
  resultKey?: string; artifactId?: string; fullPage?: boolean; timeoutMs?: number;
  [key: string]: unknown;
}
export interface SubmitJob { profileId: string; steps?: BrowserStep[]; template?: string; timeoutMs?: number; expectedAccountId?: string; [key: string]: unknown }
export type JobStatus = 'queued' | 'running' | 'waiting_for_human' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'outcome_unknown';
export interface Job { id: string; profileId: string; status: JobStatus; result?: unknown; error?: unknown; [key: string]: unknown }
export interface AcceptedJob { jobId: string; [key: string]: unknown }
export interface Artifact { id: string; profileId: string; type?: string; size?: number; [key: string]: unknown }
export interface TransferOptions { domains?: string[]; mode?: 'merge' | 'replace' | 'replace_domains'; artifactId?: string }
export interface Pagination { limit?: number; offset?: number; search?: string; state?: string; profileId?: string; archived?: boolean }
export interface JobFilters extends Pagination { createdFrom?: string; createdBefore?: string; cursor?: string }
export interface JobDensity {
  total: number; intervalMs: number;
  kinds: { kind: string; total: number }[];
  buckets: { start: string; end: string; total: number; counts: Record<string, number> }[];
}

/** Stable API code and request ID are safe to log; request bodies and tokens are never attached. */
export class FleetError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number, public readonly requestId?: string) {
    super(message); this.name = 'FleetError';
  }
}
function id(value: string): string { return encodeURIComponent(value); }
function query(value: object): string {
  const params = new URLSearchParams();
  for (const [key, item] of Object.entries(value)) if (item !== undefined && item !== null) params.set(key, String(item));
  return params.size ? `?${params}` : '';
}
const terminal = new Set<JobStatus>(['succeeded', 'failed', 'cancelled', 'timed_out', 'outcome_unknown']);

export class FleetClient {
  private readonly baseUrl: URL;
  private readonly fetcher: typeof globalThis.fetch;
  constructor(private readonly options: FleetClientOptions = {}) {
    this.baseUrl = new URL(options.baseUrl ?? 'http://127.0.0.1:8080');
    if (!['http:', 'https:'].includes(this.baseUrl.protocol) || this.baseUrl.username || this.baseUrl.password || this.baseUrl.search || this.baseUrl.hash) throw new Error('FLEET_URL 必须是没有凭证或查询参数的 HTTP(S) URL');
    this.fetcher = options.fetch ?? globalThis.fetch;
  }
  async request<T>(method: HttpMethod, path: string, body?: unknown, options: RequestOptions = {}): Promise<Envelope<T>> {
    if (!path.startsWith('/api/v1/') && !['/health', '/ready'].includes(path)) throw new Error('只允许 Chrome Fleet API 路径');
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl.origin) throw new Error('不允许跨来源 API 请求');
    const token = typeof this.options.token === 'function' ? await this.options.token() : this.options.token;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    let response: Response;
    try {
      response = await this.fetcher(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: 'error' });
    } catch {
      throw new FleetError('TRANSPORT_ERROR', '连接失败或响应超时；有副作用的请求结果可能未知，请按幂等键或任务 ID 查询。', 0);
    }
    let parsed: Record<string, unknown>;
    try { parsed = await response.json() as Record<string, unknown>; }
    catch { throw new FleetError('INVALID_RESPONSE', '控制服务返回非 JSON 响应', response.status); }
    const requestId = typeof parsed.requestId === 'string' ? parsed.requestId : undefined;
    if (!response.ok) {
      const error = (parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed) as Record<string, unknown>;
      throw new FleetError(typeof error.code === 'string' ? error.code : 'HTTP_ERROR', typeof error.message === 'string' ? error.message : '请求失败', response.status, requestId);
    }
    if (!Object.hasOwn(parsed, 'data') || !requestId) throw new FleetError('INVALID_RESPONSE', '控制服务响应缺少 data 或 requestId', response.status);
    return parsed as unknown as Envelope<T>;
  }
  readonly call: ApiCall = (method, path, body, options) => this.request(method, path, body, options);
  private async data<T>(method: HttpMethod, path: string, body?: unknown, options?: RequestOptions): Promise<T> { return (await this.request<T>(method, path, body, options)).data; }
  listProfiles(filters: Pagination = {}) { return this.data<Page<BrowserProfile>>('GET', `/api/v1/profiles${query(filters)}`); }
  getProfile(profileId: string) { return this.data<BrowserProfile>('GET', `/api/v1/profiles/${id(profileId)}`); }
  createProfile(body: CreateProfile, options?: RequestOptions) { return this.data<BrowserProfile>('POST', '/api/v1/profiles', body, options); }
  updateProfile(profileId: string, body: Partial<CreateProfile>) { return this.data<BrowserProfile>('PATCH', `/api/v1/profiles/${id(profileId)}`, body); }
  archiveProfile(profileId: string, options?: RequestOptions) { return this.data<AcceptedJob>('DELETE', `/api/v1/profiles/${id(profileId)}`, undefined, options); }
  unarchiveProfile(profileId: string, options?: RequestOptions) { return this.data<BrowserProfile>('POST', `/api/v1/profiles/${id(profileId)}/unarchive`, {}, options); }
  purgeProfile(profileId: string, confirmation: string, options?: RequestOptions) { return this.data<BrowserProfile>('POST', `/api/v1/profiles/${id(profileId)}/purge`, { confirmation }, options); }
  startProfile(profileId: string, options?: RequestOptions) { return this.data<AcceptedJob>('POST', `/api/v1/profiles/${id(profileId)}/start`, {}, options); }
  stopProfile(profileId: string, body: { force?: boolean } = {}, options?: RequestOptions) { return this.data<AcceptedJob>('POST', `/api/v1/profiles/${id(profileId)}/stop`, body, options); }
  restartProfile(profileId: string, options?: RequestOptions) { return this.data<AcceptedJob>('POST', `/api/v1/profiles/${id(profileId)}/restart`, {}, options); }
  getRuntimePolicy(profileId: string) { return this.data<RuntimePolicy>('GET', `/api/v1/profiles/${id(profileId)}/runtime-policy`); }
  setRuntimePolicy(profileId: string, body: RuntimePolicy) { return this.data<BrowserProfile>('PATCH', `/api/v1/profiles/${id(profileId)}/runtime-policy`, body); }
  getProxy(profileId: string) { return this.data<ProxyConfig>('GET', `/api/v1/profiles/${id(profileId)}/proxy`); }
  setProxy(profileId: string, body: ProxyConfig) { return this.data<ProxyConfig>('PUT', `/api/v1/profiles/${id(profileId)}/proxy`, body); }
  disableProxy(profileId: string) { return this.data<ProxyConfig>('DELETE', `/api/v1/profiles/${id(profileId)}/proxy`); }
  testProxy(profileId: string, options?: RequestOptions) { return this.data<AcceptedJob>('POST', `/api/v1/profiles/${id(profileId)}/proxy/test`, {}, options); }
  getRemoteDesktop(profileId: string) { return this.data<Record<string, unknown>>('GET', `/api/v1/profiles/${id(profileId)}/remote-desktop`); }
  setVncPassword(profileId: string, secretRef: string) { return this.data<Record<string, unknown>>('PUT', `/api/v1/profiles/${id(profileId)}/remote-desktop/password`, { secretRef }); }
  listAccounts(profileId: string) { return this.data<Page<Record<string, unknown>>>('GET', `/api/v1/profiles/${id(profileId)}/accounts`); }
  bindAccount(profileId: string, body: { provider: string; alias: string; expectedIdentity: string; [key: string]: unknown }) { return this.data<Record<string, unknown>>('POST', `/api/v1/profiles/${id(profileId)}/accounts`, body); }
  listPlatforms(filters: Pick<Pagination, 'limit' | 'offset'> = {}) { return this.data<Page<Platform>>('GET', `/api/v1/platforms${query(filters)}`); }
  createPlatform(body: PlatformInput, options?: RequestOptions) { return this.data<Platform>('POST', '/api/v1/platforms', body, options); }
  updatePlatform(platformId: string, body: Partial<PlatformInput>) { return this.data<Platform>('PATCH', `/api/v1/platforms/${id(platformId)}`, body); }
  deletePlatform(platformId: string) { return this.data<{ deleted: boolean }>('DELETE', `/api/v1/platforms/${id(platformId)}`); }
  linkPlatform(profileId: string, platformId: string, body: { googleAccountId: string; confirmedGoogleSignup: true }, options?: RequestOptions) { return this.data<PlatformAccount>('POST', `/api/v1/profiles/${id(profileId)}/platforms/${id(platformId)}`, body, options); }
  confirmPlatformLogin(profileId: string, platformId: string, body: { identity: string; nickname?: string; confirmedLoggedIn: true }, options?: RequestOptions) { return this.data<PlatformAccount>('POST', `/api/v1/profiles/${id(profileId)}/platforms/${id(platformId)}/confirm`, body, options); }
  unlinkPlatform(profileId: string, platformId: string) { return this.data<{ deleted: boolean }>('DELETE', `/api/v1/profiles/${id(profileId)}/platforms/${id(platformId)}`); }
  openPlatformLogin(profileId: string, platformId: string) { return this.data<Record<string, unknown>>('POST', `/api/v1/profiles/${id(profileId)}/platforms/${id(platformId)}/login`, {}); }
  openManualSession(profileId: string, body: { durationSeconds?: number; explicitStart?: boolean } = {}, options?: RequestOptions) { return this.data<Record<string, unknown>>('POST', `/api/v1/profiles/${id(profileId)}/manual-sessions`, body, options); }
  closeManualSession(sessionId: string) { return this.data<Record<string, unknown>>('DELETE', `/api/v1/manual-sessions/${id(sessionId)}`); }
  submitJob(body: SubmitJob, options?: RequestOptions) { return this.data<AcceptedJob>('POST', '/api/v1/jobs', body, options); }
  listJobs(filters: JobFilters = {}) { return this.data<Page<Job>>('GET', `/api/v1/jobs${query(filters)}`); }
  getJobDensity(filters: Pick<JobFilters, 'profileId'> & { createdFrom: string; createdBefore: string }) { return this.data<JobDensity>('GET', `/api/v1/jobs/density${query(filters)}`); }
  getJob(jobId: string, options?: RequestOptions) { return this.data<Job>('GET', `/api/v1/jobs/${id(jobId)}`, undefined, options); }
  cancelJob(jobId: string) { return this.data<Job>('POST', `/api/v1/jobs/${id(jobId)}/cancel`, {}); }
  resumeJob(jobId: string) { return this.data<Job>('POST', `/api/v1/jobs/${id(jobId)}/resume`, {}); }
  async waitForJob(jobId: string, options: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal; onProgress?: (job: Job) => void } = {}): Promise<Job> {
    const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 300_000), ...(options.signal ? [options.signal] : [])]);
    while (true) {
      signal.throwIfAborted();
      const job = await this.getJob(jobId, { signal });
      options.onProgress?.(job);
      if (terminal.has(job.status) || job.status === 'waiting_for_human') return job;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, options.intervalMs ?? 1000);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
  exportCookies(profileId: string, body: Pick<TransferOptions, 'domains'> = {}, options?: RequestOptions) { return this.transfer(profileId, 'cookies', 'export', body, options); }
  importCookies(profileId: string, body: TransferOptions & { artifactId: string }, options?: RequestOptions) { return this.transfer(profileId, 'cookies', 'import', body, options); }
  exportStorageState(profileId: string, body: Pick<TransferOptions, 'domains'> = {}, options?: RequestOptions) { return this.transfer(profileId, 'storage-state', 'export', body, options); }
  importStorageState(profileId: string, body: TransferOptions & { artifactId: string }, options?: RequestOptions) { return this.transfer(profileId, 'storage-state', 'import', body, options); }
  private transfer(profileId: string, kind: string, direction: string, body: unknown, options?: RequestOptions) { return this.data<AcceptedJob>('POST', `/api/v1/profiles/${id(profileId)}/${kind}/${direction}`, body, options); }
  listSnapshots(profileId: string) { return this.data<Page<Record<string, unknown>>>('GET', `/api/v1/profiles/${id(profileId)}/snapshots`); }
  backupProfile(profileId: string, options?: RequestOptions) { return this.data<AcceptedJob>('POST', `/api/v1/profiles/${id(profileId)}/snapshots`, {}, options); }
  restoreProfile(profileId: string, snapshotId: string, options?: RequestOptions) { return this.data<AcceptedJob>('POST', `/api/v1/profiles/${id(profileId)}/restore`, { snapshotId }, options); }
  uploadArtifact(body: { profileId: string; type: string; base64: string; [key: string]: unknown }) { return this.data<Artifact>('POST', '/api/v1/artifacts', body); }
  getArtifact(artifactId: string) { return this.data<Artifact>('GET', `/api/v1/artifacts/${id(artifactId)}`); }
  /** Each download rechecks platform and profile permissions; no URL credentials. */
  async downloadArtifact(artifactId: string, options: RequestOptions = {}): Promise<Uint8Array> {
    const token = typeof this.options.token === 'function' ? await this.options.token() : this.options.token;
    const signal = AbortSignal.any([AbortSignal.timeout(this.options.timeoutMs ?? 30_000), ...(options.signal ? [options.signal] : [])]);
    let response: Response;
    try { response = await this.fetcher(new URL(`/api/v1/artifacts/${id(artifactId)}/download`, this.baseUrl), { headers: token ? { authorization: `Bearer ${token}` } : {}, signal, redirect: 'error' }); }
    catch { throw new FleetError('TRANSPORT_ERROR', '下载连接失败或超时', 0); }
    if (!response.ok) {
      let body: Record<string, unknown> = {};
      try { body = await response.json() as Record<string, unknown>; } catch { /* HTTP status remains available. */ }
      throw new FleetError(typeof body.code === 'string' ? body.code : 'HTTP_ERROR', '文件下载失败，请检查文件权限与有效期', response.status, typeof body.requestId === 'string' ? body.requestId : undefined);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
  listUpdates(filters: Pagination = {}) { return this.data<Page<Record<string, unknown>>>('GET', `/api/v1/updates${query(filters)}`); }

  listBrowserVersions() { return this.data<Page<Record<string, unknown>>>('GET', '/api/v1/browser-versions'); }
  getUpdatePolicy() { return this.data<Record<string, unknown>>('GET', '/api/v1/update-policy'); }
  setUpdatePolicy(body: Record<string, unknown>) { return this.data<Record<string, unknown>>('PATCH', '/api/v1/update-policy', body); }
  checkBrowserUpdates(options?: RequestOptions) { return this.data<AcceptedJob>('POST', '/api/v1/updates/check', {}, options); }
  applyBrowserUpdate(body: { versionId?: string; profileIds?: string[] }, options?: RequestOptions) { return this.data<AcceptedJob>('POST', '/api/v1/updates/apply', body, options); }
  getUpdate(updateId: string) { return this.data<Record<string, unknown>>('GET', `/api/v1/updates/${id(updateId)}`); }
  rollbackBrowserUpdate(updateId: string, options?: RequestOptions) { return this.data<AcceptedJob>('POST', `/api/v1/updates/${id(updateId)}/rollback`, {}, options); }
}
