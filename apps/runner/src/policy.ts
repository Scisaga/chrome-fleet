import { z } from 'zod';
import { resolve, sep } from 'node:path';

export class RunnerError extends Error {constructor(public code:string,message:string,public statusCode=400,public details?:unknown){super(message);}}
export const ProfileId=z.string().regex(/^cf_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,'实例标识无效');
export const Image=z.string().regex(/^chrome-fleet\/browser:(?:google|cft)-(?:stable|\d+\.\d+\.\d+\.\d+)(?:@sha256:[a-f0-9]{64})?$|^sha256:[a-f0-9]{64}$/,'镜像不在允许范围');
export const StartBody=z.object({
  image:Image,
  expectedDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  config:z.object({browserMode:z.enum(['automation','vnc']).default('automation'),headless:z.boolean().default(false),locale:z.string().max(100).default('zh-CN'),timezoneId:z.string().max(100).default('Asia/Shanghai'),viewport:z.object({width:z.number().int().min(320).max(7680),height:z.number().int().min(240).max(4320)}).default({width:1440,height:900}),proxy:z.object({server:z.string().max(2048),username:z.string().max(1000).optional(),password:z.string().max(1000).optional(),bypass:z.string().max(2000).optional()}).strict().optional(),proxyVersion:z.number().int().min(0).default(0)}).strict(),
  resources:z.object({cpus:z.number().min(0.25).max(8).default(1),memoryMb:z.number().int().min(512).max(16384).default(1536),pidsLimit:z.number().int().min(128).max(2048).default(512),shmMb:z.number().int().min(256).max(4096).default(512)}).strict().default({}),
}).strict();
export function profilePath(root:string,id:string,child:'state'|'secrets') {
  ProfileId.parse(id);
  const base=resolve(root,'profiles');const path=resolve(base,id,child);
  if(!path.startsWith(base+sep))throw new RunnerError('PATH_FORBIDDEN','实例路径超出允许目录');
  return path;
}
export function normalizeProxy(config:z.infer<typeof StartBody>['config']) {
  const proxy=config.proxy;if(!proxy)return;
  let url:URL;try{url=new URL(proxy.server);}catch{throw new RunnerError('PROXY_INVALID','代理地址无效');}
  if(!['http:','https:','socks5:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new RunnerError('PROXY_INVALID','代理地址只允许 HTTP、HTTPS 或无认证 SOCKS5，凭据必须单独传入');
  if(url.protocol==='socks5:'&&(proxy.username||proxy.password))throw new RunnerError('SOCKS_AUTH_UNSUPPORTED','Chrome 不支持带认证 SOCKS5，本项目未启用认证中继');
}
