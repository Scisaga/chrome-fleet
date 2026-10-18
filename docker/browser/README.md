# 浏览器容器与 Runner 约定

浏览器镜像固定 Node.js 24.22.0、Playwright 1.64.1 和所选官方 Chrome 版本，默认有界面。UID/GID 为 1000:1000，`/state/chrome` 是唯一持久化上下文，`/state/keyrings` 由实例私有 D-Bus/gnome-keyring 管理，`/state/downloads` 保存下载工作文件。Chrome 使用 `chromiumSandbox: true` 和 `--password-store=gnome-libsecret`；启动前检查 Secret Service 解锁与读写探针，兼容测试进一步检查 Chrome 实际加密密钥和停止重建后的 HttpOnly Cookie。

构建普通 Google Chrome：

```sh
docker build -f docker/browser/Dockerfile \
  --build-arg CHROME_DISTRIBUTION=google \
  --build-arg CHROME_VERSION=155.0.8059.79 \
  -t chrome-fleet/browser:google-155.0.8059.79 .
```

Google Chrome 通过 Google 官方签名 APT 仓库安装确切版本。Google 仓库不保证继续提供所有旧版本，因此旧镜像及快照必须保留，不能把重新下载旧安装包当作回滚机制。显式 `CHROME_DISTRIBUTION=cft` 使用官方 CfT 发布 JSON 和白名单 HTTPS 下载地址；官方此渠道没有提供项目可验证的安装包签名，本实现不声称验证了不存在的官方 checksum。

Runner 仅接受 `cf_<UUID>` 标识，以及 `chrome-fleet/browser:google-<版本>`、`:cft-<版本>` 或经构建标签复核的 digest。expectedDigest 可固定已验证内容，容器实际由该不可变 ID 创建。浏览器不发布宿主端口、不挂 Docker socket、使用只读根目录、独立 shm、cap_drop ALL、no-new-privileges、受限 seccomp、内存/CPU/PID 限额。`seccomp.json` 基于 [Playwright v1.64.1](https://github.com/microsoft/playwright/blob/v1.64.1/utils/docker/seccomp_profile.json)，含启用 namespace sandbox 所需 clone/setns/unshare 系统调用，并额外允许 chroot syscall：官方模板默认仅在外层持有 CAP_SYS_CHROOT 时放行，cap_drop ALL 会使 Chromium 在自己的 user namespace 中也被 seccomp 拒绝。此调整不向宿主 namespace 授予该 capability。

每实例单独创建 `cf_egress_<UUID>` 网络，使用 `172.31.X.0/24` 与 `cf` 开头的网桥，控制网络为 `172.30.0.0/24`，控制服务 `.2`、Runner `.3`、浏览器 `.32` 至 `.250`。部署前在 Docker 宿主机执行：

```sh
sudo sh docker/browser/install-firewall.sh
```

脚本加载 `br_netfilter`、启用 bridge iptables hook，仅维护 `CF-FLEET`、`CF-FLEET-INPUT` 链及 Fleet 来源跳转，不清空其他服务规则。默认阻止浏览器主动访问私有网段、控制服务、宿主接口和云元数据；控制服务连接 Agent/noVNC 的已建立回复可通过。IPv6 在浏览器网络命名空间中禁用。Runner 只读挂载 `/run/chrome-fleet`，启动时校验 root 所有、不可普通写入、匹配当前宿主启动的标记，否则拒绝启动浏览器。宿主重启或防火墙服务重载后必须重新运行脚本。若其他工具删除规则，应重装；该标记不能替代对宿主防火墙的持续监控。

如需内部测试站点，显式以空格分隔的 `FLEET_ALLOWED_CIDRS` 安装精确放行规则，并在 Runner 配置逗号分隔的 `FLEET_ALLOWED_PRIVATE_HOSTS`。该选项仅供明确受信任站点，不能把整个控制网段放行。浏览器内 HTTP/HTTPS 请求同时进行地址检查；代理覆盖网页请求，不代表全容器透明隧道，不保证代理全部 UDP/WebRTC。

保存、修改或禁用实例代理时，控制服务自动把完整脱敏清单同步到 Runner 的 `POST /network-policy/sync`：`{revision,profiles:[{profileId,proxy:{host,port}|null,proxyVersion}]}`。不再要求手工填写代理白名单。运行中的实例仅从自己的实际出站网桥/IP、控制网桥/IP，放行到所配置目标 IPv4 和端口的 TCP、UDP；其他实例、其他端口和未配置的私网目标仍受隔离。规则同时覆盖 FORWARD 与宿主 INPUT，并按连接原始目标匹配，因此支持 Docker 发布端口经过 DNAT 的代理。回收规则不保留浏览器主动建立的旧私网连接通行权。

Runner 拒绝陈旧的完整清单 revision、实例代理版本以及已移除实例的旧启动请求。保存后新端点准入会更新，Chrome 使用的代理仍以生效版本为准，必要时重启实例。停止或移除容器时撤回有效来源规则，重新启动时按最新配置恢复。域名规范化为小写/IDNA，并解析 IPv4 A 记录，每 60 秒刷新；无 A 记录或解析失败时撤回其旧地址，报告待重试状态。当前浏览器禁用 IPv6，因此代理必须提供 IPv4 或可用 A 记录。访问代理上的公网网站无需把代理地址加入 `FLEET_ALLOWED_PRIVATE_HOSTS`，该选项控制浏览器访问的目标站点。允许 TCP/UDP 端点不改变 Chrome 的 HTTP/HTTPS/SOCKS5 协议能力，也不会建立整个容器的透明 UDP 隧道。

完整期望配置保存在 `DATA_ROOT/network-policy/desired.json`，有效来源和已解析地址保存在 `active.json`，均不含账号、密码或其他凭据。宿主防火墙重载读取同一次启动的 active 策略恢复规则；跨宿主启动不复用旧来源地址，由 Runner 重新计算。固定短命 helper 使用带批准标签的 Runner 镜像不可变 ID、host network、只读根目录、`cap_drop ALL` 和唯一 `NET_ADMIN` capability；只挂载策略目录和 `/run/chrome-fleet`，没有 Docker socket、浏览器状态或秘密目录。Runner 自身仍处于私有服务网络。helper 和安装脚本共享策略锁，使用相同 nft/legacy 后端；规则提交失败不会覆盖已提交的 active 文件。首次部署该自动策略版本时应先安装新版 firewall，再启动新 Runner/控制服务。

管理员的旧 `FLEET_ALLOWED_PROXY_ENDPOINTS` 仍作为全 Fleet 的精确 IPv4/TCP 例外兼容，通常应保持为空；新代理应使用实例配置的自动 TCP/UDP 策略。旧变量只接受空格分隔的 IPv4:`1..65535`，不接受域名、IPv6、URL 或凭据。`sudo ./scripts/fleet firewall` 会读取项目 `.env`；直接执行安装脚本或 `python3 docker/browser/firewall-rules.py` 时需自行提供环境变量。规则生成命令不需要 root，也不会安装规则；完整校验失败时保留原有规则与就绪标记。

`/run/fleet` 是实例独立秘密目录的只读挂载，包含 `agent-token`、`keyring-password`、`vnc-password` 和 Runner 写入的 `agent.json`。VNCAuth 密码必须恰好 8 个可打印 ASCII 字符，密码以标准输入转换，不进命令行或环境。VNC 仅绑定容器 loopback，noVNC 6080 仅供经鉴权网关访问；用户进入后自行输入密码。轮换通过 Agent `/vnc/reload` 重启本实例 VNC，现有连接被断开。

Agent 8092 的所有端点要求实例 Bearer 凭据。浏览器操作先 `/fence {token}`，再携带 `fencingToken`，同一实例串行运行；令牌升级立刻拒绝旧令牌，并等旧有界操作结束才批准接管。超时或失联发生于可能有副作用的步骤时返回 `outcome_unknown`，不自动重放。上传只接受控制面授权 artifact 注入的 base64，不接受宿主文件路径，不提供任意 JS/eval。

Cookies 文档格式为 `{format:"chrome-fleet.cookies",version:1,cookies:[...]}`，保留 HttpOnly、会话 expires=-1、partitionKey 及所锁 Playwright 的 `_crHasCrossSiteAncestor` 分区属性；未知字段和无效属性直接拒绝。replace 和 replace_domains 都必须显式指定 domains，仅替换所选域。导入逐项返回结果，失败时另行报告 rollbackSucceeded 和 outcomeUnknown，不把回滚尝试当作恢复保证。导入结果的账号状态始终为 unknown，需要另行验证身份。

storageState 导出明确覆盖 cookies/localStorage/IndexedDB，不包含 sessionStorage、cache、service workers、OPFS、真实账号 passkey。Playwright 1.64.1 的 `setStorageState` 可作用于既有持久化 context；运行实例若已有 OPFS 或虚拟 passkey，本实现拒绝导入，避免该 API 清空超出范围的数据。merge 按 localStorage 键合并，冲突 IndexedDB 数据库需要显式选择按域替换。完整目录与 keyring 快照是完整恢复机制。

Runner `/images/validate` 创建无真实账号的临时 profile，检查 Chrome、sandbox、实际 libsecret 密钥、HttpOnly Cookie、localStorage、IndexedDB 和 storageState 往返，正常停止并删除容器后以原状态重建再读回数据，结束后清理临时实例。仅此验证通过的镜像才可用于项目自动更新。真实 Google 登录与 2FA 仍需用户人工验收，不能由此本地验证替代。

官方依据：[持久化上下文](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)、[storageState/setStorageState](https://playwright.dev/docs/api/class-browsercontext)、[Linux 密码存储与回退](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/linux/password_storage.md)、[VNCAuth 八字符限制](https://tigervnc.org/doc/vncpasswd.html)、[Playwright Docker sandbox](https://playwright.dev/docs/docker)。
