import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { createApp } from '../../../apps/control-plane/src/app.js';
import { FleetService } from '../../../apps/control-plane/src/service.js';
import type { Config } from '../../../apps/control-plane/src/config.js';
export const fixtureToken = 'fixture-platform-token-at-least-32-chars';
export async function eventually(check: () => boolean, message: string) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 10)); }
}
export async function fixture(overrides: Partial<Config> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'chrome-fleet-test-')); await mkdir(join(root, 'secrets'));
  await Promise.all([writeFile(join(root, 'secrets/master.key'), randomBytes(32), { mode: 0o600 }), writeFile(join(root, 'secrets/admin-token'), fixtureToken), writeFile(join(root, 'secrets/runner-token'), 'fixture-runner-token')]);
  const runner = Fastify({ logger: false });
  const networkPolicyRequests: any[] = [];
  runner.post('/network-policy/sync', request => {
    assert.equal(request.headers.authorization, 'Bearer fixture-runner-token');
    networkPolicyRequests.push(request.body);
    return { applied: true, protocols: ['tcp', 'udp'] };
  });
  const states = new Map<string, string>(); const starts = new Map<string, number>();
  const runningImages = new Map<string, string>(); const browserModes = new Map<string, string>(); const startImages: string[] = []; const failCookieImages = new Set<string>(); const healthVersions = new Map<string, string>();
  let startHook: ((profileId: string, image: string) => Promise<void>) | undefined;
  const fences = new Map<string, number>();
  const executing = new Map<string, number>(); const maxExecuting = new Map<string, number>();
  let executeDelay = 30; let totalExecuting = 0; let maxTotalExecuting = 0; let origin: string;
  runner.get('/health', () => ({ data: { ready: true } }));
  runner.post('/profiles/:id/start', async (request) => {
    assert.equal(request.headers.authorization, 'Bearer fixture-runner-token');
    const pid = (request.params as { id: string }).id; const image = (request.body as { image: string }).image; runningImages.set(pid, image); startImages.push(image);
    browserModes.set(pid, (request.body as any).config?.browserMode || 'automation');
    if (startHook) await startHook(pid, image);
    fences.set(pid, 0); states.set(pid, 'running'); starts.set(pid, (starts.get(pid) ?? 0) + 1);
    return { data: { agentUrl: `${origin}/agents/${pid}`, desktopUrl: `${origin}/desktop/${pid}`, imageDigest: 'sha256:' + 'a'.repeat(64) } };
  });
  runner.post('/profiles/:id/stop', request => { const pid = (request.params as { id: string }).id; states.set(pid, 'stopped'); return { data: { stopped: true } }; });
  runner.delete('/profiles/:id/container', request => { states.delete((request.params as { id: string }).id); return { data: { removed: true } }; });
  runner.get('/profiles/:id/status', request => { const pid = (request.params as { id: string }).id; return { data: { status: states.get(pid) ?? 'stopped', browserMode: browserModes.get(pid) || 'automation', agentUrl: `${origin}/agents/${pid}` } }; });
  runner.get('/agents/:id/health', request => { const pid = (request.params as { id: string }).id; const image = runningImages.get(pid) ?? ''; return { data: { ready: true, browserMode: browserModes.get(pid) || 'automation', chromeVersion: healthVersions.get(image) ?? (image.endsWith(':new') ? '144.0.7559.0' : '143.0.7499.40'), playwrightVersion: '1.64.1' } }; });
  runner.post('/agents/:id/fence', (request, reply) => { const pid = (request.params as { id: string }).id; const token = (request.body as { token: number }).token; if (token < (fences.get(pid) ?? 0)) return reply.code(409).send({ code: 'FENCE_STALE', message: '注入严格旧租约拒绝' }); fences.set(pid, token); return { data: { fenced: true } }; });
  runner.post('/agents/:id/cookies/export', (request, reply) => { const image = runningImages.get((request.params as { id: string }).id); if (image && failCookieImages.has(image)) return reply.code(500).send({ code: 'COOKIE_DECRYPTION_FAILED', message: '注入新版 Cookie 读取失败' }); return { data: { document: { format: 'chrome-fleet.cookies', version: 1, cookies: [] }, count: 0 } }; });
  runner.post('/agents/:id/accounts/check', () => ({ data: { accounts: [] } }));
  runner.post('/agents/:id/shutdown', (request, reply) => { const pid = (request.params as { id: string }).id; const token = (request.body as { fencingToken?: number }).fencingToken; if ((fences.get(pid) ?? 0) > 0 && token !== fences.get(pid)) return reply.code(409).send({ code: 'FENCE_STALE', message: '新租约须先fence再关闭浏览器' }); return { data: { stopped: true } }; });
  runner.post('/agents/:id/execute', async request => {
    const pid = (request.params as { id: string }).id;
    executing.set(pid, (executing.get(pid) ?? 0) + 1); maxExecuting.set(pid, Math.max(maxExecuting.get(pid) ?? 0, executing.get(pid)!));
    maxTotalExecuting = Math.max(maxTotalExecuting, ++totalExecuting);
    await new Promise(resolve => setTimeout(resolve, executeDelay));
    executing.set(pid, executing.get(pid)! - 1); totalExecuting--;
    return { data: { results: [{ action: 'pages', pages: [{ id: 'page_fixture', url: 'https://example.test' }] }] } };
  });
  await runner.listen({ host: '127.0.0.1', port: 0 });
  const address = runner.server.address(); assert.ok(address && typeof address === 'object'); origin = `http://127.0.0.1:${address.port}`;
  const config: Config = { root, keyFile: join(root, 'secrets/master.key'), bootstrapTokenFile: join(root, 'secrets/admin-token'), runnerTokenFile: join(root, 'secrets/runner-token'), runnerUrl: origin, host: '127.0.0.1', port: 8080, publicUrl: 'http://127.0.0.1:8080', secureCookie: false, maxConcurrency: 3, defaultImage: 'chrome-fleet/browser:fixture', webRoot: join(root, 'web'), retentionDays: 7, ...overrides };
  const service = new FleetService(config); service.db.set('settings', 'update-policy', { mode: 'manual', paused: true });
  const { app, auth } = await createApp(config, service);
  const request = (method: string, url: string, body?: unknown, token = fixtureToken, extra: Record<string, string> = {}) => app.inject({ method: method as 'GET', url, headers: { host: '127.0.0.1:8080', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, ...(body === undefined ? {} : { payload: body as object }) });
  const create = async (name = '合成浏览器') => { const response = await request('POST', '/api/v1/profiles', { name, browserMode: 'automation', vncPassword: 'fixture1' }); assert.equal(response.statusCode, 201, response.body); return response.json().data; };
  return { root, config, service, app, auth, runner, states, starts, startImages, failCookieImages, healthVersions, executing, maxExecuting, networkPolicyRequests, request, create,
    setStartHook(hook: (profileId: string, image: string) => Promise<void>) { startHook = hook; },
    setExecuteDelay(value: number) { executeDelay = value; }, getMaxTotalExecuting() { return maxTotalExecuting; },
    async close() { await eventually(() => service.active.size === 0, 'worker未结束'); if (service.timer) clearInterval(service.timer); await app.close(); await runner.close(); service.close(); await rm(root, { recursive: true, force: true }); } };
}
