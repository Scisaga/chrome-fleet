#!/usr/bin/env python3
"""Fixed-command NET_ADMIN helper. Reads only credential-free Fleet network policy."""
import fcntl
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time

spec = importlib.util.spec_from_file_location("fleet_firewall_rules", pathlib.Path(__file__).with_name("firewall-rules.py"))
rules_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rules_module)


def apply_policy(directory="/policy", runtime="/run/chrome-fleet"):
    directory = pathlib.Path(directory)
    runtime = pathlib.Path(runtime)
    with (runtime / "network-policy.lock").open("a") as lock:
        deadline = time.monotonic() + 15
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise ValueError("代理策略锁等待超时")
                time.sleep(0.05)
        base = rules_module.load_policy(runtime / "base-policy.json")
        if not isinstance(base, dict) or set(base) != {"allowedCidrs", "legacyProxyEndpoints", "controlSubnet", "backend"} or base["backend"] not in ("legacy", "nft"):
            raise ValueError("宿主基础隔离策略未安装，请重新运行 firewall")
        policy = rules_module.load_policy(directory / "candidate.json")
        if policy is None:
            raise ValueError("待应用代理策略缺失")
        boot_id = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        if policy.get("bootId") != boot_id:
            raise ValueError("待应用代理策略不属于当前宿主启动")
        rules = rules_module.generate_rules(base["allowedCidrs"], base["legacyProxyEndpoints"], base["controlSubnet"], policy, boot_id)
        subprocess.run([f"iptables-{base['backend']}-restore", "--wait", "--noflush"], input=rules.encode(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=20)
        # The installer shares this lock, so reload always reads the committed policy.
        fd, name = tempfile.mkstemp(prefix=".active-", dir=directory)
        try:
            with os.fdopen(fd, "w") as output:
                output.write(json.dumps(policy, separators=(",", ":")))
                output.flush()
                os.fsync(output.fileno())
            os.replace(name, directory / "active.json")
        finally:
            if os.path.exists(name):
                os.unlink(name)


if __name__ == "__main__":
    try:
        if len(sys.argv) != 1:
            raise ValueError("helper 不接受命令行参数")
        apply_policy()
    except Exception:
        # Never echo policy payloads, subprocess output, URLs, or credentials.
        print("Chrome Fleet 代理网络策略应用失败", file=sys.stderr)
        sys.exit(1)
