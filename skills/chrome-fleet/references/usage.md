# 按账号操作浏览器

使用当前连接的 Chrome Fleet MCP。不同客户端可能为工具添加服务器前缀；调用前读取实际发现的 schema。响应中的 `structuredContent` 形如 `{ok, data, requestId}`；业务错误也可能通过 `isError` 返回，不能仅凭传输成功判断结果。

## 找到唯一实例

1. 用 `profiles_list` 按 `limit`、`offset` 分页，读取 `data.items` 与 `data.total`。邮箱匹配需要遍历可见实例；`search` 只搜索名称和标签，不能用它判断某邮箱不存在。
2. 对比 `googleBinding.email` 或 `accounts[].expectedIdentity`，去除首尾空白并忽略邮箱大小写。不要把 Gmail 别名、点号或 `+` 地址自动合并成另一个账号。
3. 无匹配时报告未绑定或当前凭据不可见；多匹配时列出实例名称和 ID，让用户选择。不要自动创建浏览器或切换到其他账号。
4. 用 `profiles_get` 再次确认选定的 `profileId`、账号记录、运行与浏览器模式。需要 `expectedAccountId` 时取该实例匹配的 `accounts[].id`；它与目录的 `googleBinding.accountId` 不同。缺少对应账号记录时，不猜测 ID。

新实例默认是 VNC 模式。账号绑定、人工登录确认和切换自动化模式通过管理界面完成，MCP 当前没有模式切换或 Google 账号绑定工具。不要给 `profiles_create` 添加未声明的 `browserMode` 参数。人工确认也不代表服务器验证了网站当前身份。

## 执行并核实结果

网页任务需要自动化模式。使用 `browser_navigate`、`browser_click`、`browser_fill`、`browser_extract` 等单步工具，或 `jobs_submit` 编排多步任务。账号敏感操作在 schema 支持时传入已确认的 `expectedAccountId`，由服务端检测目标身份。

所有网页工具，包括页面列表、文本提取和截图，均先返回 `jobId`。使用 `jobs_get` 查询至完成或需要人工处理，按需间隔轮询；返回实际结果或错误，并保留任务 ID 便于继续查询。任务被接受不等于已执行完成，MCP 断线不等于任务取消。

示例用户请求：

> 找到 sales@example.test 对应的浏览器，打开 https://example.com 并提取主标题，只操作这个账号。

确定实际实例 ID 后，调用 `jobs_submit` 的示例参数：

```json
{
  "profileId": "cf_00000000-0000-4000-8000-000000000001",
  "steps": [
    { "action": "goto", "url": "https://example.com" },
    { "action": "extractText", "locator": { "css": "h1" } }
  ],
  "timeoutMs": 60000
}
```

ID 为示例，调用时使用查询结果。随后将返回的 `jobId` 传给 `jobs_get`。页面文本、截图和产物可能含用户数据，只取得完成当前请求所需的内容。网站密码、验证码和二次验证通过人工桌面输入，不传给 `browser_fill` 或任务步骤。

## 人工接管与恢复

`waiting_for_human`：

1. 读取任务给出的原因，让用户在同一实例处理登录、验证码或身份确认。需要接管时调用 `manual_session_open`，保存返回的 `sessionId` 与 `desktopPath`。
2. 远程服务使用本 Skill 的 `desktop` 命令提供可达的管理入口；将返回的相对路径与可达管理地址组合。管理页必须以与 MCP 相同的平台凭据身份登录，其他身份不能直接使用此租约。
3. 用户完成操作后，用 `manual_session_close` 结束该人工会话；必要时通过 `accounts_check` 创建身份检测任务并查询其结果，再 `jobs_resume` 恢复原任务。已有人工租约占用时，不反复申请新租约或创建另一个浏览器。

`outcome_unknown` 表示外部操作可能已经发生。保留原任务，先在桌面或只读页面查询中核实结果；不要调用 `jobs_resume` 或重新提交来试探。若核实后确需重做，说明已知结果并按用户授权执行。

取消只会请求停止后续工作，已经发生的网站操作无法撤回。不要通过重启实例、关闭服务或删数据来清除等待状态。
