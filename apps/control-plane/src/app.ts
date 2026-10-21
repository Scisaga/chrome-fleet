import { accountView } from "./account-confirmation.js";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import serveStatic from "@fastify/static";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ZodError, z } from "zod";
import { hash, id, now } from "@chrome-fleet/core";
import {
  FleetError,
  GoogleBindingInputSchema,
  GoogleLoginConfirmationSchema,
  PlatformInputSchema,
  PlatformPatchSchema,
  PlatformLinkSchema,
  PlatformConfirmationSchema,
  CreateProfileSchema,
  ProxySchema,
  JobSchema,
  StepSchema,
  RuntimeSchema,
  Scopes,
  type Scope,
  type Profile,
  type Job,
} from "@chrome-fleet/contracts";
import { Auth, type Principal } from "./auth.js";
import { FleetService } from "./service.js";
import type { Config } from "./config.js";
import { installDesktop } from "./desktop.js";
import { createOriginPolicy } from "./origin-policy.js";
import { jobPage, jobDensity } from "./job-history.js";
export async function createApp(
  config: Config,
  service = new FleetService(config),
) {
  const app = Fastify({
    logger: false,
    bodyLimit: 24 * 1024 * 1024,
    requestIdHeader: false,
    genReqId: () => id("request"),
  });
  const auth = new Auth(service.db, config.bootstrapTokenFile);
  await app.register(cookie);
  const originPolicy = createOriginPolicy(config);
  const { hosts } = originPolicy;
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store");
    if (!originPolicy.acceptsHost(req.headers.host))
      throw new FleetError("HOST_REJECTED", "不允许的 Host", 403);
    const origin = req.headers.origin;
    if (!originPolicy.acceptsOrigin(origin, req.headers.host))
      throw new FleetError("ORIGIN_REJECTED", "不允许的 Origin", 403);
  });
  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError)
      return reply.code(400).send({
        code: "INVALID_REQUEST",
        message: "请求参数不符合格式",
        details: err.issues.map((i: any) => ({
          path: i.path,
          message: i.message,
        })),
        requestId: req.id,
      });
    reply
      .code(
        err instanceof FleetError
          ? err.statusCode
          : err.statusCode === 400
            ? 400
            : 500,
      )
      .send({
        code: err instanceof FleetError ? err.code : "INTERNAL_ERROR",
        message:
          err instanceof FleetError
            ? err.message
            : "服务操作失败，请检查运行状态",
        ...(err instanceof FleetError && err.details
          ? { details: err.details }
          : {}),
        requestId: req.id,
      });
  });
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (req, reply) => {
    try {
      await service.runner.call("/health");
      return { status: "ready" };
    } catch {
      reply.code(503);
      return { status: "not_ready" };
    }
  });
  app.get("/api/v1/session", async (req) => {
    try {
      const p = auth.authenticate(req);
      return {
        data: { authenticated: true, csrfToken: p.csrfToken },
        requestId: req.id,
      };
    } catch {
      return { data: { authenticated: false }, requestId: req.id };
    }
  });
  app.post("/api/v1/session", async (req, reply) => {
    const b = z.object({ token: z.string().min(1).max(4096) }).parse(req.body),
      login = auth.login(b.token);
    reply.setCookie("fleet_session", login.sid, {
      httpOnly: true,
      secure: config.secureCookie,
      sameSite: "strict",
      path: "/",
      maxAge: 8 * 3600,
    });
    return {
      data: { authenticated: true, csrfToken: login.csrfToken },
      requestId: req.id,
    };
  });
  app.delete("/api/v1/session", async (req, reply) => {
    const p = auth.authenticate(req);
    auth.csrf(req, p);
    if (p.sessionId) service.db.delete("sessions", p.sessionId);
    reply.clearCookie("fleet_session", { path: "/" });
    return { data: { authenticated: false }, requestId: req.id };
  });
  type Context = {
    req: FastifyRequest;
    reply: any;
    p: Principal;
    pid: string;
    body: any;
    params: any;
    query: any;
  };
  const openapi: any = {
    openapi: "3.1.0",
    info: {
      title: "Chrome Fleet API",
      version: "0.1.0",
      description:
        "中文管理、持久会话与队列。长操作返回202；会话导入不代表身份验证成功。",
    },
    servers: [{ url: config.publicUrl }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        sessionCookie: { type: "apiKey", in: "cookie", name: "fleet_session" },
      },
    },
    paths: {},
  };
  function route(
    method: string,
    path: string,
    scope: Scope,
    handler: (ctx: Context) => any,
    status = 200,
    options: { cacheResponse?: boolean } = {},
  ) {
    const url = "/api/v1" + path;
    const specPath = url.replace(/:([\w]+)/g, "{$1}");
    (openapi.paths[specPath] ||= {})[method.toLowerCase()] = {
      operationId: `${method}_${path}`.replace(/[^a-zA-Z0-9_]/g, "_"),
      summary: `${method} ${path}`,
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      parameters: [
        ...Array.from(path.matchAll(/:(\w+)/g)).map((m) => ({
          name: m[1],
          in: "path",
          required: true,
          schema: { type: "string" },
        })),
        ...(method === "GET"
          ? []
          : [
              {
                name: "Idempotency-Key",
                in: "header",
                schema: { type: "string" },
              },
            ]),
      ],
      ...(method === "GET" || method === "DELETE"
        ? {}
        : {
            requestBody: {
              required: false,
              content: {
                "application/json": {
                  schema: { type: "object", additionalProperties: true },
                },
              },
            },
          }),
      responses: {
        [status]: {
          description: status === 202 ? "已入持久化队列，轮询jobId" : "成功",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["data", "requestId"],
                properties: { data: {}, requestId: { type: "string" } },
              },
            },
          },
        },
        "400": { description: "参数错误" },
        "401": { description: "未认证" },
        "403": { description: "权限不足" },
        "409": { description: "占用、状态冲突或幂等冲突" },
      },
    };
    app.route({
      method: method as any,
      url,
      handler: async (req, reply) => {
        const p = auth.authenticate(req);
        auth.csrf(req, p);
        const params = req.params as any,
          pid = params.id || params.profileId;
        auth.require(p, scope, pid);
        const body: any = req.body || {},
          query: any = req.query || {};
        let ikey: string | undefined;
        let ihash: string | undefined;
        if (method !== "GET" && options.cacheResponse !== false) {
          const key = req.headers["idempotency-key"] || body.idempotencyKey;
          if (key) {
            if (typeof key !== "string" || key.length > 128)
              throw new FleetError(
                "INVALID_IDEMPOTENCY_KEY",
                "幂等键须小于128字符",
              );
            ikey = key;
            ihash = hash(JSON.stringify({ method, path: req.url, body }));
            const prior = service.db.db
              .prepare("SELECT * FROM idempotency WHERE principal=? AND key=?")
              .get(p.id, key) as any;
            if (prior) {
              if (prior.hash !== ihash)
                throw new FleetError(
                  "IDEMPOTENCY_CONFLICT",
                  "同一幂等键不能使用不同请求内容",
                  409,
                );
              if (!prior.response)
                throw new FleetError(
                  "OUTCOME_UNKNOWN",
                  "此幂等请求正在处理或曾中断，请查询任务后人工核对",
                  409,
                );
              const saved = JSON.parse(
                service.vault
                  .decrypt(
                    Buffer.from(prior.response, "base64"),
                    `idempotency:${p.id}:${key}`,
                  )
                  .toString(),
              );
              reply.code(saved.status);
              return { data: saved.data, requestId: req.id };
            }
            service.db.db
              .prepare("INSERT INTO idempotency VALUES(?,?,?,NULL)")
              .run(p.id, key, ihash);
          }
        }
        try {
          const data = await handler({
            req,
            reply,
            p,
            pid,
            body,
            params,
            query,
          });
          if (reply.sent) return;
          const response = { data, requestId: req.id };
          reply.code(status);
          if (ikey)
            service.db.db
              .prepare(
                "UPDATE idempotency SET response=? WHERE principal=? AND key=?",
              )
              .run(
                service.vault
                  .encrypt(
                    Buffer.from(JSON.stringify({ data, status })),
                    `idempotency:${p.id}:${ikey}`,
                  )
                  .toString("base64"),
                p.id,
                ikey,
              );
          if (method !== "GET") service.audit(p.id, `${method} ${path}`, pid);
          return response;
        } catch (e) {
          if (ikey)
            service.db.db
              .prepare("DELETE FROM idempotency WHERE principal=? AND key=?")
              .run(p.id, ikey);
          throw e;
        }
      },
    });
  }
  const visible = (p: Principal, pid: string) =>
    p.profiles.includes("*") || p.profiles.includes(pid);
  const list = (items: any[], q: any) => {
    const offset = Math.max(0, Number(q.offset) || 0),
      limit = Math.min(100, Math.max(1, Number(q.limit) || 50));
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      offset,
      limit,
    };
  };
  const queued = (kind: string, pid: string, b: any, p: Principal) => {
    const job = service.submit(kind, pid, b, p.id);
    return { jobId: job.id, status: job.status };
  };
  route("GET", "/platforms", "read", ({ query }) => list(service.platforms.list(), query));
  route("POST", "/platforms", "admin", ({ body }) => service.platforms.create(body), 201);
  route("PATCH", "/platforms/:platformId", "admin", ({ params, body }) => service.platforms.update(params.platformId, body));
  route("DELETE", "/platforms/:platformId", "admin", ({ params }) => service.platforms.delete(params.platformId));
  route("POST", "/profiles/:profileId/platforms/:platformId", "manage", ({ pid, params, body, p }) => {
    auth.require(p, "automate", pid);
    return service.platforms.link(pid, params.platformId, body, p);
  }, 201);
  route("DELETE", "/profiles/:profileId/platforms/:platformId", "manage", ({ pid, params, p }) => {
    auth.require(p, "automate", pid);
    return service.platforms.unlink(pid, params.platformId);
  });
  route("POST", "/profiles/:profileId/platforms/:platformId/confirm", "manage", ({ pid, params, body, p }) => {
    auth.require(p, "automate", pid);
    return service.platforms.confirm(pid, params.platformId, body, p);
  });
  route("POST", "/profiles/:profileId/platforms/:platformId/login", "automate", ({ pid, params, p }) =>
    service.platforms.openLogin(pid, params.platformId, p), 200, { cacheResponse: false });
  route("GET", "/host-metrics", "read", () => service.hostMetrics.snapshot());
  route("GET", "/profiles", "read", ({ p, query }) =>
    list(
      service.db
        .list<Profile>("profiles")
        .filter(
          (x) =>
            !x.purgedAt &&
            visible(p, x.id) &&
            (!query.state || x.state === query.state) &&
            (query.archived === "true" ||
              query.includeArchived === "true" ||
              !x.archived) &&
            (!query.search ||
              (x.name + " " + x.tags.join(" "))
                .toLowerCase()
                .includes(query.search.toLowerCase())),
        )
        .map((x) => ({
          ...service.publicProfile(x),
          proxy: service.proxyView(x),
        })),
      query,
    ),
  );
  route(
    "POST",
    "/profiles",
    "manage",
    async ({ body, p }) => {
      if (!p.profiles.includes("*"))
        throw new FleetError("PROFILE_DENIED", "创建实例需要所有实例权限", 403);
      if (body.accountAlias && (body.browserMode || "vnc") === "vnc") {
        auth.require(p, "admin"); auth.require(p, "automate");
      }
      const profile = await service.create(body, p);
      if (body.start)
        return { ...profile, ...queued("start", profile.id, {}, p) };
      return profile;
    },
    201,
  );
  route("GET", "/profiles/:id", "read", ({ pid }) => {
    const p = service.profile(pid);
    return { ...service.publicProfile(p), proxy: service.proxyView(p) };
  });
  route("PATCH", "/profiles/:id", "manage", ({ pid, body }) => {
    const patch = z
      .object({
        name: z.string().min(1).max(80).optional(),
        tags: z.array(z.string().max(40)).max(20).optional(),
        headless: z.boolean().optional(),
        locale: z.string().max(64).optional(),
        timezoneId: z.string().max(128).optional(),
        pinnedVersion: z.string().nullable().optional(),
      })
      .strict()
      .parse(body);
    const p = service.profile(pid);
    if (
      p.state === "running" &&
      ["headless", "locale", "timezoneId"].some((k) => k in patch)
    )
      throw new FleetError(
        "PROFILE_MUST_STOP",
        "请停止实例后修改浏览器启动配置",
        409,
      );
    Object.assign(p, patch);
    return service.publicProfile(service.saveProfile(p));
  });
  route(
    "DELETE",
    "/profiles/:id",
    "manage",
    ({ pid, p }) => queued("archive", pid, {}, p),
    202,
  );
  route("POST", "/profiles/:id/unarchive", "manage", ({ pid }) => {
    const p = service.profile(pid);
    if (
      !p.archived ||
      p.purgedAt ||
      service.db.lease(pid)?.expires_at > Date.now()
    )
      throw new FleetError(
        "UNARCHIVE_BLOCKED",
        "仅可恢复未清理且无活动租约的归档实例",
        409,
      );
    p.archived = false;
    p.state = "stopped";
    p.desiredState = "stopped";
    return service.publicProfile(service.saveProfile(p));
  });
  route("POST", "/profiles/:id/purge", "manage", async ({ pid, body }) => {
    const p = service.profile(pid);
    if (body.confirmation !== pid)
      throw new FleetError(
        "PURGE_CONFIRMATION_REQUIRED",
        "confirmation必须为目标实例ID",
      );
    if (
      !p.archived ||
      p.state !== "stopped" ||
      service.db.lease(pid)?.expires_at > Date.now()
    )
      throw new FleetError(
        "PURGE_BLOCKED",
        "彻底清理前须归档并结束所有操作",
        409,
      );
    await service.runner.call(
      `/profiles/${pid}/container`,
      undefined,
      "DELETE",
    );
    rmSync(join(config.root, "profiles", pid), {
      recursive: true,
      force: true,
    });
    for (const c of ["artifacts", "snapshots"])
      for (const a of service.db
        .list<any>(c)
        .filter((a) => a.profileId === pid)) {
        rmSync(
          join(config.root, c === "snapshots" ? "backups" : "artifacts", a.id),
          { force: true },
        );
        service.db.delete(c, a.id);
      }
    p.purgedAt = now();
    service.saveProfile(p);
    await service.syncNetworkPolicy();
    return service.publicProfile(p);
  });
  for (const action of ["start", "stop", "restart"])
    route(
      "POST",
      `/profiles/:id/${action}`,
      "manage",
      async ({ pid, body, p }) => {
        if (action === "stop" && body.force) {
          await service.revokeDesktop(pid);
          for (const j of service.db
            .list<Job>("jobs")
            .filter((j) => j.profileId === pid && j.status === "running")) {
            j.cancelRequested = true;
            j.status = "outcome_unknown";
            service.saveJob(j);
          }
          const lease = service.db.lease(pid);
          if (lease) {
            await service.runner.call(`/profiles/${pid}/stop`, { force: true });
            service.db.release(pid, lease.owner, lease.token);
            const stopped = service.profile(pid);
            stopped.state = "stopped";
            service.saveProfile(stopped);
          }
        }
        return queued(action, pid, { ...body, manual: action === "stop" }, p);
      },
      202,
    );
  route("GET", "/profiles/:id/runtime-policy", "read", ({ pid }) => {
    const p = service.profile(pid);
    return {
      startupPolicy: p.startupPolicy,
      idleTimeoutMinutes: p.idleTimeoutMinutes,
      autoWakePaused: p.autoWakePaused,
    };
  });
  route("PUT", "/profiles/:id/browser-mode", "manage", async ({ pid, body, p }) => {
    auth.require(p, "automate", pid);
    const input = z.object({ browserMode: z.enum(["automation", "vnc"]), idempotencyKey: z.string().max(128).optional() }).strict().parse(body);
    const sessions = service.db.list<any>("manual-sessions").filter(session => session.profileId === pid && !session.closed);
    if (sessions.some(session => session.principal !== p.id) && !p.scopes.includes("admin"))
      throw new FleetError("SESSION_DENIED", "无权结束其他主体的人工会话，请由会话持有人或管理员切换模式", 403);
    if (sessions.length) await service.revokeDesktop(pid);
    return queued("browser_mode", pid, { browserMode: input.browserMode }, p);
  }, 202);
  route("PATCH", "/profiles/:id/runtime-policy", "manage", ({ pid, body }) => {
    const patch = RuntimeSchema.partial().parse(body),
      p = service.profile(pid);
    Object.assign(p, patch);
    return service.publicProfile(service.saveProfile(p));
  });
  route("GET", "/profiles/:id/proxy", "read", ({ pid }) =>
    service.proxyView(service.profile(pid)),
  );
  route("PUT", "/profiles/:id/proxy", "manage", async ({ pid, body }) => {
    const p = service.profile(pid);
    p.proxy = service.storeProxy(p, body);
    service.saveProfile(p);
    await service.syncNetworkPolicy();
    return service.proxyView(p);
  });
  route("DELETE", "/profiles/:id/proxy", "manage", async ({ pid }) => {
    const p = service.profile(pid);
    p.proxy = {
      ...(p.proxy || {}),
      enabled: false,
      version: (p.proxy?.version || 0) + 1,
      appliedVersion: p.proxy?.appliedVersion || 0,
    };
    service.saveProfile(p);
    await service.syncNetworkPolicy();
    return service.proxyView(p);
  });
  route(
    "POST",
    "/profiles/:id/proxy/test",
    "automate",
    ({ pid, body, p }) => queued("proxy_test", pid, body, p),
    202,
  );
  route("GET", "/profiles/:id/remote-desktop", "read", ({ pid }) => ({
    ...service.profile(pid).remoteDesktop,
    entry: `/profiles/${pid}/desktop`,
    authentication: "VNCAuth",
    passwordLength: 8,
  }));
  route(
    "POST",
    "/profiles/:id/remote-desktop/password/reveal",
    "manage",
    ({ pid, body, p: principal }) => {
      z.object({ idempotencyKey: z.string().max(128).optional() }).strict().parse(body);
      try {
        const profile = service.profile(pid);
        if (profile.purgedAt)
          throw new FleetError("PROFILE_PURGED", "实例数据已彻底清理，无法查看VNC密码", 410);
        let password: unknown;
        try {
          if (!profile.vncSecretRef) throw new Error("missing reference");
          password = service.vault.get<unknown>(profile.vncSecretRef);
        } catch {
          throw new FleetError("VNC_PASSWORD_UNAVAILABLE", "已保存的VNC密码不可用，请重新设置", 409);
        }
        if (typeof password !== "string" || !/^[\x21-\x7e]{8}$/.test(password))
          throw new FleetError("VNC_PASSWORD_UNAVAILABLE", "已保存的VNC密码不可用，请重新设置", 409);
        service.audit(principal.id, "vnc_password_reveal", pid, "succeeded");
        return { password, version: profile.remoteDesktop.version };
      } catch (error) {
        service.audit(principal.id, "vnc_password_reveal", pid, "failed");
        throw error;
      }
    },
    200,
    // Disclosure must recheck current state and audit every access, including retries after rotation.
    { cacheResponse: false },
  );
  route(
    "PUT",
    "/profiles/:id/remote-desktop/password",
    "manage",
    async ({ pid, body }) => {
      const b = z
          .object({
            password: z
              .string()
              .regex(/^[\x21-\x7e]{8}$/)
              .optional(),
            secretRef: z.string().optional(),
          })
          .strict()
          .parse(body),
        p = service.profile(pid),
        password = b.secretRef
          ? service.vault.get<string>(b.secretRef)
          : b.password || randomBytes(6).toString("base64url");
      if (!/^[\x21-\x7e]{8}$/.test(password))
        throw new FleetError(
          "VNC_PASSWORD_LENGTH",
          "VNC密码须为8个可见ASCII字符",
        );
      await service.revokeDesktop(pid);
      const token = service.db.acquire(pid, "vnc-rotation");
      if (token === undefined)
        throw new FleetError(
          "PROFILE_BUSY",
          "请等待任务完成后轮换VNC密码",
          409,
        );
      try {
        p.vncSecretRef = service.vault.put(password);
        p.remoteDesktop.version++;
        service.saveProfile(p);
        service.prepareFiles(p);
        if (p.state === "running") {
          await service.agent(p, "/fence", { token });
          await service.agent(p, "/vnc/reload", {}, token);
          p.remoteDesktop.appliedVersion = p.remoteDesktop.version;
          service.saveProfile(p);
        }
        return {
          ...p.remoteDesktop,
          oncePassword: !b.password && !b.secretRef ? password : undefined,
        };
      } finally {
        service.db.release(pid, "vnc-rotation", token);
      }
    },
  );
  route("GET", "/google-accounts", "admin", ({ query, p }) =>
    list(service.google.list(p), query),
  );
  route("POST", "/google-accounts", "admin", ({ body, p }) =>
    service.google.create(body, p), 201,
  );
  route("PATCH", "/google-accounts/:accountId", "admin", ({ params, body, p }) =>
    service.google.update(params.accountId, body, p),
  );
  route("POST", "/google-accounts/:accountId/password/reveal", "admin", ({ params, body, p }) => {
    z.object({ idempotencyKey: z.string().max(128).optional() }).strict().parse(body);
    return service.google.revealPassword(params.accountId, p);
  }, 200, { cacheResponse: false });
  route(
    "POST",
    "/profiles/:id/google-login",
    "automate",
    ({ pid, p, body }) => {
      auth.require(p, "manage", pid);
      const input = z.object({
        accountId: z.string().regex(/^google_[0-9a-f]{24}$/).optional(),
        idempotencyKey: z.string().max(128).optional(),
      }).strict().parse(body);
      if (input.accountId) auth.require(p, "admin");
      return service.google.open(pid, p, input.accountId);
    },
    201,
  );
  route("POST", "/profiles/:id/google-login/check", "automate", () => {
    throw new FleetError("ACCOUNT_CHECK_REMOVED", "主动账号检测已移除，请在实例详情人工确认登录", 410);
  }, 200, { cacheResponse: false });
  route("GET", "/profiles/:id/accounts", "read", ({ pid, query }) =>
    list(
      service.db.list<any>("accounts").filter((a) => a.profileId === pid).map(accountView),
      query,
    ),
  );
  route("POST", "/profiles/:id/google-login/confirm", "automate", ({ pid, p, body }) => {
    auth.require(p, "manage", pid);
    auth.require(p, "admin", pid);
    const input = GoogleLoginConfirmationSchema.parse(body);
    return service.google.confirm(pid, p, input.accountId);
  });
  route("PUT", "/profiles/:id/google-binding", "manage", ({ pid, p, body }) => {
    auth.require(p, "automate", pid); auth.require(p, "admin", pid);
    return service.google.bind(pid, GoogleBindingInputSchema.parse(body).accountId, p);
  });
  route(
    "POST",
    "/profiles/:id/accounts",
    "manage",
    ({ pid, body, p }) => {
      if (typeof body.provider === "string" && body.provider.toLowerCase() === "google") {
        auth.require(p, "admin", pid); auth.require(p, "automate", pid);
      }
      return service.bindAccount(pid, body, p);
    },
    201,
  );
  route("POST", "/profiles/:id/accounts/check", "automate", () => {
    throw new FleetError("ACCOUNT_CHECK_REMOVED", "主动账号检测已移除，请在实例详情人工确认登录", 410);
  }, 200, { cacheResponse: false });
  route(
    "POST",
    "/profiles/:id/manual-sessions",
    "automate",
    ({ pid, p, body }) =>
      service.openDesktop(
        pid,
        p,
        z
          .object({
            durationSeconds: z.number().int().min(60).max(3600).optional(),
            explicitStart: z.boolean().optional(),
            idempotencyKey: z.string().max(128).optional(),
          })
          .strict()
          .parse(body),
      ),
    201,
  );
  route("GET", "/manual-sessions", "automate", ({ p, query }) =>
    list(
      service.db
        .list<any>("manual-sessions")
        .filter(
          (s) =>
            s.principal === p.id &&
            !s.closed &&
            Date.parse(s.expiresAt) > Date.now() &&
            visible(p, s.profileId) &&
            (!query.profileId || s.profileId === query.profileId),
        )
        .map(({ fencingToken, ...s }) => ({
          ...s,
          ...(s.googleLogin ? { googleLogin: service.google.loginState(s.profileId, s.googleLogin) } : {}),
          desktopPath: `/profiles/${s.profileId}/desktop`,
        })),
      query,
    ),
  );
  route(
    "DELETE",
    "/manual-sessions/:sessionId",
    "automate",
    async ({ params, p }) => {
      const s = service.db.get<any>("manual-sessions", params.sessionId);
      if (!s)
        throw new FleetError("MANUAL_SESSION_NOT_FOUND", "人工会话不存在", 404);
      auth.require(p, "automate", s.profileId);
      if (s.principal !== p.id && !p.scopes.includes("admin"))
        throw new FleetError("SESSION_DENIED", "无权结束此人工会话", 403);
      if (s.googleLogin && !s.closed)
        await service.google.finishSession(s);
      else await service.revokeDesktop(s.profileId);
      return { closed: true };
    },
  );
  route(
    "POST",
    "/jobs",
    "automate",
    ({ body, p }) => {
      let input = body;
      if (body.templateId) {
        const t = service.db.get<any>("templates", body.templateId);
        if (!t)
          throw new FleetError("TEMPLATE_NOT_FOUND", "任务模板不存在", 404);
        const parameters = body.parameters || {};
        for (const [key, rule] of Object.entries(t.parametersSchema || {}) as [
          string,
          any,
        ][]) {
          const value = parameters[key];
          if (rule.required && value === undefined)
            throw new FleetError(
              "TEMPLATE_PARAMETER_REQUIRED",
              `模板缺少参数 ${key}`,
            );
          if (value !== undefined && typeof value !== rule.type)
            throw new FleetError(
              "TEMPLATE_PARAMETER_TYPE",
              `模板参数 ${key} 类型不正确`,
            );
        }
        if (
          Object.keys(parameters).some(
            (k) => !(k in (t.parametersSchema || {})),
          )
        )
          throw new FleetError(
            "TEMPLATE_PARAMETER_UNKNOWN",
            "模板包含未声明参数",
          );
        const fill = (v: any): any =>
          typeof v === "string"
            ? v.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, k) =>
                String(parameters[k] ?? ""),
              )
            : Array.isArray(v)
              ? v.map(fill)
              : v && typeof v === "object"
                ? Object.fromEntries(
                    Object.entries(v).map(([k, x]) => [k, fill(x)]),
                  )
                : v;
        input = {
          profileId: body.profileId,
          steps: fill(t.steps),
          timeoutMs: body.timeoutMs || t.timeoutMs || 60000,
          idempotencyKey: body.idempotencyKey,
          expectedAccountId: body.expectedAccountId,
        };
      }
      const b = JobSchema.parse(input);
      auth.require(p, "automate", b.profileId);
      return queued("automation", b.profileId, b, p);
    },
    202,
  );
  route("GET", "/templates", "read", ({ query }) =>
    list(service.db.list("templates"), query),
  );
  route(
    "POST",
    "/templates",
    "manage",
    ({ body }) => {
      const t = z
        .object({
          name: z.string().min(1).max(80),
          steps: z.array(StepSchema).min(1).max(100),
          timeoutMs: z.number().int().min(1000).max(900000).default(60000),
          parametersSchema: z
            .record(
              z.string(),
              z
                .object({
                  type: z.enum(["string", "number", "boolean"]),
                  required: z.boolean().default(false),
                })
                .strict(),
            )
            .default({}),
        })
        .strict()
        .parse(body);
      const tid = id("template");
      return service.db.set("templates", tid, {
        ...t,
        id: tid,
        schemaVersion: 1,
        createdAt: now(),
      });
    },
    201,
  );
  route("GET", "/jobs", "read", ({ p, query }) => {
    const { jobs, ...page } = jobPage(service.db, p, query);
    return { ...page, items: jobs.map(publicJob) };
  });
  route("GET", "/jobs/density", "read", ({ p, query }) => jobDensity(service.db, p, query));
  route("GET", "/jobs/:jobId", "read", ({ params, p }) => {
    const j = service.job(params.jobId);
    auth.require(p, "read", j.profileId === "system" ? undefined : j.profileId);
    return publicJob(j);
  });
  for (const action of ["cancel", "resume"])
    route(
      "POST",
      `/jobs/:jobId/${action}`,
      "automate",
      async ({ params, p }) => {
        const j = service.job(params.jobId);
        auth.require(p, "automate", j.profileId);
        if (action === "cancel") {
          j.cancelRequested = true;
          if (["queued", "waiting_for_human"].includes(j.status))
            j.status = "cancelled";
          if (j.status === "running" && j.profileId !== "system")
            await service.agent(
              service.profile(j.profileId),
              "/cancel",
              {},
              j.fencingToken,
            );
        } else {
          if (j.status !== "waiting_for_human")
            throw new FleetError(
              "JOB_NOT_WAITING",
              "仅能恢复等待人工验证的任务",
              409,
            );
          if (service.db.lease(j.profileId)?.expires_at > Date.now())
            throw new FleetError("PROFILE_BUSY", "请先关闭人工接管会话", 409);
          j.status = "queued";
          j.cancelRequested = false;
        }
        service.saveJob(j);
        return publicJob(j);
      },
    );
  route(
    "GET",
    "/jobs/:jobId/events",
    "read",
    async ({ params, p, req, reply }) => {
      const j = service.job(params.jobId);
      auth.require(p, "read", j.profileId);
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      let last = "";
      const send = () => {
        const state = publicJob(service.job(j.id)),
          next = JSON.stringify(state);
        if (next !== last) {
          reply.raw.write(`event: progress\ndata: ${next}\n\n`);
          last = next;
        }
      };
      send();
      const timer = setInterval(send, 1000);
      req.raw.on("close", () => clearInterval(timer));
    },
  );
  for (const type of ["cookies", "storage-state"]) {
    route(
      "POST",
      `/profiles/:id/${type}/export`,
      "session:read",
      ({ pid, body, p }) => queued(`${type}_export`, pid, body, p),
      202,
    );
    route(
      "POST",
      `/profiles/:id/${type}/import`,
      "session:write",
      ({ pid, body, p }) => {
        if (typeof body.artifactId !== "string")
          throw new FleetError("ARTIFACT_REQUIRED", "请先上传加密导入文件");
        const a = service.readArtifact(body.artifactId);
        if (a.meta.profileId !== pid)
          throw new FleetError(
            "ARTIFACT_PROFILE_MISMATCH",
            "文件不属于实例",
            403,
          );
        return queued(`${type}_import`, pid, body, p);
      },
      202,
    );
  }
  route(
    "POST",
    "/artifacts",
    "session:write",
    async ({ body, p }) => {
      const b = z
        .object({
          profileId: z.string(),
          type: z.string().max(64).default("import"),
          base64: z.string().max(22 * 1024 * 1024),
          mimeType: z.string().max(128).default("application/json"),
        })
        .strict()
        .parse(body);
      auth.require(p, "session:write", b.profileId);
      service.profile(b.profileId);
      const data = Buffer.from(b.base64, "base64");
      if (data.length > 16 * 1024 * 1024)
        throw new FleetError(
          "ARTIFACT_TOO_LARGE",
          "单个上传文件最大16MiB",
          413,
        );
      return service.artifact(b.profileId, b.type, data, b.mimeType);
    },
    201,
  );
  route("GET", "/artifacts/:artifactId", "read", ({ params, p }) => {
    const a = service.db.get<any>("artifacts", params.artifactId);
    if (!a) throw new FleetError("ARTIFACT_NOT_FOUND", "文件不存在", 404);
    auth.require(p, "read", a.profileId);
    return a;
  });
  route(
    "GET",
    "/artifacts/:artifactId/download",
    "read",
    ({ params, p, reply }) => {
      const a = service.readArtifact(params.artifactId);
      auth.require(p, "read", a.meta.profileId);
      if (["cookies", "storage-state", "import"].includes(a.meta.type))
        auth.require(p, "session:read", a.meta.profileId);
      reply
        .type(a.meta.mimeType)
        .header(
          "Content-Disposition",
          `attachment; filename="${a.meta.id}.${a.meta.mimeType === "application/json" ? "json" : "bin"}"`,
        );
      return reply.send(a.data);
    },
  );
  route("GET", "/profiles/:id/snapshots", "backup", ({ pid, query }) =>
    list(
      service.db
        .list<any>("snapshots")
        .filter((s) => s.profileId === pid)
        .map(publicSnapshot),
      query,
    ),
  );
  route(
    "POST",
    "/profiles/:id/snapshots",
    "backup",
    ({ pid, body, p }) => queued("snapshot", pid, body, p),
    202,
  );
  route(
    "POST",
    "/profiles/:id/restore",
    "backup",
    ({ pid, body, p }) => {
      if (typeof body.snapshotId !== "string")
        throw new FleetError("SNAPSHOT_REQUIRED", "须指定快照ID");
      return queued("restore", pid, body, p);
    },
    202,
  );
  route("GET", "/browser-versions", "read", ({ query }) =>
    list(service.db.list("versions"), query),
  );
  route("GET", "/update-policy", "read", () =>
    service.db.get("settings", "update-policy"),
  );
  route("PATCH", "/update-policy", "update", ({ body }) => {
    const b = z
      .object({
        mode: z.enum(["manual", "notify", "auto"]).optional(),
        paused: z.boolean().optional(),
        checkIntervalHours: z.number().int().min(1).max(168).optional(),
        maintenanceStart: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
          .optional(),
        maintenanceEnd: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
          .optional(),
      })
      .strict()
      .parse(body);
    return service.db.set("settings", "update-policy", {
      ...service.db.get<any>("settings", "update-policy"),
      ...b,
    });
  });
  for (const action of ["check", "apply"])
    route(
      "POST",
      `/updates/${action}`,
      "update",
      ({ body, p }) => {
        if (!p.profiles.includes("*"))
          throw new FleetError(
            "PROFILE_DENIED",
            "更新管理需要所有实例权限",
            403,
          );
        return queued(`update_${action}`, "system", body, p);
      },
      202,
    );
  route("GET", "/updates", "read", ({ p, query }) => {
    auth.require(p, "update");
    return list(service.db.list("updates").reverse(), query);
  });
  route("GET", "/updates/:updateId", "read", ({ params, p }) => {
    auth.require(p, "update");
    const u = service.db.get("updates", params.updateId);
    if (!u) throw new FleetError("UPDATE_NOT_FOUND", "更新记录不存在", 404);
    return u;
  });
  route(
    "POST",
    "/updates/:updateId/rollback",
    "update",
    ({ params, p }) =>
      queued("update_rollback", "system", { updateId: params.updateId }, p),
    202,
  );
  route("GET", "/credentials", "admin", () =>
    service.db.list<any>("credentials").map(({ hash, ...c }) => c),
  );
  route(
    "POST",
    "/credentials",
    "admin",
    ({ body }) => {
      const b = z
        .object({
          scopes: z.array(z.enum(Scopes)).min(1),
          profiles: z.array(z.string()).min(1).default(["*"]),
          expiresAt: z.string().datetime(),
        })
        .strict()
        .parse(body);
      if (Date.parse(b.expiresAt) <= Date.now())
        throw new FleetError("INVALID_EXPIRY", "凭证有效期须在未来");
      return auth.issue(b.scopes, b.profiles, b.expiresAt);
    },
    201,
  );
  route("DELETE", "/credentials/:credentialId", "admin", ({ params }) => {
    const c = service.db.get<any>("credentials", params.credentialId);
    if (!c) throw new FleetError("CREDENTIAL_NOT_FOUND", "凭证不存在", 404);
    c.revoked = true;
    service.db.set("credentials", c.id, c);
    return { revoked: true };
  });
  route(
    "POST",
    "/secrets",
    "admin",
    ({ body }) => {
      const b = z
        .object({
          value: z.union([
            z.string().max(4096),
            z.object({ username: z.string(), password: z.string() }),
          ]),
        })
        .strict()
        .parse(body);
      return { secretRef: service.vault.put(b.value) };
    },
    201,
  );
  route("GET", "/audit", "admin", ({ query }) =>
    list(service.db.list("audit").reverse(), query),
  );
  // Keep HTTP tombstones for stale clients without advertising removed operations.
  delete openapi.paths["/api/v1/profiles/{id}/accounts/check"];
  delete openapi.paths["/api/v1/profiles/{id}/google-login/check"];
  openapi.components.schemas = {
    CreateProfile: z.toJSONSchema(CreateProfileSchema),
    ProxyConfig: z.toJSONSchema(ProxySchema),
    AutomationJob: z.toJSONSchema(JobSchema),
    RuntimePolicy: z.toJSONSchema(RuntimeSchema),
    PlatformInput: z.toJSONSchema(PlatformInputSchema),
    PlatformPatch: z.toJSONSchema(PlatformPatchSchema),
    PlatformLink: z.toJSONSchema(PlatformLinkSchema),
    PlatformConfirmation: z.toJSONSchema(PlatformConfirmationSchema),
    AsyncJob: {
      type: "object",
      required: ["jobId", "status"],
      properties: {
        jobId: { type: "string" },
        status: { type: "string", enum: ["queued", "running"] },
      },
    },
  };
  for (const [path, method, schema] of [
    ["/api/v1/profiles", "post", "CreateProfile"],
    ["/api/v1/jobs", "post", "AutomationJob"],
    ["/api/v1/profiles/{id}/proxy", "put", "ProxyConfig"],
    ["/api/v1/profiles/{id}/runtime-policy", "patch", "RuntimePolicy"],
    ["/api/v1/platforms", "post", "PlatformInput"],
    ["/api/v1/platforms/{platformId}", "patch", "PlatformPatch"],
    ["/api/v1/profiles/{profileId}/platforms/{platformId}", "post", "PlatformLink"],
    ["/api/v1/profiles/{profileId}/platforms/{platformId}/confirm", "post", "PlatformConfirmation"],
  ])
    openapi.paths[path][method].requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: `#/components/schemas/${schema}` },
        },
      },
    };
  app.get("/api/v1/openapi.json", async (req) => {
    auth.require(auth.authenticate(req), "read");
    return openapi;
  });
  installDesktop(app, service, auth, originPolicy);
  const mcp = await import("@chrome-fleet/mcp-bridge");
  await mcp.installMcpHttp(
    app,
    (request: any) =>
      async (method: any, path: string, body?: unknown, options?: any) => {
        const response = await app.inject({
          method,
          url: path,
          headers: {
            authorization: request.headers.authorization,
            host: request.headers.host,
            ...(options?.idempotencyKey
              ? { "idempotency-key": options.idempotencyKey }
              : {}),
          },
          ...(body === undefined ? {} : { payload: body as any }),
        });
        const result = response.json();
        if (response.statusCode >= 400)
          throw Object.assign(new Error(result.message), result, {
            status: response.statusCode,
          });
        return result;
      },
    {
      authorize: async (req: any) => {
        auth.authenticate(req);
        return true;
      },
      allowedHosts: [...hosts],
      allowedOrigins: [...originPolicy.origins],
    },
  );
  if (existsSync(config.webRoot)) {
    await app.register(serveStatic, {
      root: config.webRoot,
      prefix: "/",
      index: ["index.html"],
    });
    app.setNotFoundHandler((req, reply) => {
      let pathname: string;
      try { pathname = decodeURIComponent(new URL(req.url, "http://fleet.invalid").pathname); }
      catch { pathname = "/api/invalid-path"; }
      const resource = /^\/(?:api|mcp|health|ready|assets)(?:\/|$)/.test(pathname)
        || /^\/profiles\/[^/]+\/desktop(?:\/|$)/.test(pathname)
        || /\.[^/]+$/.test(pathname);
      return resource || !["GET", "HEAD"].includes(req.method)
        ? reply.code(404).send({
            code: "NOT_FOUND",
            message: "请求的资源不存在",
            requestId: req.id,
          })
        : reply.sendFile("index.html");
    });
  }
  app.addHook("onClose", async () => {
    if (service.timer) clearInterval(service.timer);
  });
  return { app, service, auth, openapi };
}
export function publicJob(j: Job) {
  const { payload, payloadRef, principal, fencingToken, ...out } = j;
  return out;
}
function publicSnapshot(s: any) {
  const { keyringSecretRef, vncSecretRef, ...out } = s;
  return out;
}
