import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const environment = (overrides: Record<string, string> = {}) => ({
  ...process.env,
  FLEET_CONTROL_SUBNET: '172.30.0',
  FLEET_ALLOWED_CIDRS: '',
  FLEET_ALLOWED_PROXY_ENDPOINTS: '',
  FLEET_PROXY_POLICY_FILE: '',
  PYTHONDONTWRITEBYTECODE: '1',
  ...overrides,
});
const generate = (overrides: Record<string, string> = {}) => spawnSync(
  'python3', ['docker/browser/firewall-rules.py'], { env: environment(overrides), encoding: 'utf8' },
);

test('default Fleet firewall keeps private destination drops and only emits its own chain', () => {
  const result = generate();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\*filter\n:CF-FLEET - \[0:0\]\n:CF-FLEET-INPUT - \[0:0\]/);
  assert.match(result.stdout, /-d 10\.0\.0\.0\/8 -j DROP/);
  assert.match(result.stdout, /-d 169\.254\.0\.0\/16 -j DROP/);
  assert.doesNotMatch(result.stdout, /DOCKER-USER|-A INPUT |--dport/);
  assert.ok(result.stdout.endsWith('-A CF-FLEET -j RETURN\n-A CF-FLEET-INPUT -j DROP\nCOMMIT\n'));
  assert.match(result.stdout, /ESTABLISHED,RELATED --ctdir REPLY/);
  assert.doesNotMatch(result.stdout, /ESTABLISHED,RELATED -j RETURN/);
});

const dynamic = (profiles: unknown[], bootId = 'fixture-boot') => spawnSync('python3', ['-c', `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('rules','docker/browser/firewall-rules.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
try:
 print(module.generate_rules('','','172.30.0',json.load(sys.stdin),'fixture-boot'),end='')
except (ValueError,TypeError):
 sys.exit(1)
`], { env: environment(), input: JSON.stringify({ version: 1, bootId, profiles }), encoding: 'utf8' });
const profilePolicy = () => ({
  profileId: 'cf_550e8400-e29b-41d4-a716-446655440000', proxyVersion: 2, port: 8888,
  addresses: ['192.168.50.20'], sources: [{ interface: 'cf07e48b9cd7dd', address: '172.31.1.2' }],
});

test('automatic proxy permits exact profile sources and original TCP/UDP tuples including published-port DNAT', () => {
  const result = dynamic([profilePolicy()]);
  assert.equal(result.status, 0, result.stderr);
  for (const protocol of ['tcp', 'udp']) {
    const match = `-i cf07e48b9cd7dd -s 172.31.1.2/32 -p ${protocol} -m conntrack --ctdir ORIGINAL --ctorigdst 192.168.50.20 --ctorigdstport 8888`;
    assert.ok(result.stdout.includes(`-A CF-FLEET ${match} -j RETURN`));
    assert.ok(result.stdout.includes(`-A CF-FLEET-INPUT ${match} -j ACCEPT`));
    assert.ok(result.stdout.indexOf(match) < result.stdout.indexOf('-d 10.0.0.0/8 -j DROP'));
  }
  assert.doesNotMatch(result.stdout, /-s 172\.31\.0\.0\/16|-d 10\.0\.6\.20\/32 -j RETURN/);
  const removed = dynamic([]);
  assert.equal(removed.status, 0);
  assert.doesNotMatch(removed.stdout, /--ctorigdstport/);
  const previousBoot = dynamic([profilePolicy()], 'previous-boot');
  assert.equal(previousBoot.status, 0);
  assert.doesNotMatch(previousBoot.stdout, /--ctorigdstport/);
});

test('automatic proxy policy refuses source/rule injection, duplicate profiles, and out-of-range tuples', () => {
  for (const profile of [
    { ...profilePolicy(), port: 0 },
    { ...profilePolicy(), addresses: ['proxy.example'] },
    { ...profilePolicy(), addresses: ['::1'] },
    { ...profilePolicy(), sources: [{ interface: 'cf+ -j ACCEPT', address: '172.31.1.2' }] },
    { ...profilePolicy(), sources: [{ interface: 'eth0', address: '192.168.50.20' }] },
    { ...profilePolicy(), password: 'forbidden' },
  ]) {
    const result = dynamic([profile]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
  assert.equal(dynamic([profilePolicy(), profilePolicy()]).status, 1);
});

test('fixed helper commits active state only after successful atomic restore and preserves it on failure', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util,json,pathlib,subprocess,tempfile
spec=importlib.util.spec_from_file_location('helper','docker/browser/proxy-policy-helper.py')
helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
with tempfile.TemporaryDirectory(prefix='cf-helper-test-') as directory:
 root=pathlib.Path(directory); runtime=root/'runtime';runtime.mkdir();policy=root/'policy';policy.mkdir()
 (runtime/'base-policy.json').write_text(json.dumps({'allowedCidrs':'','legacyProxyEndpoints':'','controlSubnet':'172.30.0','backend':'nft'}))
 candidate={'version':1,'bootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'profiles':[]}
 (policy/'candidate.json').write_text(json.dumps(candidate))
 # Test policy content/commit behavior independently of the root-only ownership check.
 helper.rules_module.load_policy=lambda path: json.loads(pathlib.Path(path).read_text())
 calls=[]
 def restore(command,**kwargs):
  assert command==['iptables-nft-restore','--wait','--noflush']
  assert b'--ctdir REPLY' in kwargs['input']
  calls.append(command)
 helper.subprocess.run=restore
 helper.apply_policy(policy,runtime)
 assert json.loads((policy/'active.json').read_text())==candidate
 original=(policy/'active.json').read_text()
 def failure(*args,**kwargs): raise subprocess.CalledProcessError(1,args[0])
 helper.subprocess.run=failure
 try:
  helper.apply_policy(policy,runtime)
  raise AssertionError('failed restore cannot succeed')
 except subprocess.CalledProcessError: pass
 assert (policy/'active.json').read_text()==original
 assert len(calls)==1
 candidate['profiles']=[{'profileId':'invalid','password':'forbidden'}]
 (policy/'candidate.json').write_text(json.dumps(candidate))
 helper.subprocess.run=restore
 try:
  helper.apply_policy(policy,runtime)
  raise AssertionError('invalid policy cannot reach restore')
 except ValueError: pass
 assert len(calls)==1
 assert (policy/'active.json').read_text()==original
`], { env: environment(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('explicit proxy policy permits only exact IPv4 TCP ports before private drops', () => {
  const result = generate({
    FLEET_ALLOWED_CIDRS: '192.0.2.0/24',
    FLEET_ALLOWED_PROXY_ENDPOINTS: '192.168.50.20:8888 192.168.1.20:1 192.168.1.20:65535 192.168.50.20:8888',
  });
  assert.equal(result.status, 0, result.stderr);
  const rules = result.stdout.split('\n');
  const expected = '-A CF-FLEET -d 192.168.50.20/32 -p tcp --dport 8888 -j RETURN';
  assert.equal(rules.filter(rule => rule === expected).length, 1);
  assert.ok(rules.indexOf(expected) < rules.findIndex(rule => rule.endsWith('-j DROP')));
  assert.ok(rules.includes('-A CF-FLEET -d 192.168.1.20/32 -p tcp --dport 1 -j RETURN'));
  assert.ok(rules.includes('-A CF-FLEET -d 192.168.1.20/32 -p tcp --dport 65535 -j RETURN'));
  assert.ok(rules.includes('-A CF-FLEET -d 192.0.2.0/24 -j RETURN'));
  assert.doesNotMatch(result.stdout, /-d 10\.0\.0\.0\/8 -j RETURN|-p udp/);
});

test('all policy input is rejected before any partial rule output', () => {
  for (const endpoint of [
    '192.168.50.20:0', '192.168.50.20:65536', '192.168.50.20:-1', '192.168.50.20:+80',
    '192.168.50.20:80x', '192.168.50.20', '10.0.6.020:8888', '999.0.6.20:8888',
    'proxy.example:8888', '[::1]:8888', 'http://192.168.50.20:8888',
    'user:password@192.168.50.20:8888', '192.168.50.20:8888 --dport 22',
  ]) {
    const result = generate({ FLEET_ALLOWED_PROXY_ENDPOINTS: `192.0.2.1:3128 ${endpoint}` });
    assert.equal(result.status, 1, endpoint);
    assert.equal(result.stdout, '', 'invalid policy cannot emit a partial allowlist');
    assert.match(result.stderr, /防火墙配置无效/);
  }
  for (const overrides of [
    { FLEET_ALLOWED_CIDRS: '192.168.50.20/24' },
    { FLEET_ALLOWED_CIDRS: '::1/128' },
    { FLEET_CONTROL_SUBNET: '192.168.0' },
  ]) {
    const result = generate(overrides);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
});

test('installer refuses invalid policy before host commands or ready marker changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-firewall-policy-'));
  const trace = join(root, 'host-command-called');
  try {
    for (const name of ['id', 'iptables', 'iptables-restore', 'modprobe', 'sysctl', 'mkdir', 'chmod', 'rm', 'mktemp'])
      writeFileSync(join(root, name), '#!/bin/sh\nprintf "%s\\n" "$0" >> "$FLEET_POLICY_TEST_TRACE"\nexit 99\n', { mode: 0o700 });
    for (const invalid of [
      { FLEET_ALLOWED_PROXY_ENDPOINTS: '192.168.50.20:8888 bad:3128' },
      { FLEET_ALLOWED_CIDRS: '192.168.50.20/24' },
      { FLEET_CONTROL_SUBNET: 'invalid' },
    ]) {
      const result = spawnSync('sh', ['docker/browser/install-firewall.sh'], {
        encoding: 'utf8',
        env: environment({ ...invalid, PATH: `${root}:${process.env.PATH}`, FLEET_POLICY_TEST_TRACE: trace }),
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /防火墙配置无效/);
      assert.equal(existsSync(trace), false, 'invalid input must not touch host policy or marker commands');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
