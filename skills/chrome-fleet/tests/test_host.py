"""Isolated host tests: Docker, APT, systemd and HTTP never reach the real host."""
from __future__ import annotations

import base64
from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
SPEC = importlib.util.spec_from_file_location("fleet_host_under_test", SCRIPTS / "fleet_host.py")
host = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(host)


def completed(args, stdout="", returncode=0):
    return subprocess.CompletedProcess(args, returncode, stdout, "")


def stat_with_owner(metadata, owner):
    fields = list(metadata)
    fields[4] = owner
    return os.stat_result(fields)


@unittest.skipUnless(sys.platform == "linux", "Service host operations require Linux.")
class HostTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="fleet-host-tests-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.config = host.configuration(base64.b64encode(json.dumps({
            "repo_dir": str(self.root / "source"), "data_root": str(self.root / "data"), "port": 18765,
        }).encode()).decode())
        # CI runs as a regular user. Only root ownership of our isolated marker
        # and lock fixtures is simulated; production ownership checks stay intact.
        self.real_lstat = Path.lstat
        self.real_fstat = os.fstat

        def fixture_lstat(path, *args, **kwargs):
            metadata = self.real_lstat(path, *args, **kwargs)
            if path == Path(self.config["data_root"]) / host.MARKER:
                return stat_with_owner(metadata, 0)
            return metadata

        def fixture_fstat(descriptor):
            metadata = self.real_fstat(descriptor)
            if os.readlink(f"/proc/self/fd/{descriptor}") == str(self.root / "setup.lock"):
                return stat_with_owner(metadata, 0)
            return metadata

        lstat_patch = mock.patch.object(Path, "lstat", fixture_lstat)
        fstat_patch = mock.patch.object(host.os, "fstat", side_effect=fixture_fstat)
        lstat_patch.start()
        fstat_patch.start()
        self.addCleanup(lstat_patch.stop)
        self.addCleanup(fstat_patch.stop)
        self.facts = {"os": "debian", "version": "12", "codename": "bookworm", "architecture": "amd64"}
        self.deployment = {"repo_dir": self.config["repo_dir"], "data_root": self.config["data_root"],
                           "port": self.config["port"], "public_url": "http://127.0.0.1:18765",
                           "cookie_secure": False, "allowed_origins": [], "bind_addresses": ["127.0.0.1"], "running": True}
        self.preflight = {"existing": False, "ready": False, "deployment": self.deployment,
                          "host": self.facts, "docker_installed": True, "docker_running": True,
                          "conflicts": [], "source_status": "absent", "resumable": False}

    def isolate_inspect(self):
        stack = ExitStack()
        stack.enter_context(mock.patch.object(host, "system_facts", return_value=self.facts))
        stack.enter_context(mock.patch.object(host, "existing_deployment", return_value=(None, [], True, True)))
        stack.enter_context(mock.patch.object(host, "route_conflicts", return_value=[]))
        stack.enter_context(mock.patch.object(host, "UNIT_DIR", self.root / "units"))
        stack.enter_context(mock.patch.object(host.socket, "socket"))
        return stack

    def create_marker(self, complete=False, stage="build"):
        Path(self.config["data_root"]).mkdir(parents=True, exist_ok=True)
        host.save_marker(self.config, complete=complete, stage=stage)

    def test_config_client_metadata_is_ignored_and_secret_inputs_rejected(self):
        raw = {"name": "work", "target": "ssh", "ssh_host": "server", "version": 1}
        cfg = host.configuration(base64.b64encode(json.dumps(raw).encode()).decode())
        self.assertNotIn("ssh_host", cfg)
        self.assertEqual(host.configuration(base64.b64encode(b'{"port":80}').decode())["port"], 80)
        for raw in ({"token": "secret-sentinel"}, {"runtime": "false"}, {"repo_dir": "/opt"}, {"port": True},
                    {"token_file": "/run/secrets/../master.key"}, {"revision": "main"}):
            with self.subTest(raw=list(raw)):
                with self.assertRaises(host.HostError):
                    host.configuration(base64.b64encode(json.dumps(raw).encode()).decode())

    def test_symlink_source_and_overlapping_data_paths_rejected(self):
        (self.root / "actual").mkdir()
        (self.root / "linked").symlink_to(self.root / "actual", target_is_directory=True)
        for patch in ({"repo_dir": str(self.root / "linked")}, {"data_root": self.config["repo_dir"] + "/data"}):
            with self.assertRaises(host.HostError):
                host.configuration(base64.b64encode(json.dumps({**self.config, **patch}).encode()).decode())

    def test_invalid_cli_returns_one_sanitized_json_object(self):
        result = subprocess.run([sys.executable, "-", "inspect", "secret-sentinel-not-base64"],
                                input=(SCRIPTS / "fleet_host.py").read_bytes(), capture_output=True)
        payload = json.loads(result.stdout)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(payload["error"]["code"], "INVALID_CONFIG")
        self.assertNotIn(b"secret-sentinel", result.stdout + result.stderr)

    def test_host_setup_lock_is_exclusive_and_preserves_inode(self):
        path = self.root / "setup.lock"
        with mock.patch.object(host, "LOCK_PATH", path):
            with host.setup_lock():
                inode = path.stat().st_ino
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                with self.assertRaises(host.HostError) as error:
                    with host.setup_lock():
                        self.fail("A second setup acquired the host lock.")
                self.assertEqual(error.exception.code, "HOST_SETUP_BUSY")
            self.assertTrue(path.exists())
            with host.setup_lock():
                self.assertEqual(path.stat().st_ino, inode)

    def test_host_setup_lock_rejects_symlink_and_unsafe_permissions(self):
        target = self.root / "target"
        target.touch(mode=0o600)
        path = self.root / "setup.lock"
        path.symlink_to(target)
        with mock.patch.object(host, "LOCK_PATH", path):
            with self.assertRaises(host.HostError) as error:
                with host.setup_lock():
                    self.fail("A symlink was accepted as a setup lock.")
            self.assertEqual(error.exception.code, "UNSAFE_SETUP_LOCK")
            path.unlink()
            path.touch(mode=0o644)
            with self.assertRaises(host.HostError) as error:
                with host.setup_lock():
                    self.fail("An unsafe file was accepted as a setup lock.")
            self.assertEqual(error.exception.code, "UNSAFE_SETUP_LOCK")

    def test_host_setup_lock_rejects_nonroot_owner(self):
        path = self.root / "setup.lock"
        with mock.patch.object(host, "LOCK_PATH", path), mock.patch.object(host.os, "fstat", side_effect=lambda descriptor: stat_with_owner(self.real_fstat(descriptor), 12345)):
            with self.assertRaises(host.HostError) as error:
                with host.setup_lock():
                    self.fail("A non-root owner was accepted as a setup lock.")
            self.assertEqual(error.exception.code, "UNSAFE_SETUP_LOCK")

    def test_install_marker_rejects_nonroot_owner(self):
        self.create_marker()
        with mock.patch.object(Path, "lstat", lambda path, *args, **kwargs: stat_with_owner(self.real_lstat(path, *args, **kwargs), 12345)):
            with self.assertRaises(host.HostError) as error:
                host.marker_for(self.config)
        self.assertEqual(error.exception.code, "UNSAFE_INSTALL_MARKER")

    def test_network_overlap_checks_supernets_and_owned_bridges(self):
        unrelated = {"Name": "vpn", "IPAM": {"Config": [{"Subnet": "172.16.0.0/12"}]}}
        self.assertTrue(host.network_conflicts([unrelated], False))
        own = {"Name": "chrome-fleet-control", "Labels": {"com.docker.compose.project": "chrome-fleet"},
               "IPAM": {"Config": [{"Subnet": "172.30.0.0/24"}]}}
        self.assertEqual(host.network_conflicts([own], True), [])
        self.assertTrue(host.network_conflicts([own], False))

    def test_host_routes_detect_vpn_overlap_and_ignore_default(self):
        routes = [{"dst": "default", "dev": "eth0"}, {"dst": "172.16.0.0/12", "dev": "tun0"}]
        with mock.patch.object(host.shutil, "which", return_value="/sbin/ip"), mock.patch.object(host, "command", return_value=completed([], json.dumps(routes))) as command:
            self.assertTrue(host.route_conflicts([], False))
            self.assertEqual(command.call_args.args[0], ["ip", "-j", "-4", "route", "show", "table", "all"])
        with mock.patch.object(host.shutil, "which", return_value="/sbin/ip"), mock.patch.object(host, "command", return_value=completed([], json.dumps(routes[:1]))):
            self.assertEqual(host.route_conflicts([], False), [])

    def test_host_routes_skip_verified_fleet_bridge_only(self):
        network = {"Name": "chrome-fleet-control", "Id": "abcdef012345aaaa",
                   "Labels": {"com.docker.compose.project": "chrome-fleet"}}
        routes = [{"dst": "172.30.0.0/24", "dev": "br-abcdef012345"}]
        with mock.patch.object(host.shutil, "which", return_value="/sbin/ip"), mock.patch.object(host, "command", return_value=completed([], json.dumps(routes))):
            self.assertEqual(host.route_conflicts([network], True), [])
            self.assertTrue(host.route_conflicts([network], False))

    def test_existing_container_requires_expected_labels_mounts_and_source(self):
        source = Path(self.config["repo_dir"])
        (source / "scripts").mkdir(parents=True)
        (source / "scripts/fleet").touch()
        (source / "compose.yaml").touch()
        root = self.config["data_root"]
        container = {"Config": {"Image": "chrome-fleet/control-plane:0.1.0",
                                "Labels": {"com.docker.compose.service": "control-plane", "com.docker.compose.project.working_dir": str(source)},
                                "Env": [f"FLEET_DATA_ROOT={root}", "FLEET_PUBLIC_URL=https://fleet.example.test", "FLEET_COOKIE_SECURE=true"]},
                     "Mounts": [{"Source": root, "Destination": root, "Type": "bind"},
                                {"Source": root + "/secrets", "Destination": "/run/secrets", "RW": False}],
                     "HostConfig": {"PortBindings": {"8080/tcp": [{"HostPort": "18765", "HostIp": "127.0.0.1"}]}},
                     "State": {"Running": True}}

        def fake_docker(args, **kwargs):
            if args[0] == "info": return completed(args, '{"SecurityOptions":[]}')
            if args[:2] == ["network", "ls"]: return completed(args, "")
            if args[0] == "ps": return completed(args, "ctl\n")
            if args[0] == "inspect": return completed(args, json.dumps([container]))
            raise AssertionError(args)

        with mock.patch.object(host.shutil, "which", return_value="/usr/bin/docker"), mock.patch.object(host, "docker", side_effect=fake_docker):
            deployment, _, _, _ = host.existing_deployment()
            self.assertEqual(deployment["public_url"], "https://fleet.example.test")
            self.assertTrue(deployment["cookie_secure"])
            self.assertNotIn("Env", deployment)
            container["Mounts"][1]["RW"] = True
            with self.assertRaisesRegex(host.HostError, "credential mount"):
                host.existing_deployment()

    def test_rootless_docker_is_rejected(self):
        with mock.patch.object(host.shutil, "which", return_value="docker"), mock.patch.object(host, "docker", return_value=completed([], '{"SecurityOptions":["name=rootless"]}')):
            with self.assertRaises(host.HostError) as error:
                host.existing_deployment()
        self.assertEqual(error.exception.code, "ROOTLESS_UNSUPPORTED")

    def test_existing_setup_never_installs_initializes_or_restarts(self):
        inspection = {**self.preflight, "existing": True, "ready": False}
        with mock.patch.object(host, "inspect", return_value=inspection), mock.patch.object(host, "dependencies") as dependencies, mock.patch.object(host, "command") as command:
            result = host.setup(self.config)
            self.assertTrue(result["reused"])
            self.assertFalse(result["ready"])
            dependencies.assert_not_called()
            command.assert_not_called()

    def test_complete_marker_with_missing_containers_does_not_restart(self):
        self.create_marker(complete=True, stage="complete")
        with self.isolate_inspect(), mock.patch.object(host, "dependencies") as dependencies:
            result = host.inspect(self.config)
            self.assertTrue(any("completed deployment" in value for value in result["conflicts"]))
            with self.assertRaises(host.HostError):
                host.setup(self.config)
            dependencies.assert_not_called()

    def test_conflicting_systemd_unit_stops_before_any_install(self):
        units = self.root / "units"
        units.mkdir()
        unknown = units / "chrome-fleet.service"
        unknown.write_text("ExecStart=/another/service\n")
        with self.isolate_inspect(), mock.patch.object(host, "dependencies") as dependencies:
            with self.assertRaises(host.HostError):
                host.setup(self.config)
            dependencies.assert_not_called()
        self.assertEqual(unknown.read_text(), "ExecStart=/another/service\n")

    def test_existing_env_is_not_overwritten_or_modified_before_conflict(self):
        source = Path(self.config["repo_dir"])
        source.mkdir()
        (source / ".env").write_text("FLEET_PORT=9999\n")
        with self.isolate_inspect(), mock.patch.object(host, "source_status", return_value="ready"), mock.patch.object(host, "dependencies") as dependencies:
            with self.assertRaises(host.HostError):
                host.setup(self.config)
            dependencies.assert_not_called()
        self.assertEqual((source / ".env").read_text(), "FLEET_PORT=9999\n")

    def test_apt_simulation_refuses_removal_or_existing_runtime_upgrade(self):
        for simulation in ("Remv unrelated-package [1.0]\n", "Inst containerd.io [1.6.0] (2.0.0 Docker [amd64])\n",
                           "Inst docker-ce:amd64 [28.0] (29.0 Docker [amd64])\n"):
            calls = []

            def fake(args, **kwargs):
                calls.append(args)
                return completed(args, simulation)

            with self.subTest(simulation=simulation), mock.patch.object(host, "installed", return_value=False), mock.patch.object(host, "command", side_effect=fake):
                with self.assertRaises(host.HostError) as error:
                    host.install_packages(["python3"])
                self.assertEqual(error.exception.code, "APT_UNSAFE_CHANGE")
                self.assertEqual(len(calls), 1)
                self.assertEqual(calls[0][:2], ["apt-get", "-s"])

    def test_safe_apt_install_only_missing_packages_after_simulation(self):
        calls = []

        def fake(args, **kwargs):
            calls.append(args)
            return completed(args, "Inst git (2.39 Debian [amd64])\n")

        with mock.patch.object(host, "installed", side_effect=lambda name: name == "python3"), mock.patch.object(host, "command", side_effect=fake):
            host.install_packages(["python3", "git"])
        self.assertEqual(len(calls), 2)
        self.assertIn("-s", calls[0])
        self.assertNotIn("-s", calls[1])
        self.assertEqual(calls[1][-1], "git")
        self.assertNotIn("python3", calls[1])

    def test_partial_git_init_with_marker_can_resume_missing_origin(self):
        source = Path(self.config["repo_dir"])
        source.mkdir()
        subprocess.run(["git", "init", str(source)], capture_output=True, check=True)
        self.assertEqual(host.source_status(source, host.REVISION, allow_partial=True), "partial")
        self.assertEqual(host.source_status(source, host.REVISION, allow_partial=False), "conflict")
        calls = []

        def fake(args, **kwargs):
            calls.append(args)
            if args[3:6] == ["remote", "get-url", "origin"]:
                return completed(args, returncode=1)
            if "rev-parse" in args:
                return completed(args, host.REVISION + "\n")
            return completed(args)

        with mock.patch.object(host, "command", side_effect=fake):
            host.prepare_source(self.config, "partial")
        self.assertTrue(any(args[3:6] == ["remote", "add", "origin"] for args in calls))
        self.assertTrue(any("fetch" in args for args in calls))

    def test_doctor_is_read_only_unless_runtime_explicit(self):
        inspection = {**self.preflight, "existing": True, "ready": True}
        with mock.patch.object(host, "inspect", return_value=inspection), mock.patch.object(host, "ready", return_value=True), mock.patch.object(host, "command", return_value=completed([])) as command:
            host.doctor(self.config)
            self.assertNotIn("--runtime", command.call_args.args[0])
            host.doctor({**self.config, "runtime": True})
            self.assertIn("--runtime", command.call_args.args[0])

    def test_interrupted_own_install_retries_and_always_validates_browser(self):
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(host, "inspect", return_value=self.preflight))
            stack.enter_context(mock.patch.object(host, "dependencies"))
            stack.enter_context(mock.patch.object(host, "source_status", return_value="ready"))
            stack.enter_context(mock.patch.object(host, "prepare_source"))
            stack.enter_context(mock.patch.object(host, "prepare_env"))
            stack.enter_context(mock.patch.object(host, "install_units"))
            stack.enter_context(mock.patch.object(host, "command", return_value=completed([])))
            docker = stack.enter_context(mock.patch.object(host, "docker", side_effect=host.HostError("BUILD_FAILED", "Build failed.")))
            with self.assertRaises(host.HostError):
                host.setup(self.config)
            self.assertEqual(host.marker_for(self.config)["stage"], "build")
            preserved = Path(self.config["data_root"]) / "preserved-data"
            preserved.write_text("do-not-delete")
            docker.side_effect = None
            docker.return_value = completed([])
            stack.enter_context(mock.patch.object(host, "existing_deployment", return_value=(self.deployment, [], True, True)))
            stack.enter_context(mock.patch.object(host, "ready", return_value=True))
            doctor = stack.enter_context(mock.patch.object(host, "doctor", side_effect=lambda cfg, result: result))
            result = host.setup(self.config)
            self.assertTrue(result["runtime_validated"])
            self.assertTrue(doctor.call_args.args[0]["runtime"])
            self.assertTrue(host.marker_for(self.config)["complete"])
            self.assertEqual(preserved.read_text(), "do-not-delete")

    def test_unit_installation_never_overwrites_unknown_unit(self):
        units = self.root / "units"
        units.mkdir()
        target = units / "chrome-fleet-firewall.service"
        target.write_text("unrelated")
        with mock.patch.object(host, "UNIT_DIR", units), mock.patch.object(host, "command") as command:
            with self.assertRaises(host.HostError):
                host.install_units(Path(self.config["repo_dir"]))
            command.assert_not_called()
        self.assertEqual(target.read_text(), "unrelated")


@unittest.skipIf(os.name == "nt", "The service-host bootstrap requires a POSIX shell.")
class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="fleet-bootstrap-tests-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.os_release = self.root / "os-release"
        self.os_release.write_text('ID=debian\nVERSION_ID="12"\n')
        self.systemd = self.root / "systemd"
        self.systemd.mkdir()
        self.script = self.root / "bootstrap.sh"
        self.script.write_text((SCRIPTS / "host_bootstrap.sh").read_text().replace("/etc/os-release", str(self.os_release)).replace("/run/systemd/system", str(self.systemd)))
        self.executable("uname", '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n')
        self.executable("id", "#!/bin/sh\necho 0\n")
        (self.bin / "awk").symlink_to(shutil.which("awk"))
        self.executable("apt-get", '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FLEET_TEST_APT_LOG"\ncase "$1" in -s) printf "%s\\n" "$FLEET_TEST_APT_SIM";; install) printf "#!/bin/sh\\nexit 0\\n" > "$FLEET_TEST_PYTHON"; /bin/chmod +x "$FLEET_TEST_PYTHON";; esac\n')
        self.env = {"PATH": str(self.bin), "FLEET_TEST_APT_LOG": str(self.root / "apt.log"),
                    "FLEET_TEST_APT_SIM": "Inst python3 (3.11 Debian [amd64])", "FLEET_TEST_PYTHON": str(self.bin / "python3")}

    def executable(self, name, source):
        path = self.bin / name
        path.write_text(source)
        path.chmod(0o755)

    def run_script(self, action):
        result = subprocess.run(["/bin/sh", str(self.script), action], env=self.env, capture_output=True, text=True)
        return result, json.loads(result.stdout)

    def test_existing_python_check_is_non_mutating(self):
        self.executable("python3", "#!/bin/sh\nexit 0\n")
        result, payload = self.run_script("check")
        self.assertEqual(result.returncode, 0)
        self.assertFalse(payload["installed"])
        self.assertFalse((self.root / "apt.log").exists())

    def test_check_missing_python_reports_without_installing(self):
        result, payload = self.run_script("check")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(payload["error"]["code"], "PYTHON_MISSING")
        self.assertFalse((self.root / "apt.log").exists())

    def test_setup_does_not_install_python_over_existing_fleet(self):
        self.executable("docker", "#!/bin/sh\necho existing-control-plane\n")
        result, payload = self.run_script("setup")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(payload["error"]["code"], "EXISTING_DEPLOYMENT_REQUIRES_PYTHON")
        self.assertFalse((self.root / "apt.log").exists())

    def test_setup_missing_python_simulates_before_install(self):
        result, payload = self.run_script("setup")
        self.assertEqual(result.returncode, 0)
        self.assertTrue(payload["installed"])
        calls = (self.root / "apt.log").read_text().splitlines()
        self.assertEqual(calls[0], "update")
        self.assertTrue(calls[1].startswith("-s install "))
        self.assertTrue(calls[2].startswith("install "))

    def test_dangerous_simulation_is_sanitized_and_never_installed(self):
        self.env["FLEET_TEST_APT_SIM"] = "Remv unrelated-package [1.0] secret-sentinel"
        result, payload = self.run_script("setup")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(payload["error"]["code"], "APT_UNSAFE_CHANGE")
        self.assertNotIn("secret-sentinel", result.stdout + result.stderr)
        self.assertEqual(len((self.root / "apt.log").read_text().splitlines()), 2)
        self.assertFalse((self.bin / "python3").exists())


if __name__ == "__main__":
    unittest.main()
