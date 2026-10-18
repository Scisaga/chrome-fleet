import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeOrigin, parseAllowedOrigins } from "./origin-policy.js";
export interface Config {
  root: string;
  keyFile: string;
  bootstrapTokenFile: string;
  runnerTokenFile: string;
  runnerUrl: string;
  host: string;
  port: number;
  publicUrl: string;
  allowedOrigins?: string[];
  secureCookie: boolean;
  maxConcurrency: number;
  defaultImage: string;
  webRoot: string;
  retentionDays: number;
}
export function loadConfig(env = process.env): Config {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new Error("拒绝启动：NODE_TLS_REJECT_UNAUTHORIZED=0 会关闭 TLS 校验");
  const root = resolve(env.FLEET_DATA_ROOT || "/var/lib/chrome-fleet");
  const c = {
    root,
    keyFile: env.FLEET_MASTER_KEY_FILE || `${root}/secrets/master.key`,
    bootstrapTokenFile:
      env.FLEET_ADMIN_TOKEN_FILE || `${root}/secrets/admin-token`,
    runnerTokenFile: env.RUNNER_TOKEN_FILE || `${root}/secrets/runner-token`,
    runnerUrl: env.RUNNER_URL || "http://127.0.0.1:8091",
    host: env.FLEET_HOST || "127.0.0.1",
    port: Number(env.FLEET_PORT || 8080),
    publicUrl: env.FLEET_PUBLIC_URL || "http://127.0.0.1:8080",
    allowedOrigins: parseAllowedOrigins(env.FLEET_ALLOWED_ORIGINS),
    secureCookie: env.FLEET_COOKIE_SECURE === "true",
    maxConcurrency: Number(env.FLEET_MAX_CONCURRENCY || 3),
    defaultImage:
      env.FLEET_BROWSER_IMAGE || "chrome-fleet/browser:google-stable",
    webRoot: resolve(env.FLEET_WEB_ROOT || "apps/web/dist"),
    retentionDays: Number(env.FLEET_RETENTION_DAYS || 30),
  };
  for (const f of [c.keyFile, c.bootstrapTokenFile, c.runnerTokenFile])
    readFileSync(f);
  if (
    !Number.isInteger(c.port) ||
    c.port < 1 ||
    c.port > 65535 ||
    c.maxConcurrency < 1
  )
    throw new Error("无效端口或并发配置");
  c.publicUrl = normalizeOrigin(c.publicUrl);
  if (new URL(c.publicUrl).protocol === "https:" && !c.secureCookie)
    throw new Error("HTTPS 部署须设置 FLEET_COOKIE_SECURE=true");
  return c;
}
