import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Docker } from './docker.js';

test('Docker metrics requests enforce an absolute deadline despite trickling data and reject aborted responses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-docker-deadline-'));
  const socketPath = join(root, 'docker.sock');
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.write('{');
    if (req.url?.endsWith('/abort')) { setTimeout(() => res.destroy(), 10); return; }
    const timer = setInterval(() => res.write(' '), 10);
    res.once('close', () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  try {
    const docker = new Docker(socketPath);
    const deadline = performance.now();
    await assert.rejects(docker.call('GET', '/trickle', undefined, 70), (error: any) => error.code === 'DOCKER_UNAVAILABLE');
    assert.ok(performance.now() - deadline < 500, 'response bytes must not renew the absolute deadline');
    await assert.rejects(docker.call('GET', '/abort', undefined, 300), (error: any) => error.code === 'DOCKER_UNAVAILABLE');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
