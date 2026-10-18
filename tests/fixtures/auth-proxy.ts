/** Restricted synthetic HTTP/CONNECT proxy used only by the opt-in Docker acceptance test. */
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

const config = JSON.parse(readFileSync(process.env.FIXTURE_PROXY_CONFIG ?? '/run/fixture/config.json', 'utf8')) as { id: string; username: string; password: string; port?: number };
const expected = Buffer.from(`Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`);
const log = (event: string, values: Record<string, unknown> = {}) => process.stdout.write(JSON.stringify({ event, proxyId: config.id, ...values }) + '\n');
function authorized(value: string | undefined) {
  const actual = Buffer.from(value ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const server = createServer((request, response) => {
  if (request.url === '/__fixture_health') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ proxyId: config.id })); return; }
  if (!authorized(request.headers['proxy-authorization'])) {
    log('denied', { transport: 'http' }); response.writeHead(407, { 'proxy-authenticate': 'Basic realm="Chrome Fleet synthetic acceptance"', 'content-type': 'text/plain' }); response.end('Proxy authentication required'); return;
  }
  let target: URL;
  try { target = new URL(request.url ?? ''); } catch { response.writeHead(400); response.end(); return; }
  if (target.protocol !== 'http:' || target.hostname !== 'example.com' || (target.port && target.port !== '80')) { log('blocked', { transport: 'http' }); response.writeHead(403); response.end(); return; }
  log('http', { targetHost: 'example.com' });
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-fleet-fixture-proxy': config.id });
  response.end(`<!doctype html><title>Chrome Fleet proxy acceptance</title><p id="proxy-identity">${config.id}</p>`);
});
server.on('connect', (request, client, head) => {
  if (!authorized(request.headers['proxy-authorization'])) { log('denied', { transport: 'connect' }); client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Chrome Fleet synthetic acceptance"\r\nContent-Length: 0\r\n\r\n'); return; }
  if (request.url !== 'example.com:443') { log('blocked', { transport: 'connect' }); client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
  const upstream = connect({ host: 'example.com', port: 443 });
  let upstreamBytes = 0; let browserBytes = 0;
  upstream.once('connect', () => { log('connect', { targetHost: 'example.com', port: 443 }); client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
  client.on('data', chunk => { browserBytes += chunk.length; }); upstream.on('data', chunk => { upstreamBytes += chunk.length; });
  client.on('error', () => upstream.destroy()); upstream.on('error', () => { log('upstream_error', { targetHost: 'example.com' }); client.destroy(); });
  client.once('close', () => { upstream.destroy(); log('tunnel_closed', { targetHost: 'example.com', upstreamBytes, browserBytes }); });
});
server.on('clientError', (_error, socket) => socket.destroy());
server.listen(config.port ?? 3128, '0.0.0.0', () => log('ready', { port: (server.address() as { port: number }).port }));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { server.close(); setTimeout(() => process.exit(0), 100).unref(); });
