import test from 'node:test';
import assert from 'node:assert/strict';
import { remainingDesktopTime, retainDesktopConnections } from './desktop-workspace';

test('connection retention evicts the least recently used frame while keeping the active frame', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepEqual(retainDesktopConnections(['a', 'b', 'c'], 'a', ids), ['b', 'c', 'a']);
  assert.deepEqual(retainDesktopConnections(['b', 'c', 'a'], 'd', ids), ['c', 'a', 'd']);
  assert.deepEqual(retainDesktopConnections(['c', 'a', 'd'], 'b', ['a', 'b']), ['a', 'b']);
});
test('takeover countdown clamps expired sessions to zero', () => {
  assert.equal(remainingDesktopTime('2026-11-10T00:15:01Z', Date.parse('2026-11-10T00:00:00Z')), '15:01');
  assert.equal(remainingDesktopTime('2026-11-10T00:00:00Z', Date.parse('2026-11-10T00:00:01Z')), '0:00');
});
