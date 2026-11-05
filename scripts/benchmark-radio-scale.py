#!/usr/bin/env python3
"""Five-process external radio test, with a single globally paced listener ramp.

Individual failed connections recover and remain visible in the results. Server
resource guards are identical to the conservative benchmark-listeners.py test.
"""
import argparse
import asyncio
from datetime import datetime, timezone
import importlib.util
import json
import math
from pathlib import Path
import shlex
import sys
import time

spec = importlib.util.spec_from_file_location("radio_benchmark", Path(__file__).with_name("benchmark-listeners.py"))
base = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = base
spec.loader.exec_module(base)


def admission_rate(maximum, host_cpu, unhealthy_fraction, media_lag_p95, worker_cpu, loop_lag_ms, fast=False):
    if host_cpu > 82 or unhealthy_fraction > .05 or worker_cpu > 90 or loop_lag_ms > 250:
        return 0
    if fast:
        if host_cpu > 75 or media_lag_p95 > 3:
            return min(maximum, 20)
        if host_cpu > 65:
            return min(maximum, 50)
        if host_cpu > 55 or unhealthy_fraction > .01:
            return min(maximum, 100)
        return maximum
    if host_cpu > 75:
        return min(maximum, 1)
    if host_cpu > 65:
        return min(maximum, 2)
    if host_cpu > 55 or unhealthy_fraction > .01 or media_lag_p95 > 3:
        return min(maximum, 5)
    return maximum


def hold_passes(sample, target):
    return (sample.get("active_audio", 0) >= target * .99
            and sample.get("active_metadata", 0) >= target * .99
            and sample.get("healthy", 0) >= target * .99
            and sample.get("continuous", 0) >= target * .99)


class ScaleTest(base.Benchmark):
    def __init__(self, args):
        super().__init__(args)
        self.capture.close()
        (self.output / "sentinel.ogg").unlink()
        self.workers = []
        self.worker_samples = {}
        self.worker_seen = {}
        self.worker_ready = set()
        self.tasks = []
        self.slots = [0] * args.workers
        self.holds = []
        self.history = []
        self.started_at = datetime.now(timezone.utc).isoformat()
        self.last_probe = None
        self.probe_at = None
        self.last_probe_error = None
        self.phase = "setup"
        self.current_rate = 0
        self.max_actual_audio = 0
        self.max_actual_metadata = 0
        self.max_healthy = 0
        self.next_worker = 0
        self.metadata_slots = [0] * args.workers
        self.previous_output = self.started

    async def send(self, index, message):
        process, _ = self.workers[index]
        if process.returncode is not None:
            self.abort(f"worker {index} exited")
            return
        try:
            process.stdin.write((json.dumps(message) + "\n").encode())
            await asyncio.wait_for(process.stdin.drain(), 2)
        except (OSError, TimeoutError, ConnectionError):
            self.abort(f"worker {index} control channel failed")

    async def broadcast(self, message):
        await asyncio.gather(*(self.send(i, message) for i in range(len(self.workers))))

    async def read_worker(self, index, process):
        try:
            while line := await process.stdout.readline():
                row = json.loads(line)
                self.log({"type": "worker", "worker": index, "data": row})
                self.worker_seen[index] = time.monotonic()
                if row.get("type") == "ready":
                    self.worker_ready.add(index)
                elif row.get("type") == "sample":
                    self.worker_samples[index] = row
            if not self.finished:
                self.abort(f"worker {index} telemetry ended")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.abort(f"worker {index} telemetry invalid: {error}")

    async def launch_workers(self):
        script = str(Path(__file__).with_name("radio-load-worker.py"))
        for index in range(self.args.workers):
            errors = (self.output / f"worker-{index}.stderr.log").open("wb")
            worker_url = self.args.worker_url or self.args.url
            command = [sys.executable, "-u", script, "--url", worker_url,
                "--worker-id", str(index), "--output", str(self.output / f"worker-{index}")]
            if self.args.defer_metadata:
                command.append("--defer-metadata")
            if self.args.worker_uvloop:
                command.append("--uvloop")
            if self.args.remote_worker_dir:
                directory = Path(self.args.remote_worker_dir)
                remote = ["python3", "-u", str(directory / "radio-load-worker.py"),
                    "--url", worker_url, "--worker-id", str(index),
                    "--output", str(directory / "results" / self.output.name / f"worker-{index}")]
                if self.args.defer_metadata:
                    remote.append("--defer-metadata")
                if self.args.worker_uvloop:
                    remote.append("--uvloop")
                remote_command = "ulimit -S -n 8192 && exec " + " ".join(shlex.quote(part) for part in remote)
                command = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", str(self.args.ssh_port),
                           self.args.ssh_target, remote_command]
            process = await asyncio.create_subprocess_exec(*command,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=errors)
            self.workers.append((process, errors))
            self.worker_seen[index] = time.monotonic()
            self.tasks.append(asyncio.create_task(self.read_worker(index, process)))

    async def heartbeat(self):
        while not self.stop.is_set():
            await self.broadcast({"heartbeat": True})
            await self.pause(2)

    def aggregate(self):
        values = list(self.worker_samples.values())
        total = lambda key: sum(row.get(key, 0) for row in values)
        active = total("active_audio")
        audio_only = self.args.defer_metadata and self.phase in ("setup", "ramp", "metadata")
        healthy = (total("healthy_audio") if audio_only
                   else sum(row.get("healthy", min(row.get("healthy_audio", 0), row.get("healthy_metadata", 0))) for row in values))
        return {"slots": sum(self.slots), "active_audio": active,
                "healthy_audio": total("healthy_audio"), "healthy_metadata": total("healthy_metadata"),
                "health_scope": "audio during staged startup" if audio_only else "audio and metadata",
                "active_metadata": total("active_metadata"), "healthy": healthy,
                "continuous": total("continuously_healthy"),
                "bytes": total("bytes"), "metadata_bytes": total("metadata_bytes"),
                "errors": total("errors"), "reconnects": total("reconnects"),
                "stall_events": total("stall_events"), "discontinuities": total("discontinuities"),
                "max_gap_seconds": max((row.get("max_gap_seconds", 0) for row in values), default=0),
                # These are conservative maxima of worker percentiles, not a
                # pooled percentile across every simulated listener.
                "max_worker_media_lag_p95_seconds": max((row.get("media_lag_p95_seconds", 0) or 0 for row in values), default=0),
                "max_worker_cpu_pct": max((row.get("cpu_pct", 0) for row in values), default=0),
                "max_worker_loop_lag_p95_ms": max((row.get("loop_lag_p95_ms", 0) or 0 for row in values), default=0)}

    async def probe(self):
        failures = 0
        while not self.stop.is_set():
            try:
                before = time.monotonic()
                await self.request("/healthz")
                self.last_probe = (time.monotonic() - before) * 1000
                station = json.loads(await self.request("/api/station"))
                self.public_listeners = station["listeners"]
                if not station["onAir"]:
                    self.abort("station went off air")
                failures = 0
                self.last_probe_error = None
            except Exception as error:
                failures += 1
                self.last_probe_error = str(error)
                self.log({"type": "probe_error", "error": str(error)})
                if failures >= 2:
                    self.abort("two consecutive public health/station probes failed")
            self.probe_at = time.monotonic()
            await self.pause(3)

    async def sample_loop(self):
        previous_bytes = 0
        previous_time = time.monotonic()
        degraded_at = None
        client_limited_at = None
        while not self.stop.is_set():
            now = time.monotonic()
            for index in range(len(self.workers)):
                if now - self.worker_seen.get(index, now) > 8:
                    self.abort(f"worker {index} telemetry stale")
            value = self.aggregate()
            self.total_bytes = value["bytes"]
            self.max_actual_audio = max(self.max_actual_audio, value["active_audio"])
            self.max_actual_metadata = max(self.max_actual_metadata, value["active_metadata"])
            self.max_healthy = max(self.max_healthy, value["healthy"])
            if self.total_bytes > self.args.max_gib * 1024**3:
                self.abort("global received-traffic cap reached")
            unhealthy = max(0, value["slots"] - value["healthy"])
            fraction = unhealthy / max(1, value["slots"])
            # Ignore short handshake/reconnect gaps. Pause admission immediately;
            # abort only if a broad delivery failure persists for a minute.
            if value["slots"] >= 100 and fraction > .05:
                degraded_at = degraded_at or now
                if now - degraded_at > 60:
                    self.abort("over 5% of listener slots unhealthy for 60 seconds")
            else:
                degraded_at = None
            if value["max_worker_cpu_pct"] > 90 or value["max_worker_loop_lag_p95_ms"] > 250:
                client_limited_at = client_limited_at or now
                if now - client_limited_at > 30:
                    self.abort("load-generator worker saturated for 30 seconds")
            else:
                client_limited_at = None
            cpu = (self.remote or {}).get("host_cpu_busy_pct", 0) or 0
            self.current_rate = admission_rate(self.args.rate, cpu, fraction,
                value["max_worker_media_lag_p95_seconds"], value["max_worker_cpu_pct"], value["max_worker_loop_lag_p95_ms"],
                fast=self.args.defer_metadata and self.args.rate > 20)
            value.update({"type": "sample", "elapsed_seconds": round(now - self.started, 2),
                "target": self.target, "phase": self.phase, "join_rate": self.current_rate,
                "public_listeners": self.public_listeners, "health_ms": self.last_probe,
                "health_probe_age_seconds": round(now - self.probe_at, 2) if self.probe_at else None,
                "received_mbps": round((value["bytes"] - previous_bytes) * 8 / max(.01, now - previous_time) / 1e6, 3),
                "remote": self.remote})
            self.log(value)
            self.history.append(value)
            if now - self.previous_output > 15:
                print(json.dumps({k: value[k] for k in ("elapsed_seconds", "target", "phase", "slots", "active_audio", "active_metadata", "healthy", "continuous", "join_rate", "received_mbps", "errors", "stall_events", "max_worker_media_lag_p95_seconds")}), flush=True)
                self.previous_output = now
            previous_bytes, previous_time = value["bytes"], now
            await self.pause(1)

    async def run(self):
        try:
            station = json.loads(await self.request("/api/station"))
            self.baseline_listeners = station["listeners"]
            if not station["onAir"] or station.get("locked"):
                raise ValueError("station must be public and on air")
            self.log({"type": "configuration", "arguments": vars(self.args), "baseline_listeners": self.baseline_listeners})
            await self.launch_workers()
            self.tasks.extend([asyncio.create_task(self.heartbeat()), asyncio.create_task(self.monitor_remote())])
            deadline = time.monotonic() + 15
            while not self.stop.is_set() and time.monotonic() < deadline:
                if len(self.worker_ready) == self.args.workers and len(self.worker_samples) == self.args.workers and self.remote is not None:
                    break
                await self.pause(.1)
            if self.remote is None or len(self.worker_ready) != self.args.workers or len(self.worker_samples) != self.args.workers:
                self.abort("preflight workers or remote metrics unavailable")
            self.tasks.extend([asyncio.create_task(self.loop_monitor()), asyncio.create_task(self.watchdog()),
                               asyncio.create_task(self.probe()), asyncio.create_task(self.sample_loop())])
            for index, target in enumerate(self.args.stages):
                if self.stop.is_set():
                    break
                self.target, self.phase = target, "ramp"
                await self.broadcast({"phase": "ramp", "target": target})
                print(json.dumps({"ramp_to": target}), flush=True)
                while sum(self.slots) < target and not self.stop.is_set():
                    if self.current_rate <= 0:
                        await self.pause(.5)
                        continue
                    admitted_rate = self.current_rate
                    available = [i for i, count in enumerate(self.slots) if count < 1000]
                    worker = min(available, key=lambda i: self.slots[i])
                    await self.send(worker, {"add": 1, "phase": "ramp", "target": target})
                    self.slots[worker] += 1
                    await self.pause(1 / admitted_rate)
                if self.stop.is_set():
                    break
                if self.args.defer_metadata:
                    self.phase = "metadata"
                    self.log({"type": "metadata_start", "target": target})
                    print(json.dumps({"attach_metadata_for": target}), flush=True)
                    while sum(self.metadata_slots) < target and not self.stop.is_set():
                        candidates = [i for i in range(len(self.slots)) if self.metadata_slots[i] < self.slots[i]]
                        worker = min(candidates, key=lambda i: self.metadata_slots[i])
                        await self.send(worker, {"add_metadata": 1})
                        self.metadata_slots[worker] += 1
                        await self.pause(1 / self.args.metadata_rate)
                # Give handshakes and individual recoveries a bounded settling window.
                deadline = time.monotonic() + 30
                while not self.stop.is_set() and time.monotonic() < deadline:
                    current = self.aggregate()
                    if current["active_audio"] >= target and current["active_metadata"] >= target and current["healthy"] >= target * .99:
                        break
                    await self.pause(1)
                if self.stop.is_set():
                    break
                self.phase = "hold"
                await self.broadcast({"phase": "hold", "target": target})
                hold = self.args.final_hold if index == len(self.args.stages) - 1 else self.args.hold
                self.log({"type": "hold_start", "target": target, "seconds": hold})
                started = time.monotonic()
                await self.pause(hold)
                # Worker samples lag commands by up to a second; omit that initial slice.
                observed = [r for r in self.history if r["elapsed_seconds"] > started - self.started + 2 and r["target"] == target and r["phase"] == "hold"]
                result = {"target": target, "hold_seconds": round(time.monotonic() - started, 2),
                    "completed": not self.stop.is_set(), "passed": not self.stop.is_set() and bool(observed) and all(hold_passes(r, target) for r in observed),
                    "min_active_audio": min((r["active_audio"] for r in observed), default=0),
                    "min_active_metadata": min((r["active_metadata"] for r in observed), default=0),
                    "min_healthy": min((r["healthy"] for r in observed), default=0),
                    "min_continuous": min((r["continuous"] for r in observed), default=0)}
                self.holds.append(result)
                self.log({"type": "stage", **result})
                print(json.dumps(result), flush=True)
            if not self.stop.is_set():
                self.reason = "completed requested ramp"
        except asyncio.CancelledError:
            self.reason = "interrupted"
            raise
        except Exception as error:
            self.reason = f"test setup/runtime error: {type(error).__name__}: {error}"
            raise
        finally:
            self.finished = True
            self.phase = "cleanup"
            self.stop.set()
            if self.workers:
                await self.broadcast({"stop": True})
            for process, _ in self.workers:
                if process.stdin:
                    process.stdin.close()
            for process, errors in self.workers:
                try:
                    await asyncio.wait_for(process.wait(), 8)
                except TimeoutError:
                    process.kill()
                    await process.wait()
                errors.close()
            for task in self.tasks:
                task.cancel()
            await asyncio.gather(*self.tasks, return_exceptions=True)
            if self.ssh and self.ssh.returncode is None:
                self.ssh.terminate()
                try:
                    await asyncio.wait_for(self.ssh.wait(), 5)
                except TimeoutError:
                    self.ssh.kill()
                    await self.ssh.wait()
            after = None
            for _ in range(6):
                try:
                    after = json.loads(await self.request("/api/station"))
                    if self.baseline_listeners is not None and after["listeners"] <= self.baseline_listeners:
                        break
                except Exception:
                    pass
                await asyncio.sleep(1)
            result = {"reason": self.reason, "elapsed_seconds": round(time.monotonic() - self.started, 2),
                "baseline_listeners": self.baseline_listeners, "after_listeners": after.get("listeners") if after else None,
                "max_actual_audio": self.max_actual_audio, "max_actual_metadata": self.max_actual_metadata,
                "max_healthy": self.max_healthy, "stages": self.holds,
                "worker_totals": self.aggregate(), "remote_initial": self.remote_initial,
                "arguments": vars(self.args)}
            (self.output / "summary.json").write_text(json.dumps(result, indent=2) + "\n")
            print(json.dumps({key: value for key, value in result.items() if key not in ("remote_initial", "arguments")}), flush=True)
            self.log_file.close()


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--ssh-target", required=True)
    parser.add_argument("--ssh-port", type=int, default=22)
    parser.add_argument("--sudo-metrics", action="store_true")
    parser.add_argument("--output", required=True)
    parser.add_argument("--remote-worker-dir", help="Existing isolated directory on the SSH target containing worker scripts; server-local test, not an external-network benchmark")
    parser.add_argument("--worker-url", help="Worker origin override; loopback HTTP is supported for explicitly scoped backend tests")
    parser.add_argument("--defer-metadata", action="store_true", help="Single-stage steady-capacity test: connect audio first, then attach metadata at 50/s before the hold; excludes realistic join fan-out")
    parser.add_argument("--worker-uvloop", action="store_true", help="Use explicitly installed uvloop in the worker interpreter to reduce generator CPU overhead")
    parser.add_argument("--metadata-rate", type=float, default=50, help="Global metadata attachments/s in staged startup; maximum 200")
    parser.add_argument("--workers", type=int, default=5)
    parser.add_argument("--stages", type=lambda s: [int(n) for n in s.split(',')], default=[1000, 2000, 3000, 4000, 5000])
    parser.add_argument("--rate", type=float, default=20, help="Maximum global joins/s across all workers")
    parser.add_argument("--hold", type=float, default=20)
    parser.add_argument("--final-hold", type=float, default=120)
    parser.add_argument("--max-gib", type=float, default=60)
    parser.add_argument("--max-seconds", type=float, default=1800)
    args = parser.parse_args()
    if (not 1 <= args.workers <= 5 or not args.stages or args.stages != sorted(set(args.stages))
        or min(args.stages) < 1 or max(args.stages) > min(5000, args.workers * 1000)
        or not all(math.isfinite(v) and v > 0 for v in (args.rate, args.metadata_rate, args.hold, args.final_hold, args.max_gib, args.max_seconds))
        or args.rate > (200 if args.defer_metadata else 20) or args.metadata_rate > 200 or args.max_gib > 120 or args.max_seconds > 3600
        or (args.defer_metadata and len(args.stages) != 1)):
        parser.error("use 1..5 workers, increasing stages 1..5000 (max 1000/worker), positive finite holds, global rate ≤20/s (≤200/s with staged metadata), metadata rate ≤200/s, traffic ≤120GiB, time ≤3600s")
    return args


if __name__ == "__main__":
    try:
        asyncio.run(ScaleTest(parse_args()).run())
    except KeyboardInterrupt:
        print("Interrupted; worker connections closed.")
