import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopFramePreviews } from './desktop-frame-previews';

const image = () => new Blob(['synthetic'], { type: 'image/png' });
const sampledAt = new Date().toISOString();
test('frame replacement and logout release blob URLs and notify subscribed cards', async () => {
  const cache = new DesktopFramePreviews(); let changes = 0;
  const unsubscribe = cache.subscribe(() => { changes++; });
  cache.put('a', image(), sampledAt); const first = cache.get('a')!;
  assert.equal((await fetch(first.url)).status, 200);
  cache.put('a', image(), sampledAt); assert.equal(changes, 2);
  await assert.rejects(fetch(first.url));
  const latest = cache.get('a')!; const generation = cache.generation;
  cache.clear(); assert.equal(cache.get('a'), undefined); assert.ok(cache.generation > generation);
  await assert.rejects(fetch(latest.url)); assert.equal(changes, 3); unsubscribe();
});
test('frame cache has a byte budget and drops thumbnails for revoked/archived profiles', async () => {
  const cache = new DesktopFramePreviews(image().size * 2);
  cache.put('a', image(), sampledAt); cache.put('b', image(), sampledAt);
  const removed = cache.get('a')!;
  cache.put('c', image(), sampledAt); assert.equal(cache.get('a'), undefined); await assert.rejects(fetch(removed.url));
  cache.retain(new Set(['c'])); assert.equal(cache.get('b'), undefined); assert.ok(cache.get('c'));
  cache.forget('c'); assert.equal(cache.get('c'), undefined); cache.clear();
});
test('invalid timestamps, non-PNG and oversized frame exports never enter the cache', () => {
  const cache = new DesktopFramePreviews();
  for (const [blob, time] of [[new Blob(['text'], { type: 'text/html' }), sampledAt],
    [new Blob([new Uint8Array(1024 * 1024 + 1)], { type: 'image/png' }), sampledAt], [image(), 'invalid']] as const)
    cache.put('a', blob, time);
  assert.equal(cache.get('a'), undefined); cache.clear();
});
