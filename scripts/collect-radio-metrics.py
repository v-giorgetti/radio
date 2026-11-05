#!/usr/bin/env python3
"""Read-only Linux host/container metrics, suitable for `ssh ... python3 -u -`."""

import argparse
import datetime
import json
import math
import os
from pathlib import Path
import resource
import signal
import subprocess
import sys
import time


DEFAULT_CONTAINERS = ("station-station-1", "caddy-proxy-caddy-1")


def read_text(path):
    return Path(path).read_text()


def attempt(errors, key, operation):
    try:
        return operation()
    except (OSError, ValueError, KeyError, IndexError, StopIteration) as exc:
        errors[key] = f"{type(exc).__name__}: {exc}"
        return None


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def cpu_ticks():
    fields = read_text("/proc/stat").splitlines()[0].split()
    if fields[0] != "cpu" or len(fields) < 9:
        raise ValueError("aggregate CPU counters missing")
    values = [int(value) for value in fields[1:9]]
    return sum(values), values[3] + values[4]


def memory_kib():
    return {
        parts[0].rstrip(":"): int(parts[1])
        for line in read_text("/proc/meminfo").splitlines()
        if (parts := line.split()) and len(parts) >= 2
    }


def default_interface():
    routes = []
    for line in read_text("/proc/net/route").splitlines()[1:]:
        fields = line.split()
        if len(fields) >= 8 and fields[1] == "00000000" and int(fields[3], 16) & 1:
            routes.append((int(fields[6]), fields[0]))
    if not routes:
        raise ValueError("no active IPv4 default route")
    return min(routes)[1]


def network_bytes(interface):
    for line in read_text("/proc/net/dev").splitlines():
        if ":" not in line:
            continue
        name, counters = line.split(":", 1)
        if name.strip() == interface:
            fields = counters.split()
            return int(fields[0]), int(fields[8])
    raise ValueError(f"network interface missing: {interface}")


def tcp_retransmissions():
    lines = read_text("/proc/net/snmp").splitlines()
    for header, values in zip(lines, lines[1:]):
        if header.startswith("Tcp:") and values.startswith("Tcp:"):
            fields = dict(zip(header.split()[1:], values.split()[1:]))
            return int(fields["RetransSegs"])
    raise ValueError("TCP counters missing")


def fd_limits(pid):
    for line in read_text(f"/proc/{pid}/limits").splitlines():
        if line.startswith("Max open files"):
            fields = line.split()
            return {"soft": fields[3], "hard": fields[4]}
    raise ValueError("open-file limits missing")


def application_pid(init_pid):
    """Follow container init wrappers; their FD count is not the app's count."""
    pending = [init_pid]
    visited = set()
    while pending and len(visited) < 64:
        pid = pending.pop(0)
        if pid in visited:
            continue
        visited.add(pid)
        name = read_text(f"/proc/{pid}/comm").strip()
        if name not in ("docker-init", "tini", "tini-static", "dumb-init"):
            return pid
        children = read_text(f"/proc/{pid}/task/{pid}/children").split()
        pending.extend(int(child) for child in children)
    raise ValueError("container init has no readable application child")


def cgroup_path(pid):
    for line in read_text(f"/proc/{pid}/cgroup").splitlines():
        hierarchy, controllers, path = line.split(":", 2)
        if hierarchy == "0" and not controllers:
            if not path.startswith("/") or ".." in Path(path).parts:
                raise ValueError("invalid cgroup v2 path")
            return str(Path("/sys/fs/cgroup") / path.lstrip("/"))
    raise ValueError("process has no cgroup v2 entry")


def cgroup_cpu_usec(path):
    counters = dict(line.split() for line in read_text(Path(path) / "cpu.stat").splitlines())
    return int(counters["usage_usec"])


def inspect_containers(names, errors):
    # Select only these fields; full `docker inspect` output can include secrets.
    template = '{"name":{{json .Name}},"pid":{{.State.Pid}},"restart_count":{{.RestartCount}},"status":{{json .State.Status}}}'
    try:
        result = subprocess.run(
            ["docker", "inspect", "--format", template, *names],
            capture_output=True, text=True, timeout=5, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        errors["docker_inspect"] = f"{type(exc).__name__}: {exc}"
        return {}
    if result.returncode:
        errors["docker_inspect"] = result.stderr.strip()[:500] or f"exit {result.returncode}"
    containers = {}
    for line in result.stdout.splitlines():
        try:
            entry = json.loads(line)
            name = entry.pop("name").lstrip("/")
            if name in names:
                entry["init_pid"] = entry["pid"]
                entry["pid"] = attempt(errors, f"{name}.application_pid", lambda: application_pid(entry["init_pid"])) if entry["init_pid"] else None
                containers[name] = entry
        except (ValueError, KeyError, AttributeError) as exc:
            errors["docker_inspect_output"] = f"{type(exc).__name__}: {exc}"
    for name in names:
        if name not in containers:
            errors[f"{name}.inspect"] = "container not found or not readable"
    return containers


def emit(record, errors):
    if errors:
        record["error"] = errors
    print(json.dumps(record, separators=(",", ":"), allow_nan=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--interval", type=float, default=2)
    parser.add_argument("--containers", nargs="+", default=list(DEFAULT_CONTAINERS))
    args = parser.parse_args()
    if not math.isfinite(args.interval) or args.interval <= 0:
        parser.error("--interval must be a positive finite number")
    names = list(dict.fromkeys(args.containers))
    errors = {}
    containers = inspect_containers(names, errors)
    info = {}
    for name in names:
        entry = dict(containers.get(name, {}))
        pid = entry.get("pid", 0)
        init_pid = entry.get("init_pid", 0)
        entry["cgroup_path"] = attempt(errors, f"{name}.cgroup", lambda: cgroup_path(init_pid)) if init_pid else None
        entry["fd_limits"] = attempt(errors, f"{name}.fd_limits", lambda: fd_limits(pid)) if pid else None
        info[name] = entry
    interface = attempt(errors, "default_interface", default_interface)
    memory = attempt(errors, "memory", memory_kib)
    cpu_count = os.cpu_count()
    if cpu_count is None:
        errors["cpu_count"] = "CPU count not available"
    limits = resource.getrlimit(resource.RLIMIT_NOFILE)
    emit({
        "type": "initial", "timestamp": timestamp(), "cpu_count": cpu_count,
        "memory_total_mib": memory.get("MemTotal", 0) / 1024 if memory and "MemTotal" in memory else None,
        "default_interface": interface,
        "fd_limits": {"soft": limits[0], "hard": limits[1]}, "containers": info,
    }, errors)

    start = time.monotonic()
    previous_time = start
    previous_cpu = attempt({}, "cpu", cpu_ticks)
    previous_net = attempt({}, "network", lambda: network_bytes(interface)) if interface else None
    previous_retrans = attempt({}, "tcp_retrans", tcp_retransmissions)
    previous_container_cpu = {}
    for name, entry in info.items():
        path = entry.get("cgroup_path")
        if path:
            usage = attempt({}, name, lambda: cgroup_cpu_usec(path))
            if usage is not None:
                previous_container_cpu[name] = (entry.get("pid"), usage, start)
    sample_index = 0
    deadline = start + args.interval
    while True:
        time.sleep(max(0, deadline - time.monotonic()))
        errors = {}
        sample_index += 1
        if sample_index % 15 == 0:
            containers = inspect_containers(names, errors)
        now = time.monotonic()
        elapsed = now - previous_time
        cpu = attempt(errors, "host_cpu", cpu_ticks)
        memory = attempt(errors, "memory", memory_kib)
        available = attempt(errors, "mem_available", lambda: memory["MemAvailable"] / 1024) if memory is not None else None
        current_interface = attempt(errors, "default_interface", default_interface)
        net = attempt(errors, "network", lambda: network_bytes(current_interface)) if current_interface else None
        retrans = attempt(errors, "tcp_retrans", tcp_retransmissions)
        busy = None
        if cpu and previous_cpu:
            total = cpu[0] - previous_cpu[0]
            idle = cpu[1] - previous_cpu[1]
            if total > 0 and 0 <= idle <= total:
                busy = round(100 * (total - idle) / total, 3)
        rx_mbps = tx_mbps = None
        if net and previous_net and current_interface == interface and elapsed > 0:
            rx_delta, tx_delta = net[0] - previous_net[0], net[1] - previous_net[1]
            if rx_delta >= 0 and tx_delta >= 0:
                rx_mbps, tx_mbps = round(rx_delta * 8 / elapsed / 1e6, 4), round(tx_delta * 8 / elapsed / 1e6, 4)
        samples = {}
        for name in names:
            entry = dict(containers.get(name, {}))
            pid = entry.get("pid", 0)
            init_pid = entry.get("init_pid", 0)
            path = attempt(errors, f"{name}.cgroup", lambda: cgroup_path(init_pid)) if init_pid else None
            cpu_usec = attempt(errors, f"{name}.cpu", lambda: cgroup_cpu_usec(path)) if path else None
            memory_bytes = attempt(errors, f"{name}.memory", lambda: int(read_text(Path(path) / "memory.current"))) if path else None
            count = attempt(errors, f"{name}.fds", lambda: len(os.listdir(f"/proc/{pid}/fd"))) if pid else None
            cpu_pct = None
            previous = previous_container_cpu.get(name)
            if cpu_usec is not None:
                if previous and previous[0] == pid and cpu_usec >= previous[1] and now > previous[2]:
                    cpu_pct = round((cpu_usec - previous[1]) / (now - previous[2]) / 10000, 3)
                previous_container_cpu[name] = (pid, cpu_usec, now)
            else:
                previous_container_cpu.pop(name, None)
            samples[name] = {
                "pid": pid or None, "init_pid": init_pid or None, "cpu_pct": cpu_pct,
                "memory_mib": round(memory_bytes / 1048576, 3) if memory_bytes is not None else None,
                "fd_count": count, "restart_count": entry.get("restart_count"), "status": entry.get("status"),
            }
            if not pid:
                errors[f"{name}.process"] = "container has no running/readable PID"
        retrans_delta = retrans - previous_retrans if retrans is not None and previous_retrans is not None and retrans >= previous_retrans else None
        emit({
            "type": "sample", "timestamp": timestamp(), "elapsed_seconds": round(now - start, 3),
            "host_cpu_busy_pct": busy, "mem_available_mib": available,
            "interface": current_interface, "tx_mbps": tx_mbps, "rx_mbps": rx_mbps,
            "tcp_retrans_delta": retrans_delta, "containers": samples,
        }, errors)
        previous_time, previous_cpu, previous_net, previous_retrans = now, cpu, net, retrans
        interface = current_interface
        deadline = max(deadline + args.interval, time.monotonic())


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        main()
    except KeyboardInterrupt:
        pass
    except BrokenPipeError:
        # Avoid a second exception when Python flushes stdout during shutdown.
        with open(os.devnull, "w") as sink:
            os.dup2(sink.fileno(), sys.stdout.fileno())
