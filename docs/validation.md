# 验证记录与交付限制

验证日期：2026 年 10 月 17 日（Asia/Shanghai）。环境为 Linux x86_64、Docker Engine 29.4.2、Compose 5.1.3。自动化测试使用合成账号，未读取宿主机既有浏览器数据；当前受管实例另按用户明确授权尝试 Google 分步填写，结果见下文，未提交真实账号密码。

## Chrome Fleet Skill（2026 年 10 月 18 日）

新增独立的 Codex / Claude Code Skill，包含安装、部署接入、诊断、stdio 桥接和桌面转发辅助脚本。Python 3.10+，运行时仅依赖标准库；不修改业务 HTTP API 或 MCP 工具协议。

本轮在 Linux 上以 root 和普通用户分别通过 61 项隔离测试，覆盖独立安装、注册幂等及同名冲突、SSH 引用、stdio/EOF/SIGTERM、MCP 初始化与权限错误、CRLF 处理、Docker 环境隔离、APT 模拟、网络及目录冲突、部署重试与互斥锁。主机和客户端行为使用临时目录及合成命令验证，没有执行真实 APT、Docker、systemd 部署操作或读取生产凭据。Skill Creator 结构校验通过。

另使用真实 Codex CLI，在临时 HOME 和 CODEX_HOME 中验证用户级注册、配置读取及重复注册；没有启动 MCP 或修改当前用户配置。账号选择、VNC 模式、人工接管和结果未知场景完成独立文档走查。

```bash
python3 -W error::ResourceWarning -m unittest discover -s skills/chrome-fleet/tests -v
```

已配置 Linux、macOS、Windows 的 Python 3.10 / 3.13 CI；平台不适用的主机测试明确跳过。CI 配置尚不代表对应平台已运行通过。本轮未完成原生 Windows/macOS 客户端实机、真实 Claude Code 注册、隔离 Ubuntu/Debian 首次安装及真实 SSH/Docker 断连验收。这些验收需专用环境，不能用模拟测试或既有浏览器验证记录代替。新部署脚本默认执行 `doctor --runtime` 的临时空白 Chrome 检查，已有部署复用不执行该检查。

## 目录绑定、人工确认入口与归档清理

2026年10月17日用户通过VNC完成Google网站登录，并提供Google Account页面截图及登录成功陈述。该用户证据与平台的人工确认记录、自动化验收分开；本轮不读取真实Cookies/网页、不代用户点击确认，不停止或重启已登录Chrome。

新增7项控制层绑定测试及旧回归共87项integration通过；覆盖无Chrome/无租约/无Vault读取的绑定和确认、scope/profile/CSRF、唯一映射、同账号保留时间/换绑清除、旧记录派生不猜测、本人会话同步与不改他人会话、purged列表分页/计数。完整build/check及144项总测试通过。UI组件12项与路由7项均通过。隔离真实管理UI全流程亦通过：无session详情确认、刷新保留日期、显式换绑清确认、目录直接确认、固定邮箱无下拉、未绑定卡片无Google登录；元数据阶段仅2次PUT绑定和2次confirm POST，无打开桌面/导航请求。打开已确认账号的桌面不重置确认时间，Agent导航0。全部旧路由/密码/自动化兼容/390px布局回归通过，页面错误0、意外失败API0。

每个VNC实例先绑定一个导入目录账号，Google登录只操作固定账号；保存映射不等于确认登录。人工确认是受平台权限和CSRF保护的元数据动作，账号目录关联行与实例账号状态均可直接操作，不需要重新打开VNC或保留某次桌面租约。确认结果与时间持久保存，换绑清除旧确认，重复绑定、开桌面和重启控制服务保留同账号确认。

用户看到的15个归档项均为已彻底清理的验收实例：profile目录、容器、网络、artifact、backup、账号和活动租约均为0。保留的小量SQLite清理/审计记录此前被错误纳入列表；列表及总数现应排除purgedAt记录，未purge的真实归档实例继续保留。按固定15个UUID做全records及幂等响应外部引用检查后，已删除45份唯一QA密文文件（逻辑2940B，磁盘分配184320B=180KiB），目标剩余0，并保存一条无秘密的清理审计。未做全局prune/VACUUM。真实实例、4个目录账号及凭据、5份快照和7个受保护秘密文件核对未变。本轮仅重建工作台控制服务；前后Chrome容器ID、镜像和StartedAt完全一致，确认未重启已登录浏览器。生产只读复核显示当前实例1、归档0、目录账号4，既有单条绑定派生为待人工确认；没有代用户写入登录确认。

## 本次 VNC 模式与人工绑定

2026年10月17日：新增实例默认普通 Chrome 独立启动，不连接 Playwright/CDP。8项新增控制层集成覆盖模式持久化、同目录/keyring、正常关闭与加密恢复点、权限/本人租约/CSRF、失败及重启不回滚、VNC禁用自动化、账号人工确认不读取凭据和不检测页面。Browser Agent共40项测试，其中8项验证普通启动/窗口正常关闭及VNC能力边界，9项验证本地代理HTTP/CONNECT/SOCKS5、目的私网保护、代理认证、关闭/取消竞态与无效TLS失败不直连。

隔离管理界面E2E实际通过：新建默认VNC、VNC禁用页面任务、账号选择不触发Agent导航、登录后人工确认、目录显示“人工确认/非服务器验证”、模式切换返回202，以及原有路由、390px布局、VNC密码等回归；页面错误0、失败API请求0。夹具只模拟运行元数据及页面边界，不把它作为Google真实登录或Chrome数据持久化证明。

独立 `tests/e2e/native-browser-fixture.mjs` 已在最终镜像中实际通过：network=none、非root、sandbox、无Playwright/CDP或调试/自动化启动参数；正常窗口关闭两次后，同一专用目录的持久HttpOnly Cookie、localStorage、IndexedDB和Chrome libsecret密钥保持一致。仅使用自有合成站点与临时state、Google请求0；最初空白profile受Chrome首次设置阻挡；关闭设置窗返回28（EULA_REFUSED），Agent正确拒绝将其认定正常退出。普通启动已加入标准 `--no-first-run` 跳过设置，不放宽非正常退出判定。最终镜像 `sha256:0f20d972d2fcce389cccaf9f5caa80cf13db47f53e099f6e9a3214c5c18e9678` 使用无预置sentinel的真实空白profile通过两次页面访问、正常窗口关闭及全部持久性断言。

最终镜像在已部署LAN服务上使用默认VNC、自有全新且未预置First Run的实例完成6次RFB连接、自动认证及Unicode真实OS剪贴板往返；页面错误0、密码提示0、manage reveal调用0。覆盖刷新、重连、内嵌、关闭清空、租约撤销和密码轮换，所有自有临时会话/凭证/实例/状态已清理。

既有实例已保持同Chrome155版本、原目录/keyring及代理，切换为VNC并升级Agent修复。原中继将Google域名改写为本机解析IP，导致当前上游按域名路由失效；改为可信上游使用域名、直接连接仍固定预检IP后，同一实例中继的独立无账号HTTPS请求得到Google204、YouTube200。网络复核不带网站Cookie或密码，不代表Google接受真实登录。4条账号凭据、VNC凭据及keyring解锁秘密的vault密文和版本核对一致；所选账号仅记录为待人工确认，未代用户确认真实登录。

以下既有自动化验收保留为兼容模式历史记录；VNC模式不提供相应页面任务或Google自动识别。

## 本机已执行

- `npm run build`：全部 TypeScript workspace 与 React 生产构建。
- `npm run check`：全部 workspace 类型检查。
- `npm test`：144项测试全部通过（87项 integration、6项 SDK、5项 MCP、40项 Browser Agent、6项 Runner）。另行执行的19项页面路由、Google进度/固定绑定组件测试通过，不计入这144项。HTTP Runner/Agent 故障注入使用合成服务，明确不等同真实 Docker 验收。
- VNC 密码查看新增4项集成测试通过：生成和自设密码读取、轮换后读取新值、manage/profile 授权和 Web CSRF、凭证撤销、停止实例不启动、普通 API 脱敏、逐次审计及不缓存查看响应、purged/缺失/损坏秘密拒绝。全部使用合成实例与临时存储，未读取真实实例密码。
- VNC 自动认证新增5项集成测试通过：Web/CSRF、automate/profile 范围、本人有效人工会话与租约、密码版本及运行状态检查、桌面 HTML 不含密码、绑定上下文的真实 WebSocket 转发及撤销、客户端预取认证与显式重连；全部使用合成数据。
- 桌面剪贴板新增5项控制层、2项Agent测试通过：Web/CSRF/来源/实例范围/本人租约与上下文、调用前后撤销、UTF-8限额及NUL拒绝、正文不入任务/存储/审计或幂等缓存、旧或异常Agent固定错误、HTTP面板及复制回退；CLI文本经管道传递，不放argv或磁盘。
- 防火墙策略检查覆盖默认私网拒绝、精确端点和来源匹配、TCP/UDP 准入、非法输入拒绝及无效配置不修改就绪规则；安装脚本 shell 语法检查通过。此前用精确 TCP 兼容例外验证过代理出口 Google 返回204、YouTube返回200、HTTPS CONNECT为200；当前实例自动策略无需逐个填写该全局例外。临时验证容器已移除，此项不代表网站账号登录成功。
- `npm audit --audit-level=low`：0 项已知依赖漏洞（以本次锁文件与审计时间为准）。
- `docker compose config --quiet`、控制服务与 Runner 镜像构建和实际启动；`/health` 返回ok，`/ready` 检查Runner。验证部署监听 `0.0.0.0:8080`，精确允许配置中的 LAN、两个 WireGuard 入口及 loopback 来源；Host 与 Origin 必须匹配同一已配置地址，API、MCP 和桌面仍需认证，没有公开 VNC/CDP/Agent/Runner 端口。
- LAN、WireGuard 和 loopback 的 REST、MCP HTTP 与真实 WebSocket 网关测试通过；拒绝未知 Host/Origin、跨地址组合及缺少 Origin 的桌面连接。此项验证来源限制与网关转发，不涉及真实 Google 账号。
- `sudo ./scripts/fleet doctor`：架构、Docker/Compose、磁盘、secret权限、当前boot防火墙、Chrome镜像、seccomp检查通过；端口已由本项目占用。
- `sudo ./scripts/fleet doctor --runtime`：实际创建一次性Chrome实例，sandbox、keyring、持久Cookie/IndexedDB及删除容器再重建验证通过，临时实例已清理。
- [真实管理界面验证](validation-ui.md)：官方 CfT 驱动中文界面，对接实际控制服务与数据库，页面错误0、关键流程失败API 0；含390px响应式界面、人工会话刷新恢复、两个入口的标准创建页/取消返回/账号预填/创建后详情，以及 VNC 密码主动查看、隐藏、离开实例或标签清除、轮换后重新查看和普通 GET 脱敏。截图前已统一隐藏密码；复制仅检查按钮存在及可用，未验证剪贴板实际写入。
- 本轮 History URL、图标和字号 UI QA 通过：路由直达、刷新、浏览器前进/后退恢复正确；桌面与390px布局及调大后的字体无水平溢出，页面错误0、失败 API 请求0。
- 本轮已部署 LAN 管理页真实浏览器检查通过：两个创建入口及账号预填返回、既有1个实例查看密码格式/隐藏/离开后清除，前后状态与密码/代理/镜像版本未变；既有 vault 密文 SHA 和版本比对一致，保留原 VNC 凭据。未创建或轮换生产实例，无截图或秘密输出，不作为真实 Google 登录验收。
- `node tests/e2e/desktop-autoconnect-live.mjs`：已部署 LAN 服务、独立短期平台凭证与唯一合成 Chrome 实例上完成6次真实 noVNC RFB 自动认证，覆盖新窗口、刷新、断开重连、管理页内嵌及密码轮换后新会话。密码提示框0、页面错误0、manage reveal调用0；URL/HTML/浏览器存储及输入框不含密码。结束租约或轮换立即关闭旧 WebSocket，旧上下文读取凭据和升级连接被拒绝。测试无截图或远程键鼠输入，精确清理自己的实例和凭证；既有实例密码密文及版本保持一致。
- `FLEET_TEST_CLIPBOARD=1 node tests/e2e/desktop-autoconnect-live.mjs`：仅在自有合成实例上增加真实Unicode剪贴板往返：loopback安全页写本机系统剪贴板，LAN HTTP面板真实Ctrl+V并发送，经RFB在远程Chrome地址栏粘贴，清空旧远程CLIPBOARD后重新复制、读取面板，先更换本机剪贴板再验证HTTP复制回退写入。中文、Ω、emoji及唯一标记逐字一致；未按Enter或访问网站。内嵌读取、关闭清除、浏览器不持久保存和租约/密码轮换拒绝通过。没有生产桌面输入、截图或真实密码操作，所有自有容器/凭证已清理。
- 剪贴板部署后的首次合成验收在初始连接阶段超时，当时未保留客户端状态，原因未确定；新增安全诊断后的连续两轮完整验收通过，每轮6次RFB连接及真实剪贴板往返、页面错误0。另以真实noVNC静态资源测试6组语言和模块加载延迟，均只有一次授权凭据请求且无JS错误，未复现启动竞态，因此没有据此修改noVNC启动逻辑。
- `node --import tsx tests/e2e/control-live.ts`：对实际Compose服务执行创建默认stopped、队列导航/提取、HttpOnly持久Cookie加密导入导出、认证桌面HTML与WebSocket RFB握手、桌面HTTP无凭证拒绝、人工租约阻塞队列、正常停机快照、手动停止暂停唤起、归档移除容器再重建、快照恢复后Cookie读取。全部通过，最后清理自己的合成实例。
- `node --import tsx tests/e2e/proxy.ts`：两个实际独立 Chrome 容器、不同认证HTTP代理的不同身份页面、真实HTTPS CONNECT与Chrome TLS校验、错误认证不直连、只切换目标实例代理。全部通过。临时代理仅绑定测试实例的出站网关，精确临时防火墙规则已回收，未放宽生产规则。
- `node tests/e2e/network-policy-live.mjs`：6项检查、2个真实 Chrome 容器通过；A端点 TCP/UDP 允许、未配置B端点超时、另一无代理实例不能访问A/B、仅保存B后新B允许且旧A新连接被拒绝、禁用后B撤销，最后通过 API 归档并 purge 全部合成实例。夹具仅绑定本轮实例网关，平台令牌只在内存中读取，不输出秘密。UDP 证据来自容器内 Node 数据报，证明网络准入与隔离，不证明 Chrome 或 HTTP CONNECT 支持 UDP 隧道。另以 FLEET_TEST_SOURCE_ISOLATION=0、FLEET_TEST_FIREWALL_RELOAD=1 补验1个真实容器：最新版 Runner 下宿主防火墙重载后A双协议仍通、B仍拒绝，更换/禁用及清理也通过。
- `docker compose exec -T runner node /build-context/apps/runner/dist/smoke.js`：实际三容器并发隔离、sandbox/libsecret、持久HttpOnly/CHIPS Cookie、LS/IndexedDB、独立RFB密码与轮换、停止删除容器再重建、浏览器到控制面及云元数据的网络拒绝，全部通过并清理测试容器。
- `node --import tsx tests/e2e/update-live.ts`：从官方Google源实际准备并验证候选镜像；实际旧镜像 `e61e2a5…` 升级到 `9579a433…`，停机加密快照，Cookie/LS/IndexedDB保留；再写入新状态并配对回滚旧镜像与原快照，原状态恢复且新状态被舍弃。两个镜像的Chrome版本均155.0.8059.79，此项证明真实镜像替换/回滚流程，不宣称完成跨Chrome版本迁移。测试使用隔离元数据库/vault与唯一真实运行目录，未复制模拟恢复，实体已精确清理。
- 官方 MCP SDK 连接已部署服务的 stdio（Docker exec）及 `/mcp` Streamable HTTP，初始化、35工具列举与 profiles_list 调用成功，使用同一平台主体和profile集合。
- Google绑定新增验证：账号文件全量校验、密码vault加密和清单脱敏、人工租约及导航失败保留桌面、后台自动绑定、邮箱不一致保护、关闭/撤销期间拒绝写入。Agent 14项测试覆盖强身份标记、HTTPS来源、隐藏/iframe、账号选择器、多个邮箱和无效邮箱拒绝；真实Chrome DOM夹具4组通过，页面内容来自脱敏夹具，并非真实Google登录。
- Google分步填写新增7项控制层及5项Agent测试通过：显式选定账号、admin/profile/CSRF、Vault账号匹配、当前人工租约与fence、凭证撤销及关闭竞态、允许的阶段与固定提示脱敏、旧Agent降级。未选账号不读取密码，已填密码后停止辅助且继续身份检测；结束本人或他人会话不再触发新填写。
- `node tests/e2e/google-autofill-fixture.mjs`：真实官方Chrome、18个受控DOM场景通过，全部网络使用本地route fulfill/abort，真实Google请求0、密码提交0。邮箱自动填好后反复轮询，邮箱Next点击及邮箱提交均为0；测试显式模拟人工点击后，跨文档和SPA切页都能自动填密码并停止。另覆盖人工输入不覆盖、错号/多号/无身份/隐藏/iframe/HTTP/第三方/挑战/账号选择页拒绝及fence撤销。控制层轮询测试验证`email_filled`持续等待、人工切页后推进，以及旧`email_submitted`记录兼容。
- 分步填写已部署到控制服务和浏览器镜像；新镜像通过真实容器重建与持久性兼容检查，现有唯一实例经加密恢复点和受控更新升级了Agent，Chrome版本仍为155.0.8059.79。随后按用户选定账号打开真实Google页面，页面转至`/v3/signin/rejected`并提示浏览器或应用可能不安全；辅助返回`unsupported`并停止，没有填写或提交密码，不宣称真实Google登录通过。原VNC密码、4条账号密码密文及代理版本比对一致，临时镜像验证容器已清理。
- 最新人工邮箱Next流程再次经真实镜像兼容验证、加密恢复点和受控更新部署到现有实例。重新打开用户已选账号后，真实Google页面成功进入`email_filled`，后台持续等待人工点击邮箱页下一步，没有自动提交。当前真实密码页与登录结果尚待用户点击后验收；已保留原4条账号密码、VNC密码及代理版本，临时验证容器均已清理。
- `node --import tsx tests/e2e/google-login-live.ts`：已部署LAN地址上，官方客户端HTTP MCP初始化/发现/调用、清单不含密码或secret引用、Google入口唤起真实Chrome、noVNC HTML与真实RFB握手、无错误绑定、精确清理通过。Google真实页面加载因当前直连超时而明确SKIP，不宣称该页面或真实登录验收通过。

## 故障注入覆盖

测试位于 `tests/integration/`：scope/profile权限、Web CSRF、平台凭证撤销、同实例串行/跨实例并行、人工接管互斥、重启后outcome_unknown不重放、artifact权限与AES-GCM、一次性密码幂等响应加密、归档/purge目标范围、离线快照与符号链接拒绝、目录恢复中断journal、缺失keyring拒绝空白初始化。

更新测试包括未验证候选拒绝、备份失败阻止更换、候选Cookie技术检查失败配对回滚、停止实例只标pending、下一次唤起先快照、busy延后后仍可再次应用、明确回滚、升级中断重启恢复并释放租约、回滚失败保留快照、实际Chrome版本不匹配和pending版本不匹配。它们使用真实存储/加密/快照与业务服务，HTTP容器层为故障注入夹具。

## 复现关键命令

首次部署见 [operations.md](operations.md)。宿主无Node时可用Docker构建；开发检查需要Node24。凭证只从文件读取，不要把真实Cookie、令牌或网站密码写到命令行或提交到仓库。

```bash
npm ci
npm run build
npm run check
npm test
npm audit --audit-level=low
sudo ./scripts/fleet doctor
node --import tsx tests/e2e/control-live.ts
node --import tsx tests/e2e/proxy.ts
node tests/e2e/network-policy-live.mjs
node tests/e2e/desktop-autoconnect-live.mjs
node tests/e2e/google-autofill-fixture.mjs
node --import tsx tests/e2e/update-live.ts
node --import tsx tests/e2e/google-login-live.ts
sudo ./scripts/fleet doctor --runtime
```

REST 测试使用本地令牌文件；网络策略脚本默认读取项目 `secrets/admin-token`，既有测试仍可读取运行时 `/var/lib/chrome-fleet/secrets/admin-token`。可用 `FLEET_TEST_URL` 和 `FLEET_TEST_TOKEN_FILE` 指定独立测试部署。脚本只清理自己创建的UUID实例，不运行全局prune。网络策略脚本默认不直接重载宿主规则；显式设置 `FLEET_TEST_FIREWALL_RELOAD=1` 才执行固定的 `scripts/fleet firewall`，随后重复验证A允许/B拒绝。真实容器测试会占用临时浏览器资源和网络，建议在维护时间执行。

桌面脚本默认只验证连接，不向远程Chrome输入；`FLEET_TEST_CLIPBOARD=1` 才在自己的空白合成实例地址栏输入测试文本验证剪贴板。该模式需要局域网HTTP的 `FLEET_TEST_URL` 和可访问的同一服务loopback安全来源（默认 `http://127.0.0.1:8080`，可用 `FLEET_TEST_CLIPBOARD_LOOPBACK_URL` 指定），并仅向此测试浏览器授予loopback剪贴板权限。它不会接管既有用户实例。

## 2026-10-18：任务日期筛选、密度图与滚动加载

任务中心和实例任务页已增加北京时间日期范围（默认包含今天的过去 7 天）、按任务类型分色的时间密度图和每批 30 条的滚动加载。统计使用完整筛选范围；列表通过创建时间与 ID 游标分页。后台刷新保留已加载记录，并继续更新较早的未完成任务。

随后按要求改为固定每小时统计，7 天显示 168 根柱、30 天显示 720 根柱；柱子铺满时段宽度，相邻无间隙。更新后的集成测试和完整任务页 E2E 均通过；360–1920px 下柱子连续贴合、时间刻度无重叠，任务列表滚动加载与日期切换继续通过。

- `npm run check` 全工作区通过；`npm test` 174 项通过；使用 `TSX_TSCONFIG_PATH=apps/web/tsconfig.json` 运行的前端测试 44 项通过。
- 新增集成测试覆盖超过 100 条记录、相同创建时间、新记录插入后的游标稳定性、北京时间午夜与统计分桶边界、全量统计、空时段、实例权限过滤及错误参数。
- `tests/e2e/job-history.mjs` 使用一次性 SQLite、真实任务 API 和构建后的页面，验证首次加载 30 条、滚动加载至 155 条、连续插入 65 条后的刷新与去重、较早任务状态更新、失败重试、切换日期时忽略旧响应、空范围、实例筛选和范围外任务详情。360/390/768/1440/1920px 均通过，图表提示框无横向溢出，浏览器错误为 0。
- 原有 `tests/e2e/web.mjs` 完整隔离回归通过；任务中心和实例任务页的独立布局检查通过。此回归使用模拟接管，不证明 Google 登录成功。
- 已更新运行中的控制服务；线上页面及静态资源与本次构建一致。只读验收中默认范围共 92 条记录，首次加载 30 条，滚动加载全部 92 条，无重复；“今天”筛选和手机布局通过。业务数据写入、凭据查看和浏览器错误均为 0。账号、加密凭据、绑定和实例设置与更新前一致，既有浏览器容器未重启。

## 具体限制

- Google网站登录、2FA、容器重建后的真实Google登录会话尚未人工验收。请通过该实例的noVNC桌面登录；服务器撤销或重新验证仍需人工处理，不能由本地测试推断Google永久在线。
- 此前从控制服务直连`https://accounts.google.com/ServiceLogin`在10秒内超时，相关真实Chrome检查同样未完成；这是当时的网络验证记录。当前配置代理的实例已能加载Google，但最新分步填写检查遇到Google的浏览器安全拒绝页，需人工处理；未提交密码或绕过Google验证，未宣称真实账号登录成功。
- 未重启整台宿主机进行验收；已验证容器/控制服务重启与更新阶段故障对账。宿主重启前请启用已交付的systemd防火墙unit。跨Chrome版本的实际profile格式迁移尚未完成真机验收，故障注入测试已覆盖错误版本拒绝和配对恢复。
- 当前Linux x86_64、单控制服务进程、单管理员模式；不支持ARM官方GoogleChrome分发、多机/多控制进程调度或Kubernetes。
- MCP HTTP 已集成在控制服务，使用精确允许的本机、LAN 或 WireGuard 地址和 Bearer 认证，stdio 为可选连接方式，协议锁2025-11-25；没有公网OAuth授权服务器/资源服务器集成，不声称兼容所有远程MCP客户端。
- SOCKS5只支持无认证；浏览器代理不等于全容器透明隧道。DNS/WebRTC/UDP/bypass覆盖以部署网络策略为准。认证HTTP代理和HTTPS目标CONNECT已实际验证，HTTPS代理服务器本身的TLS传输及无认证SOCKS5尚未单独完成真实出站验收。
- 单文件上传/下载16MiB，完整快照1GiB；快照暂用受限本机临时文件及有界内存加密，大profile应清理下载/缓存或先评估内存。需要磁盘静态加密时将数据根部署到加密卷。
- VNC模式的Google映射仅由人工确认，不检测实际网站登录状态。自动化兼容模式的Google检测仅检查当前可信 Google 页面中可见的账号标记；其他站点需管理员配置自定义 detector 的验证 URL、身份定位器和期望值。该检测不等于真实账号登录已验收，也不根据 Cookie 存在推断身份。
- 标准storage-state不包含sessionStorage、完整缓存、服务工作线程、真实WebAuthn设备或服务端状态。检测到无法无损保留的OPFS/虚拟passkey时拒绝覆盖式状态导入，请用完整快照。
- 主密钥在线轮换没有一键API；离线轮换及备份整套vault/数据库/密钥的步骤见运维文档。不能只保存加密快照而丢弃其keyring secret版本和主密钥。
