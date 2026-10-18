#!/bin/sh
# Run on the Docker host as root after Docker is ready. Only CF-FLEET and its jump are modified.
set -eu
# Validate the entire policy before changing host settings, rules, or the ready marker.
script_dir="$(CDPATH= cd "$(dirname "$0")" && pwd)"
fleet_rules="$(python3 "$script_dir/firewall-rules.py")"
test "$(id -u)" = 0 || { printf '%s\n' '请使用 root 在 Docker 宿主机安装 Chrome Fleet 防火墙' >&2; exit 1; }
command -v iptables >/dev/null
python3 - <<'PY'
import os,stat,sys
path='/run/xtables.lock'
try:
    descriptor=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    os.close(descriptor)
except FileExistsError:
    pass
metadata=os.lstat(path)
if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid!=0 or metadata.st_mode&0o022:
    sys.exit('宿主xtables锁必须是root所有、不可普通写入的安全普通文件')
PY
iptables -w -nL DOCKER-USER >/dev/null
if ! test -e /proc/sys/net/bridge/bridge-nf-call-iptables; then modprobe br_netfilter; fi
if ! test "$(cat /proc/sys/net/bridge/bridge-nf-call-iptables)" = 1; then sysctl -w net.bridge.bridge-nf-call-iptables=1; fi
mkdir -p /run/chrome-fleet
chmod 0755 /run/chrome-fleet
exec 9>/run/chrome-fleet/network-policy.lock
flock -x 9
# A short-lived helper may have committed a newer policy while installation waited.
fleet_rules="$(python3 "$script_dir/firewall-rules.py")"
rm -f /run/chrome-fleet/firewall-ready.json
rules_file="$(mktemp /run/chrome-fleet/firewall-rules.XXXXXX)"
trap 'rm -f "$rules_file"' EXIT TERM INT
printf '%s\n' "$fleet_rules" > "$rules_file"
# One filter-table commit updates only our chain; other services' rules remain intact.
iptables-restore --wait --noflush < "$rules_file"
if ! iptables -w -C DOCKER-USER -m iprange --src-range 172.30.0.32-172.30.0.250 -j CF-FLEET 2>/dev/null; then
  iptables -w -I DOCKER-USER 1 -m iprange --src-range 172.30.0.32-172.30.0.250 -j CF-FLEET
fi
if ! iptables -w -C DOCKER-USER -i cf+ -s 172.31.0.0/16 -j CF-FLEET 2>/dev/null; then
  iptables -w -I DOCKER-USER 1 -i cf+ -s 172.31.0.0/16 -j CF-FLEET
fi
# Browser requests to host addresses traverse INPUT, not DOCKER-USER.
# The dedicated chain checks configured endpoints before denying other host access.
if ! iptables -w -C INPUT -m iprange --src-range 172.30.0.32-172.30.0.250 -j CF-FLEET-INPUT 2>/dev/null; then
  iptables -w -I INPUT 1 -m iprange --src-range 172.30.0.32-172.30.0.250 -j CF-FLEET-INPUT
fi
if ! iptables -w -C INPUT -i cf+ -s 172.31.0.0/16 -j CF-FLEET-INPUT 2>/dev/null; then
  iptables -w -I INPUT 1 -i cf+ -s 172.31.0.0/16 -j CF-FLEET-INPUT
fi
while iptables -w -C INPUT -m iprange --src-range 172.30.0.32-172.30.0.250 -m conntrack ! --ctstate ESTABLISHED,RELATED -j DROP 2>/dev/null; do
  iptables -w -D INPUT -m iprange --src-range 172.30.0.32-172.30.0.250 -m conntrack ! --ctstate ESTABLISHED,RELATED -j DROP
done
while iptables -w -C INPUT -i cf+ -s 172.31.0.0/16 -m conntrack ! --ctstate ESTABLISHED,RELATED -j DROP 2>/dev/null; do
  iptables -w -D INPUT -i cf+ -s 172.31.0.0/16 -m conntrack ! --ctstate ESTABLISHED,RELATED -j DROP
done
python3 - <<'PY'
import json,os,pathlib,tempfile,subprocess
root=pathlib.Path('/run/chrome-fleet')
backend='legacy' if 'legacy' in subprocess.check_output(['iptables','--version'],text=True) else 'nft'
policy={'allowedCidrs':os.environ.get('FLEET_ALLOWED_CIDRS',''),'legacyProxyEndpoints':os.environ.get('FLEET_ALLOWED_PROXY_ENDPOINTS',''),'controlSubnet':os.environ.get('FLEET_CONTROL_SUBNET','172.30.0'),'backend':backend}
fd,name=tempfile.mkstemp(prefix='.base-policy-',dir=root)
with os.fdopen(fd,'w') as output:
    json.dump(policy,output)
os.replace(name,root/'base-policy.json')
PY
python3 -c 'import json,pathlib; p=pathlib.Path("/run/chrome-fleet/firewall-ready.json"); p.write_text(json.dumps({"version":1,"bootId":pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip(),"controlSubnet":"172.30.0.0/24"})); p.chmod(0o644)'
printf '%s\n' 'Chrome Fleet 防火墙已安装；重启宿主机后须重新执行，Runner 将检查本次启动标记。'
