# 会话恢复范围

| 机制 | 内容 | 条件与限制 |
| --- | --- | --- |
| 完整用户目录 | Chrome Local State、网站数据、缓存等 | 每实例独占、固定UID、与keyring和解锁秘密配对；服务器仍可撤销会话 |
| Cookies JSON | HttpOnly、SameSite、秒级expires、分区属性 | 导入只写Cookie；不迁移localStorage/IndexedDB或设备身份 |
| storage-state | Cookies、localStorage、显式IndexedDB | 使用Playwright1.64.1原生setStorageState恢复既有持久context；不包含sessionStorage等完整环境 |
| 完整快照 | 离线用户目录、keyring、镜像和secret版本引用 | 必须先正常停止Chrome/keyring；恢复仅允许停止实例；覆盖恢复点之后数据 |

Cookie标准格式为 `{format:"chrome-fleet.cookies",version:1,exportedAt,cookies:[...]}`，expires使用UTC Unix秒，-1为会话Cookie；没有前导点的domain表示host-only，前导点表示域Cookie。当前兼容的 `partitionKey` 与 `_crHasCrossSiteAncestor` 字段保留；不支持字段明确报错。精确域/子域选择语义请参考API文档；替换模式必须明确选择范围，不默认清空所有Cookie。

导出文件加密保存为artifact，MCP只返回ID；下载需要平台读取与会话导出权限。导入用授权artifact并持有写租约，账号状态重设为unknown。先dryRun预检，应用可能出现部分失败，查看任务错误与结果，不将其视为数据库事务。

重建流程：正常停止实例，移除容器而保留 `profiles/<id>/state` 和秘密，启动时仍挂同目录、UID1000和原keyring秘密；浏览器读取既有持久Cookie。会话Cookie不保证在正常退出后恢复。Google网站登录与Chrome Sync不同；不需要开启Sync。

回滚流程：停止新版容器 → 校验快照认证与checksum → 恢复完整state/keyring → 恢复快照的旧image与keyring secret引用 → 再启动旧版。禁止把旧浏览器直接指向新版迁移后的目录。若恢复失败，保留加密快照和原目录并按运维文档排错。

人工确认是用户对当时登录情况的声明。本地 fixture 不证明 Google 永久保持会话。首次登录、验证码、2FA和服务器撤销后的重新验证都需要人工桌面。

Playwright storageState 只导出当前上下文已知的 origin。重启后应先打开需要导出的站点，再导出其 localStorage/IndexedDB；未访问的既有站点可能不在 origins 中。需要覆盖全部站点和完整环境时使用离线完整快照。
## Google 人工登录与实例绑定

新建实例默认使用 VNC 模式：Chrome 以普通独立进程启动，使用原有专用用户目录、keyring、sandbox 和代理，通过受保护的 noVNC 桌面操作；不建立 Playwright/CDP 连接，也不自动填写或读取 Google 页面。

1. 在实例“账号状态”或“账号管理”明确选择目录账号并保存绑定。每个实例只绑定一个 Google 账号；这一步只保存映射，不启动或操作 Chrome，不表示已登录。
2. 已绑定的浏览器卡片才显示“Google 登录”，入口固定为该邮箱，不能在登录时临时切换账号。需要换账号时，先在账号状态中明确换绑；换绑后清除之前的人工确认。普通 Chrome 跳过首次设置页，在 VNC 桌面自行完成网站邮箱、密码及验证；无需为此启用 Chrome 同步。
3. 完成登录并核对邮箱后，在“账号管理”的关联行或实例“账号状态”点击“确认已登录”。只记录人工确认、操作者及 `lastConfirmedAt`，保留当前浏览器模式和人工桌面；旧自动检测结果保留为历史信息，不再作为当前状态。人工确认不保证网站会话始终在线。

已确认时显示状态及人工确认时间，按钮改为普通样式的“更新登录确认”；重新核对后点击，可刷新确认记录和时间。Google 实例账号页、账号目录和关联平台使用相同的状态规则。

需要网页任务时，可在实例设置中单独切换为自动化模式。切换正常关闭 Chrome、保存加密恢复点，再使用原镜像、用户目录和 keyring 启动；人工确认时间保留。Google 可能拒绝自动化浏览器中的重新登录：出现“此浏览器或应用可能不安全”、`/signin/rejected` 或“验证是你本人”时，应切回普通 Chrome（VNC）完成验证。保留 Cookie 不等于网站仍接受会话，也不能用 Chrome 右上角的账号头像代替当前网页登录证明。

未绑定或未人工确认的状态分别展示，不再用“登录待验证/最近检测”暗示VNC后台在检测。单独操作桌面仍使用实例卡片的“打开桌面”。Google登录弹窗只保留“取消”和“打开VNC登录”，且显示固定绑定邮箱。

Chrome 的 `Default`、`Network`、Cookies等目录/文件只表明本地配置或站点数据存在，不能可靠判断当前Google登录身份或服务端会话是否有效。平台在VNC模式不扫描这些文件来宣称登录成功。Google网站登录与Chrome自身的账户同步不同，右上角“Sign in to Chrome”提示不会否定已经完成的网站登录。[Chromium用户目录说明](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md)、[Google对Chrome登录的说明](https://support.google.com/chrome/answer/185277?hl=en)。

既有缺少模式字段的实例保持自动化兼容模式，不会自动迁移。可在实例设置的“浏览器模式”切换；操作会正常关闭 Chrome、创建加密恢复点，再使用同一镜像和持久目录启动目标模式。关闭或备份失败会停留当前数据并提示检查，不强制结束或自动恢复旧数据。VNC 模式的 DOM 任务、Cookies/storage-state导入导出和依赖 Playwright 的版本更新停用；完整文件快照与恢复仍可用。VNC 无法判断下载是否完成，因此不自动执行空闲关闭，请手动停止。

VNC 和自动化模式均已移除 Google 分步填写、身份轮询及账户页主动检测，登录和验证由用户在实例桌面完成。Google 若显示“浏览器或应用可能不安全”，不能据此确认已登录；切换普通 Chrome 也不保证 Google 接受登录，仍需人工核对。

## 人工接管信息

有人工接管会话时，工作台顶部以一个大面板显示全部记录。条目之间没有外部间距，用细线分隔；每条保留实例名称、到期时间及“进入桌面”“内嵌桌面”“结束人工接管”操作。窄屏下按钮自动换行，没有活动会话时隐藏整个面板。

## Google 关联平台与人工确认

在「平台管理」保存平台名称、首页、登录入口和账户设置页地址。Google 内置配置保留；其他平台可新增、编辑、停用，无关联时可删除。

以下地址可作为普通平台配置示例，通过管理页面或 `POST /api/v1/platforms` 保存；它们不是安装时自动创建的内置平台。

| 平台 | 首页 | 登录入口 | 账户设置页 |
| --- | --- | --- | --- |
| Bilibili | `https://www.bilibili.com/` | `https://passport.bilibili.com/login` | `https://account.bilibili.com/account/home` |
| GitHub | `https://github.com/` | `https://github.com/login` | `https://github.com/settings/profile` |

进入浏览器实例详情的「账号状态」，登记通过此 Google 首次创建的平台账户。在此实例桌面中自行访问登录入口并完成登录，再点击平台行的「确认已登录」，填写唯一账号 ID（或邮箱）和昵称，勾选已核对账号后保存。已有 ID 不能直接改成其他账号；更换时先解除原关联。人工确认只更新记录、操作者及时间，保留浏览器模式和当前桌面。VNC 与自动化模式都支持这些操作。

保存后显示“已人工确认登录”和确认时间，按钮变为“更新登录确认”。再次确认时账号 ID 只读，可更新昵称并刷新确认时间。

账号管理中展开「关联平台」可只读查看同一份记录，平台确认集中在浏览器实例详情。没有账号自动检测按钮、后台轮询或升级后的账户页校验；旧结果只保留为历史。解除关联仅移除管理记录，不操作网站或注销账号。

也可以直接在“账号管理”右上角点击“新增账号”，填写已有账号的邮箱、密码和选填辅助邮箱。每行“编辑账号”可修改保存的密码和辅助邮箱；密码留空保留原值，辅助邮箱可清空。邮箱是账号标识，添加其他邮箱请新增账号。账号行的密码可点击“查看”，支持复制和隐藏；切换页面、筛选移除该行或切到后台会清除已显示密码。修改这里只更新本系统登录资料；Google网站密码须先在Google修改，再到此同步。

还可以在宿主机导入账号清单，支持`account.txt`或`accounts.txt`等文件名，每行是`邮箱<TAB>密码<TAB>备用邮箱`。建议放在已被 Git 忽略的项目 `secrets/accounts.txt` 中。从项目根目录执行（需要Node24和已构建产物）：

```bash
node apps/control-plane/dist/import-google-accounts.js ./secrets/accounts.txt
```

该文件只是显式导入时读取的源文件；平台启动和日常运行读取 SQLite 账号目录及加密 vault，不会自动读取或监视 txt。因此移动文件无需修改读取代码，也不影响已导入账号。网页编辑不回写源文件；再次执行上面的导入命令会以文件中的密码覆盖同邮箱当前保存的密码，并新增其他邮箱，不会自动删除清单中已移除的旧账号，也不会改变已有实例绑定。

新增和导入本身不会创建实例、登录或绑定。VNC 登录流程仅使用目录邮箱与辅助邮箱，不读取网站密码；管理员可独立在账号页主动查看密码。密码用平台主密钥加密存入vault，普通账号清单API与保存响应或MCP不返回密码，不放入网页任务；查看接口单独校验管理员权限和Web CSRF，每次记录无密码审计且不缓存。重复导入同一邮箱更新加密凭证，不增加重复条目。源文件仍包含明文秘密，权限为 `0600`，项目 `secrets/` 目录为 `0700`；整个目录已从 Git 和 Docker 构建上下文排除，不应复制到日志、提示词或镜像。
