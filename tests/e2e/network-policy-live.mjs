/**
 * Opt-in Docker-host acceptance of automatic, per-profile proxy TCP/UDP policy.
 * Run as root after deployment: node tests/e2e/network-policy-live.mjs
 * Creates only synthetic profiles; never edits runtime secret files or .env.
 * Default mode never directly reloads host rules. FLEET_TEST_FIREWALL_RELOAD=1
 * opts into the fixed repository `scripts/fleet firewall` command and rechecks A/B.
 * UDP/TCP probes run in Node inside real Chrome containers: this does NOT test
 * Chrome UDP proxying, HTTP CONNECT UDP support, or an external proxy service.
 */
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer, isIP } from 'node:net';
import { createSocket } from 'node:dgram';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const base = (process.env.FLEET_TEST_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const tokenFile = process.env.FLEET_TEST_TOKEN_FILE ?? fileURLToPath(new URL('../../secrets/admin-token', import.meta.url));
const sourceIsolation = process.env.FLEET_TEST_SOURCE_ISOLATION !== '0';
const firewallReload = process.env.FLEET_TEST_FIREWALL_RELOAD === '1';
const runId = randomUUID();
const runStartedAt = Date.now();
const names = new Set([`网络策略验收-${runId}-A`, `网络策略验收-${runId}-B`]);
const ownedProfiles = new Map();
const fixtures = [];
const children = new Set();
const abort = new AbortController();
const nonce = `fleet-network-echo-${randomBytes(16).toString('hex')}`;
let token = '';
let cleaning = false;
let checks = 0;
let stage = 'preflight';
let failed = false;

class SafeFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function requireCondition(condition, code) { if (!condition) throw new SafeFailure(code); }
function pass(message) { checks++; process.stdout.write(`PASS ${message}\n`); }
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  abort.abort();
  if (!cleaning) for (const child of children) child.kill('SIGTERM');
});
const deadline = setTimeout(() => abort.abort(), 15 * 60_000);
deadline.unref();

async function api(method, path, body, key) {
  if (abort.signal.aborted && !cleaning) throw new SafeFailure('INTERRUPTED');
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    redirect: 'error',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: cleaning ? timeout : AbortSignal.any([timeout, abort.signal]),
  }).catch(() => { throw new SafeFailure('API_CONNECTION_FAILED'); });
  const document = await response.json().catch(() => { throw new SafeFailure('API_RESPONSE_INVALID'); });
  if (!response.ok) {
    const code = typeof document.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(document.code) ? document.code : 'API_ERROR';
    throw new SafeFailure(`HTTP_${response.status}_${code}`);
  }
  return document.data;
}

async function waitJob(jobId) {
  requireCondition(typeof jobId === 'string' && /^job_[0-9a-f-]{36}$/.test(jobId), 'INVALID_JOB_ID');
  const end = Date.now() + 180_000;
  while (Date.now() < end) {
    const job = await api('GET', `/jobs/${jobId}`);
    if (!['queued', 'running'].includes(job.status)) {
      requireCondition(job.status === 'succeeded', 'LIFECYCLE_JOB_FAILED');
      return job;
    }
    await sleep(500);
  }
  throw new SafeFailure('LIFECYCLE_JOB_TIMEOUT');
}
async function lifecycle(profileId, action) {
  requireOwned(profileId);
  const job = await api('POST', `/profiles/${profileId}/${action}`, {}, `network-${runId}-${action}-${profileId}`);
  return waitJob(job.jobId);
}
function requireOwned(profileId) {
  requireCondition(ownedProfiles.has(profileId) && /^cf_[0-9a-f-]{36}$/.test(profileId), 'NOT_AN_OWNED_PROFILE');
}

function command(args, input, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    if (abort.signal.aborted && !cleaning) { reject(new SafeFailure('INTERRUPTED')); return; }
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'ignore'] });
    children.add(child);
    let output = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(output.trim());
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 1000); force.unref();
      finish(new SafeFailure('DOCKER_COMMAND_TIMEOUT'));
    }, timeoutMs);
    child.stdout.on('data', value => {
      output += value.toString();
      if (output.length > 16_384) { child.kill('SIGTERM'); finish(new SafeFailure('DOCKER_OUTPUT_LIMIT')); }
    });
    child.once('error', () => { children.delete(child); finish(new SafeFailure('DOCKER_COMMAND_FAILED')); });
    child.once('close', code => { children.delete(child); finish(code === 0 ? undefined : new SafeFailure('DOCKER_COMMAND_FAILED')); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Optional, explicit host reload. No caller-supplied command, path, or arguments. */
function reloadHostFirewall() {
  return new Promise((resolve, reject) => {
    if (abort.signal.aborted) { reject(new SafeFailure('INTERRUPTED')); return; }
    const script = fileURLToPath(new URL('../../scripts/fleet', import.meta.url));
    const cwd = fileURLToPath(new URL('../../', import.meta.url));
    const child = spawn(script, ['firewall'], { cwd, stdio: 'ignore' });
    children.add(child);
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 1000); force.unref();
      finish(new SafeFailure('FIREWALL_RELOAD_TIMEOUT'));
    }, 30_000);
    child.once('error', () => { children.delete(child); finish(new SafeFailure('FIREWALL_RELOAD_FAILED')); });
    child.once('close', code => { children.delete(child); finish(code === 0 ? undefined : new SafeFailure('FIREWALL_RELOAD_FAILED')); });
  });
}

async function createProfile(label) {
  const name = `网络策略验收-${runId}-${label}`;
  const profile = await api('POST', '/profiles', {
    name,
    vncPassword: randomBytes(6).toString('base64url'),
    startupPolicy: 'on_demand',
    idleTimeoutMinutes: 0,
  }, `network-${runId}-create-${label}`);
  requireCondition(typeof profile.id === 'string' && /^cf_[0-9a-f-]{36}$/.test(profile.id), 'INVALID_PROFILE_ID');
  ownedProfiles.set(profile.id, name);
  requireCondition(profile.state === 'stopped', 'CREATE_MUST_BE_STOPPED');
  return profile.id;
}
async function inspect(profileId, template) {
  requireOwned(profileId);
  return command(['inspect', '--format', template, profileId]);
}
async function gateway(profileId) {
  const networks = JSON.parse(await inspect(profileId, '{{json .NetworkSettings.Networks}}'));
  const result = networks[`cf_egress_${profileId.slice(3)}`]?.Gateway;
  requireCondition(isIP(result ?? '') === 4 && result.startsWith('172.31.'), 'ISOLATED_GATEWAY_MISSING');
  return result;
}

/** Bind TCP and UDP to the same OS-assigned port on precisely one fixture gateway. */
async function startFixture(host, label) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const sockets = new Set();
    const counts = { tcp: 0, udp: 0 };
    const tcp = createServer(socket => {
      sockets.add(socket);
      socket.setTimeout(1500, () => socket.destroy());
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      let received = Buffer.alloc(0);
      socket.on('data', chunk => {
        received = Buffer.concat([received, chunk]);
        const text = received.toString();
        if (nonce.startsWith(text) && text.length < nonce.length) return;
        if (text === nonce) { counts.tcp++; socket.end(received); return; }
        // Harmless local HTTP proxy fixture; no upstream traffic or request logging.
        if (/^CONNECT /i.test(text)) { socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
        if (/^(?:GET|HEAD) /i.test(text)) {
          const body = `fleet-network-fixture-${label}`;
          socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
          return;
        }
        socket.destroy();
      });
    });
    const udp = createSocket('udp4');
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise(resolve => { try { tcp.close(() => resolve()); } catch { resolve(); } }),
        new Promise(resolve => { try { udp.close(() => resolve()); } catch { resolve(); } }),
      ]);
    };
    try {
      await new Promise((resolve, reject) => {
        tcp.once('error', reject);
        tcp.listen({ host, port: 0 }, () => { tcp.removeListener('error', reject); resolve(); });
      });
      const port = tcp.address().port;
      await new Promise((resolve, reject) => {
        udp.once('error', reject);
        udp.bind(port, host, () => { udp.removeListener('error', reject); resolve(); });
      });
      let unhealthy = false;
      tcp.on('error', () => { unhealthy = true; });
      udp.on('error', () => { unhealthy = true; });
      udp.on('message', (message, peer) => {
        if (message.toString() !== nonce) return;
        counts.udp++;
        udp.send(message, peer.port, peer.address, () => {});
      });
      const fixture = { host, port, counts, close, healthy: () => !unhealthy };
      fixtures.push(fixture);
      return fixture;
    } catch {
      await close();
    }
  }
  throw new SafeFailure('FIXTURE_BIND_FAILED');
}

async function probe(profileId, endpoint) {
  requireOwned(profileId);
  const source = `
import {connect} from 'node:net';
import {createSocket} from 'node:dgram';
const host=${JSON.stringify(endpoint.host)},port=${endpoint.port},payload=Buffer.from(${JSON.stringify(nonce)});
const tcp=new Promise(resolve=>{
  const socket=connect({host,port});let finished=false,received=Buffer.alloc(0);
  const done=status=>{if(finished)return;finished=true;clearTimeout(timer);socket.destroy();resolve(status);};
  const timer=setTimeout(()=>done('timeout'),2500);
  socket.once('connect',()=>socket.write(payload));socket.once('error',()=>done('error'));
  socket.on('data',chunk=>{received=Buffer.concat([received,chunk]);if(received.length>=payload.length)done(received.equals(payload)?'echo':'bad_echo');});
  socket.once('end',()=>{if(!finished)done('closed');});
});
const udp=new Promise(resolve=>{
  const socket=createSocket('udp4');let finished=false;
  const done=status=>{if(finished)return;finished=true;clearTimeout(timer);try{socket.close();}catch{}resolve(status);};
  const timer=setTimeout(()=>done('timeout'),2500);
  socket.once('error',()=>done('error'));socket.once('message',message=>done(message.equals(payload)?'echo':'bad_echo'));
  socket.bind(0,()=>socket.send(payload,port,host,error=>{if(error)done('error');}));
});
const [tcpResult,udpResult]=await Promise.all([tcp,udp]);
process.stdout.write(JSON.stringify({tcp:tcpResult,udp:udpResult}));
`;
  const result = JSON.parse(await command(['exec', '-i', profileId, 'node', '--input-type=module'], source, 10_000));
  requireCondition(['echo', 'timeout', 'error', 'bad_echo', 'closed'].includes(result.tcp) && ['echo', 'timeout', 'error', 'bad_echo'].includes(result.udp), 'PROBE_RESULT_INVALID');
  return result;
}
async function expectNetwork(profileId, endpoint, allowed) {
  const expected = allowed ? 'echo' : 'timeout';
  const end = Date.now() + 25_000;
  let last;
  while (Date.now() < end) {
    requireCondition(endpoint.healthy(), 'FIXTURE_SERVER_FAILED');
    last = await probe(profileId, endpoint);
    if (last.tcp === expected && last.udp === expected) return;
    await sleep(500);
  }
  throw new SafeFailure(`POLICY_${allowed ? 'ALLOW' : 'BLOCK'}_TCP_${last?.tcp ?? 'missing'}_UDP_${last?.udp ?? 'missing'}`);
}
async function configure(profileId, endpoint) {
  requireOwned(profileId);
  return api('PUT', `/profiles/${profileId}/proxy`, {
    enabled: true, scheme: 'http', host: endpoint.host, port: endpoint.port, bypass: '',
  });
}

/** Recover a lost create response using only exact UUID fixture names. */
async function recoverOwnedProfiles() {
  if (!token) return;
  const list = await api('GET', `/profiles?search=${encodeURIComponent(runId)}&limit=100`);
  for (const profile of list.items ?? []) {
    if (names.has(profile.name) && Date.parse(profile.createdAt) >= runStartedAt - 2000 && /^cf_[0-9a-f-]{36}$/.test(profile.id)) ownedProfiles.set(profile.id, profile.name);
  }
}
async function cleanup() {
  cleaning = true;
  let success = true;
  await recoverOwnedProfiles().catch(() => { success = false; });
  for (const [profileId, name] of [...ownedProfiles].reverse()) {
    try {
      const profile = await api('GET', `/profiles/${profileId}`);
      requireCondition(profile.name === name && names.has(name), 'CLEANUP_OWNERSHIP_CHANGED');
      if (!profile.archived) await waitJob((await api('DELETE', `/profiles/${profileId}`)).jobId);
      await api('POST', `/profiles/${profileId}/purge`, { confirmation: profileId });
    } catch {
      success = false;
      process.stderr.write(`FAIL cleanup ownedProfileId=${profileId}\n`);
    }
  }
  await Promise.all(fixtures.map(fixture => fixture.close()));
  if (success) pass(`仅归档并清理本轮合成实例 count=${ownedProfiles.size}`);
  return success;
}

try {
  requireCondition(process.getuid?.() === 0, 'ROOT_REQUIRED');
  requireCondition(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'TLS_VERIFY_DISABLED');
  const url = new URL(base);
  requireCondition(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/', 'INVALID_API_ORIGIN');
  token = (await readFile(tokenFile, 'utf8')).trim();
  requireCondition(token.length >= 32, 'INVALID_PLATFORM_CREDENTIAL');
  stage = 'create-and-start';
  const profileId = await createProfile('A');
  await lifecycle(profileId, 'start');
  const host = await gateway(profileId);
  const endpointA = await startFixture(host, 'A');
  const endpointB = await startFixture(host, 'B');
  requireCondition(endpointA.port !== endpointB.port, 'FIXTURE_PORT_COLLISION');
  pass('真实Chrome已启动，两个TCP/UDP夹具仅绑定其隔离出站网关');

  stage = 'proxy-a';
  const configuredA = await configure(profileId, endpointA);
  await lifecycle(profileId, 'restart');
  const profile = await api('GET', `/profiles/${profileId}`);
  requireCondition(profile.state === 'running' && profile.health?.ready === true && /^\d+\./.test(profile.chromeVersion ?? ''), 'REAL_CHROME_NOT_READY');
  requireCondition(profile.proxy?.version === configuredA.version && profile.proxy?.appliedVersion === configuredA.version && profile.health?.proxyVersion === configuredA.version, 'BROWSER_PROXY_VERSION_MISMATCH');
  await expectNetwork(profileId, endpointA, true);
  await expectNetwork(profileId, endpointB, false);
  pass('配置端点A允许容器Node TCP/UDP回显，未配置端点B新连接均超时');

  if (firewallReload) {
    stage = 'firewall-reload';
    await reloadHostFirewall();
    await expectNetwork(profileId, endpointA, true);
    await expectNetwork(profileId, endpointB, false);
    pass('可选宿主防火墙重载后，A TCP/UDP仍允许且未配置B仍超时');
  }

  if (sourceIsolation) {
    stage = 'source-isolation';
    const otherId = await createProfile('B');
    await lifecycle(otherId, 'start');
    await expectNetwork(otherId, endpointA, false);
    await expectNetwork(otherId, endpointB, false);
    pass('第二个无代理合成实例不能访问A/B，来源隔离有效');
  }

  stage = 'proxy-b-without-restart';
  const startedAt = await inspect(profileId, '{{.State.StartedAt}}');
  const configuredB = await configure(profileId, endpointB);
  requireCondition(configuredB.version > configuredA.version && configuredB.appliedVersion === configuredA.version, 'SAVE_MUST_NOT_RESTART_BROWSER');
  await expectNetwork(profileId, endpointB, true);
  await expectNetwork(profileId, endpointA, false);
  requireCondition(await inspect(profileId, '{{.State.StartedAt}}') === startedAt, 'CONTAINER_UNEXPECTEDLY_RESTARTED');
  pass('仅保存代理B即同步TCP/UDP，新B允许且旧A新连接超时，无重启');

  stage = 'disable-proxy';
  const disabled = await api('DELETE', `/profiles/${profileId}/proxy`);
  requireCondition(disabled.enabled === false, 'PROXY_DISABLE_FAILED');
  await expectNetwork(profileId, endpointB, false);
  requireCondition(await inspect(profileId, '{{.State.StartedAt}}') === startedAt, 'CONTAINER_UNEXPECTEDLY_RESTARTED');
  requireCondition(endpointA.counts.tcp > 0 && endpointA.counts.udp > 0 && endpointB.counts.tcp > 0 && endpointB.counts.udp > 0, 'FIXTURE_ECHO_NOT_OBSERVED');
  pass('禁用代理撤销端点B TCP/UDP新连接准入，原容器未重启');
} catch (error) {
  failed = true;
  const code = error instanceof SafeFailure ? error.code : 'UNEXPECTED_FAILURE';
  process.stderr.write(`FAIL stage=${stage} code=${code}\n`);
} finally {
  clearTimeout(deadline);
  const cleaned = await cleanup().catch(async () => {
    await Promise.all(fixtures.map(fixture => fixture.close().catch(() => {})));
    return false;
  });
  if (!cleaned) { failed = true; process.stderr.write('FAIL cleanup incomplete\n'); }
  for (const child of children) child.kill('SIGTERM');
  token = '';
  process.exitCode = failed ? 1 : 0;
  if (!failed) process.stdout.write(`PASS network-policy-live checks=${checks} profiles=${ownedProfiles.size}\n`);
}
