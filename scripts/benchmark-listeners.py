#!/usr/bin/env python3
"""Bounded external radio load test. Python 3.11+, standard library only.

Each listener holds one HTTPS audio stream and one SSE metadata connection.
This measures steady stream delivery, not asset loading or browser rendering.
"""
import argparse
import asyncio
from collections import deque
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import ssl
import struct
import time
from urllib.parse import urlsplit
import uuid


class OggContinuity:
    def __init__(self):
        self.buffer = bytearray()
        self.last = None
        self.audio_pages = 0

    def feed(self, data):
        self.buffer.extend(data)
        while len(self.buffer) >= 27:
            if self.buffer[:4] != b"OggS":
                raise ValueError("invalid Ogg page")
            header_size = 27 + self.buffer[26]
            if len(self.buffer) < header_size:
                return
            size = header_size + sum(self.buffer[27:header_size])
            if len(self.buffer) < size:
                return
            serial, sequence = struct.unpack_from("<II", self.buffer, 14)
            payload = self.buffer[header_size:size]
            if not (payload.startswith(b"OpusHead") or payload.startswith(b"OpusTags")):
                # Cached headers intentionally jump to the first current audio page.
                if self.last is not None:
                    if serial != self.last[0] or sequence != (self.last[1] + 1) % 2**32:
                        raise ValueError(f"Ogg sequence discontinuity: {self.last} -> {(serial, sequence)}")
                self.last = serial, sequence
                self.audio_pages += 1
            del self.buffer[:size]


async def body_chunks(reader, headers):
    if "chunked" in headers.get("transfer-encoding", "").lower():
        while True:
            line = await reader.readline()
            if not line:
                raise EOFError("HTTP chunk header ended early")
            size = int(line.split(b";", 1)[0].strip(), 16)
            if size < 0 or size > 4 * 1024 * 1024:
                raise ValueError("HTTP chunk exceeds benchmark bound")
            if size == 0:
                while await reader.readline() not in (b"\r\n", b""):
                    pass
                return
            remaining = size
            while remaining:
                data = await reader.readexactly(min(remaining, 65536))
                remaining -= len(data)
                yield data
            if await reader.readexactly(2) != b"\r\n":
                raise ValueError("invalid HTTP chunk delimiter")
    elif "content-length" in headers:
        remaining = int(headers["content-length"])
        while remaining:
            data = await reader.readexactly(min(remaining, 65536))
            remaining -= len(data)
            yield data
    else:
        while data := await reader.read(65536):
            yield data


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, int((len(ordered) - 1) * fraction))], 2)


def remote_failure(metrics, initial, pressure_count, cpu_limit=85):
    cpu = metrics.get("host_cpu_busy_pct")
    available = metrics.get("mem_available_mib")
    if cpu is None or available is None:
        return "critical host metrics unavailable", pressure_count
    pressure_count = pressure_count + 1 if cpu > cpu_limit or available < 1024 else 0
    if pressure_count >= 3:
        return f"sustained host CPU >{cpu_limit}% or available memory <1 GiB", pressure_count
    for name, before in initial.get("containers", {}).items():
        current = metrics.get("containers", {}).get(name, {})
        soft_limit = (before.get("fd_limits") or {}).get("soft")
        fd_count = current.get("fd_count")
        if not soft_limit or fd_count is None:
            return f"{name} open-file telemetry unavailable (use --sudo-metrics if needed)", pressure_count
        if soft_limit != "unlimited" and fd_count >= int(soft_limit) * .9:
            return f"{name} reached open-file safety threshold ({fd_count}/{soft_limit})", pressure_count
        if current.get("restart_count") != before.get("restart_count") or current.get("status") != "running":
            return f"{name} restarted or stopped", pressure_count
    return None, pressure_count


@dataclass
class Listener:
    number: int
    started: float
    audio_active: bool = False
    metadata_active: bool = False
    last_audio: float = 0
    audio_bytes: int = 0
    audio_pages: int = 0
    metadata_events: int = 0
    max_gap_seconds: float = 0
    max_gap_at_elapsed_seconds: float | None = None
    max_gap_phase: str | None = None
    max_gap_target: int | None = None

    def record_audio(self, now, benchmark_started, phase, target):
        if self.last_audio:
            gap = now - self.last_audio
            if gap > self.max_gap_seconds:
                self.max_gap_seconds = gap
                self.max_gap_at_elapsed_seconds = now - benchmark_started
                self.max_gap_phase = phase
                self.max_gap_target = target
        self.last_audio = now


class Benchmark:
    def __init__(self, args):
        self.args = args
        self.url = urlsplit(args.url)
        if self.url.scheme != "https" or not self.url.hostname or self.url.path not in ("", "/"):
            raise ValueError("--url must be an HTTPS origin")
        self.context = ssl.create_default_context()
        self.output = Path(args.output)
        self.output.mkdir(parents=True, exist_ok=False)
        self.log_file = (self.output / "samples.jsonl").open("w")
        self.capture = (self.output / "sentinel.ogg").open("wb")
        self.capture_bytes = 0
        self.started = time.monotonic()
        self.stop = asyncio.Event()
        self.reason = None
        self.finished = False
        self.listeners = []
        self.listener_tasks = []
        self.errors = []
        self.total_bytes = 0
        self.metadata_bytes = 0
        self.remote = None
        self.remote_initial = None
        self.remote_at = None
        self.ssh = None
        self.latencies = deque(maxlen=100)
        self.loop_lags = deque(maxlen=100)
        self.stages = []
        self.target = 0
        self.phase = "setup"
        self.public_listeners = None
        self.baseline_listeners = None
        self.max_active = 0
        self.cpu_started = time.process_time()
        self.last_sample = self.started
        self.last_bytes = 0
        self.last_cpu = self.cpu_started

    def log(self, record):
        record = {"at": datetime.now(timezone.utc).isoformat(), **record}
        self.log_file.write(json.dumps(record) + "\n")
        self.log_file.flush()

    def abort(self, reason):
        if not self.stop.is_set():
            self.reason = reason
            self.log({"type": "stop", "reason": reason})
            print(json.dumps({"stop": reason}), flush=True)
            self.stop.set()

    async def open(self, path):
        writer = None
        try:
            reader, writer = await asyncio.wait_for(asyncio.open_connection(
                self.url.hostname, self.url.port or 443, ssl=self.context,
                server_hostname=self.url.hostname, limit=131072), 8)
            writer.write((f"GET {path} HTTP/1.1\r\nHost: {self.url.netloc}\r\n"
                          "User-Agent: StationListenerBenchmark/1\r\nAccept-Encoding: identity\r\n"
                          "Connection: close\r\n\r\n").encode("ascii"))
            await writer.drain()
            raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 8)
            lines = raw.decode("latin-1").split("\r\n")
            if int(lines[0].split()[1]) != 200:
                raise ValueError(f"{path.split('?')[0]}: {lines[0]}")
            headers = dict((key.strip().lower(), value.strip())
                           for line in lines[1:] if ":" in line
                           for key, value in [line.split(":", 1)])
            return reader, writer, headers
        except BaseException:
            if writer:
                writer.close()
            raise

    async def request(self, path):
        reader, writer, headers = await self.open(path)
        try:
            async with asyncio.timeout(8):
                data = bytearray()
                async for part in body_chunks(reader, headers):
                    data.extend(part)
                    if len(data) > 2 * 1024 * 1024:
                        raise ValueError("API response exceeds bound")
                return bytes(data)
        finally:
            writer.close()

    async def connection(self, listener, kind):
        writer = None
        try:
            path = f"/stream?session=bench-{uuid.uuid4().hex}&burst=1000" if kind == "audio" else "/events"
            reader, writer, headers = await self.open(path)
            if kind == "audio" and "ogg" not in headers.get("content-type", ""):
                raise ValueError("continuity check currently requires the station's Ogg/Opus stream")
            setattr(listener, f"{'audio' if kind == 'audio' else 'metadata'}_active", True)
            check = OggContinuity()
            chunks = body_chunks(reader, headers).__aiter__()
            while True:
                chunk = await asyncio.wait_for(anext(chunks), 5 if kind == "audio" else 35)
                self.total_bytes += len(chunk)
                if kind == "audio":
                    now = time.monotonic()
                    listener.record_audio(now, self.started, self.phase, self.target)
                    listener.audio_bytes += len(chunk)
                    check.feed(chunk)
                    listener.audio_pages = check.audio_pages
                    if listener.number == 1 and self.capture_bytes < 16 * 1024 * 1024:
                        self.capture.write(chunk)
                        self.capture_bytes += len(chunk)
                else:
                    listener.metadata_events += chunk.count(b"event: station")
                    self.metadata_bytes += len(chunk)
                if self.total_bytes > self.args.max_gib * 1024**3:
                    self.abort("traffic cap reached")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if not self.finished:
                detail = {"listener": listener.number, "kind": kind, "error": f"{type(error).__name__}: {error}"}
                self.errors.append(detail)
                self.log({"type": "connection_error", **detail})
                self.abort(f"{kind} connection failed: {detail['error']}")
        finally:
            setattr(listener, f"{'audio' if kind == 'audio' else 'metadata'}_active", False)
            if writer:
                writer.close()
                try:
                    await asyncio.wait_for(writer.wait_closed(), 2)
                except (Exception, asyncio.CancelledError):
                    pass

    async def add_listener(self):
        listener = Listener(len(self.listeners) + 1, time.monotonic())
        self.listeners.append(listener)
        self.listener_tasks.extend(asyncio.create_task(self.connection(listener, kind)) for kind in ("audio", "metadata"))

    async def monitor_remote(self):
        collector = Path(__file__).with_name("collect-radio-metrics.py").read_bytes()
        remote_command = "sudo -n python3 -u -" if self.args.sudo_metrics else "python3 -u -"
        self.ssh = await asyncio.create_subprocess_exec(
            "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", str(self.args.ssh_port),
            self.args.ssh_target, remote_command, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        self.ssh.stdin.write(collector)
        await self.ssh.stdin.drain()
        self.ssh.stdin.close()
        pressure_count = 0
        try:
            while line := await self.ssh.stdout.readline():
                record = json.loads(line)
                self.log({"type": "remote", "data": record})
                if record.get("type") == "initial":
                    self.remote_initial = record
                elif record.get("type") == "sample":
                    self.remote = record
                    self.remote_at = time.monotonic()
                    reason, pressure_count = remote_failure(record, self.remote_initial or {}, pressure_count,
                        cpu_limit=getattr(self.args, "host_cpu_limit", 85))
                    if reason:
                        self.abort(reason)
            if not self.finished:
                self.abort("remote telemetry connection ended")
        except Exception as error:
            self.abort(f"remote telemetry failed: {error}")

    async def loop_monitor(self):
        while True:
            started = time.monotonic()
            await asyncio.sleep(0.2)
            self.loop_lags.append(max(0, time.monotonic() - started - 0.2) * 1000)

    async def watchdog(self):
        # Never depend on HTTP probes: they may stall at precisely the moment
        # the resource guards are needed. The remote reader checks FD/CPU/memory.
        while not self.stop.is_set():
            if time.monotonic() - self.started > self.args.max_seconds:
                self.abort("time cap reached")
            if self.remote_at is None or time.monotonic() - self.remote_at > 6:
                self.abort("remote telemetry missing or stale")
            if (percentile(self.loop_lags, .95) or 0) > 250:
                self.abort("load-generator event loop saturated")
            await self.pause(.25)

    async def sampler(self):
        failed_health = 0
        while not self.stop.is_set():
            try:
                before = time.monotonic()
                await self.request("/healthz")
                latency = (time.monotonic() - before) * 1000
                self.latencies.append(latency)
                station = json.loads(await self.request("/api/station"))
                self.public_listeners = station["listeners"]
                if not station["onAir"]:
                    self.abort("station went off air")
                failed_health = 0
            except Exception as error:
                failed_health += 1
                self.log({"type": "probe_error", "error": str(error)})
                if failed_health >= 2:
                    self.abort("two consecutive health probes failed")
            now = time.monotonic()
            active = sum(listener.audio_active for listener in self.listeners)
            self.max_active = max(self.max_active, active)
            cpu = time.process_time()
            record = {"type": "sample", "elapsed_seconds": round(now - self.started, 2),
                      "target": self.target, "phase": self.phase, "active_audio": active,
                      "active_metadata": sum(listener.metadata_active for listener in self.listeners),
                      "public_listeners": self.public_listeners,
                      "received_mbps": round((self.total_bytes - self.last_bytes) * 8 / (now - self.last_sample) / 1e6, 3),
                      "total_mib": round(self.total_bytes / 1024**2, 2),
                      "health_ms": round(latency, 2) if failed_health == 0 else None,
                      "generator_cpu_pct": round((cpu - self.last_cpu) / (now - self.last_sample) * 100, 2),
                      "loop_lag_p95_ms": percentile(self.loop_lags, 0.95),
                      "remote": self.remote}
            self.log(record)
            self.last_sample, self.last_bytes, self.last_cpu = now, self.total_bytes, cpu
            if len(self.latencies) >= 5 and percentile(list(self.latencies)[-5:], .5) > 1500:
                self.abort("sustained health response time >1.5 seconds")
            await self.pause(2)

    async def pause(self, seconds):
        try:
            await asyncio.wait_for(self.stop.wait(), seconds)
        except TimeoutError:
            pass

    async def run(self):
        monitor_tasks = []
        try:
            baseline = json.loads(await self.request("/api/station"))
            self.baseline_listeners = baseline["listeners"]
            if not baseline["onAir"] or baseline.get("locked"):
                raise ValueError("station must be public and on air")
            self.log({"type": "configuration", "arguments": vars(self.args), "baseline": baseline})
            monitor_tasks.append(asyncio.create_task(self.monitor_remote()))
            for _ in range(100):
                if self.remote is not None or self.stop.is_set():
                    break
                await asyncio.sleep(.1)
            if self.remote is None:
                self.abort("could not obtain initial remote telemetry")
            monitor_tasks.extend([asyncio.create_task(self.loop_monitor()), asyncio.create_task(self.sampler()),
                                  asyncio.create_task(self.watchdog())])
            for index, target in enumerate(self.args.stages):
                if self.stop.is_set():
                    break
                self.target = target
                self.phase = "ramp"
                print(json.dumps({"ramp_to": target}), flush=True)
                while len(self.listeners) < target and not self.stop.is_set():
                    await self.add_listener()
                    # Approach the likely file/socket ceiling slowly enough for
                    # the two-second remote sampler to stop before exhaustion.
                    rate = min(self.args.rate, 5) if len(self.listeners) >= 300 else self.args.rate
                    await self.pause(1 / rate)
                # Wait for the last TLS handshakes before starting the hold.
                deadline = time.monotonic() + 12
                while not self.stop.is_set() and time.monotonic() < deadline:
                    if all(l.audio_active and l.metadata_active and l.audio_pages > 0 for l in self.listeners):
                        break
                    await self.pause(.1)
                if any(not l.audio_active or not l.metadata_active or not l.audio_pages for l in self.listeners):
                    self.abort("listeners failed to reach a ready state")
                hold = self.args.final_hold if index == len(self.args.stages) - 1 else self.args.hold
                started = time.monotonic()
                self.phase = "hold"
                self.log({"type": "hold_start", "target": target, "seconds": hold})
                await self.pause(hold)
                passed = not self.stop.is_set()
                worst_gap = max(self.listeners, key=lambda listener: listener.max_gap_seconds, default=None)
                stage = {"target": target, "hold_seconds": round(time.monotonic() - started, 2), "passed": passed,
                         "max_audio_gap_seconds": round(worst_gap.max_gap_seconds, 3) if worst_gap else 0,
                         "max_audio_gap_at_elapsed_seconds": worst_gap.max_gap_at_elapsed_seconds if worst_gap else None,
                         "max_audio_gap_phase": worst_gap.max_gap_phase if worst_gap else None,
                         "max_audio_gap_target": worst_gap.max_gap_target if worst_gap else None}
                self.stages.append(stage)
                self.log({"type": "stage", **stage})
                print(json.dumps(stage), flush=True)
            if not self.stop.is_set():
                self.reason = "completed requested ramp"
        except asyncio.CancelledError:
            self.reason = "interrupted"
            raise
        finally:
            self.finished = True
            self.stop.set()
            for task in self.listener_tasks + monitor_tasks:
                task.cancel()
            await asyncio.gather(*self.listener_tasks, *monitor_tasks, return_exceptions=True)
            if self.ssh and self.ssh.returncode is None:
                self.ssh.terminate()
                try:
                    await asyncio.wait_for(self.ssh.wait(), 5)
                except TimeoutError:
                    self.ssh.kill()
                    await self.ssh.wait()
            self.capture.close()
            after = None
            for _ in range(6):
                try:
                    after = json.loads(await self.request("/api/station"))
                    if self.baseline_listeners is not None and after["listeners"] <= self.baseline_listeners:
                        break
                except Exception:
                    pass
                await asyncio.sleep(1)
            summary = {"url": self.args.url, "reason": self.reason,
                       "elapsed_seconds": round(time.monotonic() - self.started, 2),
                       "baseline_listeners": self.baseline_listeners, "after_listeners": after.get("listeners") if after else None,
                       "highest_active_simulated_listeners": self.max_active, "stages": self.stages,
                       "received_gib": round(self.total_bytes / 1024**3, 3),
                       "metadata_mib": round(self.metadata_bytes / 1024**2, 2),
                       "connection_errors": self.errors, "remote_initial": self.remote_initial,
                       "listeners": [asdict(listener) for listener in self.listeners]}
            (self.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
            self.log_file.close()
            print(json.dumps({k: v for k, v in summary.items() if k not in ("listeners", "remote_initial")}), flush=True)


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="Your own public HTTPS station origin")
    parser.add_argument("--ssh-target", required=True, help="Read-only telemetry target, e.g. ubuntu@your-vps")
    parser.add_argument("--ssh-port", type=int, default=22)
    parser.add_argument("--sudo-metrics", action="store_true", help="Read process FD counts with existing passwordless sudo")
    parser.add_argument("--output", required=True, help="New directory for JSONL, summary and bounded Ogg sentinel")
    parser.add_argument("--stages", type=lambda value: [int(item) for item in value.split(",")], default=[1, 10, 25, 50, 100, 200, 400, 600, 800, 1000])
    parser.add_argument("--rate", type=float, default=20, help="New listeners per second")
    parser.add_argument("--hold", type=float, default=25, help="Seconds per intermediate stage")
    parser.add_argument("--final-hold", type=float, default=120)
    parser.add_argument("--max-gib", type=float, default=4, help="Received audio + metadata traffic cap (default 4 GiB; maximum 8 GiB)")
    parser.add_argument("--max-seconds", type=float, default=720)
    args = parser.parse_args()
    finite = all(math.isfinite(value) for value in
                 (args.rate, args.hold, args.final_hold, args.max_gib, args.max_seconds))
    if (not finite or not args.stages or args.stages != sorted(set(args.stages)) or min(args.stages) < 1
            or max(args.stages) > 1000 or not 0 < args.rate <= 20
            or min(args.hold, args.final_hold, args.max_gib, args.max_seconds) <= 0
            or args.max_gib > 8 or args.max_seconds > 720):
        parser.error("use increasing stages 1..1000, rate ≤20/s, positive holds, traffic ≤8 GiB and time ≤720s")
    return args


if __name__ == "__main__":
    try:
        asyncio.run(Benchmark(parse_args()).run())
    except KeyboardInterrupt:
        print("Interrupted; listener connections closed.")
