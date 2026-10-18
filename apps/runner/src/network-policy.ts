import { readFile, writeFile, rename, mkdir, chmod, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolve4 } from 'node:dns/promises';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ProfileId, RunnerError, type StartBody } from './policy.js';

const Host = z.string().min(1).max(253).transform(host => isIP(host) ? host.toLowerCase() : domainToASCII(host).toLowerCase().replace(/\.$/, '')).refine(host => Boolean(host) && host.length <= 253 && (Boolean(isIP(host)) || host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))), '代理主机必须是IP或有效域名');
const Endpoint = z.object({ host: Host, port: z.number().int().min(1).max(65535) }).strict();
const Profile = z.object({ profileId: ProfileId, proxy: Endpoint.nullable(), proxyVersion: z.number().int().nonnegative().safe() }).strict();
export const NetworkPolicySync = z.object({ revision: z.number().int().nonnegative().safe(), profiles: z.array(Profile).max(1000) }).strict().superRefine((body, context) => {
  if (new Set(body.profiles.map(profile => profile.profileId)).size !== body.profiles.length) context.addIssue({ code: 'custom', message: '代理网络策略存在重复实例' });
});
const Stored = z.object({ version: z.literal(1), revision: z.number().int().min(-1).safe(), profiles: z.array(Profile).max(1000), retired: z.record(z.number().int().nonnegative().safe()) }).strict();
type ConfiguredProfile = z.infer<typeof Profile>;
type Sync = z.infer<typeof NetworkPolicySync>;
interface DockerApi { call<T = any>(method: string, path: string, body?: unknown): Promise<T> }
interface Source { interface: string; address: string }
interface ActiveProfile { profileId: string; proxyVersion: number; port: number; addresses: string[]; sources: Source[] }

export function endpointFromStart(config: z.infer<typeof StartBody>['config']) {
  if (!config.proxy) return null;
  const url = new URL(config.proxy.server);
  return Endpoint.parse({ host: url.hostname.replace(/^\[|\]$/g, '').toLowerCase(), port: Number(url.port || (url.protocol === 'https:' ? 443 : url.protocol === 'socks5:' ? 1080 : 80)) });
}
export function helperContainerSpec(imageId: string, policyDirectory: string) {
  return {
    Image: imageId, User: '0:0', Entrypoint: ['python3'], Cmd: ['/app/docker/browser/proxy-policy-helper.py'],
    Env: ['PYTHONDONTWRITEBYTECODE=1'], Labels: { 'chrome-fleet.network-policy-helper': 'true' },
    HostConfig: {
      NetworkMode: 'host', ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: ['NET_ADMIN'], Privileged: false,
      SecurityOpt: ['no-new-privileges:true'], RestartPolicy: { Name: 'no' },
      Binds: [`${policyDirectory}:/policy:rw`, '/run/chrome-fleet:/run/chrome-fleet:rw', '/run/xtables.lock:/run/xtables.lock:rw'],
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=16777216', '/run': 'rw,nosuid,nodev,size=16777216' },
      Memory: 128 * 1024 * 1024, NanoCpus: 250000000, PidsLimit: 32,
      LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
    },
  };
}

export class NetworkPolicy {
  private state: z.infer<typeof Stored> = { version: 1, revision: -1, profiles: [], retired: {} };
  private queue: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private directory: string;
  pending = false;
  lastErrorCode: string | null = null;
  constructor(private docker: DockerApi, root: string, private controlNetwork: string, private helperImage = process.env.FLEET_NETWORK_HELPER_IMAGE ?? 'chrome-fleet/runner:0.1.0', private resolver: (host: string) => Promise<string[]> = host => resolve4(host), private ownerUid = 0) {
    this.directory = resolve(root, 'network-policy');
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  private async initialize() {
    if (this.initialized) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== this.ownerUid || (metadata.mode & 0o077)) throw new RunnerError('NETWORK_POLICY_DIRECTORY_UNSAFE', '代理策略目录必须是root所有、0700的真实目录', 503);
    try { this.state = Stored.parse(JSON.parse(await readFile(resolve(this.directory, 'desired.json'), 'utf8'))); }
    catch (error: any) { if (error.code !== 'ENOENT') throw new RunnerError('NETWORK_POLICY_STATE_INVALID', '已保存的代理网络策略不可读取', 503); }
    this.initialized = true;
  }
  private async atomic(name: string, value: unknown) {
    const temporary = resolve(this.directory, `.${name}-${randomUUID()}`);
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, resolve(this.directory, name));
  }
  async sync(body: Sync) {
    return this.serialize(async () => {
      await this.initialize();
      const incoming = [...body.profiles].sort((a, b) => a.profileId.localeCompare(b.profileId));
      const current = [...this.state.profiles].sort((a, b) => a.profileId.localeCompare(b.profileId));
      if (body.revision < this.state.revision || (body.revision === this.state.revision && JSON.stringify(incoming) !== JSON.stringify(current))) throw new RunnerError('NETWORK_POLICY_STALE', '代理网络策略快照已过期，请重新同步最新清单', 409);
      for (const profile of incoming) {
        const prior = this.state.profiles.find(entry => entry.profileId === profile.profileId);
        if (prior && (profile.proxyVersion < prior.proxyVersion || (profile.proxyVersion === prior.proxyVersion && JSON.stringify(profile.proxy) !== JSON.stringify(prior.proxy)))) throw new RunnerError('NETWORK_POLICY_STALE', '代理配置版本已过期，请重新同步最新清单', 409);
      }
      const retired = { ...this.state.retired };
      for (const prior of this.state.profiles) if (!incoming.some(profile => profile.profileId === prior.profileId)) retired[prior.profileId] = Math.max(retired[prior.profileId] ?? 0, prior.proxyVersion);
      for (const profile of incoming) delete retired[profile.profileId];
      this.state = { version: 1, revision: body.revision, profiles: incoming, retired };
      await this.atomic('desired.json', this.state);
      return this.apply();
    });
  }
  async ensureProfile(profileId: string, config: z.infer<typeof StartBody>['config']) {
    return this.serialize(async () => {
      await this.initialize();
      const proxy = endpointFromStart(config);
      const prior = this.state.profiles.find(profile => profile.profileId === profileId);
      if ((this.state.retired[profileId] ?? -1) >= config.proxyVersion || (prior && (config.proxyVersion < prior.proxyVersion || (config.proxyVersion === prior.proxyVersion && JSON.stringify(proxy) !== JSON.stringify(prior.proxy))))) throw new RunnerError('NETWORK_POLICY_STALE', '启动请求使用旧代理配置，已拒绝重新放行旧端点', 409);
      if (!prior && !proxy) return;
      const replacement = { profileId, proxy, proxyVersion: config.proxyVersion };
      this.state.profiles = [...this.state.profiles.filter(profile => profile.profileId !== profileId), replacement];
      await this.atomic('desired.json', this.state);
    });
  }
  refresh() { return this.serialize(async () => { await this.initialize(); return this.apply(); }); }
  private async addresses(host: string) {
    if (isIP(host) === 4) return [host];
    if (isIP(host) === 6) throw new RunnerError('PROXY_IPV6_UNSUPPORTED', '浏览器IPv6已禁用，代理须提供IPv4地址或A记录', 409);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const addresses = [...new Set(await Promise.race([this.resolver(host), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error()), 4000); })]))].sort();
      if (!addresses.length || addresses.length > 64 || addresses.some(address => isIP(address) !== 4)) throw new Error();
      return addresses;
    } finally { if (timer) clearTimeout(timer); }
  }
  private async sources(profileId: string): Promise<Source[]> {
    let container: any;
    try { container = await this.docker.call('GET', `/containers/${encodeURIComponent(profileId)}/json`); }
    catch (error) { if (error instanceof RunnerError && error.code === 'DOCKER_NOT_FOUND') return []; throw error; }
    if (container.Config?.Labels?.['chrome-fleet.managed'] !== 'true' || container.Config?.Labels?.['chrome-fleet.profile'] !== profileId) throw new RunnerError('NETWORK_POLICY_SOURCE_INVALID', '拒绝为非受管容器配置代理网络', 403);
    if (!container.State.Running) return [];
    const networkName = `cf_egress_${profileId.slice(3)}`;
    const egress = container.NetworkSettings?.Networks?.[networkName];
    const control = container.NetworkSettings?.Networks?.[this.controlNetwork];
    if (!egress?.IPAddress || !control?.IPAddress) throw new RunnerError('NETWORK_POLICY_SOURCE_INVALID', '实例缺少隔离出站或控制网络', 503);
    const network = await this.docker.call('GET', `/networks/${encodeURIComponent(networkName)}`);
    const expectedBridge = `cf${createHash('sha256').update(profileId).digest('hex').slice(0, 12)}`;
    if (network.Internal || network.Labels?.['chrome-fleet.profile'] !== profileId || network.Options?.['com.docker.network.bridge.name'] !== expectedBridge) throw new RunnerError('NETWORK_POLICY_SOURCE_INVALID', '实例出站网络归属无效', 503);
    const controlInfo = await this.docker.call('GET', `/networks/${encodeURIComponent(this.controlNetwork)}`);
    return [
      { interface: expectedBridge, address: egress.IPAddress },
      { interface: controlInfo.Options?.['com.docker.network.bridge.name'] || `br-${controlInfo.Id.slice(0, 12)}`, address: control.IPAddress },
    ];
  }
  private async apply() {
    try {
      const active: ActiveProfile[] = [];
      let dnsFailed = false;
      for (const profile of this.state.profiles) {
        if (!profile.proxy) continue;
        const sources = await this.sources(profile.profileId);
        if (!sources.length) continue;
        try { active.push({ profileId: profile.profileId, proxyVersion: profile.proxyVersion, port: profile.proxy.port, addresses: await this.addresses(profile.proxy.host), sources }); }
        catch { dnsFailed = true; }
      }
      const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      await this.atomic('candidate.json', { version: 1, bootId, profiles: active });
      const image = await this.docker.call('GET', `/images/${encodeURIComponent(this.helperImage)}/json`);
      if (image.Config?.Labels?.['chrome-fleet.network-policy-helper'] !== 'true' || !/^sha256:[a-f0-9]{64}$/.test(image.Id)) throw new RunnerError('NETWORK_HELPER_IMAGE_INVALID', '代理网络helper镜像未经批准，请重建Runner镜像', 503);
      const helper = await this.docker.call('POST', '/containers/create', helperContainerSpec(image.Id, this.directory));
      try {
        await this.docker.call('POST', `/containers/${encodeURIComponent(helper.Id)}/start`);
        const result = await this.docker.call('POST', `/containers/${encodeURIComponent(helper.Id)}/wait?condition=not-running`);
        if (result.StatusCode !== 0) throw new RunnerError('NETWORK_POLICY_APPLY_FAILED', '宿主代理网络策略应用失败，请检查隔离策略安装状态', 503);
      } finally { await this.docker.call('DELETE', `/containers/${encodeURIComponent(helper.Id)}?force=true&v=true`).catch(() => undefined); }
      if (dnsFailed) throw new RunnerError('PROXY_DNS_FAILED', '部分代理没有可用IPv4解析，已回收其旧端点；将自动重试', 503);
      this.pending = false; this.lastErrorCode = null;
      return { applied: true, revision: this.state.revision, profiles: this.state.profiles.length, activeProfiles: active.length, endpointCount: active.reduce((sum, profile) => sum + profile.addresses.length, 0), protocols: ['tcp', 'udp'] };
    } catch (error) {
      this.pending = true; this.lastErrorCode = error instanceof RunnerError ? error.code : 'NETWORK_POLICY_APPLY_FAILED';
      if (error instanceof RunnerError) throw error;
      throw new RunnerError('NETWORK_POLICY_APPLY_FAILED', '代理网络策略暂未生效，将自动重试', 503);
    }
  }
}
