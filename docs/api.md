# REST API 与 TypeScript SDK

管理 API 前缀为 `/api/v1`，默认入口 `http://127.0.0.1:8080`。所有实例、任务、artifact 和桌面操作都必须经过控制平面授权。运行时间存储为 UTC；维护窗口和管理界面时间按 `Asia/Shanghai` 展示。

## 响应与鉴权

JSON 成功格式：

```json
{"data":{"jobId":"job_example"},"requestId":"request_example"}
```

集合格式为 `data: {items: [], total: 0}`，支持 `limit` 和 `offset`；实例可按 `search/state/archived` 筛选，任务可按 `profileId` 筛选。稳定错误包含 `code/message/details?/requestId`，例如 `PROFILE_STOPPED`、`PROFILE_BUSY`、`IDEMPOTENCY_CONFLICT`、`VERSION_NOT_VALIDATED`。SDK 同时识别顶层错误与 `error` 包装格式。

任务列表 `GET /jobs` 还支持 `createdFrom`（含）和 `createdBefore`（不含），值为带时区的 ISO 时间；按创建时间、任务 ID 倒序返回。分页可传上次响应的 `nextCursor` 为 `cursor`（与 `offset` 互斥），末页为 `null`；`total` 是筛选范围内的全部任务数。游标翻页不会因为新任务插入而重复或遗漏旧记录。`GET /jobs/density` 使用相同的日期和实例筛选，日期起止必填，返回完整范围的 `total`、按类型的 `kinds` 及补齐空时段的 `buckets: [{start,end,total,counts}]`，统计不受列表分页影响。密度固定按小时汇总，`intervalMs` 为 `3600000`；7 天对应 168 个时段，30 天对应 720 个时段，图中各小时柱铺满时段宽度、相邻无间隙。两个接口均只返回当前凭证可见实例的任务。SDK 对应 `listJobs` 与 `getJobDensity`。

Web 任务中心与实例任务页默认展示包含今天的过去 7 个自然日，日期边界按北京时间计算。日期筛选同时更新密度图与任务记录；记录每次加载 30 条，滚动到底部继续加载，后台刷新保留已加载的历史记录。

本地受信任客户端使用 `Authorization: Bearer` 平台凭证，生产配置应从只读 secret 文件注入。Web 管理界面使用平台会话，不把后台管理员 token 打包进前端。平台凭证的 scope 与 profile 范围共同决定权限；网站 Cookie、Google token 和 VNC 密码均不能当作平台凭证。

| scope | 用途 |
| --- | --- |
| `read` | 实例、任务、版本和授权元数据读取 |
| `manage` | 实例配置、生命周期、代理与 VNC |
| `automate` | 浏览器任务、账号检测、人工接管 |
| `session:read` | Cookies 和站点状态导出 |
| `session:write` | 会话文件上传与导入 |
| `backup` | 完整快照备份及恢复 |
| `update` | 版本检查、更新策略及升级回滚 |
| `admin` | 平台管理；仅授予受信任管理员 |

普通读取不包含代理密码、VNC 密码、keyring 解锁秘密或 Cookie 正文。受保护创建/轮换流程保留 `oncePassword` 返回兼容；密码同时在 vault 中加密保存，之后可从实例设置页点击「查看 VNC 密码」，或显式调用下述查看接口重新授权读取，不限于创建时显示。不得写入日志。传统 VNCAuth 仅使用前 8 字符，本项目要求恰好 8 个可见 ASCII 字符，避免静默截断。

实例列表及详情的 `metrics` 为后台约每3秒取得的资源快照，GET 不启动实例。`available` 表示采样是否可用，`sampledAt` 为 UTC 采样时间；`cpuPercent` 以单核100%计，首帧为 `null`，`cpuUsageNs` 为累计CPU时间；`memoryBytes` 为扣除可回收文件缓存的已用内存，`memoryLimitBytes` 为容器上限，均以字节计。停止或失败只返回不可用标记和固定 `errorCode`，旧数值不作为当前用量；客户端须检查采样时间，超过12秒视为过期。

## HTTP 202 与幂等

启动、关闭、自动化、代理测试、会话传输、备份恢复和更新等长操作返回 **202** 与持久化 `jobId`。返回 202 表示已排队，不能当作操作已完成。以同一主体查询 `/jobs/{jobId}`，结果状态包括：

- `queued/running`：继续查询。
- `waiting_for_human`：暂停轮询，打开人工桌面完成验证。
- `succeeded/failed/cancelled/timed_out/outcome_unknown`：已结束；结果未知须人工检查实际页面，不能盲目重试。

创建、生命周期、任务和更新提交支持 `Idempotency-Key`。同一键和相同请求返回原结果；同键不同内容返回冲突。客户端超时后先按原键查询或再次提交原请求，不能换键重放点击等动作。SDK 不自动重试变更请求。

下面使用仅从环境注入的平台 token。此自动化示例明确创建 `automation` 模式、默认 stopped 的实例，再异步启动并轮询（省略模式则创建 VNC 实例）：

```bash
export FLEET_URL=http://127.0.0.1:8080

PROFILE_ID=$(curl --fail-with-body -sS "$FLEET_URL/api/v1/profiles" \
  -H "Authorization: Bearer ${FLEET_TOKEN}" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-profile-create-1' \
  --data '{"name":"测试账号浏览器","browserMode":"automation","startupPolicy":"on_demand","idleTimeoutMinutes":15}' \
  | jq -er '.data.id')

JOB_ID=$(curl --fail-with-body -sS "$FLEET_URL/api/v1/profiles/$PROFILE_ID/start" \
  -H "Authorization: Bearer ${FLEET_TOKEN}" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-profile-start-1' --data '{}' \
  | jq -er '.data.jobId')

while true; do
  JOB=$(curl --fail-with-body -sS "$FLEET_URL/api/v1/jobs/$JOB_ID" \
    -H "Authorization: Bearer ${FLEET_TOKEN}") || break
  STATUS=$(printf '%s' "$JOB" | jq -er '.data.status') || break
  printf '任务状态：%s\n' "$STATUS"
  case "$STATUS" in
    queued|running) sleep 1 ;;
    *) printf '%s\n' "$JOB" | jq '.data | {id,status,result,error}'; break ;;
  esac
done
```

这里只输出任务摘要，勿在真实登录或敏感网页上复制原始页面正文到公共日志。实例创建返回的 `oncePassword` 没有被此示例打印；受保护桌面在有效 Web 登录和人工会话中自动使用已保存的 VNC 密码连接，也可在实例设置中主动查看或修改密码。

向已明确设置 `browserMode:"automation"` 的持久化浏览器提交声明式任务（默认 VNC 模式返回 `VNC_MODE_UNSUPPORTED`）：

```bash
curl --fail-with-body "$FLEET_URL/api/v1/jobs" \
  -H "Authorization: Bearer ${FLEET_TOKEN}" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-navigation-1' \
  --data "{\"profileId\":\"$PROFILE_ID\",\"steps\":[{\"action\":\"goto\",\"url\":\"https://example.com\"},{\"action\":\"extractText\",\"locator\":{\"css\":\"h1\"}}],\"timeoutMs\":60000}"
```

得到 jobId 后使用相同轮询方式。所有单步浏览器操作均持有 profile 租约，不提供绕过队列的直接浏览器控制 API。账号相关任务应指定 `expectedAccountId`；身份未经检测时进入 `waiting_for_human`。

## 管理页面 URL

页面使用 History 路由，与 `/api/v1` 业务端点分开：

| 页面 URL | 用途 |
| --- | --- |
| `/profiles`、`/accounts`、`/jobs`、`/updates`、`/guide` | 实例、账号、任务、更新和帮助主页 |
| `/integrations/mcp` | MCP连接信息、功能目录、权限与模式说明；`/mcp`仍为协议入口 |
| `/profiles/new?from=accounts&account=<accountId>` | 从账号页为所选账号创建实例，关联账号只读，取消后返回账号页 |
| `/profiles/<profileId>/{overview,settings,accounts,tasks,sessions,updates}` | 实例详情及对应标签页 |
| `/jobs?job=<jobId>` 或实例任务页的 `?job=<jobId>` | 指定任务详情 |

页面可直达、刷新并使用前进/后退；URL 只记录页面与实体 ID，不接受凭据作为登录参数。界面统一从账号管理创建实例；不带有效账号 ID 的旧创建链接（含 `/profiles/new?from=profiles` 和 `#create`）会转到 `/accounts`。页面路由不改变 REST 权限或资源范围。

## API 路由

| 方法与路径（除健康端点外均添加 `/api/v1`） | 用途 |
| --- | --- |
| `GET /health`, `GET /ready` | 进程与依赖状态；不包含秘密 |
| `GET /host-metrics` | 需要 `read` 权限；读取每3秒更新的宿主机 CPU 百分比、内存已用/总量及采样时间，不触发浏览器操作 |
| `GET/POST /profiles` | 分页实例列表/创建独立配置与目录 |
| `GET/PATCH/DELETE /profiles/{id}` | 查询/修改/归档，普通删除保留会话与可寻址元数据 |
| `POST /profiles/{id}/unarchive`, `/purge` | 恢复归档/明确确认后清除目标数据 |
| `POST /profiles/{id}/start`, `/stop`, `/restart` | 异步生命周期，stop 可显式 `force` |
| `GET/PATCH /profiles/{id}/runtime-policy` | `startupPolicy/idleTimeoutMinutes/autoWakePaused` |
| `GET/PUT/DELETE /profiles/{id}/proxy` | 脱敏读取/设置/禁用独立代理 |
| `POST /profiles/{id}/proxy/test` | 从实例真实浏览器检查 HTTP/HTTPS 出口 |
| `GET /profiles/{id}/remote-desktop` | 状态、稳定入口及密码是否配置 |
| `PUT /profiles/{id}/remote-desktop/password` | 受保护密码轮换，或 `{secretRef}` |
| `POST /profiles/{id}/remote-desktop/password/reveal` | 显式授权查看当前已保存的 VNC 密码，不轮换或启动实例 |
| `GET/POST /google-accounts` | 管理员分页读取目录或新增已有账号的登录资料 |
| `PATCH /google-accounts/{accountId}` | 管理员更新保存的账号密码、辅助邮箱 |
| `POST /google-accounts/{accountId}/password/reveal` | 管理员主动查看已保存的账号密码 |
| `GET/POST /profiles/{id}/accounts` | 读取/绑定期望账号及站点检测器 |
| `POST /profiles/{id}/accounts/check` | 异步身份检测 |
| `POST /profiles/{id}/manual-sessions` | `{durationSeconds?,explicitStart?}` 人工租约与桌面入口 |
| `DELETE /manual-sessions/{sessionId}` | 结束人工接管并收回入口权限 |
| `POST /jobs`, `GET /jobs`, `GET /jobs/{jobId}` | 提交/分页/查询任务 |
| `POST /jobs/{jobId}/cancel`, `/resume` | 取消/验证完成后恢复 |
| `GET /jobs/{jobId}/events` | 经过授权的 REST SSE 任务事件，与 MCP 传输独立 |
| `POST /profiles/{id}/cookies/export`, `/import` | Cookie 专用文件传输 |
| `POST /profiles/{id}/storage-state/export`, `/import` | Playwright 站点状态传输 |
| `POST/GET /profiles/{id}/snapshots` | 创建一致性快照/读取备份列表 |
| `POST /profiles/{id}/restore` | `{snapshotId}` 恢复停止的实例 |
| `POST /artifacts`, `GET /artifacts/{artifactId}` | 受保护上传/元数据读取 |
| `GET /artifacts/{artifactId}/download` | 每次重新授权后下载，不能用 URL token 绕过权限 |
| `GET /browser-versions` | 当前/可用/已验证 Chrome 版本 |
| `GET/PATCH /update-policy` | `manual/notify/auto` 策略、维护窗口与暂停 |
| `POST /updates/check`, `/apply` | 官方版本检查/受控升级，apply 可指定 `versionId/profileIds` |
| `GET /updates/{updateId}` | 每实例更新阶段、恢复点和回滚记录 |
| `POST /updates/{updateId}/rollback` | 匹配旧镜像及升级前完整快照回滚 |

创建实例可配置 `name/tags/accountAlias/browserMode/proxy/vncSecretRef/startupPolicy/idleTimeoutMinutes/headless/locale/timezoneId/viewport/resources/distribution`；`distribution` 默认 `google`，不能静默改为 Chromium。默认创建后 stopped，明确 `start:true` 才请求启动。实例 ID 为 `cf_` 加 UUID；客户端不能指定 Docker ID、宿主目录、内部端口或任意镜像。

查看 VNC 密码接口请求体为 `{}`（兼容可选 `idempotencyKey`），成功返回 `data: {password: string, version: number}`，要求 `manage` 及目标 profile 范围。Web 会话还需现有 `X-CSRF-Token`，Bearer 客户端沿用平台认证。密码来自当前 vault 引用，停止或归档实例无需启动即可查看；已彻底清理返回 `PROFILE_PURGED`（410），引用缺失、密文不可读或格式无效返回 `VNC_PASSWORD_UNAVAILABLE`（409）。请求体不能指定其他 secret 引用。每次读取记录 `vnc_password_reveal` 主体、实例和结果，不记录密码。此接口忽略幂等键、不缓存响应，每次重新授权并读取当前版本，响应带 `Cache-Control: no-store`；其他写入接口的加密幂等缓存保持不变。普通列表/详情继续隐藏密码及秘密引用，MCP 不提供密码查看工具。

noVNC 自动认证使用桌面网关内部的 `POST /profiles/{id}/desktop/credentials`，请求 `{sessionId,version}`。该入口仅接受有效 Web 会话及 CSRF，核验 `automate`、实例范围、本人当前人工会话和租约、密码版本后才返回握手所需凭据；它不属于上述 REST `/api/v1`、OpenAPI 或 MCP 接口，也不复用管理密码查看接口。密码响应不缓存，每次授权后的凭据读取记录无秘密审计；客户端只在内存中交给 noVNC。关闭、过期、撤销或轮换后，旧页面不能通过该入口取得新会话的密码。

桌面文本剪贴板使用同样保护的内部 `POST /profiles/{id}/desktop/clipboard`，请求 `{sessionId,version,action:"read"}` 或 `{sessionId,version,action:"write",text}`。读取返回 `data:{text}`，写入返回 `data:{written:true}`，只设置当前实例的X11 CLIPBOARD，不自动粘贴或提交。仅接受有效Web会话、CSRF和匹配Origin，前后重查本人租约及上下文，Agent同时检查fence。文本上限128KiB UTF-8，拒绝NUL或无效文本；不在任务、审计、幂等缓存或浏览器存储保存正文，响应禁止缓存。该入口不属于普通REST/OpenAPI/MCP，Bearer客户端不能绕过Web会话使用。

代理字段为 `enabled/scheme/host/port/secretRef/bypass`；`bypass` 是逗号分隔字符串。HTTP/HTTPS 可有认证；带认证 SOCKS5 明确不支持。平台根据代理配置自动同步该 profile 来源到精确目标 IP/端口的 TCP/UDP 网络规则；保存、修改、禁用、启动、停止及防火墙重载都会同步，无需客户端提供宿主防火墙参数或手填全局例外。保存后对照 `version/appliedVersion` 判断浏览器配置待生效；运行中的 Chrome 仍需要受控重启。`appliedVersion` 只说明配置已加载，不保证代理 TCP/HTTPS CONNECT 连通。配置为失败关闭，不静默回退直连；UDP 网络准入不表示 HTTP 代理具备 UDP 中继能力，浏览器代理也不等价于容器透明隧道。

网页通过单一“代理地址”输入框填写 `scheme://host:port`，提交前解析为既有的 `scheme/host/port` 字段；REST与SDK的代理结构保持上述格式。省略协议默认HTTP，省略端口采用HTTP80、HTTPS443、SOCKS51080。代理地址不接受路径、查询参数、片段或内嵌凭据；认证继续通过独立字段提交。同一端点重新保存时保留原主机键的大小写及IPv6写法，避免规范化地址时丢失已保存的认证引用。

运行策略 `idleTimeoutMinutes:0` 禁用空闲关闭。`manual` 或 `autoWakePaused:true` 的停止实例不被后台任务拉起；用户可显式启动，或申请人工桌面时传 `explicitStart:true`。停止保留 profile/keyring/账号绑定。

Cookies 导出接受 `{domains?}`；导入接受 `{artifactId,mode?,domains?}`，`mode` 支持 `merge/replace/replace_domains`。站点状态与完整目录快照恢复范围分别记录，Cookie 写入成功不代表账号已经登录。Playwright storageState 仅包含当前 context 已知的站点 origin；容器重建后应先实际访问要导出的站点，再导出 localStorage/IndexedDB。`domains` 只做筛选，不会自动发现或访问磁盘上的全部站点；完整目录快照保留整个用户目录及 keyring。完整快照恢复要求停止实例，覆盖本地状态并恢复匹配镜像；不能让旧 Chrome 直接打开新版迁移后的目录。

## TypeScript SDK

工作区包 `@chrome-fleet/sdk` 使用 Node.js 24 内置 fetch、AbortSignal 和 ESM。`FleetClient` 方法解包 `.data`；需要请求标识时使用 `client.request<T>()`，返回 `{data,requestId}`。`client.call` 可直接传给 MCP 工厂。SDK 包含全部上述资源的读取、创建、生命周期、账号、会话传输、备份和更新方法。

```ts
import { readFile } from 'node:fs/promises';
import { FleetClient } from '@chrome-fleet/sdk';

const client = new FleetClient({
  baseUrl: process.env.FLEET_URL ?? 'http://127.0.0.1:8080',
  token: async () => (await readFile(process.env.FLEET_TOKEN_FILE!, 'utf8')).trim()
});
const profile = await client.createProfile({ name: '测试浏览器', browserMode: 'automation' }, {
  idempotencyKey: 'sdk-create-example-1'
});
const accepted = await client.submitJob({
  profileId: profile.id,
  steps: [{ action: 'goto', url: 'https://example.com' }]
}, { idempotencyKey: 'sdk-goto-example-1' });
const job = await client.waitForJob(accepted.jobId, {
  intervalMs: 1000,
  timeoutMs: 120_000,
  onProgress: job => console.log(job.id, job.status)
});
if (job.status === 'waiting_for_human') {
  const session = await client.openManualSession(profile.id, { durationSeconds: 900 });
  console.log(session.desktopPath); // 仍需有效 Web 平台登录和本人对应人工会话；桌面自动认证 VNC
}
```

`waitForJob` 在人工验证和所有终态（包括 `outcome_unknown`）返回，不把失败当成功，不自动恢复或重放任务。可以用 `signal` 取消等待；取消等待不取消服务端任务，需要明确 `cancelJob(jobId)`。

SDK 连接失败返回 `FleetError`，包括 `code/status/requestId`，不附带 token 或请求正文。SDK 禁止跨来源 API 路径，拒绝 HTTP 跳转，避免把平台凭证带往别的主机。所有变更请求均只发一次；浏览器网络请求即使使用 GET，也可能有副作用。

```ts
const exported = await client.exportCookies(profile.id, { domains: ['example.com'] });
const exportJob = await client.waitForJob(exported.jobId);
// 授权下载或在受保护流程中取得 artifactId 后再导入：
const imported = await client.importCookies(profile.id, {
  artifactId: 'artifact_example', mode: 'merge', domains: ['example.com']
});
await client.waitForJob(imported.jobId);
await client.checkAccounts(profile.id); // 导入与登录有效性分开验证
```

MCP 客户端连接示例见 [mcp.md](mcp.md)。本地可控站点与 API/MCP 自动测试不代表真实 Google 首次登录、2FA 或长期在线已经验证；这些需要通过人工桌面逐项验收。

## 浏览器模式与 Google 人工确认

新建实例 `browserMode` 默认为 `vnc`，旧记录缺少字段时为 `automation`。`PUT /api/v1/profiles/{id}/browser-mode` 接收 `{browserMode:"vnc"|"automation"}`，要求 `manage/automate` 和实例权限，返回202队列任务。仅本人持有的人工会话可以在切换时关闭，不接管其他主体。任务正常停机、加密快照、同镜像/原目录/keyring重启；失败不强制关闭或自动回滚。普通PATCH不能修改模式。

VNC 模式停用页面任务、账号检测、代理页面出口测试及 Cookies/storage-state 导入导出，返回 `409 VNC_MODE_UNSUPPORTED`；Agent同样拒绝。原有完整快照、恢复、VNC自动认证和文本剪贴板仍可用，依赖自动化兼容验证的镜像更新延后，空闲关闭暂停。

- `GET /api/v1/google-accounts`：管理员读取目录邮箱、备用邮箱和关联实例，不返回密码或秘密引用。
- `POST /api/v1/google-accounts`：管理员提交 `{email,password,recoveryEmail?}` 新增目录账号，返回201与不含密码的账号元数据。邮箱规范化为小写并去除首尾空白；密码1至4096字符且原样保存；辅助邮箱可省略或为空。同邮箱返回 `409 DUPLICATE_ACCOUNT`，不覆盖原密码。支持 `Idempotency-Key`。
- `PATCH /api/v1/google-accounts/{accountId}`：管理员提交 `{password?,recoveryEmail?}`，至少提供一项；不传密码保留原值，显式空密码无效，辅助邮箱传空字符串可清除。邮箱作为目录标识不可修改，其他邮箱应新增账号。写入使用现有加密 vault，不更改实例、绑定、确认或网站密码，也不回写导入源文件。
- `POST /api/v1/google-accounts/{accountId}/password/reveal`：管理员提交 `{}`，返回 `data:{password}`；Web会话需CSRF。每次读取当前vault并记录不含密码的 `google_account_password_reveal` 审计，响应 `Cache-Control: no-store`，不使用幂等响应缓存。账号不存在返回404，密文不可读、密码无效或vault邮箱与目录不一致返回 `409 GOOGLE_PASSWORD_UNAVAILABLE`，可通过显式设置新密码修复。普通列表、保存响应和MCP不返回密码或秘密引用。
- `GET /api/v1/profiles/{id}`：两种模式的实例在唯一Google记录可匹配目录时返回 `googleBinding:{accountId,email,confirmationState:"unconfirmed"|"confirmed",lastConfirmedAt?}`。旧未知状态的单一映射派生为待人工确认，不因此改变真实登录状态。实例卡片据此显示人工确认状态，点击查看账号页；自动化身份检测成功不等于人工确认。
- `PUT /api/v1/profiles/{id}/google-binding`：严格接收 `{accountId}`，要求管理员及 `manage/automate`、实例权限，仅适用VNC。只保存单一目录账号映射，不启动/导航/读取页面或密码；重复绑定同账号保留确认，明确换绑清除确认。
- 每个 Google 账号最多关联一个未彻底清理的 Chrome 实例，包括归档实例。跨实例重复创建、绑定和指定账号登录返回 `409 GOOGLE_ACCOUNT_ALREADY_BOUND`；创建请求在分配密码、目录和启动任务前拒绝。自动识别也不会写入重复关联。原实例明确换绑后释放原账号，彻底清理后允许重建；仅归档仍保留关联。账号目录的归档关联带 `archived:true`，界面保留查看入口并隐藏重复创建入口。
- `POST /api/v1/profiles/{id}/google-login`：VNC只能打开已绑定账号的桌面；省略ID使用当前绑定，传不一致账号返回冲突。显式取得/复用本人桌面租约，返回201及 `id/profileId/desktopPath/expiresAt/googleLogin`；不导航/检测/填写网页。已有人工确认来自持久绑定，不因再次打开而重置。
- `POST /api/v1/profiles/{id}/google-login/confirm`：严格接收已绑定的 `{accountId}`，要求上述平台授权与 Web CSRF。保存 `authState:"manually_confirmed"`、确认操作者及 `lastConfirmedAt`，结束实例人工桌面并排队切换到自动化模式，不要求当前持有 VNC 租约。返回 `status:"bound",verificationSource:"manual_confirmation",takeoverJobId`，通过任务接口等待接管结果；成功后网页任务和空闲关闭生效。正在执行的任务会复用，已完成的接管不会重复重启；历史人工确认保留原时间。排队时换绑取消旧接管任务，执行前重新校验授权及绑定。确认来源仍为用户声明，不代表服务端身份检测。
- `POST /api/v1/profiles/{id}/google-login/check`：VNC仅返回持久人工确认状态，不调用Agent；自动化兼容模式仍可检测可信的已登录邮箱。
- `GET /api/v1/manual-sessions`：返回本人有效人工桌面会话与进度，和持久账号确认独立。
- `GET /api/v1/profiles`：彻底清理后含 `purgedAt` 的记录不再进入列表、总数与归档计数；真正仍保留数据的归档实例继续显示。清理审计元数据可保留，不代表浏览器容器或目录仍存在。

自动化兼容模式保留原分步填写和自动身份检测，`autofill.stage/message` 仅含固定阶段提示、无密码。VNC模式不执行这些动作，也不会在后台轮询页面。详细操作和清单导入见[会话恢复说明](session-recovery.md#google-人工登录与实例绑定)。

## 注册声明式模板

`POST /api/v1/templates` 需要 manage 权限，接收 `name`、`steps`、`timeoutMs` 和 `parametersSchema`。参数 schema 为字段名到 `{type:"string"|"number"|"boolean",required:boolean}` 的映射。步骤中的 `{{field}}` 以已校验参数作字符串替换；不支持脚本、shell 或 eval。`GET /templates` 查询模板；`POST /jobs` 可传 `{profileId,templateId,parameters,expectedAccountId?}`，仍进入同一队列与租约。

账号相关任务应传 `expectedAccountId`。执行前按注册检测器验证页面身份；未验证则进入 waiting_for_human。普通不涉及账号的导航/提取可以不指定账号；仅绑定一个别名不表示已取得可信身份检测能力。

## Chrome 分发与镜像准备

`POST /updates/check` 可传 `{distribution:"google"|"cft",prepare:true}`，从对应官方源发现版本、构建镜像并运行一次性持久性兼容验证。自动模式会准备候选；manual/notify模式可显式传 prepare。只有已验证的镜像才能 apply。创建 `distribution:"cft"` 实例前须先准备CfT，缺失时返回 `DISTRIBUTION_NOT_PREPARED`，不会悄悄改用 Google Chrome 或 Chromium。

Cookie/站点状态导入默认 merge；replace 与 replace_domains 均要求明确 domains，只有所选域及其子域被替换。没有 domains 时拒绝替换。Chrome可能对公共后缀和字段实施额外限制；预检与实际逐项应用结果以任务结果为准。导入后仍需要账号身份检测。
