import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpServer, installMcpHttp } from '../src/index.js';
import type { ApiCall } from '@chrome-fleet/sdk';

const required = ['profiles_list','profiles_get','profiles_create','profiles_start','profiles_stop','profiles_restart','profiles_runtime_policy_set','profiles_proxy_get','profiles_proxy_set','profiles_proxy_test','profiles_vnc_password_set','manual_session_open','manual_session_close','jobs_submit','jobs_get','jobs_cancel','jobs_resume','browser_pages_list','browser_navigate','browser_click','browser_fill','browser_extract','browser_screenshot','cookies_export','cookies_import','storage_state_export','storage_state_import','profiles_backup','profiles_restore','artifacts_get','browser_versions_list','browser_updates_check','browser_updates_apply','browser_updates_rollback'];

test('official client initializes, discovers all tools and queues single browser steps', async () => {
  const received: unknown[][] = [];
  const call: ApiCall = async (...args) => { received.push(args); return { data: { jobId: 'job_fixture' }, requestId: 'req_fixture' }; };
  const server = createMcpServer(call);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture', version: '1' });
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    assert.deepEqual(new Set(listed.tools.map(t => t.name)), new Set(required));
    assert.ok(listed.tools.every(t => t.inputSchema && t.outputSchema && t.annotations));
    const result = await client.callTool({ name: 'browser_click', arguments: { profileId: 'cf_fixture', locator: { css: '#submit' }, idempotencyKey: 'fixture-click' } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(received.at(-1)?.slice(0, 3), ['POST', '/api/v1/jobs', { profileId: 'cf_fixture', steps: [{ action: 'click', locator: { css: '#submit' } }] }]);
  } finally { await client.close(); await server.close(); }
});
test('secret-only tools reject raw password fields and MCP removes secrets from API responses', async () => {
  let invoked = false;
  const server = createMcpServer(async () => { invoked = true; return { data: { id: 'cf_fixture', password: 'fixture-secret', cookies: [{ value: 'cookie-secret' }], proxy: { password: 'proxy-secret', secretRef: 'sec_fixture' } }, requestId: 'req_fixture' }; });
  const [ct, st] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'fixture', version: '1' });
  await server.connect(st); await client.connect(ct);
  try {
    const invalid = await client.callTool({ name: 'profiles_vnc_password_set', arguments: { profileId: 'cf_fixture', secretRef: 'sec_fixture', password: 'do-not-accept' } });
    assert.equal(invalid.isError, true); assert.equal(invoked, false);
    const valid = await client.callTool({ name: 'profiles_get', arguments: { profileId: 'cf_fixture' } });
    assert.equal(JSON.stringify(valid).includes('fixture-secret'), false);
    assert.equal(JSON.stringify(valid).includes('cookie-secret'), false);
    assert.equal(JSON.stringify(valid).includes('proxy-secret'), false);
    assert.equal(JSON.stringify(valid).includes('sec_fixture'), true);
  } finally { await client.close(); await server.close(); }
});
test('Streamable HTTP official client: shared queue, Host/Origin checks, per-request revocation', async () => {
  const app = Fastify({ logger: false });
  let active = true; let count = 0;
  await installMcpHttp(app, () => async () => { count++; return { data: { jobId: 'job_fixture' }, requestId: 'req_fixture' }; }, { authorize: request => active && request.headers.authorization === 'Bearer fixture-platform' });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); assert.ok(address && typeof address === 'object');
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const headers = { authorization: 'Bearer fixture-platform', 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const client = new Client({ name: 'fixture-http', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { authorization: headers.authorization } } }));
    const tools = await client.listTools(); assert.equal(tools.tools.length, required.length);
    await client.callTool({ name: 'profiles_start', arguments: { profileId: 'cf_fixture' } }); assert.equal(count, 1);
    const badOrigin = await fetch(endpoint, { method: 'POST', headers: { ...headers, origin: 'https://evil.invalid' }, body: '{}' }); assert.equal(badOrigin.status, 403);
    const badHost = await app.inject({ method: 'POST', url: '/mcp', headers: { ...headers, host: 'evil.invalid' }, payload: {} }); assert.equal(badHost.statusCode, 403);
    const noAuth = await fetch(endpoint, { method: 'GET' }); assert.equal(noAuth.status, 401);
    active = false;
    const revoked = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }) }); assert.equal(revoked.status, 401);
    assert.equal(count, 1);
  } finally { await client.close(); await app.close(); }
});
test('stdio official client sees clean protocol and uses the REST API bridge', async () => {
  const requests: string[] = [];
  const api = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.headers.authorization !== 'Bearer fixture-stdio') { response.writeHead(401); response.end('{}'); return; }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: { items: [], total: 0 }, requestId: 'req_stdio' }));
  });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const address = api.address(); assert.ok(address && typeof address === 'object');
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/stdio.ts'], cwd: new URL('..', import.meta.url).pathname, env: { PATH: process.env.PATH ?? '', FLEET_TOKEN: 'fixture-stdio', FLEET_URL: `http://127.0.0.1:${address.port}` }, stderr: 'pipe' });
  const client = new Client({ name: 'fixture-stdio', version: '1' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'profiles_list', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(requests[0], 'GET /api/v1/profiles');
  } finally { await client.close(); await new Promise<void>(resolve => api.close(() => resolve())); }
});
test('explicit HTTP origin allowlists remain bound to the matching request Host', async () => {
  const app = Fastify({ logger: false });
  await installMcpHttp(app, () => async () => ({ data: {}, requestId: 'req_fixture' }), {
    authorize: () => true,
    allowedHosts: ['192.168.50.10:8080', '10.200.0.1:8080'],
    allowedOrigins: ['http://192.168.50.10:8080', 'http://10.200.0.1:8080'],
  });
  const base = { authorization: 'Bearer fixture-platform', accept: 'application/json, text/event-stream' };
  try {
    const mixed = await app.inject({ method: 'POST', url: '/mcp', headers: { ...base, host: '192.168.50.10:8080', origin: 'http://10.200.0.1:8080' }, payload: {} }); assert.equal(mixed.statusCode, 403);
    const allowed = await app.inject({ method: 'POST', url: '/mcp', headers: { ...base, host: '10.200.0.1:8080', origin: 'http://10.200.0.1:8080' }, payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } } }); assert.equal(allowed.statusCode, 200);
  } finally { await app.close(); }
  const unsafe = Fastify({ logger: false });
  try { await assert.rejects(() => installMcpHttp(unsafe, () => async () => ({ data: {}, requestId: 'req_fixture' }), { allowedOrigins: ['http://*.example.test'] })); } finally { await unsafe.close(); }
});
