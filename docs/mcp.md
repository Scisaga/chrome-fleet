# MCP HTTP 连接

管理界面左侧的「MCP」菜单打开 `/integrations/mcp`，提供当前HTTP地址复制、六类34个工具的用途和权限说明，并支持按功能或工具名搜索。每项工具标记通用、自动化模式或按模式处理；目录通过测试与服务端实际注册的工具名称及权限逐项对照。`/integrations/mcp` 为管理页面，`/mcp` 继续作为协议入口。

MCP 已集成在 Chrome Fleet 控制服务中。客户端选择 **Streamable HTTP**，连接 **管理页面地址加 `/mcp`**，使用平台访问令牌进行 **Bearer** 鉴权；不需要另外启动 MCP 服务或执行 Docker 命令。

例如管理页是 `http://192.168.50.10:8080` 时，MCP 地址就是 `http://192.168.50.10:8080/mcp`。本机默认模板对应 `http://127.0.0.1:8080/mcp`；实际地址以部署的 `FLEET_PUBLIC_URL` 和允许来源配置为准。普通用户直接在 MCP 客户端填写 URL 与 Bearer 凭证即可，管理网页也不依赖 MCP 命令。

初始化生成的平台令牌默认位于 `/var/lib/chrome-fleet/secrets/admin-token`，自定义 `FLEET_DATA_ROOT` 时相应调整路径。在服务器本地读取后填入客户端；凭据文件应保持 `0600` 权限。可选项目副本的创建和轮换说明见[部署文档](operations.md)。

项目使用官方 `@modelcontextprotocol/sdk` **1.32.1**，支持稳定协议 **2025-11-25**。初始化、能力协商、工具发现和调用由官方 SDK 实现。官方 v1 维护线不支持 2026-07-28 协议；新客户端需允许协商 2025-11-25。参考：[官方 v1 SDK](https://ts.sdk.modelcontextprotocol.io/server)、[传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)。

## HTTP 与访问控制

每个请求都校验平台 Bearer 凭证和精确 Host。浏览器发送 Origin 时，该来源还必须在配置列表中，且与请求 Host 的主机和端口一致。`FLEET_ALLOWED_ORIGINS` 支持显式配置的局域网、WireGuard 和域名来源；禁止 `*`、通配域名或把监听地址 `0.0.0.0` 当作访问来源。具体配置见[部署文档](operations.md)。非浏览器客户端可不发送 Origin，但仍须正确 Host 与有效平台凭证。

HTTP 为无状态 Streamable HTTP：POST 返回 JSON，GET SSE 流与 DELETE 传输会话返回 405。业务任务与人工租约不依赖 MCP 连接。缺失或失效凭证返回 401，非法 Host/Origin 返回 403；MCP session ID 不是认证凭证。REST 任务 SSE 是另一个经过授权的端点，见 [API 文档](api.md)。

Bearer 模式适用于本机及显式授权的受信任局域网/WireGuard 客户端。目前未实现 OAuth 资源服务器、授权服务器发现、PKCE 和 audience 校验，不能宣称兼容要求完整 [MCP OAuth 授权](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)的公网客户端。

下面是开发者验证初始化的 curl 示例。`FLEET_MCP_URL` 设置为实际 `/mcp` 地址，`FLEET_TOKEN` 通过本地环境或 secret 管理注入，不把真实秘密写入示例或版本库：

```bash
curl --fail-with-body "$FLEET_MCP_URL" \
  -H "Authorization: Bearer ${FLEET_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl-check","version":"1"}}}'
```

官方 SDK HTTP 客户端示例（开发者可选）：

```js
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const tokenFile = process.env.FLEET_TOKEN_FILE ?? '/var/lib/chrome-fleet/secrets/admin-token';
const token = (await readFile(tokenFile, 'utf8')).trim();
const client = new Client({ name: 'fleet-http-example', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(
  new URL(process.env.FLEET_MCP_URL ?? 'http://127.0.0.1:8080/mcp'),
  { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
));
console.log(await client.listTools());
const listed = await client.callTool({ name: 'profiles_list', arguments: {} });
console.log(listed.structuredContent);
await client.close();
```

两种传输均复用 `/api/v1` 的业务、鉴权与持久化队列。单步浏览器工具提交 `POST /api/v1/jobs`，先返回 `jobId`，再用 `jobs_get` 查询。断线不代表操作没有发生，不会自动重放点击、导航或提交。

新建实例默认 `browserMode:"vnc"`，提供生命周期与人工桌面，不执行Playwright网页任务或自动账号检测；需要网页任务能力时，先在实例设置中切换为自动化模式。VNC账号映射须在管理页面人工确认。

## 工具与权限

以下 scope 为服务端实际校验的授权类别；凭证也可限制 profile 范围。annotations 只是给客户端的提示，不能代替权限。`profiles_list` 与 `profiles_get` 等纯查询声明只读、幂等；浏览器单步会创建任务，均不声明只读；点击、导航、覆盖导入、恢复及升级声明具有潜在破坏性。平台设置是闭合范围，网页操作声明开放网络。

| 工具 | 所需 scope | 返回与作用 |
| --- | --- | --- |
| `profiles_list`, `profiles_get`, `profiles_proxy_get` | `read` | 分页实例、详情及脱敏配置 |
| `profiles_create`, `profiles_start`, `profiles_stop`, `profiles_restart`, `profiles_runtime_policy_set`, `profiles_proxy_set`, `profiles_vnc_password_set` | `manage` | 配置或异步生命周期任务 |
| `profiles_proxy_test`, `manual_session_open`, `manual_session_close` | `automate` | 代理连通测试或人工租约 |
| `jobs_submit`, `jobs_cancel`, `jobs_resume` | `automate` | 队列操作 |
| `jobs_get` | `read` | 进度、结果与失败摘要 |
| `browser_pages_list`, `browser_navigate`, `browser_click`, `browser_fill`, `browser_extract`, `browser_screenshot` | `automate` | 同一队列返回 jobId |
| `cookies_export`, `storage_state_export` | `session:read` | 加密 artifact 引用，不返回正文 |
| `cookies_import`, `storage_state_import` | `session:write` | 从授权 artifact 导入 |
| `profiles_backup`, `profiles_restore` | `backup` | 完整一致性快照及恢复 |
| `artifacts_get`, `browser_versions_list` | `read` | 元数据，不自动下载 |
| `browser_updates_check`, `browser_updates_apply`, `browser_updates_rollback` | `update` | 官方版本检查和受控升级/回滚任务 |

所有工具有严格参数 schema、输出 schema 和 `readOnlyHint/destructiveHint/idempotentHint/openWorldHint`。成功返回 `structuredContent: {ok:true,data,requestId}`；业务错误返回 `isError:true` 与 `{ok:false,error:{code,message},requestId?}`。错误消息不回显参数、凭证或控制服务原始异常。

账号相关的单步工具同样可传 `expectedAccountId`，控制平面先要求该账号具有人工确认记录，再执行网页动作；不访问账号页面。浏览器定位器恰好选择一种 `css`、`role`（可加 `name`）、`label`、`text`，可指定 `iframe`；不是任意脚本执行入口。`browser_fill` 不用于传递真实网站密码；网站邮箱、密码及验证均由用户在实例桌面中自行完成。代理和 VNC 写入只接收已授权的 `secretRef`，不要求助手索取密码。create 时平台生成的 VNC 密码同样被 MCP 隐去，受保护桌面可自动认证，管理员也可在实例设置查看或修改。截图、页面文本与 artifact 仍可能敏感，调用前须获得相应权限。

`waiting_for_human` 时使用 `manual_session_open`，在同一浏览器完成验证并关闭人工会话后，在实例详情保存人工确认，再通过 `jobs_resume` 恢复。`outcome_unknown` 先核查外部页面实际结果，不重复提交。

## 可选 stdio 客户端

只有客户端需要本地进程传输时才选用 stdio；正常 HTTP 连接无需这一节的配置。stdio 入口仅把请求转给已经运行的控制服务，不创建第二套浏览器、队列或数据库。

安装 Node.js 24 并构建源码后，本地客户端配置示例：

```json
{
  "mcpServers": {
    "chrome-fleet-local": {
      "command": "node",
      "args": ["/opt/chrome-fleet/apps/mcp-bridge/dist/stdio.js"],
      "env": {
        "FLEET_URL": "http://127.0.0.1:8080",
        "FLEET_TOKEN_FILE": "/var/lib/chrome-fleet/secrets/admin-token"
      }
    }
  }
}
```

路径按本地部署调整。`FLEET_TOKEN_FILE` 优先于 `FLEET_TOKEN`，文件按请求重新读取；使用项目令牌副本时，轮换后须先同步该文件。容器内现有 `/run/secrets/` 挂载路径不变。不使用网站 Cookie 或 Google token。stdout 只输出 MCP 协议数据，诊断使用 stderr。官方 SDK 通过 `StdioClientTransport` 启动此进程即可；需要检查时可调用 `listTools()` 与 `profiles_list`。

## 开发与验证

控制服务通过 `installMcpHttp(app, callApiForRequest, options)` 嵌入 HTTP MCP。请求始终保留当前平台主体及 profile scope，逐次鉴权；不能替换为服务级管理员凭证。`createMcpServer(callApi)` 供 stdio 和传输测试使用。

```bash
npm run test -w @chrome-fleet/sdk
npm run test -w @chrome-fleet/mcp-bridge
node --import tsx --test tests/integration/origins.test.ts
```

自动测试覆盖官方客户端两种传输、34 个工具、队列映射、密码字段拒绝、敏感输出脱敏、精确 LAN/WireGuard/loopback Host-Origin 配对、桌面 WebSocket 授权和凭证即时撤销；不访问真实 Google 账号。

账号自动检测工具 `accounts_check` 已移除。Google 与关联平台均由用户在管理界面人工确认；关联平台确认位于实例详情。
