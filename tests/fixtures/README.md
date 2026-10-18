# 合成账号验收站

此站点只使用合成身份，不需要真实 Google 账号，不读取已有浏览器。启动：

```bash
node --import tsx tests/fixtures/auth-site.ts
# 默认 http://127.0.0.1:8180
```

`FIXTURE_HOST` 和 `FIXTURE_PORT` 可调整监听地址。宿主机的 `127.0.0.1` 不是浏览器容器的 loopback。真实容器测试须把站点放在可访问的专用测试机器/容器网络，精确设置 `FLEET_ALLOWED_PRIVATE_HOSTS` 与防火墙 `FLEET_ALLOWED_CIDRS`；不要整体开放管理网、宿主接口或云元数据。防火墙默认也拒绝浏览器访问宿主机 INPUT，所以仅修改监听地址不足以让容器访问宿主站点。

页面 `/app` 提供测试身份登录、撤销、计数和本地状态保存。HTTP 端点：

| 路径 | 用途 |
| --- | --- |
| `POST /login?identity=alice@example.test&persistent=true` | 设置 HttpOnly 持久认证 Cookie（1 天）与独立会话 Cookie；`persistent=false` 创建会话认证 Cookie |
| `GET /identity` | 服务器检查当前 Cookie 是否仍有效；未登录/已撤销返回 401 |
| `POST /revoke?identity=alice@example.test` | 服务器撤销该身份全部会话，浏览器仍有 Cookie 也不能通过验证 |
| `GET /counter` | 查询当前身份计数 |
| `POST /counter` | 当前身份计数加一 |
| `POST /counter?disconnect=true` | 先提交计数，再断开响应，模拟副作用已发生但客户端未收到结果 |
| `GET /health` | 合成站点健康检查 |

真实 Chrome 验收流程：

1. 创建至少 3 个独立 profile，在各自桌面登录 alice/bob/carol 三个合成身份，访问 `/identity` 与页面 `#identity` 核对互不串用。
2. 在页面保存不同的 localStorage 与 IndexedDB 值。使用页面 `window.fixtureReadState()`，或检查 `#stored` 的显示，记录两种存储内容。
3. 使用持久认证 Cookie 正常停止、再次启动、删除重建运行容器及重启控制服务，核对身份及两种存储。会话 Cookie 单独验证，不把其结果当作持久化承诺。
4. 导出 Cookies、storageState，分别在目标授权流程中导入，检查 HttpOnly、到期时间与支持字段；Cookie 文件不会恢复 localStorage/IndexedDB。storageState 的 IndexedDB 范围按 Agent 实现及实际验收结果记录。
5. 用 `/revoke` 让服务器撤销认证，确认账号检测返回需要登录，而非根据 Cookie 存在误报。示例 detector 使用 `/app` 的 `identityLocator:{css:'#identity'}`，期望身份为对应合成邮箱。
6. 点击“提交后断线”，随后查询 `/counter`。结果必须只增加一次；任务显示 `outcome_unknown` 或等待人工核查，不自动再次点击。
7. 停机备份、改变本地状态、恢复完整快照，核对 profile/keyring 和本地状态恢复点；升级和回滚使用配对的旧镜像及快照。

本地 HTTP 单元/集成测试只验证站点端点与协议、控制平面队列和加密，不证明真实 Chrome 的 keyring、Cookie 重建、IndexedDB 或 Google 登录已通过；真实容器验收需 Docker Engine、Chrome 镜像及可用 sandbox。

## 真实双代理验收

先按部署文档构建并启动服务，安装宿主机防火墙，等待批准的 Chrome 镜像就绪。随后在 Docker 宿主机项目目录以 root 执行：

```bash
FLEET_TEST_IMAGE=chrome-fleet/browser:google-155.0.8059.79 \
node --experimental-strip-types tests/e2e/proxy.ts
```

可通过 `FLEET_TEST_RUNNER_CONTAINER` 调整 Runner 容器名（默认 `chrome-fleet-runner-1`），`FLEET_DATA_ROOT` 须与 Runner 的实际宿主路径一致。工具复用 Runner 的批准镜像和标准隔离配置，不读取现有 profile，不修改 `.env` 或生产防火墙脚本。

工具创建两个有独立随机认证的测试代理容器与专用网络，添加 `chrome-fleet.fixture=<唯一runId>` 标签；浏览器实例使用独立生成的 `chrome-fleet.profile=cf_<UUID>` 标签并精确记录。代理只发布到本次浏览器独立出站网络的 `172.31.X.1` 网关随机端口，且只允许 `example.com` 测试目标。HTTP 返回代理自己的身份测试页；HTTPS CONNECT 转发真实 `example.com:443`，保持浏览器 TLS 校验。临时 `CF-FLEET` 规则仅允许对应代理容器 IP/32 的 TCP 3128，并带唯一 comment。

依次验证两个真实浏览器的独立 HTTP 代理身份、HTTPS CONNECT 与认证、错误密码失败且不直连、受控重启只改变目标实例代理。`finally` 按本次 ID 清理临时 profile、代理容器、网络和精确防火墙规则；SIGINT/SIGTERM 会触发清理。若 Docker/iptables 本身故障导致清理失败，终端会打印需要精确处理的目标，不能使用广泛的 `docker system prune`。

自动集成测试 `tests/integration/proxy-fixture.test.ts` 只验证代理 fixture 协议、认证、目标限制和脱敏日志；真实代理验收是否通过以该 e2e 工具的实际输出为准。

## 真实镜像升级与配对回滚

保留两个已批准的浏览器镜像内容 ID 后，可运行真实服务编排验收：

```bash
env -u NODE_TLS_REJECT_UNAUTHORIZED \
  FLEET_TEST_OLD_IMAGE=sha256:e61e2a5aa454b890bca6179f36a14b41781a59b0403e542a6941be976ca9653d \
  node --import tsx tests/e2e/update-live.ts
```

旧内容 ID 仅适用于本机确实保留该镜像的情况；其他部署应设置自己的旧批准镜像。工具先检查镜像真实存在及批准标签，再从官方 Google 软件源发现候选，调用真实 Runner 镜像准备与隔离兼容验证。此用例要求旧/新镜像的 Chrome 版本相同且镜像内容 ID 不同，验证的是实际项目镜像升级及配对恢复，不能称为已验证跨 Chrome 版本的数据迁移。

工具使用真实 `FleetService`，立即将其 SQLite 与 Vault 切换到独立临时目录；不启动第二个后台 worker。运行目录仍为 Runner 的真实数据根，只有本次唯一 profile 与对应 snapshot/artifact 被创建、停机备份和原子恢复。测试 adapter 仅把 Runner 返回的容器 DNS 名改为 Docker 实际控制 IP，使宿主进程可达；没有复制状态、伪造恢复或修改产品逻辑。

旧镜像写入合成 Cookie/localStorage/IndexedDB 后，真实执行快照与升级，读取原状态；随后写入不同新状态，回滚到匹配的旧镜像与升级前 profile/keyring 快照，再证明旧状态恢复、新状态被舍弃。两代镜像的自测内部标记可能不同，因此跨镜像恢复以两代共用的 Cookies 与 storageState 导出契约核对实际值，不人工补造标记。

只输出阶段、Chrome 版本及镜像内容 ID，不输出 Cookie、keyring 或凭证值。`finally` 按临时数据库记录的唯一 profile、snapshot 和 artifact 精确清理，不修改其他 profile；通过此工具准备的批准镜像保留，便于后续部署与复验。
