import type { Config } from './config.js';

/** A listening address is not an access origin: require exact HTTP(S) authorities. */
export function normalizeOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('访问来源必须是完整 HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.hostname.includes('*') || ['0.0.0.0', '[::]'].includes(url.hostname)) throw new Error('访问来源必须指定实际主机，禁止通配符、凭据、路径和监听通配地址');
  return url.origin;
}
export function parseAllowedOrigins(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const entries = value.split(',').map(item => item.trim());
  if (entries.some(item => !item)) throw new Error('FLEET_ALLOWED_ORIGINS 不允许空条目');
  return [...new Set(entries.map(normalizeOrigin))];
}
export interface OriginPolicy {
  publicOrigin: string;
  origins: Set<string>;
  hosts: Set<string>;
  acceptsHost(host: string | undefined): boolean;
  acceptsOrigin(origin: string | undefined, host: string | undefined, requireOrigin?: boolean): boolean;
}
export function createOriginPolicy(config: Pick<Config, 'publicUrl' | 'port' | 'allowedOrigins'>): OriginPolicy {
  const publicOrigin = normalizeOrigin(config.publicUrl);
  const origins = new Set([publicOrigin, ...(config.allowedOrigins ?? []).map(normalizeOrigin), `http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, `http://[::1]:${config.port}`].map(normalizeOrigin));
  const hosts = new Set([...origins].map(origin => new URL(origin).host));
  return {
    publicOrigin, origins, hosts,
    acceptsHost: host => typeof host === 'string' && hosts.has(host),
    acceptsOrigin(origin, host, requireOrigin = false) {
      if (!host || !hosts.has(host)) return false;
      if (origin === undefined) return !requireOrigin;
      if (!origins.has(origin)) return false;
      try { return new URL(origin).host === host; } catch { return false; }
    },
  };
}
