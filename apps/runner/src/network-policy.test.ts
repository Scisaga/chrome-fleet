import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { NetworkPolicy, NetworkPolicySync, helperContainerSpec } from './network-policy.js';
import { RunnerError, StartBody } from './policy.js';

const a = 'cf_550e8400-e29b-41d4-a716-446655440000';
const b = 'cf_550e8400-e29b-41d4-a716-446655440001';
const approvedImage = `sha256:${'a'.repeat(64)}`;
class FakeDocker {
  running = true;
  approved = true;
  helperSpecs: any[] = [];
  async call<T = any>(method: string, path: string, body?: any): Promise<T> {
    const profileId = decodeURIComponent(path.match(/^\/containers\/(cf_[^/]+)\/json$/)?.[1] || '');
    if (profileId) return {
      Config: { Labels: { 'chrome-fleet.managed': 'true', 'chrome-fleet.profile': profileId } }, State: { Running: this.running },
      NetworkSettings: { Networks: { [`cf_egress_${profileId.slice(3)}`]: { IPAddress: '172.31.1.2' }, 'chrome-fleet-control': { IPAddress: '172.30.0.32' } } },
    } as T;
    const networkId = decodeURIComponent(path.match(/^\/networks\/cf_egress_(.+)$/)?.[1] || '');
    if (networkId) { const id = `cf_${networkId}`; return { Internal: false, Labels: { 'chrome-fleet.profile': id }, Options: { 'com.docker.network.bridge.name': `cf${createHash('sha256').update(id).digest('hex').slice(0, 12)}` } } as T; }
    if (path === '/networks/chrome-fleet-control') return { Id: 'b'.repeat(64) } as T;
    if (path.startsWith('/images/')) return { Id: approvedImage, Config: { Labels: this.approved ? { 'chrome-fleet.network-policy-helper': 'true' } : {} } } as T;
    if (method === 'POST' && path === '/containers/create') { this.helperSpecs.push(body); return { Id: `helper-${this.helperSpecs.length}` } as T; }
    if (/^\/containers\/helper-\d+\/wait\?/.test(path)) return { StatusCode: 0 } as T;
    if (/^\/containers\/helper-\d+/.test(path)) return {} as T;
    throw new Error(`Unexpected fake Docker operation: ${method} ${path}`);
  }
}
async function fixture(resolver = async (_host: string) => ['192.168.50.20']) {
  const root = await mkdtemp(join(tmpdir(), 'cf-network-policy-'));
  const docker = new FakeDocker();
  const manager = new NetworkPolicy(docker, root, 'chrome-fleet-control', 'chrome-fleet/runner:0.1.0', resolver, process.getuid?.() ?? 0);
  return { root, docker, manager, active: async () => JSON.parse(await readFile(join(root, 'network-policy/candidate.json'), 'utf8')), close: () => rm(root, { recursive: true, force: true }) };
}
const body = (revision: number, proxyVersion = 1, host = '192.168.50.20') => NetworkPolicySync.parse({ revision, profiles: [{ profileId: a, proxyVersion, proxy: { host, port: 8888 } }] });

test('proxy host normalization accepts uppercase/IDNA and excludes credentials from persisted network state', async () => {
  const f = await fixture(async host => { assert.equal(host, 'proxy.example'); return ['192.168.50.20']; });
  try {
    const result = await f.manager.sync(body(1, 1, 'PrOxY.Example.'));
    assert.deepEqual(result.protocols, ['tcp', 'udp']);
    assert.equal(result.activeProfiles, 1);
    await f.manager.ensureProfile(a, StartBody.parse({ image: 'chrome-fleet/browser:google-stable', config: { proxy: { server: 'http://PROXY.EXAMPLE:8888', username: 'secret-user', password: 'secret-value' }, proxyVersion: 1 } }).config);
    const saved = await readFile(join(f.root, 'network-policy/desired.json'), 'utf8');
    assert.equal(saved.includes('secret-user') || saved.includes('secret-value'), false);
    assert.equal(JSON.parse(saved).profiles[0].proxy.host, 'proxy.example');
    assert.equal(body(2, 2, '例子.测试').profiles[0].proxy!.host, 'xn--fsqu00a.xn--0zwm56d');
    assert.equal(NetworkPolicySync.safeParse({ revision: 2, profiles: [{ profileId: a, proxyVersion: 2, proxy: { host: 'proxy.example', port: 8888, password: 'forbidden' } }] }).success, false);
  } finally { await f.close(); }
});

test('new snapshots replace endpoints, tombstone removals, and reject stale sync/start without overwriting other profiles', async () => {
  const f = await fixture();
  try {
    await f.manager.sync(NetworkPolicySync.parse({ revision: 1, profiles: [...body(1).profiles, { profileId: b, proxyVersion: 1, proxy: { host: '192.168.1.20', port: 3128 } }] }));
    await f.manager.ensureProfile(a, StartBody.parse({ image: 'chrome-fleet/browser:google-stable', config: { proxy: { server: 'http://10.0.6.21:9999' }, proxyVersion: 2 } }).config);
    await f.manager.refresh();
    assert.deepEqual((await f.active()).profiles.map((entry: any) => [entry.profileId, entry.addresses[0], entry.port]).sort(), [[a, '10.0.6.21', 9999], [b, '192.168.1.20', 3128]].sort());
    await assert.rejects(f.manager.sync(body(0)), { code: 'NETWORK_POLICY_STALE' });
    await assert.rejects(f.manager.ensureProfile(a, StartBody.parse({ image: 'chrome-fleet/browser:google-stable', config: { proxy: { server: 'http://192.168.50.20:8888' }, proxyVersion: 1 } }).config), { code: 'NETWORK_POLICY_STALE' });
    await f.manager.sync(NetworkPolicySync.parse({ revision: 2, profiles: [] }));
    assert.equal((await f.active()).profiles.length, 0);
    await assert.rejects(f.manager.ensureProfile(a, StartBody.parse({ image: 'chrome-fleet/browser:google-stable', config: { proxy: { server: 'http://10.0.6.21:9999' }, proxyVersion: 2 } }).config), { code: 'NETWORK_POLICY_STALE' });
    const restarted = new NetworkPolicy(f.docker, f.root, 'chrome-fleet-control', undefined, undefined, process.getuid?.() ?? 0);
    await assert.rejects(restarted.sync(body(1)), { code: 'NETWORK_POLICY_STALE' });
  } finally { await f.close(); }
});

test('DNS refresh replaces old IPs, resolution failure revokes old grants, and stopped instances have no sources', async () => {
  let addresses = ['192.168.50.20'];
  const f = await fixture(async () => { if (!addresses.length) throw new Error('DNS fixture failure'); return addresses; });
  try {
    await f.manager.sync(body(1, 1, 'proxy.example'));
    addresses = ['10.0.6.21'];
    await f.manager.refresh();
    assert.deepEqual((await f.active()).profiles[0].addresses, addresses);
    addresses = [];
    await assert.rejects(f.manager.refresh(), { code: 'PROXY_DNS_FAILED' });
    assert.equal((await f.active()).profiles.length, 0);
    assert.equal(f.manager.pending, true);
    addresses = ['10.0.6.22'];
    await f.manager.refresh();
    assert.equal(f.manager.pending, false);
    f.docker.running = false;
    await f.manager.refresh();
    assert.equal((await f.active()).profiles.length, 0);
  } finally { await f.close(); }
});

test('fixed helper requires an approved immutable image and gets only host NET_ADMIN plus policy mounts', async () => {
  const spec = helperContainerSpec(approvedImage, '/fixture/network-policy');
  assert.equal(spec.Image, approvedImage);
  assert.deepEqual(spec.Entrypoint, ['python3']);
  assert.deepEqual(spec.Cmd, ['/app/docker/browser/proxy-policy-helper.py']);
  assert.equal(spec.HostConfig.NetworkMode, 'host');
  assert.equal(spec.HostConfig.Privileged, false);
  assert.equal(spec.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(spec.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(spec.HostConfig.CapAdd, ['NET_ADMIN']);
  assert.deepEqual(spec.HostConfig.Binds, ['/fixture/network-policy:/policy:rw', '/run/chrome-fleet:/run/chrome-fleet:rw', '/run/xtables.lock:/run/xtables.lock:rw']);
  assert.doesNotMatch(JSON.stringify(spec), /docker\.sock|secrets|agent-token|password|keyring/);
  const f = await fixture();
  try {
    f.docker.approved = false;
    await assert.rejects(f.manager.sync(body(1)), { code: 'NETWORK_HELPER_IMAGE_INVALID' });
    assert.equal(f.docker.helperSpecs.length, 0);
  } finally { await f.close(); }
});
