#!/bin/sh
set -eu
umask 077
test "$(id -u)" = 1000 || { printf '%s\n' '浏览器必须使用 UID 1000' >&2; exit 1; }
for secret in agent-token keyring-password vnc-password; do
  test -r "/run/fleet/$secret" || { printf '%s\n' '缺少实例秘密文件' >&2; exit 1; }
done
mkdir -p /state/chrome /state/keyrings /state/downloads /state/config "$XDG_RUNTIME_DIR"
chmod 0700 "$XDG_RUNTIME_DIR" /state/chrome /state/keyrings /state/downloads /state/config
dbus-run-session -- /usr/local/bin/fleet-session &
bus_pid=$!
stop_session() {
  trap - TERM INT
  node /app/apps/browser-agent/dist/stop.js || true
  if test -f "$XDG_RUNTIME_DIR/session.pid"; then kill -TERM "$(cat "$XDG_RUNTIME_DIR/session.pid")" 2>/dev/null || true; fi
  wait "$bus_pid" 2>/dev/null || true
}
trap stop_session TERM INT
wait "$bus_pid"
