import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('proxy fixture requires auth, returns HTTP identity and restricts CONNECT destinations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cf-proxy-unit-')); const config = join(root, 'proxy.json');
  const username = 'fixture-user'; const password = 'fixture-password';
  await writeFile(config, JSON.stringify({ id: 'PROXY_FIXTURE', username, password, port: 0 }));
  const child = spawn(process.execPath, ['--experimental-strip-types', 'tests/fixtures/auth-proxy.ts'], { env: { ...process.env, FIXTURE_PROXY_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('代理fixture启动超时')), 5000);
    child.stdout.on('data', value => { logs += String(value); const ready = logs.split('\n').find(line => line.includes('"event":"ready"')); if (ready) { clearTimeout(timer); resolve(JSON.parse(ready).port); } });
    child.once('error', reject); child.once('exit', code => { clearTimeout(timer); if (code) reject(new Error('代理fixture提前退出')); });
  });
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const http = (url: string, credential?: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path: url, headers: credential ? { 'proxy-authorization': credential } : {} }, response => { let body = ''; response.on('data', part => { body += String(part); }); response.on('end', () => resolve({ status: response.statusCode!, body })); }); r.once('error', reject); r.end();
  });
  const tunnel = (target: string, credential: string) => new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${credential}\r\n\r\n`));
    let result = ''; socket.on('data', part => { result += part.toString(); socket.destroy(); resolve(result); }); socket.once('error', reject);
  });
  try {
    assert.equal((await http('http://example.com/')).status, 407);
    const accepted = await http('http://example.com/', authorization); assert.equal(accepted.status, 200); assert.ok(accepted.body.includes('PROXY_FIXTURE'));
    assert.equal((await http('http://169.254.169.254/', authorization)).status, 403);
    assert.match(await tunnel('example.com:443', 'Basic invalid'), /^HTTP\/1.1 407/);
    assert.match(await tunnel('169.254.169.254:80', authorization), /^HTTP\/1.1 403/);
    assert.equal(logs.includes(password), false); assert.equal(logs.includes(authorization), false);
  } finally { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); await rm(root, { recursive: true, force: true }); }
});
