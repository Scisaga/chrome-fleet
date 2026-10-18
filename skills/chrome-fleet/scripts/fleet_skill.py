#!/usr/bin/env python3
"""Install and connect the Chrome Fleet skill. Python 3.10+, standard library only."""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
from dataclasses import asdict, dataclass, fields
import json
import os
from pathlib import Path, PurePosixPath
import queue
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit

REVISION = "7f0d20728dc359eac347d96f387f1a7d419e07d8"
BUNDLE = Path(__file__).resolve().parent.parent
MAX_MESSAGE = 16 * 1024 * 1024


class SkillError(Exception):
    """A diagnostic safe to display without command output or credential values."""


def checked_name(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", value):
        raise SkillError("连接名称仅支持字母、数字、下划线和连字符，长度 1–64。")
    return value


def host_path(value: str) -> str:
    path = PurePosixPath(value)
    if not path.is_absolute() or ".." in path.parts or any(ord(c) < 32 for c in value):
        raise SkillError("服务端路径必须是无控制字符、无 .. 的绝对 Linux 路径。")
    return str(path)


@dataclass(frozen=True)
class Connection:
    name: str = "chrome-fleet"
    target: str = "local"
    ssh_host: str | None = None
    repo_dir: str = "/opt/chrome-fleet"
    data_root: str = "/var/lib/chrome-fleet"
    port: int = 8080
    token_file: str = "/run/secrets/admin-token"
    public_url: str = "http://127.0.0.1:8080"
    cookie_secure: bool = False
    allowed_origins: tuple[str, ...] = ()
    version: int = 1

    def __post_init__(self):
        checked_name(self.name)
        if self.version != 1 or self.target not in ("local", "ssh"):
            raise SkillError("不支持的连接配置版本或部署目标。")
        if type(self.port) is not int or not 1 <= self.port <= 65535:
            raise SkillError("端口必须是 1–65535 的整数。")
        for value in (self.repo_dir, self.data_root, self.token_file):
            host_path(value)
        if self.target == "ssh" and (not isinstance(self.ssh_host, str) or not re.fullmatch(
                r"[A-Za-z0-9_][A-Za-z0-9_.@:\-]*", self.ssh_host)):
            raise SkillError("请提供已配置的 SSH 别名或 user@host，不要包含选项、空格或密码。")
        if self.target == "local" and self.ssh_host:
            raise SkillError("本机目标不能设置 SSH 主机。")
        if type(self.cookie_secure) is not bool:
            raise SkillError("无效的 Cookie 配置。")
        for origin in (self.public_url, *self.allowed_origins):
            try:
                url = urlsplit(origin)
                valid = (url.scheme in ("http", "https") and url.hostname and not url.username
                         and not url.password and url.path in ("", "/") and not url.query
                         and not url.fragment and url.port != 0)
            except (ValueError, TypeError):
                valid = False
            if not valid:
                raise SkillError("管理入口必须是不含凭据、查询参数的 HTTP(S) 来源。")

    @classmethod
    def from_dict(cls, data: dict) -> Connection:
        try:
            if not isinstance(data, dict) or set(data) - {f.name for f in fields(cls)}:
                raise ValueError()
            data = dict(data)
            origins = data.get("allowed_origins", [])
            if not isinstance(origins, (list, tuple)) or not all(isinstance(x, str) for x in origins):
                raise ValueError()
            data["allowed_origins"] = tuple(origins)
            return cls(**data)
        except (TypeError, ValueError):
            raise SkillError("连接文件格式错误；请重新运行 setup。") from None


def state_path(name: str) -> Path:
    return Path.home() / ".chrome-fleet" / "skill" / (checked_name(name) + ".json")


def load_connection(name: str) -> Connection:
    try:
        path = state_path(name)
        if path.stat().st_size > 65536:
            raise ValueError()
        connection = Connection.from_dict(json.loads(path.read_text(encoding="utf-8")))
        if connection.name != name:
            raise ValueError()
        return connection
    except (OSError, ValueError):
        raise SkillError("未找到有效连接；请先运行 setup。") from None


def save_connection(connection: Connection):
    path = state_path(connection.name)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, filename = tempfile.mkstemp(prefix=".connection-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(asdict(connection), output, ensure_ascii=False, indent=2)
            output.write("\n")
        os.replace(filename, path)
    finally:
        if os.path.exists(filename):
            os.unlink(filename)


@contextmanager
def connection_lock(name: str):
    """Serialize this user's setups; OS releases the lock after a crash."""
    directory = state_path(name).parent
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / ("." + name + ".lock")).open("a+b") as stream:
        if os.name == "nt":
            import msvcrt
            if stream.seek(0, 2) == 0:
                stream.write(b"\0")
                stream.flush()
            stream.seek(0)
            try:
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                raise SkillError("同名连接的 setup 正在运行；请等待完成。") from None
            try:
                yield
            finally:
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            try:
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                raise SkillError("同名连接的 setup 正在运行；请等待完成。") from None
            try:
                yield
            finally:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def executable(name: str) -> str:
    found = shutil.which(name)
    if not found:
        raise SkillError(f"缺少客户端命令 {name}；请先安装并确保它在 PATH 中。")
    return str(Path(found).absolute())


def ssh_base(connection: Connection) -> list[str]:
    return [executable("ssh"), "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
            "-o", "ConnectTimeout=15", "--", connection.ssh_host or ""]


def target_command(connection: Connection, argv: list[str], *, root: bool = True) -> list[str]:
    if connection.target == "ssh":
        command = shlex.join(argv)
        if root:
            command = ('if [ "$(id -u)" -eq 0 ]; then exec ' + command
                       + "; else exec sudo -n -- " + command + "; fi")
        return [*ssh_base(connection), command]
    if sys.platform != "linux":
        raise SkillError("本机部署需要 Linux；macOS 和原生 Windows 请使用 --target ssh。")
    if root and os.geteuid() != 0:
        return [executable("sudo"), "-n", "--", *argv]
    return argv


def run_quiet(argv: list[str], *, input: bytes | None = None, timeout: int = 60,
              cwd: Path | None = None) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(argv, input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=timeout, cwd=cwd)
    except (OSError, subprocess.TimeoutExpired):
        raise SkillError("命令无法执行或超时；请检查客户端、SSH 连接和免交互 sudo。") from None


def host_error(result: dict) -> SkillError:
    error = result.get("error", {})
    if not isinstance(error, dict):
        return SkillError("主机未返回有效诊断；请检查 SSH 启动输出。")
    code = error.get("code", "HOST_FAILED")
    code = code if isinstance(code, str) and re.fullmatch(r"[A-Za-z_0-9]{1,80}", code) else "HOST_FAILED"
    message = error.get("message", "主机操作失败。")
    if not isinstance(message, str) or len(message) > 1000:
        message = "主机操作失败。"
    return SkillError(f"{code}: {message}")


def run_host(connection: Connection, action: str, runtime: bool = False) -> dict:
    # Git on Windows may check shell scripts out with CRLF. The remote POSIX
    # shell must receive LF even when this bundle was installed on Windows.
    bootstrap = (BUNDLE / "scripts" / "host_bootstrap.sh").read_bytes().replace(b"\r\n", b"\n")
    print("检查服务主机前置条件。", file=sys.stderr, flush=True)
    preflight = run_quiet(target_command(connection, ["sh", "-s", "--", "setup" if action == "setup" else "check"]),
                          input=bootstrap, timeout=600)
    if preflight.returncode:
        try:
            diagnostic = json.loads(preflight.stdout)
        except (ValueError, UnicodeError):
            diagnostic = None
        if isinstance(diagnostic, dict) and diagnostic.get("ok") is False:
            raise host_error(diagnostic)
        raise SkillError("主机预检失败：需要受支持的 Linux amd64、Python 3.10+ 和 root/免交互 sudo。"
                         " SSH 目标还需预配置密钥及主机信任记录。")
    config = {key: getattr(connection, key) for key in ("repo_dir", "data_root", "port", "token_file")}
    config.update(revision=REVISION, runtime=runtime)
    encoded = base64.b64encode(json.dumps(config).encode()).decode("ascii")
    source = (BUNDLE / "scripts" / "fleet_host.py").read_bytes()
    # Long builds remain visible without exposing raw command or credential output.
    process = subprocess.Popen(target_command(connection, ["python3", "-", action, encoded]),
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None)
    try:
        stdout, _ = process.communicate(source, timeout=7200 if action == "setup" else 900)
    except (subprocess.TimeoutExpired, KeyboardInterrupt):
        stop_child(process)
        raise SkillError("主机操作中断；数据已保留，请诊断后重新运行 setup。") from None
    try:
        result = json.loads(stdout)
    except (ValueError, UnicodeError):
        raise SkillError("主机未返回有效结果；检查 SSH 启动脚本是否向 stdout 打印了内容。") from None
    if not isinstance(result, dict):
        raise SkillError("主机未返回有效结果；请检查 SSH 启动输出。")
    if process.returncode or result.get("ok") is not True:
        raise host_error(result)
    return result


def bridge_command(connection: Connection) -> list[str]:
    argv = ["env", "-u", "DOCKER_CONTEXT", "-u", "COMPOSE_PROJECT_NAME", "-u", "COMPOSE_FILE", "-u", "COMPOSE_PROFILES",
            "docker", "--host", "unix:///var/run/docker.sock", "compose", "--project-name", "chrome-fleet",
            "--project-directory", connection.repo_dir,
            "-f", str(PurePosixPath(connection.repo_dir) / "compose.yaml"),
            "exec", "-T", "-e", "FLEET_URL=http://127.0.0.1:8080",
            "-e", "FLEET_TOKEN_FILE=" + connection.token_file,
            "control-plane", "node", "/app/apps/mcp-bridge/dist/stdio.js"]
    return target_command(connection, argv)


def stop_child(process: subprocess.Popen):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    if process.stdin is not None and not process.stdin.closed:
        try:
            process.stdin.close()
        except OSError:
            pass


def close_reader(process: subprocess.Popen, reader: threading.Thread):
    reader.join(timeout=2)
    if process.stdout is not None and not reader.is_alive():
        process.stdout.close()


def read_messages(stream, output: queue.Queue):
    try:
        while True:
            line = stream.readline(MAX_MESSAGE + 1)
            if not line:
                break
            if len(line) > MAX_MESSAGE:
                raise ValueError()
            item = json.loads(line)
            if not isinstance(item, dict) or item.get("jsonrpc") != "2.0":
                raise ValueError()
            output.put((line, item))
    except (ValueError, OSError, UnicodeError):
        output.put(SkillError("MCP stdout 含非协议内容；检查 SSH 启动输出和服务版本。"))
    finally:
        output.put(None)


def probe(connection: Connection):
    """Read-only MCP initialize, tool discovery and authorized profile listing; discard account data."""
    process = subprocess.Popen(bridge_command(connection), stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    messages: queue.Queue = queue.Queue()
    reader = threading.Thread(target=read_messages, args=(process.stdout, messages), daemon=True)
    reader.start()

    def send(message):
        try:
            process.stdin.write(json.dumps(message).encode() + b"\n")
            process.stdin.flush()
        except (OSError, BrokenPipeError):
            raise SkillError("MCP 连接关闭；检查 SSH、容器和服务端凭据文件。") from None

    def request(number, method, params):
        send({"jsonrpc": "2.0", "id": number, "method": method, "params": params})
        deadline = time.monotonic() + 45
        while True:
            try:
                item = messages.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty:
                raise SkillError("MCP 探测超时；检查容器、SSH 和凭据权限。") from None
            if isinstance(item, Exception):
                raise item
            if item is None:
                raise SkillError("MCP 未完成探测；检查容器、SSH 和有效的服务端 Token 文件。")
            response = item[1]
            if response.get("id") == number:
                if "error" in response or not isinstance(response.get("result"), dict):
                    raise SkillError("MCP 请求失败；检查服务兼容性和平台凭据权限。")
                return response["result"]
            if time.monotonic() >= deadline:
                raise SkillError("MCP 探测超时。")

    try:
        request(1, "initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                   "clientInfo": {"name": "chrome-fleet-skill", "version": "1.0.0"}})
        send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        tools = request(2, "tools/list", {})
        names = {tool.get("name") for tool in tools.get("tools", []) if isinstance(tool, dict)}
        if not {"profiles_list", "profiles_get", "jobs_get"}.issubset(names):
            raise SkillError("服务缺少所需 Fleet MCP 工具；不自动升级已有服务。")
        result = request(3, "tools/call", {"name": "profiles_list", "arguments": {"limit": 1}})
        if result.get("isError"):
            raise SkillError("凭据无法读取实例；请提供有效、具有 read 权限的服务端凭据文件。")
    finally:
        if process.stdin:
            process.stdin.close()
        stop_child(process)
        close_reader(process, reader)


def stream_mcp(connection: Connection) -> int:
    process = subprocess.Popen(bridge_command(connection), stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=None)
    messages: queue.Queue = queue.Queue(maxsize=32)
    reader = threading.Thread(target=read_messages, args=(process.stdout, messages), daemon=True)
    reader.start()

    input_closed = threading.Event()

    def pump_input():
        try:
            while True:
                data = sys.stdin.buffer.read1(65536)
                if not data:
                    break
                process.stdin.write(data)
                process.stdin.flush()
        except (BrokenPipeError, OSError, ValueError):
            pass
        finally:
            try:
                process.stdin.close()
            except OSError:
                pass
            input_closed.set()

    threading.Thread(target=pump_input, daemon=True).start()
    previous = {}
    def interrupted(_number, _frame):
        raise KeyboardInterrupt()
    for sig in (signal.SIGINT, signal.SIGTERM):
        previous[sig] = signal.signal(sig, interrupted)
    try:
        eof_deadline = None
        while True:
            if input_closed.is_set():
                eof_deadline = eof_deadline or time.monotonic() + 5
                if time.monotonic() >= eof_deadline:
                    return 0
            try:
                message = messages.get(timeout=1)
            except queue.Empty:
                continue
            if message is None:
                break
            if isinstance(message, Exception):
                raise message
            sys.stdout.buffer.write(message[0])
            sys.stdout.buffer.flush()
        return process.wait(timeout=5)
    finally:
        stop_child(process)
        close_reader(process, reader)
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def clients(value: str) -> tuple[str, ...]:
    return ("codex", "claude") if value == "both" else (value,)


def install_path(client: str) -> Path:
    return Path.home() / (".agents" if client == "codex" else ".claude") / "skills" / "chrome-fleet"


def bundle_files(root: Path) -> dict[str, bytes]:
    return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*")
            if p.is_file() and not any(x in ("__pycache__", "tests") for x in p.relative_to(root).parts)
            and p.suffix != ".pyc"}


def check_install(client: str):
    destination = install_path(client)
    if destination.is_symlink():
        raise SkillError("同名 Skill 是符号链接；请保留原安装并选择手动处理。")
    if destination.exists() and destination.resolve() != BUNDLE:
        if not destination.is_dir() or bundle_files(destination) != bundle_files(BUNDLE):
            raise SkillError("已存在不同内容的 chrome-fleet Skill；请先备份并手动处理，不自动覆盖。")


def install_skill(client: str) -> Path:
    check_install(client)
    destination = install_path(client)
    if not destination.exists():
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(BUNDLE, destination, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "tests"))
    return destination / "scripts" / "fleet_skill.py"


def command_matches(existing: dict, command: str, args: list[str]) -> bool:
    transport = existing.get("transport", existing)
    return (isinstance(transport, dict) and transport.get("type", "stdio") == "stdio" and transport.get("command") == command
            and transport.get("args", []) == args and not transport.get("env")
            and not transport.get("env_vars") and not transport.get("cwd")
            and existing.get("enabled", True) is not False)


def claude_config_path() -> Path:
    custom = os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(custom).expanduser() / ".claude.json" if custom else Path.home() / ".claude.json"


def existing_registration(client: str, cli: str, name: str) -> dict | None:
    if client == "codex":
        result = run_quiet([cli, "mcp", "list", "--json"], cwd=Path.home())
        try:
            entries = json.loads(result.stdout) if result.returncode == 0 else None
            if not isinstance(entries, list):
                raise ValueError()
            if not any(isinstance(x, dict) and x.get("name") == name for x in entries):
                return None
            result = run_quiet([cli, "mcp", "get", name, "--json"], cwd=Path.home())
            entry = json.loads(result.stdout) if result.returncode == 0 else None
            if not isinstance(entry, dict):
                raise ValueError()
            return entry
        except (ValueError, UnicodeError):
            raise SkillError("无法读取 Codex MCP 配置；未写入任何客户端配置。") from None
    try:
        path = claude_config_path()
        data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        servers = data.get("mcpServers", {})
        if not isinstance(servers, dict):
            raise ValueError()
        entry = servers.get(name)
        if entry is not None and not isinstance(entry, dict):
            raise ValueError()
        return entry
    except (ValueError, OSError, AttributeError):
        raise SkillError("无法读取 Claude Code 用户配置；未写入任何客户端配置。") from None


def registration_plan(client: str, name: str, script: Path) -> dict:
    cli = executable(client)
    command = str(Path(sys.executable).resolve())
    args = [str(script.absolute()), "mcp", "--name", name]
    existing = existing_registration(client, cli, name)
    if existing is not None and not command_matches(existing, command, args):
        raise SkillError(f"{client} 已有不同的同名 MCP；请使用 --name 指定其他名称，不自动覆盖。")
    return dict(client=client, cli=cli, name=name, command=command, args=args, exists=existing is not None)


def register(plan: dict):
    # Deployment can take minutes. Re-read immediately before writing rather
    # than overwriting a server added after the initial preflight.
    current = existing_registration(plan["client"], plan["cli"], plan["name"])
    if current is not None and not command_matches(current, plan["command"], plan["args"]):
        raise SkillError(f"{plan['client']} 出现同名 MCP 配置冲突；保留现有配置，未覆盖。")
    if current is None:
        argv = [plan["cli"], "mcp", "add"]
        if plan["client"] == "claude":
            argv += ["--transport", "stdio", "--scope", "user"]
        argv += [plan["name"], "--", plan["command"], *plan["args"]]
        result = run_quiet(argv, cwd=Path.home())
        if result.returncode:
            raise SkillError(f"{plan['client']} 注册失败；连接已保留，修复客户端配置后可重试 setup。")
    current = existing_registration(plan["client"], plan["cli"], plan["name"])
    if current is None or not command_matches(current, plan["command"], plan["args"]):
        raise SkillError(f"{plan['client']} 注册后核验失败；请检查用户配置与客户端版本。")


def setup(args):
    previous = load_connection(args.name) if state_path(args.name).exists() else None
    if previous and (previous.target, previous.ssh_host) != (args.target, args.ssh_host):
        raise SkillError("连接名称已指向其他部署；使用新的 --name，不覆盖原连接。")
    defaults = previous or Connection(target=args.target, ssh_host=args.ssh_host)
    connection = Connection(name=args.name, target=args.target, ssh_host=args.ssh_host,
                            **{key: getattr(args, key) if getattr(args, key) is not None else getattr(defaults, key)
                               for key in ("repo_dir", "data_root", "port", "token_file")})
    if connection.target == "local" and sys.platform != "linux":
        raise SkillError("本机部署需要 Linux；macOS 和原生 Windows 请使用 --target ssh。")
    selected = clients(args.client)
    plans = []
    for client in selected:
        check_install(client)
        plans.append(registration_plan(client, connection.name,
                                       install_path(client) / "scripts" / "fleet_skill.py"))
    if previous:
        identity = ("target", "ssh_host", "repo_dir", "data_root", "port", "token_file")
        if any(getattr(previous, key) != getattr(connection, key) for key in identity):
            raise SkillError("连接名称已指向其他部署；使用新的 --name，不覆盖原连接。")
    result = run_host(connection, "setup")
    if result.get("ready") is not True:
        raise SkillError("SERVICE_NOT_READY: 已识别服务尚未就绪；请先修复控制服务与 Runner，不自动重启已有部署。")
    deployment = result.get("deployment", {})
    allowed = {"repo_dir", "data_root", "port", "public_url", "cookie_secure", "allowed_origins"}
    merged = asdict(connection)
    merged.update({key: deployment[key] for key in allowed if key in deployment})
    connection = Connection.from_dict(merged)
    probe(connection)
    for client in selected:
        install_skill(client)
    save_connection(connection)
    for plan in plans:
        register(plan)
        print(f"{plan['client']}：用户级 MCP 配置成功。")
    print("连接验证成功：MCP 初始化、工具发现及实例读取通过。")
    print("请重新加载客户端会话，再在 /mcp 检查工具是否已加载。当前会话未自动切换。")
    print(f"管理入口：{connection.public_url}；远端桌面转发使用 desktop --name {connection.name}。")


def desktop(connection: Connection) -> int:
    if connection.cookie_secure or connection.public_url.startswith("https://"):
        print(f"使用既有 HTTPS 管理入口：{connection.public_url}")
        return 0
    if connection.target == "local":
        print(f"管理入口：{connection.public_url}")
        return 0
    origin = f"http://127.0.0.1:{connection.port}"
    permitted = {"http://127.0.0.1:8080", connection.public_url.rstrip("/"), *connection.allowed_origins}
    if origin not in permitted:
        raise SkillError("转发来源不在服务允许列表中；请使用既有管理入口或显式配置允许来源。")
    with socket.socket() as sock:
        try:
            sock.bind(("127.0.0.1", connection.port))
        except OSError:
            raise SkillError("本地管理端口已占用；请释放该端口或使用既有入口，不自动更换来源端口。") from None
    command = ssh_base(connection)
    # Forward options must precede -- and the hostname.
    command[-2:-2] = ["-N", "-o", "ExitOnForwardFailure=yes", "-L",
                       f"127.0.0.1:{connection.port}:127.0.0.1:{connection.port}"]
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
    previous = {}
    def interrupted(_number, _frame):
        raise KeyboardInterrupt()
    for sig in (signal.SIGINT, signal.SIGTERM):
        previous[sig] = signal.signal(sig, interrupted)
    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise SkillError("SSH 转发未建立；检查密钥、主机信任和服务端端口。")
            try:
                with socket.create_connection(("127.0.0.1", connection.port), timeout=0.5):
                    break
            except OSError:
                time.sleep(0.1)
        else:
            raise SkillError("SSH 转发超时。")
        print(f"管理入口：{origin}；在页面打开目标实例桌面。保持本命令运行，Ctrl+C 结束转发。", flush=True)
        return process.wait()
    finally:
        stop_child(process)
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    install = commands.add_parser("install", help="复制独立 Skill 到当前用户")
    install.add_argument("--client", choices=("codex", "claude", "both"), required=True)
    command = commands.add_parser("setup", help="部署或复用服务并注册用户级 MCP")
    command.add_argument("--client", choices=("codex", "claude", "both"), required=True)
    command.add_argument("--target", choices=("local", "ssh"), required=True)
    command.add_argument("--ssh-host")
    command.add_argument("--name", default="chrome-fleet")
    command.add_argument("--repo-dir", help="服务端源码目录；新连接默认 /opt/chrome-fleet")
    command.add_argument("--data-root", help="服务端数据目录；新连接默认 /var/lib/chrome-fleet")
    command.add_argument("--port", type=int, help="服务端端口；新连接默认 8080")
    command.add_argument("--token-file",
                         help="已有凭据在 control-plane 容器内的文件路径，非 Token 内容")
    for name in ("doctor", "mcp", "desktop"):
        sub = commands.add_parser(name)
        sub.add_argument("--name", default="chrome-fleet")
        if name == "doctor":
            sub.add_argument("--runtime", action="store_true", help="创建并清理临时空白 Chrome 做运行时验收")
    args = parser.parse_args(argv)
    try:
        if args.command == "install":
            for client in clients(args.client):
                check_install(client)
            for client in clients(args.client):
                print(f"{client} Skill：{install_skill(client)}")
            print("安装完成；请从已安装脚本运行 setup，或重新加载客户端发现 Skill。")
        elif args.command == "setup":
            with connection_lock(args.name):
                setup(args)
        else:
            connection = load_connection(args.name)
            if args.command == "mcp":
                return stream_mcp(connection)
            if args.command == "desktop":
                return desktop(connection)
            run_host(connection, "doctor", args.runtime)
            probe(connection)
            print("主机诊断与 MCP 连接验证通过。" + ("临时空白 Chrome 运行时验收通过。" if args.runtime else "未运行真实浏览器验收。"))
        return 0
    except SkillError as error:
        print(str(error), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("操作已中断；服务和已提交任务继续运行。", file=sys.stderr)
        return 130
    except (OSError, ValueError, subprocess.SubprocessError):
        print("操作失败；请检查文件权限、客户端命令和 SSH/容器连接。未输出命令原始内容。", file=sys.stderr)
        return 1


if __name__ == "__main__":
    # Redirected Windows streams otherwise inherit a legacy code page. MCP is
    # UTF-8 and the human diagnostics include Chinese paths and messages.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    if sys.version_info < (3, 10):
        sys.exit("Chrome Fleet Skill 需要 Python 3.10+。")
    raise SystemExit(main())
