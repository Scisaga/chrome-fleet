import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers/fleet.js';

test('management URLs load the SPA directly while APIs, desktop resources and missing files keep their boundaries', async () => {
  const webRoot = await mkdtemp(join(tmpdir(), 'fleet-web-routes-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>fleet-route-fixture</title>');
  const f = await fixture({ webRoot });
  try {
    const id = 'cf_00000000-0000-4000-8000-000000000001';
    for (const path of ['/profiles', '/accounts', '/jobs?job=fixture', '/updates', '/guide', '/profiles/new?from=accounts&account=fixture', `/profiles/${id}/settings`, `/profiles/${id}/accounts`, '/unknown-management-page']) {
      const response = await f.request('GET', path, undefined, '');
      assert.equal(response.statusCode, 200, path);
      assert.match(response.headers['content-type']!, /text\/html/);
      assert.match(response.body, /fleet-route-fixture/);
    }
    for (const path of ['/api/unknown', '/api/v1/missing', '/assets/missing.js', '/favicon-missing.svg', '/mcp/missing', '/ready/missing', '/profiles/invalid/desktop-missing.js']) {
      const response = await f.request('GET', path, undefined, '');
      assert.equal(response.statusCode, 404, path);
      assert.doesNotMatch(response.body, /fleet-route-fixture/);
    }
    const desktop = await f.request('GET', `/profiles/${id}/desktop/missing.js`, undefined, '');
    assert.equal(desktop.statusCode, 401);
    assert.doesNotMatch(desktop.body, /fleet-route-fixture/);
    const mutation = await f.request('POST', '/profiles/unknown-view', {}, '');
    assert.equal(mutation.statusCode, 404);
    assert.doesNotMatch(mutation.body, /fleet-route-fixture/);
  } finally { await f.close(); await rm(webRoot, { recursive: true, force: true }); }
});
