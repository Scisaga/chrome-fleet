import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DesktopPreviews } from '../../apps/control-plane/src/desktop-preview.js';
import type { Profile } from '@chrome-fleet/contracts';
import { fixture } from './helpers/fleet.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
const sample = (at = Date.now()) => ({ mimeType: 'image/png', base64: png.toString('base64'), sampledAt: new Date(at).toISOString() });
const path = (id: string) => `/profiles/${id}/desktop/preview`;
const source = (id = 'test') => ({ id, state: 'running', health: { desktopPreviewAvailable: true } }) as Profile;

test('preview requires automate/profile scope without manual ownership, coalesces requests and preserves lifecycle/lease/activity', async () => {
  const f = await fixture();
  try {
    const p = await f.create(); const stored = f.service.profile(p.id);
    stored.state = 'running'; stored.browserMode = 'vnc'; stored.health = { desktopPreviewAvailable: true }; f.service.saveProfile(stored);
    const before = f.service.profile(p.id); let captures = 0;
    f.service.ensureStart = async () => { throw new Error('preview must never start'); };
    f.service.agent = async (_p, target, body, token) => {
      assert.equal(target, '/desktop/preview'); assert.equal(body, undefined); assert.equal(token, undefined);
      captures++; await new Promise(resolve => setTimeout(resolve, 20)); return sample();
    };
    const owner = f.auth.issue(['automate'], [p.id], new Date(Date.now() + 60000).toISOString());
    const [first, second] = await Promise.all([f.request('GET', path(p.id), undefined, owner.token), f.request('GET', path(p.id), undefined, owner.token)]);
    for (const response of [first, second]) {
      assert.equal(response.statusCode, 200, response.body); assert.equal(response.headers['content-type'], 'image/png');
      assert.equal(response.headers['cache-control'], 'no-store'); assert.ok(response.headers['x-fleet-preview-sampled-at']);
      assert.deepEqual(response.rawPayload, png);
    }
    assert.equal(captures, 1);
    assert.equal(f.service.db.lease(p.id), undefined); assert.equal(f.service.db.list('manual-sessions').length, 0);
    for (const field of ['state', 'browserMode', 'lastActivityAt', 'updatedAt']) assert.equal(f.service.profile(p.id)[field], before[field]);
    assert.equal((await f.request('GET', path(p.id), undefined, '')).statusCode, 401);
    for (const scopes of [['read'], ['manage']]) {
      const restricted = f.auth.issue(scopes, [p.id], new Date(Date.now() + 60000).toISOString());
      assert.equal((await f.request('GET', path(p.id), undefined, restricted.token)).json().code, 'SCOPE_DENIED');
    }
    const other = f.auth.issue(['automate'], ['another-profile'], new Date(Date.now() + 60000).toISOString());
    assert.equal((await f.request('GET', path(p.id), undefined, other.token)).json().code, 'PROFILE_DENIED');
    const stopped = f.service.profile(p.id); stopped.state = 'stopped'; f.service.saveProfile(stopped);
    assert.deepEqual((await f.request('GET', path(p.id))).rawPayload, png); assert.equal(captures, 1);
    stopped.archived = true; f.service.saveProfile(stopped);
    assert.equal((await f.request('GET', path(p.id))).json().code, 'DESKTOP_PREVIEW_UNAVAILABLE');
  } finally { await f.close(); }
});

test('native and automation use authenticated JSON Agent reads with no fencing token', async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls++; assert.equal(req.url, '/desktop/preview'); assert.equal(req.method, 'GET'); assert.ok(req.headers.authorization?.startsWith('Bearer '));
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(sample()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const f = await fixture();
  try {
    for (const mode of ['vnc', 'automation'] as const) {
      const created = await f.create(); const p = f.service.profile(created.id);
      p.state = 'running'; p.browserMode = mode; p.agentUrl = `http://127.0.0.1:${address.port}`;
      p.health = { desktopPreviewAvailable: true }; f.service.saveProfile(p);
      const response = await f.request('GET', path(p.id)); assert.equal(response.statusCode, 200, response.body);
    }
    assert.equal(calls, 2); assert.equal(f.service.db.list('leases').length, 0);
  } finally { await f.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('cache expires after five seconds, preserves old images on failure/stop and handles unsupported/headless instances', async () => {
  let now = Date.now(), count = 0, fail = false;
  const p = source();
  const cache = new DesktopPreviews(() => p, async () => { count++; if (fail) throw Error('private upstream'); return sample(now); }, undefined, () => now);
  const first = await cache.get(p.id); now += 4999;
  assert.equal(await cache.get(p.id), first); assert.equal(count, 1);
  now++; const next = await cache.get(p.id); assert.notEqual(next.sampledAt, first.sampledAt);
  fail = true; now += 20000;
  assert.equal(await cache.get(p.id), next); assert.equal(count, 3);
  p.state = 'stopped'; cache.invalidate(p.id); assert.equal(await cache.get(p.id), next); assert.equal(count, 3);
  cache.close();
  for (const profile of [{ ...source(), state: 'stopped' }, { ...source(), headless: true }, { ...source(), health: {} }]) {
    const disabled = new DesktopPreviews(() => profile, async () => { throw Error('must not call Agent'); });
    await assert.rejects(disabled.get(profile.id), { code: 'DESKTOP_PREVIEW_UNAVAILABLE' }); disabled.close();
  }
});

test('global capture concurrency is two, same-instance reads coalesce and LRU eviction respects the byte budget', async () => {
  const profiles = new Map(['a', 'b', 'c'].map(id => [id, source(id)]));
  let active = 0, max = 0, calls = 0;
  const cache = new DesktopPreviews(id => profiles.get(id)!, async () => {
    calls++; max = Math.max(max, ++active); await new Promise(resolve => setTimeout(resolve, 20)); active--; return sample();
  }, png.length * 2);
  await Promise.all(['a', 'a', 'b', 'c'].map(id => cache.get(id)));
  assert.equal(calls, 3); assert.equal(max, 2);
  for (const profile of profiles.values()) profile.state = 'stopped';
  await assert.rejects(cache.get('a'), { code: 'DESKTOP_PREVIEW_UNAVAILABLE' });
  assert.deepEqual((await cache.get('b')).bytes, png); assert.deepEqual((await cache.get('c')).bytes, png); cache.close();
});

test('late captures from a prior run or deleted profile cannot replace the last valid frame', async () => {
  const p = source(); let release!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const cache = new DesktopPreviews(() => p, async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return sample(); });
  const pending = cache.get(p.id); await entered;
  p.state = 'stopped'; cache.invalidate(p.id); release();
  await assert.rejects(pending, { code: 'DESKTOP_PREVIEW_UNAVAILABLE' });
  await assert.rejects(cache.get(p.id), { code: 'DESKTOP_PREVIEW_UNAVAILABLE' }); cache.close();
  const deleting = source(); let finish!: () => void;
  const second = new DesktopPreviews(() => deleting, async () => { await new Promise<void>(resolve => { finish = resolve; }); return sample(); });
  const request = second.get(deleting.id); deleting.purgedAt = new Date().toISOString(); second.invalidate(deleting.id, true); finish();
  await assert.rejects(request, { code: 'DESKTOP_PREVIEW_UNAVAILABLE' }); second.close();
});

test('invalid, oversized and out-of-bounds Agent frames are rejected', async () => {
  const huge = Buffer.alloc(1024 * 1024 + 1);
  const wide = Buffer.from(png); wide.writeUInt32BE(641, 16);
  for (const bad of [{ ...sample(), mimeType: 'text/html' }, { ...sample(), base64: huge.toString('base64') },
    { ...sample(), base64: wide.toString('base64') }, { ...sample(), sampledAt: 'invalid' }]) {
    const cache = new DesktopPreviews(() => source(), async () => bad);
    await assert.rejects(cache.get('test'), { code: 'DESKTOP_PREVIEW_UNAVAILABLE' }); cache.close();
  }
});
