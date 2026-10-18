"""Isolated acceptance checks for the distributable Skill (Python stdlib only).

No test contacts a service, installs host packages, or reads real credentials.
Run with: python3 -m unittest discover -s skills/chrome-fleet/tests -v
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


BUNDLE = Path(__file__).resolve().parents[1]
SCRIPT = BUNDLE / "scripts" / "fleet_skill.py"


# These executables model external process boundaries, not deployment internals.
# Their state is always under a TemporaryDirectory and contains no real secrets.
FAKE_EXECUTABLE = r'''#!__PYTHON__
import json, os, pathlib, sys

tool = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
home = pathlib.Path(os.environ['HOME'])
log = home / 'calls.jsonl'
with log.open('a', encoding='utf-8') as stream:
    stream.write(json.dumps({'tool': tool, 'args': args}, ensure_ascii=False) + '\n')
state_path = home / 'fake-clients.json'
state = json.loads(state_path.read_text()) if state_path.exists() else {}

if tool in ('codex', 'claude'):
    client = state.setdefault(tool, {})
    if args[:2] == ['mcp', 'list'] and tool == 'codex':
        print(json.dumps([{'name': name, 'enabled': True, 'transport': value} for name, value in client.items()]))
        sys.exit(0)
    if args[:2] == ['mcp', 'get']:
        name = args[2]
        if name not in client:
            print('No MCP server found', file=sys.stderr)
            sys.exit(1)
        item = client[name]
        if tool == 'codex':
            print(json.dumps({'name': name, 'enabled': True, 'transport': item}))
        else:
            print(name + ':\n  Type: stdio\n  Command: ' + item['command'])
        sys.exit(0)
    if args[:2] == ['mcp', 'add']:
        marker = args.index('--')
        options = args[2:marker]
        if tool == 'codex':
            name = options[0]
        else:
            candidates = [x for x in options if x not in ('--scope', 'user', '--transport', 'stdio')]
            name = candidates[0]
        client[name] = {'type': 'stdio', 'command': args[marker + 1], 'args': args[marker + 2:]}
        state_path.write_text(json.dumps(state), encoding='utf-8')
        if tool == 'claude':
            config_path = home / '.claude.json'
            config = json.loads(config_path.read_text()) if config_path.exists() else {}
            config.setdefault('mcpServers', {})[name] = client[name]
            config_path.write_text(json.dumps(config), encoding='utf-8')
        print('Registered ' + name)
        sys.exit(0)
    print('Unexpected client command', file=sys.stderr)
    sys.exit(23)

if tool == 'ssh':
    if os.environ.get('FAKE_SSH_ERROR'):
        print('Permission denied (publickey).', file=sys.stderr)
        sys.exit(255)
    # ssh sends the final command to a shell on the server. Executing only our
    # fake docker locally exercises remote quoting without making a connection.
    os.execvpe('sh', ['sh', '-c', args[-1]], os.environ)

if tool == 'sudo':
    while args and args[0] in ('-n', '--'):
        args = args[1:]
    os.execvpe(args[0], args, os.environ)

if tool == 'docker':
    if os.environ.get('FAKE_DOCKER_ERROR'):
        print('Control-plane container is unavailable', file=sys.stderr)
        sys.exit(17)
    scenario = os.environ.get('FAKE_MCP_SCENARIO')
    if scenario:
        if scenario == 'noise':
            print('Welcome to a noisy login shell!', flush=True)
        for line in sys.stdin:
            message = json.loads(line)
            method = message.get('method')
            if method == 'notifications/initialized':
                continue
            if method == 'initialize':
                result = {'protocolVersion': '2024-11-05', 'capabilities': {}, 'serverInfo': {'name': 'fixture', 'version': '1'}}
            elif method == 'tools/list':
                names = ['profiles_list', 'profiles_get', 'jobs_get'] if scenario != 'missing_tools' else ['profiles_list']
                result = {'tools': [{'name': name, 'inputSchema': {'type': 'object'}} for name in names]}
            elif method == 'tools/call':
                result = {'isError': scenario == 'permission_denied', 'content': [{'type': 'text', 'text': 'PRIVATE-FIXTURE-ACCOUNT-AND-TOKEN'}]}
            else:
                sys.exit(25)
            print(json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'result': result}), flush=True)
        sys.exit(0)
    sys.stdout.buffer.write(sys.stdin.buffer.read())
    sys.stdout.buffer.flush()
    print('fake bridge closed', file=sys.stderr)
    sys.exit(0)

print('Unexpected executable', file=sys.stderr)
sys.exit(24)
'''


def load_module(script=SCRIPT, name="fleet_skill_under_test"):
    spec = importlib.util.spec_from_file_location(name, script)
    if spec is None or spec.loader is None:
        raise RuntimeError("Skill launcher is missing")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class SkillFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fleet-skill-tests-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "用户 home"
        self.home.mkdir()
        self.bin = self.root / "fake-bin"
        self.bin.mkdir()
        self.work = self.root / "unrelated working directory"
        self.work.mkdir()
        self.env = {
            key: value for key, value in os.environ.items()
            if not key.startswith(("FLEET_", "CHROME_", "CODEX_", "CLAUDE_"))
        }
        self.env.update({
            "HOME": str(self.home),
            "USERPROFILE": str(self.home),
            "PATH": str(self.bin) + os.pathsep + os.environ.get("PATH", ""),
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        if os.name != "nt":
            for tool in ("codex", "claude", "docker", "ssh", "sudo"):
                executable = self.bin / tool
                executable.write_text(FAKE_EXECUTABLE.replace("__PYTHON__", sys.executable), encoding="utf-8")
                executable.chmod(0o755)

    def cli(self, *args, script=SCRIPT, input=None, env=None):
        return subprocess.run(
            [sys.executable, str(script), *args],
            cwd=self.work,
            env=self.env if env is None else env,
            input=input,
            text=True,
            encoding="utf-8",
            capture_output=True,
            timeout=15,
            check=False,
        )

    def connection(self, target="local", **updates):
        value = {
            "version": 1,
            "name": "chrome-fleet",
            "target": target,
            "ssh_host": "test-fleet" if target == "ssh" else None,
            "repo_dir": "/opt/chrome-fleet",
            "data_root": "/var/lib/chrome-fleet",
            "port": 8080,
            "public_url": "http://127.0.0.1:8080",
            "cookie_secure": False,
            "allowed_origins": [],
            "token_file": "/run/secrets/admin-token",
        }
        value.update(updates)
        return value

    def save_connection(self, value):
        directory = self.home / ".chrome-fleet" / "skill"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / (value["name"] + ".json")).write_text(json.dumps(value), encoding="utf-8")

    def calls(self):
        path = self.home / "calls.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def set_client_state(self, value):
        (self.home / "fake-clients.json").write_text(json.dumps(value), encoding="utf-8")
        if "claude" in value:
            (self.home / ".claude.json").write_text(json.dumps({
                "theme": "dark",
                "mcpServers": value["claude"],
            }), encoding="utf-8")


class InstallTests(SkillFixture):
    def test_installed_bundle_runs_without_source_working_directory(self):
        result = self.cli("install", "--client", "both")
        self.assertEqual(result.returncode, 0, result.stderr)
        for parent in (self.home / ".agents" / "skills", self.home / ".claude" / "skills"):
            installed = parent / "chrome-fleet"
            self.assertTrue((installed / "SKILL.md").is_file())
            self.assertTrue((installed / "references").is_dir())
            launcher = installed / "scripts" / "fleet_skill.py"
            self.assertTrue(launcher.is_file())
            help_result = self.cli("--help", script=launcher)
            self.assertEqual(help_result.returncode, 0, help_result.stderr)
            self.assertIn("setup", help_result.stdout)
            self.assertIn("desktop", help_result.stdout)
        self.assertEqual(list((self.home / ".chrome-fleet" / "skill").glob("*.json")), [])
        self.assertFalse(self.calls(), "Installing the Skill must not run Docker, SSH, or client registration")

    def test_install_conflict_preserves_existing_skill_and_other_client(self):
        existing = self.home / ".claude" / "skills" / "chrome-fleet"
        existing.mkdir(parents=True)
        original = "A locally customized skill\n"
        (existing / "SKILL.md").write_text(original, encoding="utf-8")
        result = self.cli("install", "--client", "both")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((existing / "SKILL.md").read_text(), original)
        self.assertFalse((self.home / ".agents" / "skills" / "chrome-fleet").exists())
        self.assertFalse(self.calls())


class ConnectionValidationTests(SkillFixture):
    """Pure client validation can run on Windows, macOS, and Linux unchanged."""

    def setUp(self):
        super().setUp()
        self.module = load_module()

    def test_credentials_cannot_be_embedded_in_connection_metadata(self):
        for update in (
            {"token": "FAKE-PRIVATE-TOKEN"},
            {"password": "FAKE-PRIVATE-PASSWORD"},
            {"public_url": "https://user:FAKE-PRIVATE-PASSWORD@fleet.example.test"},
        ):
            with self.subTest(update_keys=list(update)):
                with self.assertRaises(self.module.SkillError) as failure:
                    self.module.Connection.from_dict(self.connection("ssh", **update))
                self.assertNotIn("FAKE-PRIVATE", str(failure.exception))

    def test_ssh_target_rejects_options_and_preserves_valid_alias(self):
        valid = self.module.Connection.from_dict(self.connection("ssh", ssh_host="fleet-prod"))
        self.assertEqual(valid.ssh_host, "fleet-prod")
        for host in ("-oProxyCommand=anything", "fleet\nanything", "fleet;anything", "fleet host"):
            with self.subTest(host=repr(host)), self.assertRaises(self.module.SkillError):
                self.module.Connection.from_dict(self.connection("ssh", ssh_host=host))

    def test_windows_command_paths_are_compared_as_arguments_without_shell_splitting(self):
        command = r"C:\Program Files\Python\python.exe"
        args = [r"C:\Users\测试 user\.agents\skills\chrome-fleet\scripts\fleet_skill.py", "mcp", "--name", "chrome-fleet"]
        registration = {"type": "stdio", "command": command, "args": list(args)}
        self.assertTrue(self.module.command_matches(registration, command, args))
        self.assertFalse(self.module.command_matches(registration, command + " --unsafe", args))


@unittest.skipIf(os.name == "nt", "Executable fixtures use POSIX shebangs; native Windows needs its own smoke run")
class BridgeTests(SkillFixture):
    @unittest.skipUnless(sys.platform == "linux", "Local service connections require Linux; other clients use SSH")
    def test_local_stdio_preserves_protocol_and_uses_container_token_path(self):
        self.save_connection(self.connection())
        protocol = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n'
        result = self.cli("mcp", input=protocol)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, protocol)
        docker = [entry for entry in self.calls() if entry["tool"] == "docker"]
        self.assertEqual(len(docker), 1)
        self.assertIn("-T", docker[0]["args"])
        self.assertIn("FLEET_TOKEN_FILE=/run/secrets/admin-token", docker[0]["args"])
        self.assertIn("/app/apps/mcp-bridge/dist/stdio.js", docker[0]["args"])

    def test_ssh_stdio_quotes_unicode_and_shell_metacharacters(self):
        marker = self.root / "must-not-exist"
        repo = str(self.root / ("源码 with spaces; touch " + str(marker)))
        self.save_connection(self.connection("ssh", repo_dir=repo))
        protocol = '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'
        result = self.cli("mcp", input=protocol)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, protocol)
        self.assertFalse(marker.exists(), "A repository path must never become shell syntax")
        ssh = next(entry for entry in self.calls() if entry["tool"] == "ssh")
        self.assertIn("-T", ssh["args"])
        self.assertIn("BatchMode=yes", ssh["args"])
        self.assertIn("StrictHostKeyChecking=yes", ssh["args"])
        docker = next(entry for entry in self.calls() if entry["tool"] == "docker")
        self.assertIn(repo, docker["args"])
        self.assertIn(repo + "/compose.yaml", docker["args"])

    def test_ssh_failure_is_reported_without_stdout_noise(self):
        self.save_connection(self.connection("ssh"))
        env = dict(self.env, FAKE_SSH_ERROR="1")
        result = self.cli("mcp", input="", env=env)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertNotIn("Traceback", result.stderr)
        self.assertIn("Permission denied", result.stderr)

    def test_untrusted_ssh_option_is_rejected_before_execution(self):
        self.save_connection(self.connection("ssh", ssh_host="-oProxyCommand=touch pwned"))
        result = self.cli("mcp", input="")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.calls())

    def test_connection_name_cannot_escape_metadata_directory(self):
        result = self.cli("mcp", "--name", "../../outside", input="")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.calls())

    def test_sigterm_closes_adapter_without_stopping_services(self):
        self.save_connection(self.connection("ssh"))
        process = subprocess.Popen(
            [sys.executable, str(SCRIPT), "mcp"], cwd=self.work, env=self.env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        deadline = time.monotonic() + 5
        while not self.calls() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(self.calls(), "The fake bridge did not start")
        process.send_signal(signal.SIGTERM)
        stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 130, stderr)
        self.assertEqual(stdout, "")
        for entry in self.calls():
            self.assertFalse({"stop", "down", "kill", "rm"} & set(entry["args"]))


@unittest.skipIf(os.name == "nt", "Executable fixtures use POSIX shebangs; native Windows needs its own smoke run")
class RegistrationTests(SkillFixture):
    def setUp(self):
        super().setUp()
        self.module = load_module()
        self.environment = mock.patch.dict(os.environ, self.env, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_codex_registration_is_idempotent_and_keeps_other_servers(self):
        unrelated = {"type": "stdio", "command": "other-tool", "args": ["--safe"]}
        self.set_client_state({"codex": {"unrelated": unrelated}})
        plan = self.module.registration_plan("codex", "chrome-fleet", SCRIPT)
        self.module.register(plan)
        self.module.register(self.module.registration_plan("codex", "chrome-fleet", SCRIPT))
        state = json.loads((self.home / "fake-clients.json").read_text())
        self.assertEqual(state["codex"]["unrelated"], unrelated)
        adds = [entry for entry in self.calls() if entry["tool"] == "codex" and entry["args"][:2] == ["mcp", "add"]]
        self.assertEqual(len(adds), 1)
        self.assertIn(str(SCRIPT), state["codex"]["chrome-fleet"]["args"])

    def test_claude_registration_is_user_scoped_and_preserves_other_fields(self):
        unrelated = {"type": "stdio", "command": "other-tool", "args": []}
        self.set_client_state({"claude": {"unrelated": unrelated}})
        plan = self.module.registration_plan("claude", "chrome-fleet", SCRIPT)
        self.module.register(plan)
        self.module.register(self.module.registration_plan("claude", "chrome-fleet", SCRIPT))
        config = json.loads((self.home / ".claude.json").read_text())
        self.assertEqual(config["theme"], "dark")
        self.assertEqual(config["mcpServers"]["unrelated"], unrelated)
        adds = [entry for entry in self.calls() if entry["tool"] == "claude" and entry["args"][:2] == ["mcp", "add"]]
        self.assertEqual(len(adds), 1)
        args = adds[0]["args"]
        self.assertEqual(args[args.index("--scope") + 1], "user")

    def test_conflicting_registration_is_not_overwritten_or_deployed(self):
        secret = "FAKE-TOKEN-that-must-stay-private"
        existing = {"type": "stdio", "command": "different-server", "args": [], "env": {"TOKEN": secret}}
        original = {"codex": {"chrome-fleet": existing}}
        self.set_client_state(original)
        result = self.cli("setup", "--client", "codex", "--target", "ssh", "--ssh-host", "test-fleet")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads((self.home / "fake-clients.json").read_text()), original)
        self.assertNotIn(secret, result.stdout + result.stderr)
        self.assertIn("同名 MCP", result.stderr)
        self.assertFalse(any(entry["tool"] in ("docker", "ssh", "sudo") for entry in self.calls()))
        self.assertEqual(list((self.home / ".chrome-fleet" / "skill").glob("*.json")), [])

    def test_malformed_registration_is_rejected_without_traceback(self):
        self.set_client_state({"codex": {"chrome-fleet": None}})
        result = self.cli("setup", "--client", "codex", "--target", "ssh", "--ssh-host", "test-fleet")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Traceback", result.stderr)
        self.assertFalse(any(entry["tool"] in ("docker", "ssh", "sudo") for entry in self.calls()))

    def test_registration_rechecks_conflict_created_after_preflight(self):
        self.set_client_state({"codex": {}})
        plan = self.module.registration_plan("codex", "chrome-fleet", SCRIPT)
        concurrent = {"codex": {"chrome-fleet": {
            "type": "stdio", "command": "another-server", "args": [],
            "env": {"TOKEN": "FAKE-CONCURRENT-PRIVATE-TOKEN"},
        }}}
        self.set_client_state(concurrent)
        with self.assertRaises(self.module.SkillError) as failure:
            self.module.register(plan)
        self.assertNotIn("FAKE-CONCURRENT", str(failure.exception))
        self.assertEqual(json.loads((self.home / "fake-clients.json").read_text()), concurrent)
        self.assertFalse(any(entry["args"][:2] == ["mcp", "add"] for entry in self.calls()))


@unittest.skipIf(os.name == "nt", "Executable fixtures use POSIX shebangs; native Windows needs its own smoke run")
class WorkflowTests(SkillFixture):
    def setUp(self):
        super().setUp()
        self.module = load_module()
        self.environment = mock.patch.dict(os.environ, self.env, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def main(self, args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result = self.module.main(args)
        return result, stdout.getvalue(), stderr.getvalue()

    def test_failed_probe_does_not_register_or_persist_connection(self):
        host_result = {"ok": True, "existing": True, "ready": True, "deployment": self.connection("ssh")}
        with mock.patch.object(self.module, "run_host", return_value=host_result), \
                mock.patch.object(self.module, "probe", side_effect=self.module.SkillError("MCP probe failed")):
            code, stdout, stderr = self.main(["setup", "--client", "both", "--target", "ssh", "--ssh-host", "test-fleet"])
        self.assertEqual(code, 1)
        self.assertIn("probe failed", stderr)
        self.assertNotIn("配置成功", stdout)
        self.assertFalse(any(entry["args"][:2] == ["mcp", "add"] for entry in self.calls()))
        self.assertEqual(list((self.home / ".chrome-fleet" / "skill").glob("*.json")), [])
        self.assertFalse((self.home / ".agents" / "skills" / "chrome-fleet").exists())

    def test_unready_host_does_not_attempt_mcp_or_client_registration(self):
        host_result = {"ok": True, "existing": True, "ready": False, "deployment": self.connection("ssh")}
        with mock.patch.object(self.module, "run_host", return_value=host_result), \
                mock.patch.object(self.module, "probe") as probe:
            code, stdout, _ = self.main(["setup", "--client", "codex", "--target", "ssh", "--ssh-host", "test-fleet"])
        self.assertEqual(code, 1)
        probe.assert_not_called()
        self.assertNotIn("配置成功", stdout)
        self.assertFalse(any(entry["args"][:2] == ["mcp", "add"] for entry in self.calls()))
        self.assertEqual(list((self.home / ".chrome-fleet" / "skill").glob("*.json")), [])

    def test_successful_setup_saves_nonsecret_metadata_and_independent_launcher(self):
        host_result = {"ok": True, "existing": True, "ready": True, "deployment": self.connection("ssh")}
        with mock.patch.object(self.module, "run_host", return_value=host_result), \
                mock.patch.object(self.module, "probe") as probe:
            code, stdout, stderr = self.main(["setup", "--client", "both", "--target", "ssh", "--ssh-host", "test-fleet"])
        self.assertEqual(code, 0, stderr)
        self.assertEqual(probe.call_count, 1)
        self.assertIn("连接验证成功", stdout)
        self.assertIn("重新加载", stdout)
        metadata = self.home / ".chrome-fleet" / "skill" / "chrome-fleet.json"
        saved = json.loads(metadata.read_text())
        self.assertEqual(saved["token_file"], "/run/secrets/admin-token")
        self.assertFalse({"token", "password", "secret"} & saved.keys())
        state = json.loads((self.home / "fake-clients.json").read_text())
        for client, folder in (("codex", ".agents"), ("claude", ".claude")):
            registered = state[client]["chrome-fleet"]
            expected = str(self.home / folder / "skills" / "chrome-fleet" / "scripts" / "fleet_skill.py")
            self.assertIn(expected, registered["args"])
            self.assertNotIn(str(SCRIPT), registered["args"])

    def test_repeated_discovery_reuses_actual_nondefault_deployment(self):
        actual = self.connection("ssh", repo_dir="/srv/fleet/source", data_root="/srv/fleet/data", port=18080,
                                 public_url="https://fleet.example.test", cookie_secure=True)
        host_result = {"ok": True, "existing": True, "ready": True, "deployment": actual}
        command = ["setup", "--client", "codex", "--target", "ssh", "--ssh-host", "test-fleet"]
        with mock.patch.object(self.module, "run_host", return_value=host_result), \
                mock.patch.object(self.module, "probe"):
            first, _, first_error = self.main(command)
            self.assertEqual(first, 0, first_error)
            second, _, second_error = self.main(command)
        self.assertEqual(second, 0, "Repeating the same discovery must reuse its discovered paths: " + second_error)
        saved = json.loads((self.home / ".chrome-fleet" / "skill" / "chrome-fleet.json").read_text())
        self.assertEqual(saved["repo_dir"], actual["repo_dir"])
        self.assertEqual(saved["port"], actual["port"])

    def test_connection_collision_prevents_host_access_and_keeps_previous_metadata(self):
        previous = self.connection("ssh")
        self.save_connection(previous)
        metadata = self.home / ".chrome-fleet" / "skill" / "chrome-fleet.json"
        original = metadata.read_bytes()
        with mock.patch.object(self.module, "run_host") as host:
            code, _, stderr = self.main(["setup", "--client", "codex", "--target", "ssh", "--ssh-host", "different-fleet"])
        self.assertEqual(code, 1)
        self.assertIn("其他部署", stderr)
        host.assert_not_called()
        self.assertEqual(metadata.read_bytes(), original)
        self.assertFalse(any(entry["args"][:2] == ["mcp", "add"] for entry in self.calls()))

    def test_doctor_runtime_requires_explicit_flag(self):
        self.save_connection(self.connection("ssh"))
        for runtime in (False, True):
            with self.subTest(runtime=runtime), \
                    mock.patch.object(self.module, "run_host", return_value={"ok": True}) as host, \
                    mock.patch.object(self.module, "probe"):
                args = ["doctor"] + (["--runtime"] if runtime else [])
                code, stdout, stderr = self.main(args)
                self.assertEqual(code, 0, stderr)
                self.assertEqual(host.call_args.args[1:], ("doctor", runtime))
                self.assertIn("运行时验收通过" if runtime else "未运行真实浏览器验收", stdout)

    def test_desktop_port_conflict_does_not_start_ssh_or_change_connection(self):
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            port = occupied.getsockname()[1]
            self.save_connection(self.connection("ssh", port=port, public_url=f"http://127.0.0.1:{port}"))
            metadata = self.home / ".chrome-fleet" / "skill" / "chrome-fleet.json"
            original = metadata.read_bytes()
            result = self.cli("desktop")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("已占用", result.stderr)
        self.assertFalse(self.calls())
        self.assertEqual(metadata.read_bytes(), original)

    def test_desktop_reuses_https_management_entry_without_tunnel(self):
        self.save_connection(self.connection("ssh", public_url="https://fleet.example.test", cookie_secure=True))
        result = self.cli("desktop")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("https://fleet.example.test", result.stdout)
        self.assertFalse(self.calls())

    def test_real_probe_discovers_tools_and_discards_account_output(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        connection = self.module.Connection.from_dict(self.connection("ssh"))
        with mock.patch.dict(os.environ, {"FAKE_MCP_SCENARIO": "success"}), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.module.probe(connection)
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), "")
        self.assertEqual(len([entry for entry in self.calls() if entry["tool"] == "docker"]), 1)

    def test_real_probe_rejects_missing_tools_permission_errors_and_stdout_noise(self):
        connection = self.module.Connection.from_dict(self.connection("ssh"))
        for scenario in ("missing_tools", "permission_denied", "noise"):
            with self.subTest(scenario=scenario), \
                    mock.patch.dict(os.environ, {"FAKE_MCP_SCENARIO": scenario}):
                with self.assertRaises(self.module.SkillError) as failure:
                    self.module.probe(connection)
                self.assertNotIn("PRIVATE-FIXTURE", str(failure.exception))
                self.assertNotIn("Welcome", str(failure.exception))


@unittest.skipUnless(sys.platform == "linux", "Host provisioning is supported on Linux only")
class HostSafetyTests(SkillFixture):
    """Exercise host decisions using synthetic command results, never host apt/Docker."""

    def setUp(self):
        super().setUp()
        self.host = load_module(BUNDLE / "scripts" / "fleet_host.py", "fleet_host_under_test")

    def test_client_host_configuration_contract(self):
        client = load_module()
        connection = client.Connection.from_dict(self.connection("ssh"))
        bundle = self.root / "CRLF skill bundle"
        scripts = bundle / "scripts"
        scripts.mkdir(parents=True)
        (scripts / "host_bootstrap.sh").write_bytes(b"#!/bin/sh\r\nexit 0\r\n")
        (scripts / "fleet_host.py").write_bytes(b"# synthetic host source\n")
        process = mock.Mock(returncode=0)
        process.communicate.return_value = (b'{"ok":true,"existing":true,"ready":true,"deployment":{}}', None)
        with mock.patch.object(client, "BUNDLE", bundle), \
                mock.patch.object(client, "target_command", side_effect=lambda connection, args: args), \
                mock.patch.object(client, "run_quiet", return_value=subprocess.CompletedProcess([], 0, b"", b"")) as preflight, \
                mock.patch.object(client.subprocess, "Popen", return_value=process) as launch:
            result = client.run_host(connection, "setup", runtime=True)
        self.assertEqual(preflight.call_args.kwargs["input"], b"#!/bin/sh\nexit 0\n")
        command = launch.call_args.args[0]
        self.assertEqual(command[:3], ["python3", "-", "setup"])
        config = self.host.configuration(command[3])
        self.assertTrue(config["runtime"])
        self.assertEqual(config["revision"], client.REVISION)
        self.assertEqual(config["repo_dir"], connection.repo_dir)
        self.assertEqual(config["token_file"], connection.token_file)
        self.assertTrue(result["ok"])

    def test_package_simulation_refuses_removal_and_runtime_upgrade(self):
        for simulation in (
            "Remv containerd [1.7.0]\n",
            "Inst docker-ce [28.0.0] (29.0.0 Docker:stable [amd64])\n",
            "Inst containerd.io:amd64 [1.7.0] (2.0.0 Docker:stable [amd64])\n",
        ):
            with self.subTest(simulation=simulation), \
                    mock.patch.object(self.host, "installed", return_value=False), \
                    mock.patch.object(self.host, "command", return_value=subprocess.CompletedProcess([], 0, simulation, "")) as command:
                with self.assertRaises(self.host.HostError) as failure:
                    self.host.install_packages(["git"])
                self.assertEqual(failure.exception.code, "APT_UNSAFE_CHANGE")
                self.assertEqual(command.call_count, 1, "The actual apt install must never run after unsafe simulation")
                self.assertIn("-s", command.call_args.args[0])

    def test_existing_packages_are_not_reinstalled_and_missing_packages_are_simulated_first(self):
        with mock.patch.object(self.host, "installed", side_effect=lambda package: package == "git"), \
                mock.patch.object(self.host, "command", return_value=subprocess.CompletedProcess([], 0, "Inst ca-certificates (1 [all])\n", "")) as command:
            self.host.install_packages(["git", "ca-certificates"])
        self.assertEqual(command.call_count, 2)
        simulated, installed = [call.args[0] for call in command.call_args_list]
        self.assertEqual(simulated[1], "-s")
        self.assertNotIn("-s", installed)
        self.assertNotIn("git", installed)
        self.assertIn("--no-upgrade", installed)

    def test_enclosing_network_subnet_is_detected_as_conflict(self):
        network = {"Name": "unrelated", "Labels": {}, "IPAM": {"Config": [{"Subnet": "172.16.0.0/12"}]}}
        self.assertTrue(self.host.network_conflicts([network], False))
        unrelated = {"Name": "unrelated", "Labels": {}, "IPAM": {"Config": [{"Subnet": "192.168.0.0/24"}]}}
        self.assertEqual(self.host.network_conflicts([unrelated], False), [])

    def test_docker_inspection_ignores_ambient_context_and_compose_settings(self):
        injected = {"DOCKER_CONTEXT": "unrelated-context", "COMPOSE_PROJECT_NAME": "unrelated-project",
                    "COMPOSE_FILE": "/unrelated/compose.yaml", "FLEET_TOKEN": "FAKE-PRIVATE-TOKEN"}
        with mock.patch.dict(os.environ, injected), \
                mock.patch.object(self.host, "command", return_value=subprocess.CompletedProcess([], 0, "{}", "")) as command:
            self.host.docker(["info"], check=False)
        args = command.call_args.args[0]
        self.assertEqual(args, ["docker", "--host", "unix:///var/run/docker.sock", "info"])
        environment = command.call_args.kwargs["env"]
        self.assertFalse(set(injected) & environment.keys())
        self.assertEqual(environment["DOCKER_HOST"], "unix:///var/run/docker.sock")

    def test_reuse_performs_no_install_configuration_or_restart(self):
        config = dict(self.connection(), revision=self.host.REVISION, runtime=False)
        result = {"existing": True, "ready": True, "deployment": self.connection(), "conflicts": []}
        with mock.patch.object(self.host, "inspect", return_value=result), \
                mock.patch.object(self.host, "marker_for", return_value=None), \
                mock.patch.object(self.host, "dependencies") as dependencies, \
                mock.patch.object(self.host, "command") as command, \
                mock.patch.object(self.host, "save_marker") as marker:
            reused = self.host.setup(config)
        self.assertTrue(reused["reused"])
        dependencies.assert_not_called()
        command.assert_not_called()
        marker.assert_not_called()

    def test_host_conflict_stops_before_deployment_changes(self):
        config = dict(self.connection(), revision=self.host.REVISION, runtime=False)
        result = {"existing": False, "ready": False, "conflicts": ["Occupied port"], "deployment": self.connection()}
        with mock.patch.object(self.host, "inspect", return_value=result), \
                mock.patch.object(self.host, "marker_for", return_value=None), \
                mock.patch.object(self.host, "dependencies") as dependencies, \
                mock.patch.object(self.host, "save_marker") as marker:
            with self.assertRaises(self.host.HostError) as failure:
                self.host.setup(config)
        self.assertEqual(failure.exception.code, "DEPLOYMENT_CONFLICT")
        dependencies.assert_not_called()
        marker.assert_not_called()

    def test_new_deployment_always_validates_empty_browser_before_marking_complete(self):
        repo, data = self.root / "source", self.root / "data"
        repo.mkdir()
        config = dict(self.connection(), repo_dir=str(repo), data_root=str(data), revision=self.host.REVISION, runtime=False)
        deployment = {"repo_dir": str(repo), "data_root": str(data), "port": 8080}
        inspection = {"existing": False, "ready": False, "conflicts": [], "host": {"os": "ubuntu", "version": "24.04"}, "docker_installed": True}
        success = subprocess.CompletedProcess([], 0, "", "")
        with mock.patch.object(self.host, "inspect", return_value=inspection), \
                mock.patch.object(self.host, "progress"), \
                mock.patch.object(self.host, "marker_for", return_value=None), \
                mock.patch.object(self.host, "dependencies"), \
                mock.patch.object(self.host, "source_status", return_value="ready"), \
                mock.patch.object(self.host, "prepare_source"), \
                mock.patch.object(self.host, "prepare_env"), \
                mock.patch.object(self.host, "install_units"), \
                mock.patch.object(self.host, "command", return_value=success), \
                mock.patch.object(self.host, "docker", return_value=success), \
                mock.patch.object(self.host, "existing_deployment", return_value=(deployment, [], True, True)), \
                mock.patch.object(self.host, "ready", return_value=True), \
                mock.patch.object(self.host, "doctor", side_effect=lambda config, state: state) as doctor:
            result = self.host.setup(config)
        self.assertTrue(doctor.call_args.args[0]["runtime"])
        self.assertTrue(result["runtime_validated"])
        marker = json.loads((data / self.host.MARKER).read_text())
        self.assertTrue(marker["complete"])
        self.assertEqual(marker["stage"], "complete")


if __name__ == "__main__":
    unittest.main()
