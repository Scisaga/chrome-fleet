import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket, WebSocketServer } from 'ws';
import { createOriginPolicy, normalizeOrigin, parseAllowedOrigins } from '../../apps/control-plane/src/origin-policy.js';
import { loadConfig } from '../../apps/control-plane/src/config.js';
import { fixture, fixtureToken } from './helpers/fleet.js';

const lanOrigins = ['http://192.168.50.10:8080', 'http://10.200.0.1:8080', 'http://10.201.0.1:8080'];
const config = { publicUrl: lanOrigins[0], port: 8080, allowedOrigins: lanOrigins };

test('origin configuration accepts exact LAN/WireGuard/loopback origins and rejects wildcard or mixed authorities', async () => {
  const policy = createOriginPolicy(config);
  for (const origin of [...lanOrigins, 'http://127.0.0.1:8080', 'http://localhost:8080', 'http://[::1]:8080']) {
    assert.equal(policy.acceptsHost(new URL(origin).host), true);
    assert.equal(policy.acceptsOrigin(origin, new URL(origin).host, true), true);
  }
  assert.equal(policy.acceptsOrigin(lanOrigins[1], new URL(lanOrigins[0]).host), false);
  assert.equal(policy.acceptsOrigin('null', new URL(lanOrigins[0]).host), false);
  assert.equal(policy.acceptsOrigin(undefined, new URL(lanOrigins[0]).host, true), false);
  assert.equal(policy.acceptsHost('0.0.0.0:8080'), false);
  assert.equal(policy.acceptsHost('evil.invalid:8080'), false);
  assert.deepEqual(parseAllowedOrigins(`${lanOrigins[0]}, ${lanOrigins[0]}`), [lanOrigins[0]]);
  for (const value of ['*', 'http://*.example.test:8080', 'http://0.0.0.0:8080', 'http://[::]:8080', 'http://example.test/path', 'http://user:secret@example.test', 'http://example.test?token=sample']) assert.throws(() => normalizeOrigin(value));
  const f = await fixture();
  try {
    const actual = loadConfig({ FLEET_DATA_ROOT: f.root, FLEET_PUBLIC_URL: lanOrigins[0], FLEET_ALLOWED_ORIGINS: lanOrigins.join(','), FLEET_HOST: '0.0.0.0' });
    assert.deepEqual(actual.allowedOrigins, lanOrigins); assert.equal(actual.host, '0.0.0.0');
    assert.throws(() => loadConfig({ FLEET_DATA_ROOT: f.root, FLEET_ALLOWED_ORIGINS: '*' }));
  } finally { await f.close(); }
});
test('REST and integrated HTTP MCP accept each configured authority and reject cross-authority Origin', async () => {
  const f = await fixture(config);
  try {
    for (const origin of [...lanOrigins, 'http://127.0.0.1:8080']) {
      const headers = { host: new URL(origin).host, origin };
      const listed = await f.request('GET', '/api/v1/profiles', undefined, fixtureToken, headers); assert.equal(listed.statusCode, 200, listed.body);
      const initialized = await f.request('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lan-origin-test', version: '1' } } }, fixtureToken, { ...headers, accept: 'application/json, text/event-stream' });
      assert.equal(initialized.statusCode, 200, initialized.body); assert.equal(initialized.json().result.protocolVersion, '2025-11-25');
    }
    for (const url of ['/api/v1/profiles', '/mcp']) {
      const method = url === '/mcp' ? 'POST' : 'GET'; const body = method === 'POST' ? {} : undefined;
      const mixed = await f.request(method, url, body, fixtureToken, { host: '192.168.50.10:8080', origin: lanOrigins[1] }); assert.equal(mixed.statusCode, 403);
      const badHost = await f.request(method, url, body, fixtureToken, { host: 'evil.invalid:8080', origin: lanOrigins[0] }); assert.equal(badHost.statusCode, 403);
      const badOrigin = await f.request(method, url, body, fixtureToken, { host: '192.168.50.10:8080', origin: 'https://evil.invalid' }); assert.equal(badOrigin.statusCode, 403);
    }
    const nativeClient = await f.request('GET', '/api/v1/profiles', undefined, fixtureToken, { host: '10.200.0.1:8080' }); assert.equal(nativeClient.statusCode, 200);
  } finally { await f.close(); }
});
test('desktop WebSocket checks exact configured Host/Origin pairs and still requires platform authentication', async () => {
  const f = await fixture(config); const clients = new Set<WebSocket>();
  const upstream = new WebSocketServer({ noServer: true });
  f.runner.server.on('upgrade', (request, socket, head) => upstream.handleUpgrade(request, socket, head, client => client.on('message', message => client.send(message))));
  try {
    const profile = await f.create(); const opened = await f.request('POST', `/api/v1/profiles/${profile.id}/manual-sessions`, { durationSeconds: 60 }); assert.equal(opened.statusCode, 201);
    await f.app.listen({ host: '127.0.0.1', port: 0 }); const address = f.app.server.address(); assert.ok(address && typeof address === 'object');
    const url = `ws://127.0.0.1:${address.port}/profiles/${profile.id}/desktop/websockify`;
    const connect = (host: string, origin?: string, token = fixtureToken) => new Promise<WebSocket>((resolve, reject) => {
      const client = new WebSocket(url, { headers: { host, ...(origin === undefined ? {} : { origin }), ...(token ? { authorization: `Bearer ${token}` } : {}) } }); clients.add(client);
      const timer = setTimeout(() => { client.terminate(); reject(new Error('WebSocket鉴权超时')); }, 3000);
      client.once('open', () => { clearTimeout(timer); resolve(client); }); client.once('error', error => { clearTimeout(timer); reject(error); });
    });
    for (const origin of [...lanOrigins, 'http://127.0.0.1:8080']) {
      const client = await connect(new URL(origin).host, origin); const echoed = new Promise<string>(resolve => client.once('message', message => resolve(message.toString()))); client.send('fixture-lan-desktop'); assert.equal(await echoed, 'fixture-lan-desktop'); client.close();
    }
    await assert.rejects(() => connect('192.168.50.10:8080', lanOrigins[1]));
    await assert.rejects(() => connect('evil.invalid:8080', lanOrigins[0]));
    await assert.rejects(() => connect('192.168.50.10:8080', 'https://evil.invalid'));
    await assert.rejects(() => connect('192.168.50.10:8080'));
    await assert.rejects(() => connect('192.168.50.10:8080', lanOrigins[0], ''));
  } finally {
    for (const client of clients) client.terminate(); await f.close(); upstream.close();
  }
});
