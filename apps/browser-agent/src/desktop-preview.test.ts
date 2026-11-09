import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { X11Preview } from './desktop-preview.js';
import { createManualAgent } from './manual-agent.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
function sampler(script: string, timeout = 3000) {
  return new X11Preview(((_command, args, options) => {
    if (_command === '/usr/bin/import') assert.deepEqual(args, ['-display', ':99', '-window', 'root', '-silent', 'png:-']);
    else assert.deepEqual(args, ['png:-', '-resize', '640x400>', '-depth', '8', '-strip', 'png:-']);
    return spawn(process.execPath, ['-e', _command === '/usr/bin/import' ? script : 'process.stdin.pipe(process.stdout)'], options as Parameters<typeof spawn>[2]);
  }) as typeof spawn, timeout);
}

test('X11 capture exports bounded PNG via pipes and merges simultaneous reads', async () => {
  const capture = sampler(`process.stdout.write(Buffer.from('${png}','base64'))`);
  const first = capture.capture(), second = capture.capture(); assert.equal(first, second);
  assert.deepEqual((await first).base64, png); assert.equal((await second).mimeType, 'image/png'); capture.close();
});

test('capture rejects timeouts, oversized output, invalid PNG and command failure', async () => {
  for (const [script, timeout] of [
    ['setInterval(()=>{},1000)', 100],
    ['process.stdout.write(Buffer.alloc(1024*1024+1))', 3000],
    ["process.stdout.write('not a PNG')", 3000],
    ['process.exit(1)', 3000],
  ] as const) {
    const capture = sampler(script, timeout);
    await assert.rejects(capture.capture(), { code: 'DESKTOP_PREVIEW_UNAVAILABLE' }); capture.close();
  }
});

test('manual Agent preview is authenticated, reports capability and does not acquire or advance a fencing lease', async () => {
  const capture = sampler(`process.stdout.write(Buffer.from('${png}','base64'))`); capture.available = () => true;
  let running = true;
  const token = 'synthetic-preview-token-with-at-least-32-characters';
  const agent = createManualAgent({ authToken: token, browser: { get running() { return running; }, version: 'synthetic', ready: async () => true, close: async () => { running = false; } },
    proxyVersion: 0, playwrightVersion: 'synthetic', keyringHealth: async () => ({}), desktopReady: async () => true, closeProxy: async () => {}, preview: capture });
  const headers = { authorization: `Bearer ${token}` };
  try {
    assert.equal((await agent.app.inject({ method: 'GET', url: '/desktop/preview' })).statusCode, 401);
    const before = agent.gate.token;
    const response = await agent.app.inject({ method: 'GET', url: '/desktop/preview', headers });
    assert.equal(response.statusCode, 200); assert.equal(response.json().base64, png); assert.equal(agent.gate.token, before); assert.equal(agent.gate.busy, false);
    assert.equal((await agent.app.inject({ method: 'GET', url: '/health', headers })).json().desktopPreviewAvailable, true);
    running = false;
    assert.equal((await agent.app.inject({ method: 'GET', url: '/desktop/preview', headers })).statusCode, 503);
  } finally { await agent.app.close(); }
});
