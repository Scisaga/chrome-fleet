import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetError } from '@chrome-fleet/contracts';
import { fixture } from './helpers/fleet.js';

test('proxy creation, edits and disabling automatically sync only endpoint metadata', async () => {
  const f = await fixture();
  try {
    const created = await f.request('POST', '/api/v1/profiles', {
      name: '代理网络策略', vncPassword: 'fixture1',
      proxy: { enabled: true, scheme: 'http', host: '192.168.50.20', port: 8888, username: 'private-user', password: 'private-password' },
    });
    assert.equal(created.statusCode, 201);
    const id = created.json().data.id;
    assert.equal(f.networkPolicyRequests.length, 1);
    assert.deepEqual(f.networkPolicyRequests[0].profiles, [{ profileId: id, proxyVersion: 1, proxy: { host: '192.168.50.20', port: 8888 } }]);
    const saved = await f.request('PUT', `/api/v1/profiles/${id}/proxy`, { enabled: true, scheme: 'socks5', host: '192.168.0.2', port: 1080 });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(f.networkPolicyRequests.at(-1).profiles[0], { profileId: id, proxyVersion: 2, proxy: { host: '192.168.0.2', port: 1080 } });
    assert.equal((await f.request('DELETE', `/api/v1/profiles/${id}/proxy`)).statusCode, 200);
    assert.deepEqual(f.networkPolicyRequests.at(-1).profiles[0], { profileId: id, proxyVersion: 3, proxy: null });
    const serialized = JSON.stringify(f.networkPolicyRequests);
    for (const secret of ['private-user', 'private-password', 'fixture1', 'secretRef', 'credentialsRef']) assert.ok(!serialized.includes(secret));
    assert.equal(f.starts.size, 0);
    const revisions = f.networkPolicyRequests.map(request => request.revision);
    assert.ok(revisions.every((revision, index) => Number.isSafeInteger(revision) && (index === 0 || revision > revisions[index - 1])));
  } finally { await f.close(); }
});

test('sync is serialized, excludes purged profiles and retries saved desired state after failure', async () => {
  const f = await fixture();
  try {
    const profile = await f.create();
    const p = f.service.profile(profile.id);
    p.proxy = f.service.storeProxy(p, { enabled: true, scheme: 'http', host: '192.168.50.20', port: 8888 });
    f.service.saveProfile(p);
    const call = f.service.runner.call.bind(f.service.runner);
    let fail = true;
    let active = 0;
    let maxActive = 0;
    f.service.runner.call = async (path, ...args) => {
      if (path !== '/network-policy/sync') return call(path, ...args);
      active++; maxActive = Math.max(maxActive, active);
      try {
        await new Promise(resolve => setTimeout(resolve, 10));
        if (fail) throw new FleetError('RUNNER_UNAVAILABLE', '合成故障', 503);
        return await call(path, ...args);
      } finally { active--; }
    };
    assert.equal(await f.service.syncNetworkPolicy(), false);
    assert.equal(f.service.db.get<any>('settings', 'network-policy-sync').pending, true);
    assert.equal(f.service.profile(p.id).proxy!.enabled, true);
    fail = false;
    await Promise.all([f.service.syncNetworkPolicy(), f.service.syncNetworkPolicy()]);
    assert.equal(maxActive, 1);
    assert.equal(f.service.db.get<any>('settings', 'network-policy-sync').applied, true);
    p.purgedAt = new Date().toISOString(); f.service.saveProfile(p);
    await f.service.syncNetworkPolicy();
    assert.deepEqual(f.networkPolicyRequests.at(-1).profiles, []);
    assert.equal(f.starts.size, 0);
  } finally { await f.close(); }
});
