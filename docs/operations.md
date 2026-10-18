# 部署与运维

## 首次启动

在项目根目录执行：

```bash
sudo ./scripts/fleet init
sudo ./scripts/fleet firewall
docker compose --profile build build
docker compose up -d
sudo ./scripts/fleet doctor
curl http://127.0.0.1:8080/health
```

按 `.env` 中的 `FLEET_PUBLIC_URL` 打开管理页面（模板默认 `http://127.0.0.1:8080`）。首次登录使用初始化生成的平台令牌，默认文件为 `/var/lib/chrome-fleet/secrets/admin-token`；自定义数据根目录时相应调整路径。在安全本机终端读取该文件并粘贴到登录表单。凭证不会进入前端 bundle 或 localStorage。VNC 密码已在 vault 中加密保存，可在实例设置页点击「查看 VNC 密码」，需该实例的 `manage` 权限；停止实例也能查看，每次查看记录审计，查看不会轮换密码。默认实例停止，点击启动或桌面唤起。受保护桌面会在核验当前平台登录和人工会话后自动填写 VNC 密码并连接，无需再次输入或点击提交。普通 Chrome 启动跳过首次设置页，直接打开初始登录页面；其余网站登录及验证由你操作。默认 VNC 模式下，先把目录账号绑定到实例，再打开固定邮箱的普通 Chrome 桌面；完成登录后，直接在账号管理关联行或实例账号状态点击“确认已登录”，记录人工确认时间，无需重新打开登录流程。系统不读取页面、填写网站密码或验证登录结果。实例设置可切换浏览器模式，执行正常停机、加密恢复点及同目录重启；旧实例保留自动化兼容模式直到显式切换。

如需在项目内保存凭据副本，将其放在 `secrets/`，目录权限设为 `0700`，`admin-token` 和 `accounts.txt` 文件权限设为 `0600`。整个目录由 Git 忽略并排除在 Docker 构建上下文之外。Compose 挂载数据根目录中的运行时令牌原文件；项目副本不会自动跟随轮换更新，切换平台凭证后应同步副本及客户端配置。

通用 `init` 只初始化运行时秘密，不自动创建项目副本。其他部署可在初始化后从项目根目录执行以下可选同步命令；自定义数据根目录时调整源路径：

```bash
sudo install -d -m 0700 secrets
sudo install -m 0600 /var/lib/chrome-fleet/secrets/admin-token secrets/admin-token
```

初始化只创建本项目数据根与 `.env`，不会修改 `/opt` 其他服务。需要避开现有 Docker 子网：预先检查 `docker network ls/inspect`。当前控制网段固定172.30.0.0/24，修改须同步 Runner、Compose 和防火墙模板，不支持只改一个环境变量。

宿主机重启后需重新安装本次 boot 的防火墙。可用下面的 systemd unit，放到 `/etc/systemd/system/chrome-fleet-firewall.service`，检查路径后启用：

```ini
[Unit]
Description=Chrome Fleet 浏览器网络隔离
After=docker.service
Requires=docker.service
Before=chrome-fleet.service
[Service]
Type=oneshot
ExecStart=/opt/chrome-fleet/scripts/fleet firewall
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
```

建议用另一 oneshot unit `ExecStart=/usr/bin/docker compose up -d`、`WorkingDirectory=/opt/chrome-fleet`、`Requires/After=chrome-fleet-firewall.service` 管理启动顺序。防火墙缺失时 Runner 拒绝启动新实例。停止的浏览器没有 restart-always 策略。

## 配置和 HTTPS

复制 `.env.example` 后调整数据目录、端口、并发数；数据目录应在加密磁盘上，并放在项目源码目录之外；初始化会拒绝系统目录或无法识别的已有非空目录。设置 `FLEET_PUBLIC_URL=https://浏览器管理域名` 与 `FLEET_COOKIE_SECURE=true`，用自己的 HTTPS 反向代理转发全部路由，包含 `/profiles/.../desktop/websockify` WebSocket。配置模板仍默认只绑定 127.0.0.1；如明确需要局域网访问，可按下节将宿主监听改为 0.0.0.0 并设置精确允许来源。不要发布 8091/8092/5900/6080、CDP 或 Docker socket。

Nginx location 关键配置示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $http_host;
    proxy_set_header Origin $http_origin;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600;
}
```

MCP 已集成在同一 HTTP 服务中，连接 URL 为管理页面地址加 `/mcp`，客户端选择 Streamable HTTP 并配置 Bearer 平台令牌。普通用户无需执行 Docker 或 MCP 启动命令。受信任局域网/WireGuard 可以使用显式允许的来源；目前不提供完整公网 OAuth，HTTPS 管理网页不代表已具备该授权兼容性。

管理页面使用标准 History URL，包含 `/profiles`、`/accounts`、`/jobs`、`/updates`、`/guide`、`/profiles/new` 及实例各标签页，详细格式见 [页面 URL](api.md#管理页面-url)。反向代理应把这些页面路径也转给控制服务，以便直达和刷新恢复；继续保留原始 Host 与 Origin。正文约15px、表单14px、按钮13–14px、辅助文字至少12px，桌面与移动端分别保留适当换行。

## 监听与精确允许来源

`FLEET_BIND_ADDRESS` 控制宿主端口映射，`FLEET_PUBLIC_URL` 指定默认访问 origin；额外入口用 `FLEET_ALLOWED_ORIGINS` 逗号分隔配置。所有来源都必须是实际 HTTP(S) 主机与端口，不接受 `*`、通配域名、路径、凭据、`null` 或监听通配地址。public URL 和同端口 loopback 来源始终保留；带 Origin 的请求必须与自己的 Host 配对，不能在两个已允许地址之间跨来源发请求。REST、HTTP MCP 和桌面 WebSocket 共用这套规则；WebSocket 还必须携带匹配 Origin 与有效平台身份。

下面以 LAN 和两个 WireGuard 入口说明配置。所有地址均为示例，请替换为部署服务器的实际地址：

```dotenv
FLEET_BIND_ADDRESS=0.0.0.0
FLEET_PUBLIC_URL=http://192.168.50.10:8080
FLEET_ALLOWED_ORIGINS=http://192.168.50.10:8080,http://10.200.0.1:8080,http://10.201.0.1:8080,http://127.0.0.1:8080,http://localhost:8080,http://[::1]:8080
```

对应管理页面为 `http://192.168.50.10:8080`、`http://10.200.0.1:8080` 或 `http://10.201.0.1:8080`；MCP 分别在同一地址的 `/mcp`。`0.0.0.0` 是监听设置，不是浏览器或 MCP 连接 URL。其他机器部署请替换为自己的实际地址；`.env.example` 保留通用本机默认值。

修改配置后由部署管理员统一重新创建控制服务，使 Compose 端口映射和环境生效。这里只开放管理 HTTP 入口，Runner、Browser Agent、VNC/noVNC 原始端口、CDP 与 Docker socket 继续保持私有。

账号导入源文件可放在项目 `secrets/accounts.txt`，文件权限应为 `0600`；`account.txt`、`accounts.txt` 及整个项目 `secrets/` 目录均从 Git 和 Docker 构建上下文排除。不要把账号密码放进日志、提示词或镜像。首次网站登录与 2FA 仍通过受保护桌面人工完成。

## 桌面剪贴板

远程桌面右上角点击「剪贴板」，或使用noVNC侧栏原有剪贴板按钮，打开同一中文面板。

- 本机到远程：在面板文本框按Ctrl+V（Mac为⌘V），点击「发送到远程」，再在远程Chrome目标位置按Ctrl+V。发送只设置远程剪贴板，不会自动粘贴或提交表单。
- 远程到本机：在远程Chrome复制文本，点击面板的「读取远程剪贴板」，再点「复制到本机」。浏览器限制自动复制时，面板会选中文本，手动按Ctrl+C或⌘C即可。

支持最多128KiB的UTF-8文本，包括中文；不传输图片或文件。局域网HTTP不依赖受限的系统剪贴板读取API，也不后台读取本机内容。面板文本只驻留当前页面内存，关闭面板、断开桌面或离开页面会清除。读取和发送都需当前本人有效人工会话，结束会话或轮换VNC密码后需重新打开桌面。

## 实例代理与自动网络规则

新建实例和实例设置均使用单一“代理地址”输入框，采用 [Chrome 的 URI 格式](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md#proxy-server-identifiers)，例如 `http://192.168.50.20:8888`、`https://proxy.example.com:8443`、`socks5://proxy.example.com:1080`。协议可省略，默认HTTP；端口省略时HTTP为80、HTTPS为443、SOCKS5为1080。认证信息填在独立的用户名和密码栏，地址中不填写路径、查询参数或认证信息。同一代理的认证栏留空时保留原凭据；保存成功后清空认证输入框。

浏览器出站默认拒绝私网地址。实例设置中保存代理后，平台按该 profile 的来源地址、代理目标 IP 和端口自动维护 TCP/UDP 精确准入；修改或禁用代理、启动或停止实例以及防火墙重载时同步规则。通常只需在实例中配置实际代理，无需额外修改 `.env`；也不应放行整个私网。修改已运行 Chrome 的代理配置后仍需受控重启以加载新版本，网络规则同步不等于浏览器已切换出口。

代理域名使用 IPv4 A 记录，每60秒刷新；浏览器禁用 IPv6，只有 IPv6 或没有可用 A 记录的代理不能使用。解析失败会回收旧地址的新连接例外并标记 pending，随后重试；保存的代理配置仍保留。Runner 内部健康信息的 `networkPolicy.pending` 和 `lastErrorCode` 用于诊断同步失败。停止实例回收其来源规则但保留目标配置，下次启动重新计算；重载复用当前 boot 的已提交规则，跨宿主重启则由 Runner 根据实际容器地址重新计算。

`FLEET_ALLOWED_PROXY_ENDPOINTS` 保留为旧部署的管理员兼容例外，通常留空。确有独立全局例外需求时，可填写不含认证信息的精确 IPv4/TCP 端点，例如：

```dotenv
FLEET_ALLOWED_PROXY_ENDPOINTS=192.168.50.20:8888
```

修改这个兼容配置后，从项目根目录重新加载宿主防火墙：

```bash
sudo ./scripts/fleet firewall
```

仅同步网络准入规则无需重建 Runner 或浏览器容器。宿主重启后必须重新加载规则；已安装上述 systemd 防火墙 unit 时由其执行，否则应先手动运行该命令再启动服务。其他部署请替换为实际代理的 IP 和端口。

代理 `appliedVersion` 表示配置已加载到浏览器，不代表代理可连通或 HTTPS CONNECT 成功。若宿主通过代理正常而容器请求超时，应检查 `CF-FLEET` 中该实例来源到代理端点的规则是否已同步，再使用实例代理测试核实 HTTP/HTTPS 出口。允许到同一端点的 UDP 数据报不表示 HTTP CONNECT 支持 UDP，也不把浏览器变为全容器透明隧道；实际协议能力仍取决于 Chrome 和代理服务器。

## 数据和密钥

主密钥为运行时数据根目录中的 `secrets/master.key`（默认 `/var/lib/chrome-fleet/secrets/master.key`），32字节；与项目 `secrets/` 中的用户文件分开管理。artifacts、快照和 vault 均为 AES-256-GCM，使用随机 nonce、认证 tag 和实体ID AAD，元数据记录 keyId。将主密钥和平台/Runner凭证另行离线保管，不与加密备份正文存放一起。实例秘密从 vault 解密为0400/0600文件只读挂载，仅注入对应实例。

主密钥轮换：停控制服务和全部浏览器，离线复制数据库/vault/artifacts/backups；用旧密钥逐实体认证解密，再用新32字节密钥加密，更新每条keyId，验证所有条目后原子切换主密钥文件，失败恢复整套旧数据。当前没有在线一键换主密钥功能。不要直接覆盖 master.key，否则既有数据不可读。平台凭证轮换通过创建新凭证、切换客户端、撤销旧凭证完成。

默认 artifact 与审计记录保留30天，每分钟回收过期数据，下载逐次鉴权。任务结果、截图、下载和导出均可能包含敏感信息。禁止人工登录期间自动截图。任务参数通过vault加密引用保存，提取结果位于受权限保护的本机SQLite，磁盘加密由部署方配置。

## 排错

- `FIREWALL_NOT_READY`：执行 firewall，检查 br_netfilter、iptables、当前boot marker；不会通过关闭隔离默认启动。
- `PROFILE_DIRECTORY_UNSAFE`：数据/state/secrets必须真实目录，UID1000、0700；不要共享一个profile给多容器。
- `KEYRING_UNAVAILABLE`：检查持久keyrings与原版本解锁秘密。禁止改为basic。恢复必须匹配快照内secret引用。
- `PROFILE_STOPPED`：手动模式或暂停自动唤起；手动启动后再提交任务。
- `PROFILE_BUSY`：等待任务完成或关闭人工会话。强制关闭可能使动作结果未知。
- `needs_login/needs_verification/unsupported`：与容器运行状态独立。unsupported表示未注册可信站点身份检测器；Cookie存在不能证明账号有效。
- `outcome_unknown`：检查远端站点实际结果，禁止直接重放提交/删除等动作。
- `DISK_FULL`：保留现有数据，释放空间后重试；完整快照首版上限1GiB，上传/下载单文件16MiB。
- Chrome sandbox 不可用：检查 Docker seccomp 和宿主 user namespace / AppArmor 策略，按Playwright官方部署文档配置；不能以 no-sandbox 绕过。
- 代理不通：查看实例内HTTP/HTTPS测试。配置失败不会自动切直连。更改运行实例代理后重启应用；测试按钮会受控应用待生效配置。

诊断命令：`docker compose ps`、`docker compose logs --tail=100`、`docker ps --filter label=chrome-fleet.managed=true`。秘密文件不要粘贴到日志或Issue。

`sudo ./scripts/fleet doctor --runtime` 会额外创建一次性空白实例，实际验证 Chrome sandbox、keyring、Cookie/IndexedDB 与容器重建，再清理该实例；部署就绪后在无其他镜像验证运行时执行。

项目已提供 `docker/host/chrome-fleet-firewall.service` 与 `docker/host/chrome-fleet.service`。部署路径为默认 `/opt/chrome-fleet` 时，可用以下命令配置宿主启动顺序；其他路径先调整unit中的路径：

```bash
sudo cp docker/host/chrome-fleet*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable chrome-fleet-firewall.service chrome-fleet.service
```

上述命令需要部署管理员显式执行；初始化不会自动安装 systemd unit。若未启用上述 unit，重启后应先执行 firewall，再用 Compose 启动。

## 已清理实例与归档列表

归档保留用户目录和可恢复数据，适合暂时不用的真实实例；彻底清理会删除目标容器、目录及对应导出/快照。已清理的 `purgedAt` 记录只用于审计，不进入普通列表、归档列表或计数。不要根据历史列表条目推断仍有同名容器占磁盘。2026年10月17日显示的15项是此前QA清理记录，并非15个仍运行的浏览器；其数据已释放，唯一QA秘密残留另经精确归属和外部引用检查后删除。
