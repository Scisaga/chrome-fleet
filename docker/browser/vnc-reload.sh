#!/bin/sh
set -eu
umask 077
python3 -c 'import pathlib,re; p=pathlib.Path("/run/fleet/vnc-password").read_bytes().strip(); assert re.fullmatch(rb"[!-~]{8}",p), "VNCAuth 密码必须恰好 8 个可打印 ASCII 字符"'
if test -f "$XDG_RUNTIME_DIR/vnc.pid"; then
  pid="$(cat "$XDG_RUNTIME_DIR/vnc.pid")"
  # Only operate our own VNC process, never accept an arbitrary process identifier.
  if test -r "/proc/$pid/comm" && test "$(cat "/proc/$pid/comm")" = x11vnc; then
    kill -TERM "$pid" 2>/dev/null || true
    attempt=0
    while kill -0 "$pid" 2>/dev/null && test "$attempt" -lt 30; do sleep 0.1; attempt=$((attempt+1)); done
  fi
fi
tigervncpasswd -f < /run/fleet/vnc-password > "$XDG_RUNTIME_DIR/vnc-passwd.tmp"
chmod 0600 "$XDG_RUNTIME_DIR/vnc-passwd.tmp"
mv "$XDG_RUNTIME_DIR/vnc-passwd.tmp" "$XDG_RUNTIME_DIR/vnc-passwd"
x11vnc -display :99 -localhost -rfbport 5900 -rfbauth "$XDG_RUNTIME_DIR/vnc-passwd" -forever -shared -noxdamage > "$XDG_RUNTIME_DIR/vnc.log" 2>&1 &
printf '%s\n' "$!" > "$XDG_RUNTIME_DIR/vnc.pid"
