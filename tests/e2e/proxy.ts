/** Opt-in real Chrome/Docker proxy acceptance. Run on the Docker host as root. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, chown, chmod, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';

const root = process.env.FLEET_DATA_ROOT ?? '/var/lib/chrome-fleet';
const runnerContainer = process.env.FLEET_TEST_RUNNER_CONTAINER ?? 'chrome-fleet-runner-1';
const fixtureImage = process.env.FLEET_TEST_NODE_IMAGE ?? 'chrome-fleet/runner:0.1.0';
const browserImage = process.env.FLEET_TEST_IMAGE ?? 'chrome-fleet/browser:google-155.0.8059.79';
const runId = `proxy-${randomUUID()}`;
const network = `cf-fixture-${runId}`;
const temp = await mkdtemp(join(tmpdir(), 'chrome-fleet-proxy-'));
const proxySource = resolve('tests/fixtures/auth-proxy.ts');
const profiles: { id: string; fence: number; gateway: string }[] = [];
const diagnosticSecrets: string[] = [];
const containers: string[] = [];
const rules: string[][] = [];
let networkCreated = false; let interrupted = false; let cleaning = false;
const children = new Set<ReturnType<typeof spawn>>();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { interrupted = true; for (const child of children) child.kill('SIGTERM'); });
function command(command: string, args: string[], input?: string, timeoutMs = 180_000): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    if (interrupted && !cleaning) { reject(new Error('测试被中断，开始清理临时资源')); return; }
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] }); let output = ''; let errors = ''; children.add(child);
    child.stdout.on('data', value => { output += String(value); }); child.stderr.on('data', value => { if (command === 'docker' && args[0] === 'logs') output += String(value); errors = (errors + String(value)).slice(-4000); });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${command} 超时`)); }, timeoutMs);
    child.once('error', error => { children.delete(child); clearTimeout(timer); reject(error); });
    child.once('exit', code => { children.delete(child); clearTimeout(timer); if (code === 0) resolveCommand(output.trim()); else reject(new Error(`${command} 失败(${code})：${errors.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')}`)); });
    child.stdin.end(input);
  });
}
/** Token remains in the Runner's secret file; no credential is placed in argv or stdout. */
async function remote(path: string, body?: unknown, profileId?: string, method = body === undefined ? 'GET' : 'POST'): Promise<any> {
  const source = `import {readFile} from 'node:fs/promises';
const target=${JSON.stringify(profileId ? `http://${profileId}:8092${path}` : `http://127.0.0.1:8091${path}`)};
const token=(await readFile(${JSON.stringify(profileId ? `${root}/profiles/${profileId}/secrets/agent-token` : '/run/secrets/runner-token')},'utf8')).trim();
const body=${JSON.stringify(body ?? null)};
const r=await fetch(target,{method:${JSON.stringify(method)},headers:{authorization:'Bearer '+token,...(body===null?{}:{'content-type':'application/json'})},body:body===null?undefined:JSON.stringify(body),signal:AbortSignal.timeout(180000)});
const result=await r.json();if(!r.ok){process.stderr.write(JSON.stringify({status:r.status,code:result.code??result.error?.code??'API_ERROR'}));process.exit(1);}process.stdout.write(JSON.stringify(result));`;
  return JSON.parse(await command('docker', ['exec', '-i', runnerContainer, 'node', '--input-type=module'], source));
}
async function events(name: string): Promise<{ event: string; proxyId: string; [key: string]: unknown }[]> {
  return (await command('docker', ['logs', name])).split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
}
async function makeProxy(id: string, gateways: string[]) {
  const name = `cf-fixture-${runId}-${id.toLowerCase()}`; const configPath = join(temp, `${id}.json`);
  const username = `fixture_${id}`; const password = randomBytes(24).toString('base64url'); diagnosticSecrets.push(username, password);
  await writeFile(configPath, JSON.stringify({ id, username, password }), { mode: 0o444 });
  containers.push(name);
  await command('docker', ['run', '-d', '--name', name, '--label', `chrome-fleet.fixture=${runId}`, '--network', network, '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', ...[...new Set(gateways)].flatMap(gateway => ['-p', `${gateway}::3128`]), '-v', `${proxySource}:/fixture/proxy.ts:ro`, '-v', `${configPath}:/run/fixture/config.json:ro`, fixtureImage, 'node', '/fixture/proxy.ts']);
  const inspect = JSON.parse(await command('docker', ['inspect', name]))[0]; const ip = inspect.NetworkSettings.Networks[network].IPAddress;
  const published = inspect.NetworkSettings.Ports['3128/tcp'] as { HostIp: string; HostPort: string }[];
  const servers = Object.fromEntries(published.map(binding => [binding.HostIp, `http://${binding.HostIp}:${binding.HostPort}`]));
  const healthBase = servers[gateways[0]];
  const rule = ['-d', `${ip}/32`, '-p', 'tcp', '--dport', '3128', '-m', 'comment', '--comment', runId, '-j', 'RETURN'];
  await command('iptables', ['-w', '-I', 'CF-FLEET', '2', ...rule]); rules.push(rule);
  for (let attempt = 0; attempt < 30; attempt++) { try { const ready = await fetch(`${healthBase}/__fixture_health`, { signal: AbortSignal.timeout(1000) }); if (ready.ok) break; } catch {} if (attempt === 29) throw new Error('测试代理未就绪'); await new Promise(resolve => setTimeout(resolve, 200)); }
  return { name, id, username, password, at: (p: typeof profiles[number]) => ({ server: servers[p.gateway], username, password }) };
}
async function start(p: typeof profiles[number], proxy: { server: string; username: string; password: string }, version: number) {
  try { await remote(`/profiles/${p.id}/start`, { image: browserImage, config: { headless: false, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 800 }, proxy, proxyVersion: version } }); } catch (error) {
    let diagnostic = await command('docker', ['logs', '--tail', '35', p.id]).catch(() => '浏览器日志不可用');
    for (const secret of diagnosticSecrets) diagnostic = diagnostic.split(secret).join('[已隐藏]');
    process.stderr.write(`合成浏览器启动诊断：${diagnostic.slice(-6000)}\n`); throw error;
  }
  await remote('/fence', { token: p.fence }, p.id);
}
async function create() {
  const p = { id: `cf_${randomUUID()}`, fence: 1, gateway: '' }; profiles.push(p);
  const base = join(root, 'profiles', p.id); await mkdir(base, { mode: 0o700 }); await chown(base, 1000, 1000);
  for (const folder of ['state', 'secrets']) { const path = join(base, folder); await mkdir(path, { mode: 0o700 }); await chown(path, 1000, 1000); }
  for (const [name, value] of Object.entries({ 'agent-token': randomBytes(32).toString('hex'), 'keyring-password': randomBytes(32).toString('hex'), 'vnc-password': randomBytes(6).toString('base64') })) { diagnosticSecrets.push(value); const path = join(base, 'secrets', name); await writeFile(path, value, { mode: 0o400 }); await chown(path, 1000, 1000); }
  // Startup itself does not navigate. A closed local proxy prevents background direct traffic.
  await start(p, { server: 'http://127.0.0.1:9', username: 'fixture', password: 'fixture' }, 0);
  const inspect = JSON.parse(await command('docker', ['inspect', p.id]))[0];
  const endpoint = Object.entries(inspect.NetworkSettings.Networks).find(([name]) => name.startsWith('cf_egress_'))?.[1] as { Gateway?: string } | undefined;
  assert.ok(endpoint?.Gateway); p.gateway = endpoint.Gateway;
  return p;
}
async function checkProxy(p: typeof profiles[number], server: string) {
  const healthUrl = new URL('/__fixture_health', server).href;
  await command('docker', ['exec', p.id, 'node', '-e', `fetch(${JSON.stringify(healthUrl)},{signal:AbortSignal.timeout(5000)}).then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())}).catch(()=>{process.stderr.write('浏览器网络无法到达fixture代理发布端口');process.exit(1)})`], undefined, 10_000);
}

async function browser(p: typeof profiles[number], url: string, css: string) {
  return remote('/execute', { fencingToken: p.fence, timeoutMs: 60_000, steps: [{ action: 'goto', url, timeoutMs: 30_000 }, { action: 'extractText', locator: { css }, timeoutMs: 10_000 }] }, p.id);
}
function resultText(result: unknown): string { return JSON.stringify(result); }
try {
  assert.equal(process.getuid?.(), 0, '需root安装并精确回收临时fixture防火墙规则');
  await command('iptables', ['-w', '-S', 'CF-FLEET']);
  const image = JSON.parse(await command('docker', ['image', 'inspect', browserImage]))[0]; assert.equal(image.Config.Labels['chrome-fleet.browser'], 'true', '先构建批准的真实Chrome镜像');
  await command('docker', ['network', 'create', '--label', `chrome-fleet.fixture=${runId}`, network]); networkCreated = true;
  const a = await create(); const b = await create();
  const aProxy = await makeProxy('PROXY_A', [a.gateway, b.gateway]); const bProxy = await makeProxy('PROXY_B', [a.gateway, b.gateway]);
  await remote(`/profiles/${a.id}/stop`, {}); await remote(`/profiles/${b.id}/stop`, {}); a.fence++; b.fence++;
  await start(a, aProxy.at(a), 1); await start(b, bProxy.at(b), 1);
  await checkProxy(a, aProxy.at(a).server); await checkProxy(b, bProxy.at(b).server);
  const aHttp = await browser(a, 'http://example.com/fleet-proxy-fixture', '#proxy-identity'); const bHttp = await browser(b, 'http://example.com/fleet-proxy-fixture', '#proxy-identity');
  assert.equal(aHttp.status, 'succeeded', resultText(aHttp)); assert.equal(bHttp.status, 'succeeded', resultText(bHttp));
  assert.ok(resultText(aHttp).includes('PROXY_A')); assert.ok(resultText(bHttp).includes('PROXY_B'));
  console.log('PASS 两个真实Chrome实例HTTP请求显示不同代理身份');
  const aHttps = await browser(a, 'https://example.com/', 'body'); const bHttps = await browser(b, 'https://example.com/', 'body');
  assert.equal(aHttps.status, 'succeeded', resultText(aHttps)); assert.equal(bHttps.status, 'succeeded', resultText(bHttps));
  assert.match(resultText(aHttps), /Example Domain|documentation examples/i); assert.match(resultText(bHttps), /Example Domain|documentation examples/i);
  assert.ok((await events(aProxy.name)).some(row => row.event === 'connect')); assert.ok((await events(bProxy.name)).some(row => row.event === 'connect'));
  console.log('PASS 两个认证HTTP代理实际执行HTTPS CONNECT且浏览器TLS验证通过');
  await remote(`/profiles/${a.id}/stop`, {}); a.fence++;
  const beforeBad = (await events(bProxy.name)).filter(row => row.event === 'http').length;
  await start(a, { ...bProxy.at(a), password: 'fixture-intentionally-wrong' }, 2);
  const denied = await browser(a, 'http://example.com/fleet-proxy-fixture', 'h1');
  assert.notEqual(denied.status, 'succeeded', '错误认证不能绕过代理直连成功');
  const badEvents = await events(bProxy.name); assert.ok(badEvents.some(row => row.event === 'denied')); assert.equal(badEvents.filter(row => row.event === 'http').length, beforeBad);
  console.log('PASS 错误代理认证被拒绝，没有静默直连');
  await remote(`/profiles/${a.id}/stop`, {}); a.fence++; await start(a, bProxy.at(a), 3);
  const changed = await browser(a, 'http://example.com/fleet-proxy-fixture', '#proxy-identity'); const unchanged = await browser(b, 'http://example.com/fleet-proxy-fixture', '#proxy-identity');
  assert.equal(changed.status, 'succeeded', resultText(changed)); assert.equal(unchanged.status, 'succeeded', resultText(unchanged));
  assert.ok(resultText(changed).includes('PROXY_B')); assert.ok(resultText(unchanged).includes('PROXY_B'));
  await remote(`/profiles/${a.id}/stop`, {}); a.fence++; await start(a, aProxy.at(a), 4);
  const restored = await browser(a, 'http://example.com/fleet-proxy-fixture', '#proxy-identity'); const stable = await browser(b, 'http://example.com/fleet-proxy-fixture', '#proxy-identity');
  assert.ok(resultText(restored).includes('PROXY_A')); assert.ok(resultText(stable).includes('PROXY_B'));
  console.log('PASS 只重启并切换目标实例代理，另一实例持续使用自身代理');
} catch (error) {
  for (const name of containers) { const rows = await events(name).catch(() => []); const counts = Object.fromEntries([...new Set(rows.map(row => row.event))].map(event => [event, rows.filter(row => row.event === event).length])); process.stderr.write(`代理fixture ${name}事件计数：${JSON.stringify(counts)}\n`); }
  throw error;
} finally {
  cleaning = true;
  for (const p of profiles) {
    let removed = false;
    try { await remote(`/profiles/${p.id}/stop`, {}); await remote(`/profiles/${p.id}/container`, undefined, undefined, 'DELETE'); removed = true; } catch { process.stderr.write(`测试实例${p.id}清理失败，请按其profile标签精确清理。\n`); }
    if (removed) await rm(join(root, 'profiles', p.id), { recursive: true, force: true });
  }
  for (const name of containers.reverse()) await command('docker', ['rm', '-f', name]).catch(() => process.stderr.write(`fixture容器${name}需精确清理。\n`));
  if (networkCreated) await command('docker', ['network', 'rm', network]).catch(() => process.stderr.write(`fixture网络${network}需精确清理。\n`));
  for (const rule of rules.reverse()) await command('iptables', ['-w', '-D', 'CF-FLEET', ...rule]).catch(() => process.stderr.write(`fixture防火墙规则comment=${runId}需精确清理。\n`));
  await rm(temp, { recursive: true, force: true });
}
