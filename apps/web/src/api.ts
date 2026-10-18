export class ApiError extends Error {
  code: string;
  requestId?: string;
  constructor(message: string, code: string, requestId?: string) {
    super(message);
    this.code = code;
    this.requestId = requestId;
  }
}

let csrfToken = "";
export function setCsrfToken(value: string) {
  csrfToken = value;
}
export function createIdempotencyKey(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function")
    return webCrypto.randomUUID();
  if (typeof webCrypto?.getRandomValues !== "function") {
    throw new ApiError(
      "浏览器无法生成安全随机幂等键，请更新浏览器或使用 HTTPS 访问管理界面",
      "SECURE_RANDOM_UNAVAILABLE",
    );
  }
  const bytes = webCrypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function api<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") {
    if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
    if (method === "POST") headers["Idempotency-Key"] = createIdempotencyKey();
  }
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: "same-origin",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    throw new ApiError(
      "无法连接控制服务，请检查网络或稍后重试",
      "NETWORK_ERROR",
    );
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && path !== "/session")
      window.dispatchEvent(new Event("fleet-session-expired"));
    throw new ApiError(
      payload?.message || `请求失败（${response.status}）`,
      payload?.code || "REQUEST_FAILED",
      payload?.requestId,
    );
  }
  return payload?.data as T;
}

export interface ProxyConfig {
  enabled: boolean;
  scheme: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  bypass?: string;
  version?: number;
  appliedVersion?: number;
  hasCredentials?: boolean;
}
export interface Account {
  id: string;
  provider: string;
  alias: string;
  expectedIdentity: string;
  authState?: string;
  state?: string;
  status?: string;
  lastCheckedAt?: string;
  boundAt?: string;
  lastConfirmedAt?: string;
  bindingSource?: string;
  evidence?: unknown;
}
export interface GoogleAccountOption {
  id: string;
  email: string;
  recoveryEmail?: string;
  updatedAt?: string;
  bindings: { profileId: string; profileName: string; archived?: boolean }[];
}
export interface GoogleLoginStatus {
  status: "waiting" | "bound" | "mismatch" | "unknown";
  navigationStatus?: "opened" | "pending";
  browserMode?: "vnc" | "automation";
  verificationSource?: "manual_confirmation" | string;
  expectedAccountId?: string;
  lastConfirmedAt?: string;
  takeoverJobId?: string;
  autofill?: {
    // email_submitted is retained for older sessions; the email Next is a human action.
    stage: "waiting" | "email_filled" | "email_submitted" | "password_filled" | "manual_required" | "account_mismatch" | "unsupported";
    message?: string;
  };
  expectedEmail?: string;
  detectedEmail?: string;
  message?: string;
}
export interface ManualSession {
  id: string;
  profileId: string;
  desktopPath: string;
  expiresAt: string;
  googleLogin?: GoogleLoginStatus;
}
export interface HostMetrics {
  scope: "host";
  available: boolean;
  sampledAt?: string;
  cpuPercent?: number | null;
  cpuCount?: number;
  memoryBytes?: number;
  memoryTotalBytes?: number;
  memoryPercent?: number;
  errorCode?: string;
}
export interface Profile {
  id: string;
  name: string;
  tags: string[];
  state: string;
  browserMode?: "vnc" | "automation";
  googleBinding?: GoogleBinding;
  desiredState?: string;
  startupPolicy: "on_demand" | "manual" | "always";
  autoWakePaused?: boolean;
  idleTimeoutMinutes: number;
  headless?: boolean;
  chromeVersion?: string;
  playwrightVersion?: string;
  image?: string;
  imageDigest?: string;
  proxy?: ProxyConfig;
  remoteDesktop?: {
    passwordConfigured?: boolean;
    version?: number;
    appliedVersion?: number;
  };
  accounts?: Account[];
  currentJob?: any;
  lastError?: any;
  archived?: boolean;
  purgedAt?: string;
  createdAt?: string;
  lastActivityAt?: string;
  pinnedVersion?: string | null;
  lastSnapshotId?: string;
  lastUpdateId?: string;
  resources?: { memoryMb: number; cpus: number; pidsLimit: number };
  health?: {
    ready?: boolean;
    sandboxEnabled?: boolean;
    keyring?: { unlocked?: boolean; probeVerified?: boolean };
  } | null;
  metrics?: {
    available?: boolean;
    sampledAt?: string;
    memoryBytes?: number;
    memoryUsageBytes?: number;
    memoryLimitBytes?: number;
    cpuUsageNs?: number;
    cpuPercent?: number | null;
    pids?: number;
    diskBytes?: number;
    errorCode?: string;
  };
}
export interface GoogleBinding {
  accountId: string;
  email: string;
  confirmationState: "unconfirmed" | "confirmed";
  lastConfirmedAt?: string;
}
export interface Job {
  id: string;
  profileId: string;
  type?: string;
  kind?: string;
  reason?: string;
  state?: string;
  status?: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  progress?: any;
  result?: any;
  error?: any;
  steps?: any[];
}
export function items<T>(value: { items?: T[] } | T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : value?.items || [];
}
export function date(value?: string) {
  return value
    ? new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Shanghai",
      }).format(new Date(value))
    : "—";
}
export function message(error: unknown) {
  return error instanceof ApiError
    ? `${error.message}${error.requestId ? ` · 请求 ${error.requestId}` : ""}`
    : error instanceof Error
      ? error.message
      : "操作失败，请稍后重试";
}
export function safeDesktopPath(value: string) {
  if (!value.startsWith("/") || value.startsWith("//"))
    throw new Error("桌面入口不是有效的同站点路径");
  return value;
}
