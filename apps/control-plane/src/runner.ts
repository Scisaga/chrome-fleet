import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { FleetError } from "@chrome-fleet/contracts";
/** Native HTTP avoids fetch's fixed response-header timeout during controlled image builds. */
export class Runner {
  token: string;
  constructor(
    public baseUrl: string,
    tokenFile: string,
  ) {
    this.token = readFileSync(tokenFile, "utf8").trim();
  }
  async call(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    timeout = 300000,
  ): Promise<any> {
    const url = new URL(path, this.baseUrl),
      payload =
        body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            ...(payload
              ? {
                  "content-type": "application/json",
                  "content-length": payload.length,
                }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1024 * 1024) req.destroy(new Error("response limit"));
            else chunks.push(chunk);
          });
          res.on("end", () => {
            clearTimeout(timer);
            try {
              const b = JSON.parse(Buffer.concat(chunks).toString());
              if ((res.statusCode || 500) >= 400)
                reject(
                  new FleetError(
                    b.code || "RUNNER_ERROR",
                    b.message || "容器操作失败",
                    res.statusCode! >= 500 ? 502 : res.statusCode,
                  ),
                );
              else resolve(b.data ?? b);
            } catch {
              reject(
                new FleetError(
                  "RUNNER_INVALID_RESPONSE",
                  "Runner 返回无效响应",
                  502,
                ),
              );
            }
          });
          res.on("error", () => {
            clearTimeout(timer);
            reject(
              new FleetError(
                "RUNNER_UNAVAILABLE",
                "Runner 连接中断，操作可能尚在进行",
                503,
              ),
            );
          });
        },
      );
      const timer = setTimeout(
        () => req.destroy(new Error("timeout")),
        timeout,
      );
      req.on("error", () => {
        clearTimeout(timer);
        reject(
          new FleetError(
            "RUNNER_UNAVAILABLE",
            "受限 Runner 无法连接或等待超时，请查询实际状态",
            503,
          ),
        );
      });
      if (payload) req.write(payload);
      req.end();
    });
  }
}
