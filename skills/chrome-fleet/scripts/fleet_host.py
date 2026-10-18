#!/usr/bin/env python3
"""Chrome Fleet host operations; send this file to ``python3 - ACTION BASE64_JSON``.

Only the standard library is used. stdout contains one JSON result, never command
output or credentials. inspect is read-only; setup only resumes its own marker.
"""
from __future__ import annotations

import base64
from contextlib import contextmanager
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import shutil
import socket
import stat
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

REVISION = "7f0d20728dc359eac347d96f387f1a7d419e07d8"
REPOSITORY = "https://github.com/Scisaga/chrome-fleet.git"
DOCKER_SOCKET = "unix:///var/run/docker.sock"
SUPPORTED = {"ubuntu": {"22.04", "24.04", "26.04"}, "debian": {"12", "13"}}
UNIT_DIR = Path("/etc/systemd/system")
MARKER = ".chrome-fleet-skill-install.json"
LOCK_PATH = Path("/run/lock/chrome-fleet-skill.lock")
PROTECTED_PACKAGES = {"docker-ce", "docker-ce-cli", "docker.io", "containerd", "containerd.io", "runc", "podman-docker"}


class HostError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def progress(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


@contextmanager
def setup_lock():
    """Serialize host-wide setup; keep the inode after releasing its lock."""
    import fcntl
    descriptor = None
    acquired = False
    try:
        try:
            descriptor = os.open(LOCK_PATH, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        except OSError:
            raise HostError("UNSAFE_SETUP_LOCK", "The host setup lock cannot be opened safely.") from None
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o077:
            raise HostError("UNSAFE_SETUP_LOCK", "The host setup lock must be a root-owned regular file with mode 0600.")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise HostError("HOST_SETUP_BUSY", "Another Chrome Fleet setup is active on this host; wait for it to finish before retrying.") from None
        acquired = True
        yield
    finally:
        if descriptor is not None:
            if acquired:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)


def command(args: list[str], *, cwd: Path | None = None, timeout: int = 60,
            check: bool = True, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        raise HostError("COMMAND_MISSING", "A required host executable is unavailable.") from None
    except subprocess.TimeoutExpired:
        raise HostError("COMMAND_TIMEOUT", "A host operation exceeded its time limit; existing files were preserved.") from None
    if check and result.returncode:
        raise HostError("HOST_COMMAND_FAILED", "A host operation failed; existing files were preserved. Inspect host service logs locally.")
    return result


def docker(args: list[str], **kwargs) -> subprocess.CompletedProcess:
    kwargs.setdefault("env", host_environment())
    return command(["docker", "--host", DOCKER_SOCKET, *args], **kwargs)


def parse_json(text: str, code: str = "INVALID_HOST_RESPONSE"):
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        raise HostError(code, "The host returned an unexpected response.") from None


def safe_directory(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"/[A-Za-z0-9_./-]+", value):
        raise HostError("INVALID_PATH", "Host directories must be absolute paths without spaces or shell metacharacters.")
    path = Path(value)
    if ".." in path.parts or path.resolve() != path or value != str(path):
        raise HostError("UNSAFE_PATH", "Host directories must be canonical paths without symlinks or parent traversal.")
    if value in {"/", "/opt", "/var", "/var/lib", "/etc", "/home", "/root", "/tmp", "/usr", "/run"}:
        raise HostError("UNSAFE_PATH", "A dedicated directory is required.")
    return value


def configuration(encoded: str) -> dict:
    try:
        if len(encoded) > 16000:
            raise ValueError()
        raw = json.loads(base64.b64decode(encoded, validate=True).decode("utf-8"))
        host_keys = {"repo_dir", "data_root", "port", "revision", "runtime", "token_file"}
        client_keys = {"version", "name", "target", "ssh_host", "public_url", "cookie_secure", "allowed_origins"}
        if not isinstance(raw, dict) or set(raw) - host_keys - client_keys:
            raise ValueError()
    except (ValueError, TypeError, UnicodeError):
        raise HostError("INVALID_CONFIG", "Expected a base64-encoded configuration object.") from None
    result = {"repo_dir": "/opt/chrome-fleet", "data_root": "/var/lib/chrome-fleet", "port": 8080,
              "revision": REVISION, "runtime": False, "token_file": "/run/secrets/admin-token",
              **{key: value for key, value in raw.items() if key in host_keys}}
    for key in ("repo_dir", "data_root"):
        result[key] = safe_directory(result[key])
    repo, data = Path(result["repo_dir"]), Path(result["data_root"])
    if repo == data or repo in data.parents or data in repo.parents:
        raise HostError("UNSAFE_PATH", "Source and runtime data directories must be separate.")
    if type(result["port"]) is not int or not 1 <= result["port"] <= 65535:
        raise HostError("INVALID_PORT", "The management port must be between 1 and 65535.")
    if not isinstance(result["revision"], str) or not re.fullmatch(r"[0-9a-f]{40}", result["revision"]):
        raise HostError("INVALID_REVISION", "A complete immutable Git commit is required.")
    if type(result["runtime"]) is not bool:
        raise HostError("INVALID_CONFIG", "runtime must be a boolean.")
    token_file = result["token_file"]
    if not isinstance(token_file, str) or not re.fullmatch(r"/run/secrets/[A-Za-z0-9_.-]+", token_file) or Path(token_file).name in {".", ".."}:
        raise HostError("INVALID_TOKEN_PATH", "The credential path must name a file under the existing /run/secrets mount.")
    return result


def host_environment() -> dict[str, str]:
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("FLEET_", "GIT_CONFIG_")) and key not in {"RUNNER_URL", "CHROME_VERSION", "DOCKER_HOST", "DOCKER_CONTEXT", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_SSL_NO_VERIFY"}}
    env.update({"DOCKER_HOST": DOCKER_SOCKET, "DEBIAN_FRONTEND": "noninteractive", "LC_ALL": "C"})
    return env


def system_facts() -> dict:
    if platform.system() != "Linux" or platform.machine() not in {"x86_64", "amd64"}:
        raise HostError("UNSUPPORTED_HOST", "The service host must be Linux amd64.")
    if os.geteuid() != 0:
        raise HostError("ROOT_REQUIRED", "Run host operations as root or through non-interactive sudo.")
    try:
        entries = {}
        for line in Path("/etc/os-release").read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                key, value = line.split("=", 1)
                entries[key] = value.strip('"\'')
    except OSError:
        raise HostError("UNSUPPORTED_HOST", "Unable to identify the service host operating system.") from None
    distro, version = entries.get("ID", ""), entries.get("VERSION_ID", "")
    if version not in SUPPORTED.get(distro, set()):
        raise HostError("UNSUPPORTED_OS", "Supported hosts: Ubuntu 22.04/24.04/26.04 and Debian 12/13 amd64.")
    if not Path("/run/systemd/system").is_dir() or not shutil.which("systemctl"):
        raise HostError("SYSTEMD_REQUIRED", "A booted systemd service host is required.")
    return {"os": distro, "version": version, "codename": entries.get("VERSION_CODENAME", ""), "architecture": "amd64"}


def read_environment(repo: Path) -> dict[str, str]:
    path = repo / ".env"
    if path.is_symlink():
        raise HostError("UNSAFE_ENV", "The deployment .env must not be a symlink.")
    if not path.exists():
        return {}
    result = {}
    for line in path.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            if key in {"FLEET_DATA_ROOT", "FLEET_PORT", "FLEET_BIND_ADDRESS", "FLEET_PUBLIC_URL", "FLEET_COOKIE_SECURE", "FLEET_ALLOWED_ORIGINS", "CHROME_VERSION"}:
                result[key] = value.strip().strip('"\'')
    return result


def origin(value: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"} or "*" in parsed.netloc or parsed.hostname in {"0.0.0.0", "::"}:
            raise ValueError()
        _ = parsed.port
        return f"{parsed.scheme}://{parsed.netloc}"
    except (ValueError, TypeError):
        raise HostError("INVALID_ORIGIN", "An existing deployment has an invalid access origin; inspect its configuration locally.") from None


def marker_for(config: dict) -> dict | None:
    path = Path(config["data_root"]) / MARKER
    if not path.exists() and not path.is_symlink():
        return None
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o077 or metadata.st_size > 8192:
        raise HostError("UNSAFE_INSTALL_MARKER", "The installation retry marker is unsafe.")
    marker = parse_json(path.read_text(), "INVALID_INSTALL_MARKER")
    expected = {key: config[key] for key in ("repo_dir", "data_root", "port", "revision")}
    if not isinstance(marker, dict) or marker.get("version") != 1 or marker.get("config") != expected:
        raise HostError("INSTALL_CONFIG_MISMATCH", "An interrupted installation belongs to another configuration; preserve its files and inspect it locally.")
    return marker


def source_status(repo: Path, revision: str, *, allow_partial: bool = False) -> str:
    if not repo.exists():
        return "absent"
    if not repo.is_dir() or repo.is_symlink():
        return "conflict"
    if not any(repo.iterdir()):
        return "empty"
    if not shutil.which("git") or not (repo / ".git").is_dir():
        return "conflict"
    remote = command(["git", "-C", str(repo), "remote", "get-url", "origin"], check=False)
    if remote.returncode and allow_partial and set(path.name for path in repo.iterdir()) == {".git"}:
        return "partial"
    if remote.returncode or remote.stdout.strip().removesuffix(".git") != REPOSITORY.removesuffix(".git"):
        return "conflict"
    dirty = command(["git", "-C", str(repo), "status", "--porcelain", "--untracked-files=all"], check=False)
    if dirty.returncode or dirty.stdout.strip():
        return "dirty"
    head = command(["git", "-C", str(repo), "rev-parse", "HEAD"], check=False)
    if head.returncode:
        return "partial" if allow_partial else "conflict"
    return "ready" if head.stdout.strip() == revision else "revision_mismatch"


def ready(deployment: dict) -> bool:
    if not deployment.get("running"):
        return False
    try:
        request = urllib.request.Request(f"http://127.0.0.1:{deployment['port']}/ready",
                                         headers={"Host": urllib.parse.urlsplit(deployment["public_url"]).netloc})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=4) as response:
            data = json.loads(response.read(4096))
            return response.status == 200 and data.get("status") == "ready"
    except (OSError, ValueError, urllib.error.URLError):
        return False


def existing_deployment() -> tuple[dict | None, list[dict], bool, bool]:
    if not shutil.which("docker"):
        return None, [], False, False
    info_result = docker(["info", "--format", "{{json .}}"], check=False)
    if info_result.returncode:
        return None, [], True, False
    info = parse_json(info_result.stdout)
    if any("rootless" in str(value) for value in info.get("SecurityOptions", [])):
        raise HostError("ROOTLESS_UNSUPPORTED", "Chrome Fleet requires the host's rootful Docker Engine.")
    networks = []
    network_ids = docker(["network", "ls", "-q"]).stdout.split()
    if network_ids:
        networks = parse_json(docker(["network", "inspect", *network_ids]).stdout)
    ids = docker(["ps", "-aq", "--filter", "label=com.docker.compose.project=chrome-fleet"]).stdout.split()
    if not ids:
        return None, networks, True, True
    containers = parse_json(docker(["inspect", *ids]).stdout)
    control = [item for item in containers if item.get("Config", {}).get("Labels", {}).get("com.docker.compose.service") == "control-plane"]
    if len(control) != 1:
        raise HostError("DEPLOYMENT_IDENTITY_CONFLICT", "The chrome-fleet Compose project does not identify one control-plane container.")
    container = control[0]
    labels = container.get("Config", {}).get("Labels", {})
    if not container.get("Config", {}).get("Image", "").startswith("chrome-fleet/control-plane:"):
        raise HostError("DEPLOYMENT_IDENTITY_CONFLICT", "An unrelated container uses the chrome-fleet Compose project name.")
    env = dict(item.split("=", 1) for item in container.get("Config", {}).get("Env", []) if "=" in item)
    data_root = safe_directory(env.get("FLEET_DATA_ROOT", ""))
    mounts = container.get("Mounts", [])
    if not any(item.get("Source") == data_root and item.get("Destination") == data_root and item.get("Type") == "bind" for item in mounts):
        raise HostError("DEPLOYMENT_IDENTITY_CONFLICT", "The existing service's data mount does not match its configured data root.")
    if not any(item.get("Source") == data_root + "/secrets" and item.get("Destination") == "/run/secrets" and item.get("RW") is False for item in mounts):
        raise HostError("DEPLOYMENT_IDENTITY_CONFLICT", "The existing service's credential mount is not the expected read-only mount.")
    repo_dir = safe_directory(labels.get("com.docker.compose.project.working_dir", ""))
    if not (Path(repo_dir) / "compose.yaml").is_file() or not (Path(repo_dir) / "scripts/fleet").is_file():
        raise HostError("DEPLOYMENT_IDENTITY_CONFLICT", "The existing Compose working directory cannot be verified.")
    bindings = container.get("HostConfig", {}).get("PortBindings", {}).get("8080/tcp", []) or []
    ports = {int(item["HostPort"]) for item in bindings if item.get("HostPort", "").isdigit()}
    if len(ports) != 1:
        raise HostError("DEPLOYMENT_IDENTITY_CONFLICT", "The existing management port mapping is ambiguous.")
    public = origin(env.get("FLEET_PUBLIC_URL", ""))
    allowed = [origin(value.strip()) for value in env.get("FLEET_ALLOWED_ORIGINS", "").split(",") if value.strip()]
    deployment = {"repo_dir": repo_dir, "data_root": data_root, "port": ports.pop(), "public_url": public,
                  "cookie_secure": env.get("FLEET_COOKIE_SECURE", "false") == "true", "allowed_origins": allowed,
                  "bind_addresses": sorted({item.get("HostIp", "") for item in bindings}),
                  "running": bool(container.get("State", {}).get("Running"))}
    return deployment, networks, True, True


def network_conflicts(networks: list[dict], own: bool) -> list[str]:
    conflicts = []
    reserved = [ipaddress.ip_network("172.30.0.0/24"), ipaddress.ip_network("172.31.0.0/16")]
    for network in networks:
        labels = network.get("Labels") or {}
        belongs = (network.get("Name") in {"chrome-fleet-control", "chrome-fleet-service-egress"}
                   and labels.get("com.docker.compose.project") == "chrome-fleet") or labels.get("chrome-fleet.managed") == "true"
        if belongs and own:
            continue
        if network.get("Name") in {"chrome-fleet-control", "chrome-fleet-service-egress"}:
            conflicts.append("A fixed Chrome Fleet Docker network name is already in use.")
        for entry in (network.get("IPAM") or {}).get("Config") or []:
            try:
                subnet = ipaddress.ip_network(entry.get("Subnet", ""), strict=False)
            except ValueError:
                continue
            if subnet.version == 4 and any(subnet.overlaps(item) for item in reserved):
                conflicts.append("An existing Docker network overlaps the reserved Chrome Fleet address ranges.")
    return sorted(set(conflicts))


def route_conflicts(networks: list[dict], own: bool) -> list[str]:
    own_interfaces = set()
    if own:
        for network in networks:
            labels = network.get("Labels") or {}
            if ((network.get("Name") in {"chrome-fleet-control", "chrome-fleet-service-egress"}
                 and labels.get("com.docker.compose.project") == "chrome-fleet")
                    or labels.get("chrome-fleet.managed") == "true"):
                options = network.get("Options") or {}
                own_interfaces.add(options.get("com.docker.network.bridge.name") or "br-" + network.get("Id", "")[:12])
    routes = []
    if shutil.which("ip"):
        response = command(["ip", "-j", "-4", "route", "show", "table", "all"], check=False)
        if response.returncode:
            raise HostError("ROUTE_INSPECTION_FAILED", "Unable to inspect host IPv4 routes before deployment.")
        routes = parse_json(response.stdout)
        if not isinstance(routes, list):
            raise HostError("ROUTE_INSPECTION_FAILED", "The host returned an unexpected IPv4 route table.")
    else:
        # Minimal installations may lack iproute2; the kernel main table remains readable.
        try:
            for line in Path("/proc/net/route").read_text().splitlines()[1:]:
                fields = line.split()
                address = socket.inet_ntoa(struct.pack("<I", int(fields[1], 16)))
                netmask = socket.inet_ntoa(struct.pack("<I", int(fields[7], 16)))
                routes.append({"dev": fields[0], "dst": f"{address}/{netmask}"})
        except (OSError, IndexError, ValueError):
            raise HostError("ROUTE_INSPECTION_FAILED", "Unable to inspect the kernel IPv4 route table.") from None
    reserved = [ipaddress.ip_network("172.30.0.0/24"), ipaddress.ip_network("172.31.0.0/16")]
    for route in routes:
        if route.get("dev") in own_interfaces or route.get("dst", "default") == "default":
            continue
        try:
            subnet = ipaddress.ip_network(route["dst"], strict=False)
        except (ValueError, KeyError):
            continue
        if subnet.prefixlen and subnet.version == 4 and any(subnet.overlaps(item) for item in reserved):
            return ["A host IPv4 route overlaps the reserved Chrome Fleet address ranges."]
    return []


def unit_contents(repo: Path) -> dict[str, str]:
    # Rendering matches the shipped units while pinning the daemon to this host.
    return {
        "chrome-fleet-firewall.service": f"[Unit]\nDescription=Chrome Fleet browser network isolation\nRequires=docker.service\nAfter=docker.service\nBefore=chrome-fleet.service\n\n[Service]\nType=oneshot\nWorkingDirectory={repo}\nExecStart={repo}/scripts/fleet firewall\nRemainAfterExit=yes\nEnvironment=DOCKER_HOST={DOCKER_SOCKET}\n\n[Install]\nWantedBy=multi-user.target\n",
        "chrome-fleet.service": f"[Unit]\nDescription=Chrome Fleet control services\nRequires=docker.service chrome-fleet-firewall.service\nAfter=docker.service chrome-fleet-firewall.service network-online.target\nWants=network-online.target\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nWorkingDirectory={repo}\nExecStart=/usr/bin/docker --host {DOCKER_SOCKET} compose up -d\nExecStop=/usr/bin/docker --host {DOCKER_SOCKET} compose stop control-plane runner\nEnvironment=DOCKER_HOST={DOCKER_SOCKET}\nTimeoutStartSec=180\nTimeoutStopSec=120\n\n[Install]\nWantedBy=multi-user.target\n",
    }


def inspect(config: dict) -> dict:
    facts = system_facts()
    deployment, networks, docker_installed, docker_running = existing_deployment()
    if deployment:
        # Existing installations are reported using their actual configuration.
        return {"existing": True, "ready": ready(deployment), "deployment": deployment,
                "host": facts, "docker_installed": docker_installed, "docker_running": docker_running,
                "conflicts": network_conflicts(networks, True) + route_conflicts(networks, True)}
    marker = marker_for(config)
    repo, data = Path(config["repo_dir"]), Path(config["data_root"])
    status = source_status(repo, config["revision"], allow_partial=bool(marker))
    conflicts = network_conflicts(networks, bool(marker)) + route_conflicts(networks, bool(marker))
    if marker and marker.get("complete"):
        conflicts.append("A completed deployment is stopped or missing; setup will not recreate or restart it. Diagnose it explicitly.")
    if status in {"conflict", "dirty", "revision_mismatch"}:
        conflicts.append("The source directory is unknown, dirty, or does not match the pinned revision.")
    if (repo / ".env").exists() or (repo / ".env").is_symlink():
        values = read_environment(repo)
        expected = {"FLEET_DATA_ROOT": config["data_root"], "FLEET_PORT": str(config["port"]),
                    "FLEET_BIND_ADDRESS": "127.0.0.1", "FLEET_PUBLIC_URL": f"http://127.0.0.1:{config['port']}",
                    "FLEET_COOKIE_SECURE": "false"}
        if any(values.get(key) != value for key, value in expected.items()):
            conflicts.append("The existing .env differs from the requested fresh deployment and will not be overwritten.")
    if data.exists() and not marker and (not data.is_dir() or any(data.iterdir())):
        conflicts.append("The data directory is non-empty and is not owned by this installer.")
    if docker_installed and not docker_running:
        conflicts.append("An existing Docker CLI is not connected to a running local rootful Engine; it will not be replaced or restarted.")
    for name, content in unit_contents(repo).items():
        path = UNIT_DIR / name
        if path.is_symlink() or (path.exists() and (not marker or path.read_text() != content)):
            conflicts.append("An existing Chrome Fleet systemd unit will not be overwritten.")
    try:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", config["port"]))
    except OSError:
        conflicts.append("The requested loopback management port is occupied by an unverified service.")
    deployment = {"repo_dir": str(repo), "data_root": str(data), "port": config["port"],
                  "public_url": f"http://127.0.0.1:{config['port']}", "cookie_secure": False,
                  "allowed_origins": [], "bind_addresses": ["127.0.0.1"], "running": False}
    return {"existing": False, "ready": False, "deployment": deployment, "host": facts,
            "docker_installed": docker_installed, "docker_running": docker_running,
            "source_status": status, "resumable": bool(marker and not marker.get("complete")), "conflicts": sorted(set(conflicts))}


def installed(package: str) -> bool:
    result = command(["dpkg-query", "-W", "-f=${Status}", package], check=False)
    return result.returncode == 0 and result.stdout.strip() == "install ok installed"


def install_packages(packages: list[str]) -> None:
    missing = [name for name in packages if not installed(name)]
    if not missing:
        return
    args = ["apt-get", "install", "--no-install-recommends", "--no-upgrade", "-y", *missing]
    simulated = command(["apt-get", "-s", *args[1:]], env=host_environment(), timeout=180)
    for line in simulated.stdout.splitlines():
        if line.startswith("Remv "):
            raise HostError("APT_UNSAFE_CHANGE", "Dependency installation would remove existing packages; no packages were installed.")
        match = re.match(r"Inst ([^ :]+)(?::\S+)? (.*)", line)
        if match and match.group(1) in PROTECTED_PACKAGES and match.group(2).startswith("["):
            raise HostError("APT_UNSAFE_CHANGE", "Dependency installation would upgrade or replace the existing container runtime; no packages were installed.")
    command(args, env=host_environment(), timeout=600)


def docker_repository(facts: dict) -> None:
    codename = facts["codename"]
    expected = {("ubuntu", "22.04"): "jammy", ("ubuntu", "24.04"): "noble", ("ubuntu", "26.04"): "resolute",
                ("debian", "12"): "bookworm", ("debian", "13"): "trixie"}[(facts["os"], facts["version"])]
    if codename != expected:
        raise HostError("UNSUPPORTED_CODENAME", "The distribution codename does not match its supported version.")
    source = Path("/etc/apt/sources.list.d/chrome-fleet-docker.sources")
    key = Path("/etc/apt/keyrings/chrome-fleet-docker.asc")
    content = f"Types: deb\nURIs: https://download.docker.com/linux/{facts['os']}\nSuites: {codename}\nComponents: stable\nArchitectures: amd64\nSigned-By: {key}\n"
    if source.is_symlink() or key.is_symlink() or (source.exists() and source.read_text() != content):
        raise HostError("APT_SOURCE_CONFLICT", "An installer-specific APT source or key conflicts with the expected Docker repository.")
    if not key.exists():
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(f"https://download.docker.com/linux/{facts['os']}/gpg", timeout=30) as response:
                value = response.read(65537)
            if len(value) > 65536 or not value.startswith(b"-----BEGIN PGP PUBLIC KEY BLOCK-----"):
                raise ValueError()
        except (OSError, ValueError, urllib.error.URLError):
            raise HostError("DOCKER_KEY_DOWNLOAD_FAILED", "Unable to fetch the official Docker APT signing key with TLS verification.") from None
        key.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        key.write_bytes(value)
        key.chmod(0o644)
    if not source.exists():
        source.write_text(content)
        source.chmod(0o644)
    command(["apt-get", "update"], env=host_environment(), timeout=300)


def dependencies(facts: dict, docker_was_installed: bool) -> None:
    progress("Checking host dependencies.")
    command(["apt-get", "update"], env=host_environment(), timeout=300)
    install_packages(["ca-certificates", "git", "python3", "iptables", "kmod", "util-linux"])
    if not docker_was_installed:
        if any(installed(name) for name in PROTECTED_PACKAGES):
            raise HostError("EXISTING_RUNTIME_CONFLICT", "Existing container runtime packages require manual review; they will not be replaced.")
        docker_repository(facts)
        install_packages(["docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin"])
        command(["systemctl", "enable", "--now", "docker"], env=host_environment())
    else:
        for probe, candidates in [(["compose", "version"], ["docker-compose-plugin", "docker-compose-v2"]),
                                  (["buildx", "version"], ["docker-buildx-plugin", "docker-buildx"])]:
            if docker(probe, check=False).returncode == 0:
                continue
            selected = None
            for name in candidates:
                result = command(["apt-cache", "policy", name], check=False, env=host_environment())
                if re.search(r"Candidate:\s+(?!\(none\))\S+", result.stdout):
                    selected = name
                    break
            if selected is None:
                raise HostError("DOCKER_PLUGIN_MISSING", "The existing Docker installation lacks a compatible Compose or Buildx plugin; configure it manually.")
            install_packages([selected])
    for args in (["info"], ["compose", "version"], ["buildx", "version"]):
        docker(args)
    if command(["iptables", "-w", "-nL", "DOCKER-USER"], check=False).returncode:
        raise HostError("DOCKER_FIREWALL_UNSUPPORTED", "The local Docker Engine must provide the iptables DOCKER-USER chain; its daemon configuration was not changed.")


def save_marker(config: dict, *, complete: bool = False, stage: str) -> None:
    path = Path(config["data_root"]) / MARKER
    value = {"version": 1, "config": {key: config[key] for key in ("repo_dir", "data_root", "port", "revision")},
             "complete": complete, "stage": stage}
    temporary = path.with_name(MARKER + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as output:
        json.dump(value, output)
    temporary.chmod(0o600)
    temporary.replace(path)


def prepare_source(config: dict, status: str) -> None:
    repo = Path(config["repo_dir"])
    if status == "ready":
        return
    if status not in {"absent", "empty", "partial"}:
        raise HostError("SOURCE_CONFLICT", "Existing source files were not modified.")
    repo.mkdir(mode=0o755, parents=True, exist_ok=True)
    if not (repo / ".git").exists():
        command(["git", "init", str(repo)], env=host_environment())
    if command(["git", "-C", str(repo), "remote", "get-url", "origin"], check=False, env=host_environment()).returncode:
        command(["git", "-C", str(repo), "remote", "add", "origin", REPOSITORY], env=host_environment())
    command(["git", "-C", str(repo), "fetch", "--depth=1", "origin", config["revision"]], timeout=300, env=host_environment())
    commit = command(["git", "-C", str(repo), "rev-parse", "FETCH_HEAD"], env=host_environment()).stdout.strip()
    if commit != config["revision"]:
        raise HostError("SOURCE_REVISION_MISMATCH", "The fetched source does not match the pinned revision.")
    command(["git", "-C", str(repo), "checkout", "--detach", commit], env=host_environment())


def prepare_env(config: dict) -> None:
    repo = Path(config["repo_dir"])
    path = repo / ".env"
    expected = {"FLEET_DATA_ROOT": config["data_root"], "FLEET_PORT": str(config["port"]),
                "FLEET_BIND_ADDRESS": "127.0.0.1", "FLEET_PUBLIC_URL": f"http://127.0.0.1:{config['port']}",
                "FLEET_COOKIE_SECURE": "false"}
    if path.exists() or path.is_symlink():
        values = read_environment(repo)
        if any(values.get(key) != value for key, value in expected.items()):
            raise HostError("ENV_CONFIG_CONFLICT", "The existing .env differs from the requested fresh deployment; it was not overwritten.")
        return
    template = (repo / ".env.example").read_text()
    lines = []
    for line in template.splitlines():
        key = line.split("=", 1)[0]
        lines.append(f"{key}={expected[key]}" if key in expected else line)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    with os.fdopen(descriptor, "w") as output:
        output.write("\n".join(lines) + "\n")


def install_units(repo: Path) -> None:
    for name, content in unit_contents(repo).items():
        path = UNIT_DIR / name
        if path.is_symlink() or (path.exists() and path.read_text() != content):
            raise HostError("SYSTEMD_UNIT_CONFLICT", "An existing systemd unit was not overwritten.")
        if not path.exists():
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
            with os.fdopen(descriptor, "w") as output:
                output.write(content)
    command(["systemctl", "daemon-reload"], env=host_environment())
    command(["systemctl", "enable", "chrome-fleet-firewall.service", "chrome-fleet.service"], env=host_environment())


def deployment_environment(config: dict) -> dict[str, str]:
    env = host_environment()
    env.update({"FLEET_DATA_ROOT": config["data_root"], "FLEET_PORT": str(config["port"])})
    return env


def doctor(config: dict, inspection: dict | None = None) -> dict:
    result = inspection or inspect(config)
    if not result["existing"]:
        raise HostError("DEPLOYMENT_NOT_FOUND", "No verified Chrome Fleet deployment was found.")
    actual = {**config, **{key: result["deployment"][key] for key in ("repo_dir", "data_root", "port")}}
    args = [str(Path(actual["repo_dir"]) / "scripts/fleet"), "doctor"]
    if config["runtime"]:
        args.append("--runtime")
    progress("Running the empty-profile browser check." if config["runtime"] else "Checking the existing deployment without creating a browser.")
    outcome = command(args, cwd=Path(actual["repo_dir"]), env=deployment_environment(actual), timeout=600, check=False)
    if outcome.returncode:
        raise HostError("DOCTOR_FAILED", "Deployment verification failed; preserved files and existing services were not removed.")
    result["ready"] = ready(result["deployment"])
    result["runtime_validated"] = config["runtime"]
    if not result["ready"]:
        raise HostError("SERVICE_NOT_READY", "The existing control service or Runner is not ready.")
    return result


def setup(config: dict) -> dict:
    result = inspect(config)
    marker = None
    if not result["existing"]:
        marker = marker_for(config)
    elif all(result["deployment"][key] == config[key] for key in ("repo_dir", "data_root", "port")):
        try:
            marker = marker_for(config)
        except HostError:
            # A new Skill release must still reuse a completed older deployment.
            marker = None
    if result["existing"] and not (marker and not marker.get("complete") and all(result["deployment"][key] == config[key] for key in ("repo_dir", "data_root", "port"))):
        result["reused"] = True
        return result
    if result["conflicts"]:
        raise HostError("DEPLOYMENT_CONFLICT", " ".join(result["conflicts"])[:900])
    repo, data = Path(config["repo_dir"]), Path(config["data_root"])
    if marker is None:
        data.mkdir(mode=0o700, parents=True, exist_ok=True)
        data.chmod(0o700)
        # init recognizes this dedicated directory; the marker contains no secrets.
        (data / ".chrome-fleet-data").touch(mode=0o600, exist_ok=False)
        save_marker(config, stage="dependencies")
    progress("Preparing this installer's new or interrupted Chrome Fleet deployment.")
    dependencies(result["host"], result["docker_installed"])
    status = source_status(repo, config["revision"], allow_partial=True)
    prepare_source(config, status)
    prepare_env(config)
    save_marker(config, stage="initialized")
    env = deployment_environment(config)
    command([str(repo / "scripts/fleet"), "init"], cwd=repo, env=env)
    command([str(repo / "scripts/fleet"), "firewall"], cwd=repo, env=env, timeout=120)
    install_units(repo)
    save_marker(config, stage="build")
    progress("Building Chrome Fleet and its browser image; this can take several minutes.")
    docker(["compose", "--profile", "build", "build"], cwd=repo, env=env, timeout=3600)
    save_marker(config, stage="starting")
    docker(["compose", "up", "-d"], cwd=repo, env=env, timeout=300)
    deadline = time.monotonic() + 180
    current = None
    while time.monotonic() < deadline:
        deployment, _, _, _ = existing_deployment()
        if deployment and ready(deployment):
            current = {**result, "existing": True, "deployment": deployment, "ready": True, "conflicts": []}
            break
        time.sleep(2)
    if current is None:
        raise HostError("STARTUP_TIMEOUT", "The new control service or Runner did not become ready; its data was preserved for retry.")
    save_marker(config, stage="runtime_validation")
    checked = doctor({**config, "runtime": True}, current)
    save_marker(config, stage="complete", complete=True)
    checked.update({"new": True, "existing": False, "reused": False, "resumable": False, "runtime_validated": True})
    return checked


def main() -> int:
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        if len(sys.argv) != 3 or action not in {"inspect", "setup", "doctor"}:
            raise HostError("INVALID_ACTION", "Usage: python3 - inspect|setup|doctor BASE64_JSON")
        config = configuration(sys.argv[2])
        if action == "setup":
            with setup_lock():
                result = setup(config)
        else:
            result = {"inspect": inspect, "doctor": doctor}[action](config)
        print(json.dumps({"ok": True, "action": action, **result}, separators=(",", ":")))
        return 0
    except HostError as error:
        print(json.dumps({"ok": False, "action": action, "error": {"code": error.code, "message": error.message}}, separators=(",", ":")))
    except Exception:
        print(json.dumps({"ok": False, "action": action, "error": {"code": "HOST_OPERATION_FAILED", "message": "A host operation failed; inspect the host locally. Existing deployment data was preserved."}}, separators=(",", ":")))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
