import type { FastifyInstance, FastifyRequest } from "fastify";
import { WebSocket, WebSocketServer } from "ws";
import { FleetError } from "@chrome-fleet/contracts";
import { z } from "zod";
import type { FleetService } from "./service.js";
import type { Auth } from "./auth.js";
import type { OriginPolicy } from "./origin-policy.js";
import { desktopClientModule } from "./desktop-client.js";
import { desktopClipboardModule } from "./desktop-clipboard-client.js";
export function installDesktop(
  app: FastifyInstance,
  service: FleetService,
  auth: Auth,
  policy: OriginPolicy,
) {
  const sockets = new Map<
    WebSocket,
    { sessionId: string; upstream: WebSocket; valid: () => boolean }
  >();
  const authorized = (req: FastifyRequest, pid: string) => {
    const principal = auth.authenticate(req);
    auth.require(principal, "automate", pid);
    const session = service.manualSession(pid, principal);
    const lease = service.db.lease(pid);
    if (!lease || lease.expires_at <= Date.now())
      throw new FleetError("MANUAL_SESSION_EXPIRED", "人工操作租约已过期，请重新打开桌面", 403);
    const profile = service.profile(pid);
    if (profile.purgedAt || profile.archived || profile.state !== "running")
      throw new FleetError("DESKTOP_UNAVAILABLE", "实例桌面不可用，请重新打开桌面", 409);
    if (!profile.remoteDesktop.passwordConfigured || profile.remoteDesktop.appliedVersion !== profile.remoteDesktop.version)
      throw new FleetError("DESKTOP_PASSWORD_PENDING", "桌面密码版本尚未生效，请重新打开桌面", 409);
    return { principal, session, profile };
  };
  service.desktopRevoker = async (sid) => {
    for (const [socket, entry] of sockets)
      if (entry.sessionId === sid) {
        entry.upstream.terminate();
        socket.terminate();
        sockets.delete(socket);
      }
  };
  app.get("/profiles/:id/desktop", async (req, reply) => {
    const pid = (req.params as any).id;
    authorized(req, pid);
    return reply.redirect(
      `/profiles/${pid}/desktop/vnc.html?autoconnect=1&resize=scale&path=profiles/${pid}/desktop/websockify`,
    );
  });
  app.post("/profiles/:id/desktop/credentials", async (req, reply) => {
    const pid = (req.params as any).id;
    const { principal, session, profile } = authorized(req, pid);
    if (!principal.sessionId)
      throw new FleetError("WEB_SESSION_REQUIRED", "桌面自动认证需要有效的平台Web会话", 403);
    auth.csrf(req, principal);
    if (!policy.acceptsOrigin(req.headers.origin, req.headers.host, true))
      throw new FleetError("ORIGIN_REJECTED", "桌面自动认证需要同源请求", 403);
    const body = z.object({
      sessionId: z.string().regex(/^manual_[0-9a-f-]{36}$/),
      version: z.number().int().positive().safe(),
    }).strict().parse(req.body);
    if (body.sessionId !== session.id || body.version !== profile.remoteDesktop.version)
      throw new FleetError("DESKTOP_CONTEXT_EXPIRED", "桌面会话或密码版本已变化，请重新打开桌面", 409);
    reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
    try {
      const password: unknown = profile.vncSecretRef ? service.vault.get(profile.vncSecretRef) : undefined;
      if (typeof password !== "string" || !/^[\x21-\x7e]{8}$/.test(password)) throw new Error("unavailable");
      service.audit(principal.id, "desktop_credentials", pid, "succeeded");
      return { data: { password, version: profile.remoteDesktop.version }, requestId: req.id };
    } catch {
      service.audit(principal.id, "desktop_credentials", pid, "failed");
      throw new FleetError("VNC_PASSWORD_UNAVAILABLE", "桌面认证凭据不可用，请重新设置", 409);
    }
  });
  app.get("/profiles/:id/desktop/fleet-desktop.js", async (req, reply) => {
    authorized(req, (req.params as any).id);
    return reply.type("application/javascript; charset=utf-8").send(desktopClientModule);
  });
  app.post("/profiles/:id/desktop/clipboard", async (req, reply) => {
    reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
    const pid = (req.params as any).id;
    const { principal, session, profile } = authorized(req, pid);
    if (!principal.sessionId)
      throw new FleetError("WEB_SESSION_REQUIRED", "剪贴板需要有效的平台Web会话", 403);
    auth.csrf(req, principal);
    if (!policy.acceptsOrigin(req.headers.origin, req.headers.host, true))
      throw new FleetError("ORIGIN_REJECTED", "剪贴板需要同源请求", 403);
    const binding = {
      sessionId: z.string().regex(/^manual_[0-9a-f-]{36}$/),
      version: z.number().int().positive().safe(),
    };
    const text = z.string().max(128 * 1024).refine(value => !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 128 * 1024);
    const body = z.discriminatedUnion("action", [
      z.object({ ...binding, action: z.literal("read") }).strict(),
      z.object({ ...binding, action: z.literal("write"), text }).strict(),
    ]).parse(req.body);
    const assertContext = () => {
      const current = authorized(req, pid);
      if (body.sessionId !== current.session.id || body.version !== current.profile.remoteDesktop.version ||
          current.session.id !== session.id || current.session.fencingToken !== session.fencingToken)
        throw new FleetError("DESKTOP_CONTEXT_EXPIRED", "桌面会话或密码版本已变化，请重新打开桌面", 409);
    };
    assertContext();
    try {
      const result = await service.agent(profile, "/desktop/clipboard", body.action === "read"
        ? { action: "read" } : { action: "write", text: body.text }, session.fencingToken, 5000);
      assertContext();
      if (body.action === "read") {
        if (!result || typeof result.text !== "string" || result.text.includes("\0") || Buffer.byteLength(result.text, "utf8") > 128 * 1024)
          throw new FleetError("CLIPBOARD_TOO_LARGE", "远程剪贴板文本无效或超过128KiB", 413);
        return { data: { text: result.text }, requestId: req.id };
      }
      if (result?.written !== true)
        throw new FleetError("CLIPBOARD_UNAVAILABLE", "远程剪贴板未确认写入，请稍后重试", 503);
      return { data: { written: true }, requestId: req.id };
    } catch (error) {
      if (error instanceof FleetError && ["DESKTOP_CONTEXT_EXPIRED", "MANUAL_SESSION_EXPIRED", "CLIPBOARD_TOO_LARGE", "SCOPE_DENIED", "PROFILE_DENIED", "UNAUTHORIZED", "DESKTOP_UNAVAILABLE", "DESKTOP_PASSWORD_PENDING"].includes(error.code)) throw error;
      throw new FleetError("CLIPBOARD_UNAVAILABLE", "远程剪贴板暂不可用，请确认浏览器镜像已更新后重试", 503);
    } finally {
      if (body.action === "write") body.text = "";
      if (req.body && typeof req.body === "object" && "text" in req.body) (req.body as { text: string }).text = "";
    }
  });
  app.get("/profiles/:id/desktop/fleet-clipboard.js", async (req, reply) => {
    authorized(req, (req.params as any).id);
    return reply.type("application/javascript; charset=utf-8").header("Cache-Control", "no-store").send(desktopClipboardModule);
  });
  app.get("/profiles/:id/desktop/*", async (req, reply) => {
    const pid = (req.params as any).id;
    const { session, profile } = authorized(req, pid);
    const path = (req.params as any)["*"];
    if (path.includes("..") || path.includes("://"))
      throw new FleetError("INVALID_PATH", "桌面资源路径无效");
    const r = await fetch(profile.desktopUrl + "/" + path, {
      signal: AbortSignal.timeout(10000),
    });
    reply.code(r.status);
    reply.type(r.headers.get("content-type") || "application/octet-stream");
    if (path === "vnc.html" && r.ok) {
      const html = await r.text();
      const metadata = `<meta name="fleet-desktop-context" data-profile-id="${profile.id}" data-session-id="${session.id}" data-version="${profile.remoteDesktop.version}"><script type="module" src="fleet-desktop.js"></script><script type="module" src="fleet-clipboard.js"></script>`;
      return reply.type("text/html; charset=utf-8").send(html.replace(/<head(?:\s[^>]*)?>/i, (head) => head + metadata));
    }
    return reply.send(Buffer.from(await r.arrayBuffer()));
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024,
  });
  app.server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url || "/", policy.publicOrigin),
        m = url.pathname.match(
          /^\/profiles\/(cf_[0-9a-f-]{36})\/desktop\/websockify$/,
        );
      if (!m) {
        socket.destroy();
        return;
      }
      if (!policy.acceptsHost(req.headers.host) || !policy.acceptsOrigin(req.headers.origin, req.headers.host, true)) {
        socket.destroy();
        return;
      }
      const cookies = Object.fromEntries(
        (req.headers.cookie || "").split(";").map((c) => c.trim().split("=")),
      );
      const authenticatedRequest = {
        headers: req.headers,
        cookies,
      } as FastifyRequest;
      const { session, profile } = authorized(authenticatedRequest, m[1]);
      const version = profile.remoteDesktop.version;
      const expectedSession = url.searchParams.get("sessionId");
      const expectedVersion = url.searchParams.get("version");
      if ((expectedSession !== null || expectedVersion !== null) &&
        (expectedSession !== session.id || expectedVersion !== String(version))) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (client) => {
        const target = new WebSocket(
          profile.desktopUrl.replace(/^http/, "ws") + "/websockify",
        );
        sockets.set(client, { sessionId: session.id, upstream: target, valid: () => {
          try {
            const current = authorized(authenticatedRequest, m[1]);
            return current.session.id === session.id && current.profile.remoteDesktop.version === version;
          } catch { return false; }
        } });
        const pending: Buffer[] = [];
        client.on("message", (data) => {
          if (target.readyState === WebSocket.OPEN) target.send(data);
          else if (pending.length < 10)
            pending.push(Buffer.from(data as Buffer));
          else client.close(1013, "浏览器连接繁忙");
        });
        target.on("open", () => pending.forEach((d) => target.send(d)));
        target.on("message", (data) => {
          if (client.readyState === WebSocket.OPEN) client.send(data);
        });
        target.on("close", () => client.close(1000, "桌面连接结束"));
        target.on("error", () => client.close(1011, "浏览器桌面不可用"));
        client.on("close", () => {
          target.close();
          sockets.delete(client);
        });
        client.on("error", () => target.close());
      });
    } catch {
      socket.destroy();
    }
  });
  const timer = setInterval(() => {
    for (const [socket, entry] of sockets) {
      if (!entry.valid()) {
        entry.upstream.terminate();
        socket.close(1008, "桌面会话已失效，请重新打开桌面");
      }
    }
  }, 1000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    for (const ws of sockets.keys()) ws.terminate();
    wss.close();
  });
}
