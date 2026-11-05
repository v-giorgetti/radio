#!/usr/bin/env python3
"""External radio load worker; controlled by newline-delimited JSON on stdin."""
import argparse
import asyncio
from collections import deque
from dataclasses import dataclass, field
import importlib.util
import json
import math
from pathlib import Path
import random
import resource
import signal
import ssl
import struct
import sys
import time
from urllib.parse import urlsplit
import uuid


_spec = importlib.util.spec_from_file_location("radio_http", Path(__file__).with_name("benchmark-listeners.py"))
_http = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _http
_spec.loader.exec_module(_http)
body_chunks = _http.body_chunks
AUDIO_SOFT_STALL_SECONDS = 5
AUDIO_HARD_STALL_SECONDS = 20


def percentile(values, fraction):
    values = sorted(values)
    return values[min(len(values) - 1, math.ceil(len(values) * fraction) - 1)] if values else None


def heartbeat_expired(now, last):
    return now - last > 10


class Discontinuity(ValueError):
    pass


class MediaLagReconnect(RuntimeError):
    pass


class OggMediaClock:
    """Check sequence continuity and measure delay against the best observed delivery."""
    def __init__(self):
        self.buffer = bytearray()
        self.sequence = None
        self.pages = 0
        self.first_time = None
        self.first_granule = None
        self.last_granule = None
        self.baseline = 0.0

    def feed(self, data, now):
        self.buffer.extend(data)
        count = 0
        while len(self.buffer) >= 27:
            if self.buffer[:4] != b"OggS" or self.buffer[4] != 0:
                raise ValueError("invalid Ogg page")
            header_size = 27 + self.buffer[26]
            if len(self.buffer) < header_size:
                break
            size = header_size + sum(self.buffer[27:header_size])
            if len(self.buffer) < size:
                break
            granule, serial, sequence = struct.unpack_from("<QII", self.buffer, 6)
            payload = self.buffer[header_size:size]
            if not payload.startswith((b"OpusHead", b"OpusTags")):
                if self.sequence is not None and (serial != self.sequence[0] or sequence != (self.sequence[1] + 1) % 2**32):
                    raise Discontinuity(f"Ogg page sequence {self.sequence} -> {(serial, sequence)}")
                self.sequence = serial, sequence
                self.pages += 1
                count += 1
                if granule != 2**64 - 1:
                    if self.last_granule is not None and granule < self.last_granule:
                        raise Discontinuity("Ogg granule moved backwards")
                    self.last_granule = granule
            del self.buffer[:size]
        if count and self.last_granule is not None:
            if self.first_time is None:
                # Several cached startup pages may arrive in the first read.
                self.first_time, self.first_granule = now, self.last_granule
            self.baseline = min(self.baseline, self.raw_lag(now))
        return count

    def raw_lag(self, now):
        if self.first_time is None:
            return None
        return now - self.first_time - (self.last_granule - self.first_granule) / 48000

    def lag(self, now):
        raw = self.raw_lag(now)
        return max(0.0, raw - self.baseline) if raw is not None else None


@dataclass
class Slot:
    number: int
    audio_active: bool = False
    metadata_active: bool = False
    metadata_scheduled: bool = False
    last_audio: float | None = None
    last_metadata: float | None = None
    continuous: bool = False
    lag_degraded: bool = False
    lag_degraded_at: float | None = None
    clock: OggMediaClock = field(default_factory=OggMediaClock)
    max_gap_seconds: float = 0

    def healthy_audio(self, now):
        lag = self.clock.lag(now)
        return (self.audio_active and self.last_audio is not None and now - self.last_audio < AUDIO_SOFT_STALL_SECONDS
                and (lag is None or lag <= 5))

    def healthy_metadata(self, now):
        return self.metadata_active and self.last_metadata is not None and now - self.last_metadata < 35

    def reset_hold(self, now):
        self.continuous = self.healthy_audio(now) and self.healthy_metadata(now)

    def observe_lag(self, now):
        lag = self.clock.lag(now)
        if lag is not None and lag > 5:
            if self.lag_degraded_at is None:
                self.lag_degraded_at = now
            self.lag_degraded = True
            self.continuous = False
            return now - self.lag_degraded_at >= 20
        self.lag_degraded = False
        self.lag_degraded_at = None
        return False


class Worker:
    def __init__(self, args):
        self.args = args
        self.defer_metadata = getattr(args, "defer_metadata", False)
        self.origin = urlsplit(args.url)
        self.context = ssl.create_default_context()
        self.output = Path(args.output)
        self.output.mkdir(parents=True, exist_ok=False)
        self.errors_file = (self.output / "errors.jsonl").open("w")
        self.stop = asyncio.Event()
        self.slots = []
        self.tasks = []
        self.phase, self.target = "ramp", 0
        self.started = self.last_heartbeat = time.monotonic()
        self.bytes = self.metadata_bytes = self.audio_pages = 0
        self.errors = self.reconnects = self.stall_events = self.discontinuities = 0
        self.reconnect_semaphore = asyncio.Semaphore(2)
        self.reconnect_lock = asyncio.Lock()
        self.next_reconnect = 0
        self.loop_lags = deque(maxlen=100)
        self.capture_bytes = 0
        self.loop_info = None

    def emit(self, record):
        try:
            print(json.dumps(record, separators=(",", ":"), allow_nan=False), flush=True)
        except BrokenPipeError:
            self.stop.set()

    def event(self, event_type, slot=None, **details):
        self.errors_file.write(json.dumps({"elapsed_seconds": round(time.monotonic() - self.started, 3),
            "type": event_type, "worker_id": self.args.worker_id, "slot": slot.number if slot else None,
            "phase": self.phase, "target": self.target, **details}) + "\n")
        self.errors_file.flush()

    async def pause(self, seconds):
        try:
            await asyncio.wait_for(self.stop.wait(), seconds)
        except TimeoutError:
            pass

    def set_phase(self, phase, target):
        if phase == "hold" and (self.phase != "hold" or target != self.target):
            now = time.monotonic()
            for slot in self.slots:
                slot.reset_hold(now)
        self.phase, self.target = phase, target

    def apply_command(self, command):
        if not isinstance(command, dict):
            raise ValueError("control command must be an object")
        if command.get("stop") is True:
            self.stop.set()
            return
        phase, target = command.get("phase", self.phase), command.get("target", self.target)
        add, add_metadata = command.get("add", 0), command.get("add_metadata", 0)
        available_metadata = sum(not slot.metadata_scheduled for slot in self.slots)
        if self.defer_metadata and isinstance(add, int) and not isinstance(add, bool):
            available_metadata += add
        if (phase not in ("ramp", "hold") or not isinstance(target, int) or isinstance(target, bool)
                or not 0 <= target <= 5000 or not isinstance(add, int) or isinstance(add, bool)
                or not 0 <= add <= 1000 - len(self.slots)
                or not isinstance(add_metadata, int) or isinstance(add_metadata, bool)
                or not 0 <= add_metadata <= available_metadata):
            raise ValueError("invalid phase, target, slot count, or metadata count")
        self.set_phase(phase, target)
        for _ in range(add):
            slot = Slot(len(self.slots) + 1)
            self.slots.append(slot)
            self.tasks.append(asyncio.create_task(self.connection(slot, "audio")))
            if not self.defer_metadata:
                self.schedule_metadata(slot)
        for slot in (slot for slot in self.slots if not slot.metadata_scheduled):
            if add_metadata == 0:
                break
            self.schedule_metadata(slot)
            add_metadata -= 1

    def schedule_metadata(self, slot):
        slot.metadata_scheduled = True
        self.tasks.append(asyncio.create_task(self.connection(slot, "metadata")))

    async def control(self):
        reader = asyncio.StreamReader(limit=65536)
        protocol = asyncio.StreamReaderProtocol(reader)
        transport, _ = await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin.buffer)
        try:
            while not self.stop.is_set():
                line = await reader.readline()
                if not line:
                    self.event("coordinator_eof")
                    self.stop.set()
                    return
                command = json.loads(line)
                self.last_heartbeat = time.monotonic()
                self.apply_command(command)
        except (ValueError, OSError) as error:
            self.event("control_error", error=str(error))
            self.stop.set()
        finally:
            transport.close()

    async def watchdog(self):
        while not self.stop.is_set():
            if heartbeat_expired(time.monotonic(), self.last_heartbeat):
                self.event("coordinator_heartbeat_timeout")
                self.stop.set()
            await self.pause(.25)

    async def loop_monitor(self):
        while not self.stop.is_set():
            before = time.monotonic()
            await self.pause(.2)
            self.loop_lags.append(max(0, time.monotonic() - before - .2) * 1000)

    async def reconnect_open(self, path):
        # Limit only connection establishment, never hold a permit for a live stream.
        async with self.reconnect_semaphore:
            async with self.reconnect_lock:
                await self.pause(max(0, self.next_reconnect - time.monotonic()))
                self.next_reconnect = time.monotonic() + 1
            if self.stop.is_set():
                raise asyncio.CancelledError
            self.reconnects += 1
            return await self.open(path)

    async def open(self, path):
        writer = None
        try:
            https = self.origin.scheme == "https"
            transport_options = {"ssl": self.context, "server_hostname": self.origin.hostname} if https else {}
            reader, writer = await asyncio.wait_for(asyncio.open_connection(
                self.origin.hostname, self.origin.port or (443 if https else 80),
                limit=131072, **transport_options), 8)
            writer.write((f"GET {path} HTTP/1.1\r\nHost: {self.origin.netloc}\r\n"
                          "User-Agent: StationScaleWorker/1\r\nAccept-Encoding: identity\r\n"
                          "Connection: close\r\n\r\n").encode("ascii"))
            await writer.drain()
            raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 8)
            lines = raw.decode("latin-1").split("\r\n")
            if int(lines[0].split()[1]) != 200:
                raise ValueError(lines[0])
            headers = {key.strip().lower(): value.strip() for line in lines[1:] if ":" in line
                       for key, value in [line.split(":", 1)]}
            return reader, writer, headers
        except BaseException:
            if writer:
                writer.close()
            raise

    async def audio(self, slot, chunks, capture):
        progress = time.monotonic()
        warned = False
        pending = None
        try:
            while not self.stop.is_set():
                if pending is None:
                    pending = asyncio.create_task(anext(chunks))
                due = AUDIO_HARD_STALL_SECONDS if warned else AUDIO_SOFT_STALL_SECONDS
                try:
                    chunk = await asyncio.wait_for(asyncio.shield(pending), max(.01, due - (time.monotonic() - progress)))
                except TimeoutError:
                    age = time.monotonic() - progress
                    if age >= AUDIO_HARD_STALL_SECONDS:
                        raise TimeoutError("no valid audio page for 20 seconds")
                    if age >= AUDIO_SOFT_STALL_SECONDS and not warned:
                        warned = True
                        slot.continuous = False
                        self.stall_events += 1
                        self.event("audio_stall", slot, seconds=round(age, 3), pages=slot.clock.pages)
                    continue
                pending = None
                self.bytes += len(chunk)
                now = time.monotonic()
                count = slot.clock.feed(chunk, now)
                if capture and self.capture_bytes < 16 * 1024 * 1024:
                    part = chunk[:16 * 1024 * 1024 - self.capture_bytes]
                    capture.write(part)
                    self.capture_bytes += len(part)
                if count:
                    if slot.last_audio is not None:
                        slot.max_gap_seconds = max(slot.max_gap_seconds, now - slot.last_audio)
                    slot.last_audio = progress = now
                    slot.audio_active = True
                    warned = False
                    self.audio_pages += count
                    if slot.observe_lag(now):
                        raise MediaLagReconnect("media lag exceeded 5 seconds for 20 seconds")
        finally:
            if pending is not None:
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)

    async def metadata(self, slot, chunks):
        while not self.stop.is_set():
            chunk = await asyncio.wait_for(anext(chunks), 35)
            self.bytes += len(chunk)
            self.metadata_bytes += len(chunk)
            slot.last_metadata = time.monotonic()
            slot.metadata_active = True

    async def connection(self, slot, kind):
        attempt = 0
        while not self.stop.is_set():
            writer = capture = None
            connected_at = None
            if attempt:
                await self.pause(min(8, 2**min(attempt - 1, 3)) + random.uniform(0, .5))
                if self.stop.is_set():
                    return
            try:
                path = f"/stream?session=scale-{uuid.uuid4().hex}&burst=1000" if kind == "audio" else "/events"
                reader, writer, headers = await (self.reconnect_open(path) if attempt else self.open(path))
                connected_at = time.monotonic()
                chunks = body_chunks(reader, headers).__aiter__()
                if kind == "audio":
                    if "ogg" not in headers.get("content-type", ""):
                        raise ValueError("expected Ogg/Opus audio")
                    slot.clock = OggMediaClock()
                    slot.last_audio = None
                    slot.lag_degraded = False
                    slot.lag_degraded_at = None
                    if self.args.worker_id == 0 and slot.number == 1 and self.capture_bytes < 16 * 1024 * 1024:
                        capture = (self.output / f"sentinel-attempt-{attempt:04d}-{uuid.uuid4().hex[:8]}.ogg").open("wb")
                    await self.audio(slot, chunks, capture)
                else:
                    await self.metadata(slot, chunks)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                self.errors += 1
                slot.continuous = False
                if isinstance(error, Discontinuity):
                    self.discontinuities += 1
                if isinstance(error, MediaLagReconnect):
                    self.event("media_lag_reconnect", slot, seconds=slot.clock.lag(time.monotonic()))
                self.event("connection_error", slot, kind=kind, error=f"{type(error).__name__}: {error}", pages=slot.clock.pages)
            finally:
                setattr(slot, "audio_active" if kind == "audio" else "metadata_active", False)
                if capture:
                    capture.close()
                if writer:
                    writer.close()
                    try:
                        await asyncio.wait_for(writer.wait_closed(), 2)
                    except (Exception, asyncio.CancelledError):
                        pass
            attempt = 1 if connected_at is not None and time.monotonic() - connected_at > 10 else attempt + 1

    def sample(self, now, cpu_pct):
        lags = []
        for slot in self.slots:
            lag = slot.clock.lag(now) if slot.audio_active else None
            if lag is not None:
                lags.append(lag)
                was_degraded = slot.lag_degraded
                slot.observe_lag(now)
                if slot.lag_degraded and not was_degraded:
                    self.event("media_lag", slot, seconds=round(lag, 3))
            if self.phase == "hold" and not (slot.healthy_audio(now) and slot.healthy_metadata(now)):
                slot.continuous = False
        return {"type": "sample", "worker_id": self.args.worker_id, "slots": len(self.slots),
            "active_audio": sum(s.audio_active for s in self.slots),
            "active_metadata": sum(s.metadata_active for s in self.slots),
            "healthy_audio": sum(s.healthy_audio(now) for s in self.slots),
            "healthy_metadata": sum(s.healthy_metadata(now) for s in self.slots),
            "healthy": sum(s.healthy_audio(now) and s.healthy_metadata(now) for s in self.slots),
            "continuously_healthy": sum(s.continuous and s.healthy_audio(now) and s.healthy_metadata(now) for s in self.slots) if self.phase == "hold" else 0,
            "bytes": self.bytes, "metadata_bytes": self.metadata_bytes, "audio_pages": self.audio_pages,
            "errors": self.errors, "reconnects": self.reconnects, "stall_events": self.stall_events,
            "discontinuities": self.discontinuities,
            "media_lag_p50_seconds": percentile(lags, .5), "media_lag_p95_seconds": percentile(lags, .95),
            "max_gap_seconds": max((s.max_gap_seconds for s in self.slots), default=0),
            "cpu_pct": cpu_pct, "loop_lag_p95_ms": percentile(self.loop_lags, .95),
            "rss_mib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1048576 if sys.platform == "darwin" else 1024)}

    async def sampler(self):
        before, cpu = time.monotonic(), time.process_time()
        while not self.stop.is_set():
            await self.pause(1)
            now, current_cpu = time.monotonic(), time.process_time()
            self.emit(self.sample(now, 100 * (current_cpu - cpu) / max(.001, now - before)))
            before, cpu = now, current_cpu

    async def run(self):
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, self.stop.set)
        ready = {"type": "ready", "worker_id": self.args.worker_id, "slots": 0}
        if self.defer_metadata:
            ready["defer_metadata"] = True
        if self.loop_info:
            ready.update(self.loop_info)
        self.emit(ready)
        monitors = [asyncio.create_task(task()) for task in (self.control, self.watchdog, self.loop_monitor, self.sampler)]
        # Any unexpected monitor exit also fails closed instead of orphaning load.
        for task in monitors:
            task.add_done_callback(lambda _: self.stop.set())
        try:
            await self.stop.wait()
        finally:
            self.stop.set()
            for task in self.tasks + monitors:
                task.cancel()
            await asyncio.gather(*self.tasks, *monitors, return_exceptions=True)
            self.errors_file.close()


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--worker-id", type=int, choices=range(5), required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--defer-metadata", action="store_true", help="Connect audio first; attach SSE with add_metadata commands")
    parser.add_argument("--uvloop", action="store_true", help="Explicitly use installed uvloop; fail if unavailable")
    args = parser.parse_args()
    origin = urlsplit(args.url)
    allowed_transport = origin.scheme == "https" or (origin.scheme == "http" and origin.hostname in ("127.0.0.1", "::1"))
    if (not allowed_transport or not origin.hostname or origin.path not in ("", "/")
            or origin.username is not None or origin.password is not None or "?" in args.url or "#" in args.url):
        parser.error("--url must be an HTTPS origin or HTTP on literal 127.0.0.1 or ::1")
    soft, _ = resource.getrlimit(resource.RLIMIT_NOFILE)
    if soft != resource.RLIM_INFINITY and soft <= 2200:
        parser.error("worker needs an open-file soft limit above 2200")
    return args


def run_worker(args):
    if getattr(args, "uvloop", False):
        try:
            uvloop = importlib.import_module("uvloop")
        except ImportError as error:
            raise SystemExit("--uvloop was requested but uvloop is unavailable in this Python environment") from error
        instance = Worker(args)
        instance.loop_info = {"loop_implementation": "uvloop", "loop_version": uvloop.__version__}
        return uvloop.run(instance.run())
    return asyncio.run(Worker(args).run())


if __name__ == "__main__":
    try:
        run_worker(parse_args())
    except KeyboardInterrupt:
        pass
