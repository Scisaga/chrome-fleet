#!/bin/sh
set -eu
umask 077
printf '%s\n' "$$" > "$XDG_RUNTIME_DIR/session.pid"
export GNOME_KEYRING_CONTROL="$XDG_RUNTIME_DIR/keyring"
mkdir -p "$GNOME_KEYRING_CONTROL"
gnome-keyring-daemon --unlock --components=secrets --control-directory="$GNOME_KEYRING_CONTROL" < /run/fleet/keyring-password > "$XDG_RUNTIME_DIR/keyring.env"
printf '%s' 'chrome-fleet-keyring-ready' | secret-tool store --label='Chrome Fleet Keyring Probe' chrome-fleet probe
test "$(secret-tool lookup chrome-fleet probe)" = 'chrome-fleet-keyring-ready' || exit 1
Xvfb :99 -screen 0 1440x900x24 -nolisten tcp -ac > "$XDG_RUNTIME_DIR/xvfb.log" 2>&1 &
xvfb_pid=$!
attempt=0
until xdpyinfo -display :99 >/dev/null 2>&1; do
  attempt=$((attempt+1)); test "$attempt" -lt 50 || exit 1
  sleep 0.1
done
openbox > "$XDG_RUNTIME_DIR/openbox.log" 2>&1 &
wm_pid=$!
/usr/local/bin/fleet-vnc-reload
websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 > "$XDG_RUNTIME_DIR/novnc.log" 2>&1 &
web_pid=$!
node /app/apps/browser-agent/dist/index.js &
agent_pid=$!
cleanup() {
  trap - TERM INT EXIT
  kill -TERM "$agent_pid" 2>/dev/null || true
  wait "$agent_pid" 2>/dev/null || true
  if test -f "$XDG_RUNTIME_DIR/vnc.pid"; then kill -TERM "$(cat "$XDG_RUNTIME_DIR/vnc.pid")" 2>/dev/null || true; fi
  kill -TERM "$web_pid" "$wm_pid" "$xvfb_pid" 2>/dev/null || true
  # Let Secret Service finish its normal persistence path before the container exits.
  pkill -TERM -u 1000 -x gnome-keyring-d 2>/dev/null || true
  sleep 0.3
}
trap cleanup TERM INT EXIT
wait "$agent_pid"
