#!/bin/sh
# Sent over SSH to sh -s -- check|setup. No secrets or arbitrary shell config.
set -eu
fleet_action=${1:-}
case "$fleet_action" in check|setup) ;; *) printf '%s\n' '{"ok":false,"error":{"code":"INVALID_ACTION","message":"Expected check or setup."}}'; exit 1;; esac
fleet_fail() {
  printf '{"ok":false,"error":{"code":"%s","message":"%s"}}\n' "$1" "$2"
  exit 1
}
[ "$(uname -s)" = Linux ] || fleet_fail UNSUPPORTED_HOST 'The service host must be Linux amd64.'
case "$(uname -m)" in x86_64|amd64) ;; *) fleet_fail UNSUPPORTED_HOST 'The service host must be Linux amd64.';; esac
[ "$(id -u)" = 0 ] || fleet_fail ROOT_REQUIRED 'Use root or non-interactive sudo on the service host.'
[ -r /etc/os-release ] || fleet_fail UNSUPPORTED_OS 'Unable to identify the service host OS.'
# /etc/os-release is a root-managed OS definition; never source caller input.
. /etc/os-release
case "${ID:-}:${VERSION_ID:-}" in ubuntu:22.04|ubuntu:24.04|ubuntu:26.04|debian:12|debian:13) ;; *) fleet_fail UNSUPPORTED_OS 'Supported hosts are Ubuntu 22.04/24.04/26.04 and Debian 12/13.';; esac
[ -d /run/systemd/system ] || fleet_fail SYSTEMD_REQUIRED 'A booted systemd service host is required.'
if command -v python3 >/dev/null 2>&1; then
  python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)' || fleet_fail PYTHON_VERSION 'Python 3.10 or later is required.'
  printf '%s\n' '{"ok":true,"python_available":true,"installed":false}'
  exit 0
fi
if [ "$fleet_action" = check ]; then
  fleet_fail PYTHON_MISSING 'Python 3.10 or later is missing; run setup to install this prerequisite.'
fi
command -v apt-get >/dev/null 2>&1 || fleet_fail APT_MISSING 'The host requires apt-get for dependency installation.'
if command -v docker >/dev/null 2>&1; then
  fleet_existing=$(docker --host unix:///var/run/docker.sock ps -aq --filter label=com.docker.compose.project=chrome-fleet 2>/dev/null) || fleet_fail DOCKER_UNAVAILABLE 'The existing local Docker Engine cannot be inspected; no prerequisites were installed.'
  [ -z "$fleet_existing" ] || fleet_fail EXISTING_DEPLOYMENT_REQUIRES_PYTHON 'Chrome Fleet already exists; install Python explicitly before reusing it. Setup did not install dependencies.'
fi
printf '%s\n' 'Installing the missing Python host prerequisite.' >&2
if ! DEBIAN_FRONTEND=noninteractive apt-get update >/dev/null 2>&1; then fleet_fail APT_FAILED 'APT metadata refresh failed.'; fi
fleet_simulation=$(LC_ALL=C DEBIAN_FRONTEND=noninteractive apt-get -s install --no-install-recommends --no-upgrade -y python3 2>&1) || fleet_fail APT_FAILED 'Python dependency simulation failed.'
if printf '%s\n' "$fleet_simulation" | awk '/^Remv / {bad=1} /^Inst (docker-ce|docker-ce-cli|docker\.io|containerd|containerd\.io|runc|podman-docker)(:[^ ]+)? \[/ {bad=1} END {exit bad ? 0 : 1}'; then
  fleet_fail APT_UNSAFE_CHANGE 'Python installation would remove packages or replace the container runtime.'
fi
if ! DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends --no-upgrade -y python3 >/dev/null 2>&1; then fleet_fail APT_FAILED 'Python installation failed.'; fi
python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)' || fleet_fail PYTHON_VERSION 'Python 3.10 or later is required.'
printf '%s\n' '{"ok":true,"python_available":true,"installed":true}'
