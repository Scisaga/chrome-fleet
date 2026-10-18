import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetClient, FleetError } from '../src/index.js';

function response(data: unknown, status = 200) { return new Response(JSON.stringify({ data, requestId: 'req-test' }), { status }); }
test('client preserves asynchronous envelopes and sends idempotency once', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = new FleetClient({ token: 'fixture-platform-credential', fetch: (async (url, init) => {
    calls.push({ url: String(url), init: init! }); return response({ jobId: 'job_fixture' }, 202);
  }) as typeof fetch });
  assert.deepEqual(await client.startProfile('cf_fixture', { idempotencyKey: 'start-fixture' }), { jobId: 'job_fixture' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8080/api/v1/profiles/cf_fixture/start');
  assert.equal((calls[0].init.headers as Record<string, string>)['idempotency-key'], 'start-fixture');
});
test('transport failure does not replay a browser submission or expose the request', async () => {
  let calls = 0;
  const client = new FleetClient({ token: 'fixture-sensitive', fetch: (async () => { calls++; throw new Error('fixture-sensitive'); }) as typeof fetch });
  await assert.rejects(() => client.submitJob({ profileId: 'cf_fixture', steps: [{ action: 'click', locator: { text: '确认' } }] }), error => error instanceof FleetError && error.code === 'TRANSPORT_ERROR' && !error.message.includes('fixture-sensitive'));
  assert.equal(calls, 1);
});
test('polling stops on human verification rather than replaying or waiting forever', async () => {
  let calls = 0;
  const client = new FleetClient({ fetch: (async () => response({ id: 'job_fixture', profileId: 'cf_fixture', status: calls++ ? 'waiting_for_human' : 'running' })) as typeof fetch });
  const job = await client.waitForJob('job_fixture', { intervalMs: 1 });
  assert.equal(job.status, 'waiting_for_human'); assert.equal(calls, 2);
});
test('API errors keep stable status and request ID', async () => {
  const client = new FleetClient({ fetch: (async () => new Response(JSON.stringify({ code: 'PROFILE_BUSY', message: '实例忙碌', requestId: 'req-fixture' }), { status: 409 })) as typeof fetch });
  await assert.rejects(() => client.startProfile('cf_fixture'), error => error instanceof FleetError && error.code === 'PROFILE_BUSY' && error.requestId === 'req-fixture' && error.status === 409);
});
test('cross-origin paths and redirects cannot leak platform credentials', async () => {
  let calls = 0;
  const client = new FleetClient({ fetch: (async () => { calls++; return response({}); }) as typeof fetch });
  await assert.rejects(() => client.request('GET', '//attacker.invalid/api/v1/profiles'));
  assert.equal(calls, 0);
});
test('artifact download authenticates each request and keeps binary content intact', async () => {
  const content = Uint8Array.from([0, 1, 255, 2]);
  const client = new FleetClient({ token: 'fixture-download-token', fetch: (async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:8080/api/v1/artifacts/artifact_fixture/download');
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer fixture-download-token');
    assert.equal(init?.redirect, 'error');
    return new Response(content);
  }) as typeof fetch });
  assert.deepEqual(await client.downloadArtifact('artifact_fixture'), content);
});
