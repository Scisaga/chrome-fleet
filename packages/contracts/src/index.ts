import { z } from "zod";
export const ProfileId = z.string().regex(/^cf_[0-9a-f-]{36}$/);
export const GoogleBindingInputSchema = z.object({
  accountId: z.string().regex(/^google_[0-9a-f]{24}$/),
  idempotencyKey: z.string().max(128).optional(),
}).strict();
export const GoogleLoginConfirmationSchema = GoogleBindingInputSchema.extend({
  enableAutomation: z.literal(false).optional(),
});
export const GoogleBindingSchema = z.object({
  accountId: z.string(), email: z.string().email(),
  confirmationState: z.enum(["unconfirmed", "confirmed"]),
  lastConfirmedAt: z.string().optional(),
});
export type GoogleBinding = z.infer<typeof GoogleBindingSchema>;
export const ProxySchema = z
  .object({
    enabled: z.boolean().default(true),
    scheme: z.enum(["http", "https", "socks5"]).default("http"),
    host: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[a-zA-Z0-9.:[\]-]+$/),
    port: z.number().int().min(1).max(65535),
    username: z.string().max(256).optional(),
    password: z.string().max(4096).optional(),
    secretRef: z.string().optional(),
    bypass: z.string().max(1024).default(""),
  })
  .strict()
  .refine(
    (p) =>
      !(p.scheme === "socks5" && (p.username || p.password || p.secretRef)),
    { message: "暂不支持带认证的 SOCKS5" },
  );
export const RuntimeSchema = z.object({
  startupPolicy: z.enum(["on_demand", "manual", "always"]).default("on_demand"),
  idleTimeoutMinutes: z.number().int().min(0).max(10080).default(15),
  autoWakePaused: z.boolean().default(false),
});
export const CreateProfileSchema = z
  .object({
    name: z.string().min(1).max(80),
    browserMode: z.enum(["automation", "vnc"]).default("vnc"),
    tags: z.array(z.string().max(40)).max(20).default([]),
    accountAlias: z.string().max(128).optional(),
    proxy: ProxySchema.optional(),
    vncPassword: z
      .string()
      .regex(/^[\x21-\x7e]{8}$/)
      .optional(),
    vncSecretRef: z.string().optional(),
    startupPolicy: z
      .enum(["on_demand", "manual", "always"])
      .default("on_demand"),
    idleTimeoutMinutes: z.number().int().min(0).max(10080).default(15),
    headless: z.boolean().default(false),
    locale: z.string().default("zh-CN"),
    timezoneId: z.string().default("Asia/Shanghai"),
    viewport: z
      .object({
        width: z.number().int().min(800).max(3840),
        height: z.number().int().min(600).max(2160),
      })
      .default({ width: 1440, height: 900 }),
    resources: z
      .object({
        memoryMb: z.number().int().min(512).max(16384).default(2048),
        cpus: z.number().min(0.25).max(8).default(2),
        pidsLimit: z.number().int().min(128).max(2048).default(512),
      })
      .default({ memoryMb: 2048, cpus: 2, pidsLimit: 512 }),
    start: z.boolean().default(false),
    distribution: z.enum(["google", "cft"]).default("google"),
  })
  .strict();
export const LocatorSchema = z
  .object({
    css: z.string().max(2048).optional(),
    role: z.string().max(128).optional(),
    name: z.string().max(1024).optional(),
    label: z.string().max(1024).optional(),
    text: z.string().max(1024).optional(),
    iframe: z.string().max(2048).optional(),
  })
  .strict();
const AccountPageUrl = z.string().url().max(2048).refine(value => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
}, "账户页面须为不含凭据的 HTTP(S) 地址");
export const PlatformInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  homeUrl: AccountPageUrl,
  loginUrl: AccountPageUrl,
  accountUrl: AccountPageUrl,
  enabled: z.boolean().default(true),
}).strict();
export const PlatformPatchSchema = PlatformInputSchema.partial();
export const PlatformLinkSchema = z.object({
  googleAccountId: z.string().regex(/^google_[0-9a-f]{24}$/),
  confirmedGoogleSignup: z.literal(true),
  idempotencyKey: z.string().max(128).optional(),
}).strict();
export const PlatformConfirmationSchema = z.object({
  identity: z.string().trim().min(1).max(256),
  nickname: z.string().trim().max(256).optional(),
  confirmedLoggedIn: z.literal(true),
  idempotencyKey: z.string().max(128).optional(),
}).strict();
export type PlatformInput = z.infer<typeof PlatformInputSchema>;
export type Platform = PlatformInput & { id: string; builtin?: boolean; createdAt?: string; updatedAt?: string };
export interface PlatformAccount {
  id: string;
  profileId: string;
  platformId: string;
  platformName: string;
  googleAccountId: string;
  loginMethod: "google";
  expectedIdentity: string;
  nickname?: string;
  authState: "manually_confirmed" | "bound_unconfirmed";
  confirmationState: "confirmed" | "unconfirmed";
  linkState: "pending" | "linked";
  firstLinkedAt?: string;
  lastConfirmedAt?: string;
  confirmedBy?: string;
  historicalVerification?: { authState?: string; lastCheckedAt?: string; lastSuccessAt?: string; evidence?: unknown; detectedIdentity?: string };
  evidence?: string;
  accountUrl: string;
  loginUrl: string;
  enabled: boolean;
}
export const StepSchema = z
  .object({
    action: z.enum([
      "goto",
      "click",
      "fill",
      "press",
      "select",
      "waitFor",
      "extractText",
      "screenshot",
      "pages",
      "newPage",
      "switchPage",
      "assertText",
      "upload",
      "download",
      "waitPopup",
      "requireHuman",
    ]),
    url: z.string().url().optional(),
    locator: LocatorSchema.optional(),
    value: z.string().max(100000).optional(),
    text: z.string().max(100000).optional(),
    key: z.string().max(128).optional(),
    values: z.array(z.string()).optional(),
    state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
    timeoutMs: z.number().int().min(100).max(120000).optional(),
    resultKey: z.string().max(128).optional(),
    fullPage: z.boolean().optional(),
    pageId: z.string().optional(),
    artifactId: z.string().optional(),
    expected: z.string().optional(),
    reason: z.string().max(500).optional(),
    safeToRetry: z.literal(false).optional(),
  })
  .strict();
export const JobSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    profileId: ProfileId,
    steps: z.array(StepSchema).min(1).max(100),
    timeoutMs: z.number().int().min(1000).max(900000).default(60000),
    idempotencyKey: z.string().max(128).optional(),
    expectedAccountId: z.string().optional(),
  })
  .strict();
export const Scopes = [
  "read",
  "manage",
  "automate",
  "session:read",
  "session:write",
  "backup",
  "update",
  "admin",
] as const;
export type Scope = (typeof Scopes)[number];
export type Profile = Record<string, any> & {
  id: string;
  name: string;
  state: string;
  archived: boolean;
};
export type Job = Record<string, any> & {
  id: string;
  profileId: string;
  kind: string;
  status: string;
  payload: any;
  progress: number;
  createdAt: string;
};
export class FleetError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
    public details?: unknown,
  ) {
    super(message);
  }
}
