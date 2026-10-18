#!/usr/bin/env python3
"""Validate Fleet policy and print an iptables-restore fragment without side effects."""
import ipaddress
import os
import re
import sys
import json
import pathlib
import stat

PROFILE_ID = re.compile(r"cf_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")


def validate_policy(policy, boot_id):
    if not isinstance(policy, dict) or set(policy) != {"version", "bootId", "profiles"} or policy["version"] != 1:
        raise ValueError("动态代理策略格式无效")
    if not isinstance(policy["bootId"], str) or not isinstance(policy["profiles"], list) or len(policy["profiles"]) > 1000:
        raise ValueError("动态代理策略格式无效")
    profiles = []
    seen = set()
    for entry in policy["profiles"]:
        if not isinstance(entry, dict) or set(entry) != {"profileId", "proxyVersion", "port", "addresses", "sources"}:
            raise ValueError("动态代理条目包含未知字段")
        pid = entry["profileId"]
        if not isinstance(pid, str) or not PROFILE_ID.fullmatch(pid) or pid in seen:
            raise ValueError("动态代理实例标识无效或重复")
        seen.add(pid)
        if type(entry["port"]) is not int or not 1 <= entry["port"] <= 65535 or type(entry["proxyVersion"]) is not int or entry["proxyVersion"] < 0:
            raise ValueError("动态代理版本或端口无效")
        if not isinstance(entry["addresses"], list) or not 1 <= len(entry["addresses"]) <= 64 or not isinstance(entry["sources"], list) or not 1 <= len(entry["sources"]) <= 2:
            raise ValueError("动态代理地址或来源数量无效")
        addresses = list(dict.fromkeys(str(ipaddress.IPv4Address(address)) for address in entry["addresses"]))
        sources = []
        for source in entry["sources"]:
            if not isinstance(source, dict) or set(source) != {"interface", "address"}:
                raise ValueError("动态代理来源格式无效")
            interface = source["interface"]
            if not isinstance(interface, str) or not re.fullmatch(r"[a-zA-Z0-9_.-]{1,15}", interface):
                raise ValueError("动态代理来源接口无效")
            address = ipaddress.IPv4Address(source["address"])
            if address not in ipaddress.IPv4Network("172.31.0.0/16") and address not in ipaddress.IPv4Network("172.30.0.0/24"):
                raise ValueError("动态代理来源不在 Fleet 网络中")
            sources.append({"interface": interface, "address": str(address)})
        profiles.append({**entry, "addresses": addresses, "sources": sources})
    # Addresses from a previous boot cannot authorize a newly allocated source.
    return profiles if policy["bootId"] == boot_id else []


def load_policy(path):
    if not path or not pathlib.Path(path).exists():
        return None
    metadata = pathlib.Path(path).lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022 or metadata.st_size > 1024 * 1024:
        raise ValueError("动态代理策略文件权限或大小无效")
    return json.loads(pathlib.Path(path).read_text())


def generate_rules(allowed_cidrs: str, proxy_endpoints: str, control_subnet: str = "172.30.0", policy=None, boot_id="") -> str:
    if control_subnet != "172.30.0":
        raise ValueError("当前防火墙模板仅支持 172.30.0.0/24 控制网段")

    cidrs = []
    for value in allowed_cidrs.split():
        try:
            network = str(ipaddress.IPv4Network(value, strict=True))
        except ValueError:
            raise ValueError("FLEET_ALLOWED_CIDRS 必须是严格 IPv4 网段") from None
        if network not in cidrs:
            cidrs.append(network)

    endpoints = []
    for value in proxy_endpoints.split():
        parts = value.split(":")
        if len(parts) != 2 or not re.fullmatch(r"[0-9]{1,5}", parts[1]):
            raise ValueError("FLEET_ALLOWED_PROXY_ENDPOINTS 必须是空格分隔的 IPv4:端口")
        try:
            address = str(ipaddress.IPv4Address(parts[0]))
        except ValueError:
            raise ValueError("代理例外地址必须是严格 IPv4，不接受域名、IPv6 或 URL") from None
        port = int(parts[1])
        if not 1 <= port <= 65535:
            raise ValueError("代理例外端口必须在 1 至 65535 之间")
        if (address, port) not in endpoints:
            endpoints.append((address, port))

    profiles = validate_policy(policy, boot_id) if policy is not None else []
    # Build output only after every supplied token has passed validation.
    rules = [
        "*filter",
        ":CF-FLEET - [0:0]",
        ":CF-FLEET-INPUT - [0:0]",
        "-F CF-FLEET",
        "-F CF-FLEET-INPUT",
        "-A CF-FLEET -m conntrack --ctstate ESTABLISHED,RELATED --ctdir REPLY -j RETURN",
        "-A CF-FLEET-INPUT -m conntrack --ctstate ESTABLISHED,RELATED --ctdir REPLY -j ACCEPT",
    ]
    for entry in profiles:
        for source in entry["sources"]:
            for address in entry["addresses"]:
                for protocol in ("tcp", "udp"):
                    # Docker published ports may already be DNATed in DOCKER-USER.
                    # Match the configured original tuple, not the translated fixture/service.
                    match = f"-i {source['interface']} -s {source['address']}/32 -p {protocol} -m conntrack --ctdir ORIGINAL --ctorigdst {address} --ctorigdstport {entry['port']}"
                    rules.append(f"-A CF-FLEET {match} -j RETURN")
                    rules.append(f"-A CF-FLEET-INPUT {match} -j ACCEPT")
    rules.extend(f"-A CF-FLEET -d {network} -j RETURN" for network in cidrs)
    rules.extend(
        f"-A CF-FLEET -d {address}/32 -p tcp --dport {port} -j RETURN"
        for address, port in endpoints
    )
    for network in (
        "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
        "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/4",
    ):
        rules.append(f"-A CF-FLEET -d {network} -j DROP")
    return "\n".join([*rules, "-A CF-FLEET -j RETURN", "-A CF-FLEET-INPUT -j DROP", "COMMIT", ""])


if __name__ == "__main__":
    try:
        rules = generate_rules(
            os.environ.get("FLEET_ALLOWED_CIDRS", ""),
            os.environ.get("FLEET_ALLOWED_PROXY_ENDPOINTS", ""),
            os.environ.get("FLEET_CONTROL_SUBNET", "172.30.0"),
            load_policy(os.environ.get("FLEET_PROXY_POLICY_FILE", str(pathlib.Path(os.environ.get("FLEET_DATA_ROOT", "/var/lib/chrome-fleet")) / "network-policy/active.json"))),
            pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
        )
    except (ValueError, TypeError, OSError) as error:
        print(f"Chrome Fleet 防火墙配置无效：{error}", file=sys.stderr)
        sys.exit(1)
    sys.stdout.write(rules)
