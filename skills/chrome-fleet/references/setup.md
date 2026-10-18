# 安装与接入

本 Skill 自包含，可复制到另一台客户端使用；无需在客户端安装 Node.js 或启动额外的 Fleet 服务。入口是 Skill 目录中的 `scripts/fleet_skill.py`。

## 客户端准备

- Python 3.10+，以及要接入的 Codex 或 Claude Code CLI。
- SSH 目标需要 OpenSSH 客户端、已配置的主机别名或地址、密钥或 agent，以及已核实的 `known_hosts` 记录。脚本使用无交互认证，不接受未知主机密钥。
- Linux/WSL 可使用本机或 SSH 目标；macOS 和原生 Windows 使用 SSH Linux 目标。Windows 与 WSL 的用户配置相互独立，分别安装和注册。

以下命令中的 `python3` 可替换为实际 Python 3.10+ 路径；原生 Windows 使用 `py -3`。安装和注册以当前客户端用户运行，不要为了远端部署而把整个客户端安装过程放到 sudo 下。

在源码副本中安装所需客户端的 Skill：

```bash
python3 skills/chrome-fleet/scripts/fleet_skill.py install --client codex
# 或 --client claude / --client both
```

安装位置：Codex 为 `~/.agents/skills/chrome-fleet`，Claude Code 为 `~/.claude/skills/chrome-fleet`。接下来的命令使用已安装副本；Claude Code 用户将下面的 `.agents` 替换成 `.claude`。

## 部署或复用服务

本机 Linux：

```bash
python3 ~/.agents/skills/chrome-fleet/scripts/fleet_skill.py setup --client codex --target local
```

SSH 远端：

```bash
python3 ~/.agents/skills/chrome-fleet/scripts/fleet_skill.py setup --client codex --target ssh --ssh-host fleet-host
```

原生 Windows PowerShell 示例，从解压或检出的源码目录开始：

```powershell
py -3 .\skills\chrome-fleet\scripts\fleet_skill.py install --client codex
py -3 "$HOME\.agents\skills\chrome-fleet\scripts\fleet_skill.py" setup --client codex --target ssh --ssh-host fleet-host
```

Claude Code 使用 `--client claude`；同时注册两个已安装客户端使用 `--client both`。首次部署可能安装系统包、构建镜像并创建服务，因此仅在已授权的服务主机上执行。

新部署支持 Ubuntu 22.04/24.04/26.04 LTS、Debian 12/13 的 amd64 主机，要求 systemd、rootful Docker，以及 root 或免交互 sudo。脚本仅补缺失依赖；Docker 使用官方 APT 源，包模拟若涉及替换、卸载或升级已有 Docker/containerd，则停止并给出诊断。

默认配置：

| 参数 | 默认值与含义 |
| --- | --- |
| `--name` | `chrome-fleet`，本地连接名与 MCP 注册名 |
| `--repo-dir` | `/opt/chrome-fleet`，服务主机上的源码目录 |
| `--data-root` | `/var/lib/chrome-fleet`，与源码分离的数据目录 |
| `--port` | `8080`，默认绑定 `127.0.0.1` |
| `--token-file` | `/run/secrets/admin-token`，control-plane 容器内已有的凭据文件路径 |

新部署锁定经过验证的服务提交，首版为 `7f0d207`。部署使用现有初始化、防火墙和 Compose 流程，并安装 systemd 启动顺序。默认真实验收会创建一个空白 Chrome，检查沙箱、存储和重建能力，完成后清理测试实例，不登录真实账号。

已有部署通过 Compose 身份、挂载和 MCP 探测确认后复用，不初始化、不改 `.env`、不重启、不创建验收浏览器。指定路径与已有安装不一致、端口或网络冲突时，先处理脚本给出的诊断，不自行重建服务或清空数据。失败保留数据和诊断，修复原因后可重试。

## MCP 注册与验证

`setup` 使用官方客户端 CLI 注册当前用户的 stdio 服务，保留其他服务器配置。同名配置一致时复用，不一致时报告冲突。连接元数据保存在 `~/.chrome-fleet/skill/<name>.json`，仅含路径、SSH 别名和端口，不含凭据值。

stdio 桥接在 control-plane 容器中执行。SSH 使用无 TTY 通道，平台 Token 在服务端读取，不复制到客户端；MCP 的 stdout 专用于协议，诊断写入 stderr。关闭客户端不会关闭 Fleet、浏览器或取消已提交任务。

检查输出中的三个状态：配置是否保存、连接探测是否成功、当前客户端会话是否需要重新加载。配置成功不等于当前对话已加载工具；按提示重启客户端或重新加载会话后发现工具。

```bash
python3 ~/.agents/skills/chrome-fleet/scripts/fleet_skill.py doctor --name chrome-fleet
```

`doctor` 默认只诊断；显式添加 `--runtime` 会创建并清理空白验收浏览器。客户端配置启动 `mcp --name chrome-fleet`，日常无需手动运行该命令。

官方注册说明：[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[Claude Code MCP](https://code.claude.com/docs/en/mcp)。

## 管理界面与人工桌面

```bash
python3 ~/.agents/skills/chrome-fleet/scripts/fleet_skill.py desktop --name chrome-fleet
```

按输出地址打开管理页，再选择对应实例的桌面。SSH 转发以前台进程运行，保持终端开启；Ctrl+C 仅结束本次转发。本机服务直接使用管理入口。

转发保持端口、Host 和允许来源匹配；已有 HTTPS 入口优先复用。端口占用或已有入口不适合转发时，按诊断处理，不静默改写服务来源或 Cookie 配置。

管理页登录在用户自己的浏览器中完成，从服务主机安全读取平台令牌；不要让助手读取或输出令牌内容。人工租约绑定平台凭据身份，管理页需使用与该 MCP 连接相同的凭据。自定义 `--token-file` 必须位于既有 `/run/secrets/` 挂载下且在容器中可读；它不是创建新凭据的入口。
