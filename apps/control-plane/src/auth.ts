import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { Store, hash, id, now } from "@chrome-fleet/core";
import { FleetError, type Scope } from "@chrome-fleet/contracts";
import type { FastifyRequest } from "fastify";
export interface Principal {
  id: string;
  scopes: string[];
  profiles: string[];
  expiresAt?: string;
  revoked?: boolean;
  csrfToken?: string;
  sessionId?: string;
}
export class Auth {
  constructor(
    public db: Store,
    tokenFile: string,
  ) {
    const token = readFileSync(tokenFile, "utf8").trim();
    if (token.length < 32) throw new Error("平台凭证长度不足32");
    if (!db.get("credentials", "bootstrap"))
      db.set("credentials", "bootstrap", {
        id: "bootstrap",
        hash: hash(token),
        scopes: ["admin"],
        profiles: ["*"],
        createdAt: now(),
      });
  }
  token(token: string): Principal {
    const digest = hash(token);
    const c = this.db
      .list<any>("credentials")
      .find(
        (c) =>
          c.hash === digest &&
          !c.revoked &&
          (!c.expiresAt || Date.parse(c.expiresAt) > Date.now()),
      );
    if (!c) throw new FleetError("UNAUTHORIZED", "平台凭证无效或已过期", 401);
    return {
      id: c.id,
      scopes: c.scopes,
      profiles: c.profiles,
      expiresAt: c.expiresAt,
    };
  }
  authenticate(req: FastifyRequest): Principal {
    const bearer = req.headers.authorization;
    if (bearer?.startsWith("Bearer ")) return this.token(bearer.slice(7));
    const sid = (req as any).cookies?.fleet_session;
    if (sid) {
      const s = this.db.get<any>("sessions", hash(sid));
      if (s && Date.parse(s.expiresAt) > Date.now()) {
        const c = this.db.get<any>("credentials", s.credentialId);
        if (
          c &&
          !c.revoked &&
          (!c.expiresAt || Date.parse(c.expiresAt) > Date.now())
        )
          return { ...c, sessionId: hash(sid), csrfToken: s.csrfToken };
      }
    }
    throw new FleetError("UNAUTHORIZED", "请先登录 Chrome Fleet", 401);
  }
  require(p: Principal, scope: Scope, profileId?: string) {
    if (!p.scopes.includes("admin") && !p.scopes.includes(scope))
      throw new FleetError("SCOPE_DENIED", `缺少 ${scope} 权限`, 403);
    if (
      profileId &&
      !p.profiles.includes("*") &&
      !p.profiles.includes(profileId)
    )
      throw new FleetError("PROFILE_DENIED", "无权访问此实例", 403);
  }
  login(token: string) {
    const c = this.token(token),
      sid = randomBytes(32).toString("base64url"),
      csrfToken = randomBytes(24).toString("base64url");
    this.db.set("sessions", hash(sid), {
      id: hash(sid),
      credentialId: c.id,
      csrfToken,
      expiresAt: new Date(Date.now() + 8 * 3600000).toISOString(),
    });
    return { sid, csrfToken };
  }
  issue(scopes: string[], profiles: string[], expiresAt: string) {
    const token = randomBytes(32).toString("base64url"),
      cid = id("cred");
    this.db.set("credentials", cid, {
      id: cid,
      hash: hash(token),
      scopes,
      profiles,
      expiresAt,
      createdAt: now(),
      revoked: false,
    });
    return { id: cid, token, scopes, profiles, expiresAt };
  }
  csrf(req: FastifyRequest, p: Principal) {
    if (p.sessionId && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const provided = req.headers["x-csrf-token"];
      if (typeof provided !== "string" || provided !== p.csrfToken)
        throw new FleetError("CSRF_REJECTED", "CSRF 校验失败，请重新登录", 403);
    }
  }
}
