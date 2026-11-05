"""Local checks for worker media clocks, stream recovery, and fail-closed IPC."""
import argparse
import asyncio
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, Mock, patch


spec = importlib.util.spec_from_file_location("radio_worker", Path(__file__).with_name("radio-load-worker.py"))
worker = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = worker
spec.loader.exec_module(worker)


def page(sequence, granule, payload=b"audio", serial=7):
    return (b"OggS\x00\x00" + struct.pack("<QII", granule, serial, sequence)
            + bytes(4) + bytes([1, len(payload)]) + payload)


class ClockTests(unittest.TestCase):
    def test_headers_and_fragmented_startup_burst_do_not_create_media_lag(self):
        clock = worker.OggMediaClock()
        data = page(0, 0, b"OpusHead") + page(1, 0, b"OpusTags") + page(40, 9600) + page(41, 19200)
        for start in range(0, len(data), 7):
            clock.feed(data[start:start + 7], 100)
        self.assertEqual(clock.pages, 2)
        self.assertEqual(clock.lag(100), 0)
        clock.feed(page(42, 28800), 100.2)
        self.assertAlmostEqual(clock.lag(100.2), 0)
        clock.feed(page(43, 38400), 106.4)
        self.assertAlmostEqual(clock.lag(106.4), 6)

    def test_cached_pages_in_later_reads_use_a_running_baseline(self):
        clock = worker.OggMediaClock()
        clock.feed(page(40, 9600), 10)
        clock.feed(page(41, 19200) + page(42, 28800), 10.01)
        self.assertEqual(clock.lag(10.01), 0)
        clock.feed(page(43, 38400), 10.21)
        self.assertAlmostEqual(clock.lag(10.21), 0)

    def test_missing_page_and_backwards_granule_are_rejected(self):
        for following in (page(42, 19200), page(41, 9000)):
            with self.subTest(following=following):
                clock = worker.OggMediaClock()
                clock.feed(page(40, 9600), 1)
                with self.assertRaises(worker.Discontinuity):
                    clock.feed(following, 1.2)


class HealthTests(unittest.TestCase):
    def slot(self):
        slot = worker.Slot(1, audio_active=True, metadata_active=True, last_audio=10, last_metadata=10)
        slot.clock.feed(page(40, 9600), 10)
        return slot

    def test_hold_reset_restores_only_currently_healthy_slots(self):
        slot = self.slot()
        slot.reset_hold(11)
        self.assertTrue(slot.continuous)
        slot.continuous = False
        self.assertFalse(slot.continuous)
        slot.reset_hold(12)
        self.assertTrue(slot.continuous)
        slot.reset_hold(16)
        self.assertFalse(slot.continuous)

    def test_recent_bytes_with_old_media_are_not_healthy(self):
        slot = self.slot()
        slot.clock.feed(page(41, 19200), 16)
        slot.last_audio = 16
        self.assertFalse(slot.healthy_audio(16))

    def test_heartbeat_allows_ten_seconds_and_then_expires(self):
        self.assertFalse(worker.heartbeat_expired(110, 100))
        self.assertTrue(worker.heartbeat_expired(110.01, 100))

    def test_persistent_lag_requests_reconnect_after_twenty_seconds(self):
        slot = self.slot()
        slot.continuous = True
        with patch.object(slot.clock, "lag", return_value=6):
            self.assertFalse(slot.observe_lag(10))
            self.assertFalse(slot.continuous)
            self.assertEqual(slot.lag_degraded_at, 10)
            self.assertFalse(slot.observe_lag(29.99))
            self.assertTrue(slot.observe_lag(30))

    def test_lag_recovery_restarts_the_persistence_timer(self):
        slot = self.slot()
        with patch.object(slot.clock, "lag", return_value=6):
            slot.observe_lag(10)
        with patch.object(slot.clock, "lag", return_value=4):
            self.assertFalse(slot.observe_lag(29))
            self.assertIsNone(slot.lag_degraded_at)
            self.assertFalse(slot.lag_degraded)
        with patch.object(slot.clock, "lag", return_value=6):
            self.assertFalse(slot.observe_lag(30))
            self.assertEqual(slot.lag_degraded_at, 30)
            self.assertFalse(slot.observe_lag(49.99))
            self.assertTrue(slot.observe_lag(50))


class OriginTests(unittest.TestCase):
    def parse(self, url, *options):
        argv = ["radio-load-worker.py", "--url", url, "--worker-id", "0", "--output", "/tmp/unused-worker-test", *options]
        with patch.object(sys, "argv", argv), patch.object(worker.resource, "getrlimit", return_value=(8192, 8192)), contextlib.redirect_stderr(io.StringIO()):
            return worker.parse_args()

    def test_https_and_literal_loopback_http_origins_are_allowed(self):
        for url in ("https://radio.example", "http://127.0.0.1:6790", "http://[::1]:6790/"):
            with self.subTest(url=url):
                self.assertEqual(self.parse(url).url, url)

    def test_metadata_deferral_requires_explicit_flag(self):
        self.assertFalse(self.parse("https://radio.example").defer_metadata)
        self.assertTrue(self.parse("https://radio.example", "--defer-metadata").defer_metadata)

    def test_uvloop_requires_explicit_flag(self):
        self.assertFalse(self.parse("https://radio.example").uvloop)
        self.assertTrue(self.parse("https://radio.example", "--uvloop").uvloop)

    def test_public_http_and_non_origin_urls_are_rejected(self):
        urls = ("http://radio.example", "http://localhost", "http://127.1", "http://[::ffff:127.0.0.1]",
                "http://user@127.0.0.1", "http://@127.0.0.1", "http://127.0.0.1?x=1",
                "http://127.0.0.1#fragment", "http://127.0.0.1/stream", "https://user@radio.example",
                "https://radio.example?", "https://radio.example#", "https://radio.example/path")
        for url in urls:
            with self.subTest(url=url), self.assertRaises(SystemExit):
                self.parse(url)


class EventLoopTests(unittest.TestCase):
    def test_missing_uvloop_fails_before_creating_worker_output(self):
        with patch.object(worker.importlib, "import_module", side_effect=ModuleNotFoundError("uvloop")), patch.object(worker, "Worker") as factory:
            with self.assertRaisesRegex(SystemExit, "requested but uvloop is unavailable"):
                worker.run_worker(argparse.Namespace(uvloop=True))
        factory.assert_not_called()

    def test_opt_in_routes_through_uvloop_run_and_records_version(self):
        fake_loop = Mock(__version__="0.23.0")
        instance = Mock()
        with patch.object(worker.importlib, "import_module", return_value=fake_loop) as load, patch.object(worker, "Worker", return_value=instance):
            worker.run_worker(argparse.Namespace(uvloop=True))
        load.assert_called_once_with("uvloop")
        fake_loop.run.assert_called_once_with(instance.run.return_value)
        self.assertEqual(instance.loop_info, {"loop_implementation": "uvloop", "loop_version": "0.23.0"})

    def test_default_routes_through_stdlib_without_importing_uvloop(self):
        instance = Mock()
        with patch.object(worker.importlib, "import_module") as load, patch.object(worker, "Worker", return_value=instance), patch.object(worker.asyncio, "run") as run:
            worker.run_worker(argparse.Namespace(uvloop=False))
        load.assert_not_called()
        run.assert_called_once_with(instance.run.return_value)


class WorkerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.instance = worker.Worker(argparse.Namespace(url="https://radio.example", worker_id=1,
                                                        output=str(Path(self.temp.name) / "output")))

    async def asyncTearDown(self):
        for task in self.instance.tasks:
            task.cancel()
        await asyncio.gather(*self.instance.tasks, return_exceptions=True)
        self.instance.errors_file.close()
        self.temp.cleanup()

    async def test_ready_includes_requested_loop_audit_fields(self):
        self.instance.loop_info = {"loop_implementation": "uvloop", "loop_version": "0.23.0"}
        ready = []

        def emit(record):
            ready.append(record)
            self.instance.stop.set()

        with patch.object(self.instance, "emit", side_effect=emit):
            await self.instance.run()
        self.assertEqual(ready[0]["loop_implementation"], "uvloop")
        self.assertEqual(ready[0]["loop_version"], "0.23.0")

    async def test_default_add_starts_audio_and_metadata(self):
        with patch.object(self.instance, "connection", new_callable=AsyncMock) as connect:
            self.instance.apply_command({"add": 2, "phase": "ramp", "target": 200})
        self.assertEqual([(call.args[0].number, call.args[1]) for call in connect.call_args_list],
                         [(1, "audio"), (1, "metadata"), (2, "audio"), (2, "metadata")])
        self.assertTrue(all(slot.metadata_scheduled for slot in self.instance.slots))
        self.assertFalse(any(slot.metadata_active for slot in self.instance.slots))

    async def test_deferred_metadata_attaches_oldest_missing_slots_once(self):
        self.instance.defer_metadata = True
        with patch.object(self.instance, "connection", new_callable=AsyncMock) as connect:
            self.instance.apply_command({"add": 3})
            self.assertEqual([call.args[1] for call in connect.call_args_list], ["audio"] * 3)
            self.assertFalse(any(slot.metadata_scheduled for slot in self.instance.slots))
            self.instance.apply_command({"add_metadata": 2})
            self.assertEqual([slot.metadata_scheduled for slot in self.instance.slots], [True, True, False])
            self.instance.apply_command({"add_metadata": 1})
            self.instance.apply_command({"add_metadata": 0})
            with self.assertRaises(ValueError):
                self.instance.apply_command({"add_metadata": 1})
        self.assertEqual([(call.args[0].number, call.args[1]) for call in connect.call_args_list[3:]],
                         [(1, "metadata"), (2, "metadata"), (3, "metadata")])
        self.assertFalse(any(slot.metadata_active for slot in self.instance.slots))

    async def test_bad_metadata_count_is_rejected_before_scheduling(self):
        self.instance.defer_metadata = True
        with patch.object(self.instance, "connection", new_callable=AsyncMock):
            self.instance.apply_command({"add": 2})
            for value in (-1, 3, True, 1.5, "1", None):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    self.instance.apply_command({"add_metadata": value})
            with self.assertRaises(ValueError):
                self.instance.apply_command({"add": 1, "add_metadata": 4})
        self.assertEqual(len(self.instance.slots), 2)
        self.assertEqual(len(self.instance.tasks), 2)
        self.assertFalse(any(slot.metadata_scheduled for slot in self.instance.slots))

    async def test_soft_stall_keeps_pending_body_read_alive(self):
        slot = worker.Slot(1)
        paused_read_cancelled = False
        second_page_received = asyncio.Event()

        async def chunks():
            nonlocal paused_read_cancelled
            yield page(40, 9600)
            try:
                await asyncio.sleep(.07)
            except asyncio.CancelledError:
                paused_read_cancelled = True
                raise
            yield page(41, 19200)
            second_page_received.set()
            await asyncio.Event().wait()

        with patch.object(worker, "AUDIO_SOFT_STALL_SECONDS", .02), patch.object(worker, "AUDIO_HARD_STALL_SECONDS", .3):
            task = asyncio.create_task(self.instance.audio(slot, chunks().__aiter__(), None))
            try:
                await asyncio.wait_for(second_page_received.wait(), 1)
                self.assertFalse(paused_read_cancelled)
                self.assertEqual(slot.clock.pages, 2)
                self.assertEqual(self.instance.stall_events, 1)
                self.assertTrue(slot.audio_active)
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def test_loopback_http_uses_plain_transport_and_default_port(self):
        for url, expected_port in (("http://127.0.0.1", 80), ("http://[::1]:6790", 6790)):
            with self.subTest(url=url):
                self.instance.origin = worker.urlsplit(url)
                reader = asyncio.StreamReader()
                reader.feed_data(b"HTTP/1.1 200 OK\r\nContent-Type: audio/ogg\r\n\r\n")
                writer = Mock()
                writer.drain = AsyncMock()
                opener = AsyncMock(return_value=(reader, writer))
                with patch.object(worker.asyncio, "open_connection", opener):
                    await self.instance.open("/stream")
                args, kwargs = opener.call_args
                self.assertEqual(args[1], expected_port)
                self.assertNotIn("ssl", kwargs)
                self.assertNotIn("server_hostname", kwargs)

    async def test_hard_stall_ends_read_after_recording_soft_stall(self):
        slot = worker.Slot(1)

        async def chunks():
            yield page(40, 9600)
            await asyncio.Event().wait()

        with patch.object(worker, "AUDIO_SOFT_STALL_SECONDS", .02), patch.object(worker, "AUDIO_HARD_STALL_SECONDS", .06):
            with self.assertRaisesRegex(TimeoutError, "20 seconds"):
                await asyncio.wait_for(self.instance.audio(slot, chunks().__aiter__(), None), 1)
        self.assertEqual(self.instance.stall_events, 1)

    async def test_audio_delivery_exits_for_persistent_media_lag(self):
        slot = worker.Slot(1)

        async def chunks():
            yield page(40, 9600)
            await asyncio.Event().wait()

        with patch.object(slot, "observe_lag", return_value=True):
            with self.assertRaisesRegex(worker.MediaLagReconnect, "20 seconds"):
                await asyncio.wait_for(self.instance.audio(slot, chunks().__aiter__(), None), 1)

    async def test_phase_hold_repeated_command_does_not_reset_a_failure(self):
        slot = worker.Slot(1, audio_active=True, metadata_active=True,
                           last_audio=time.monotonic(), last_metadata=time.monotonic())
        self.instance.slots.append(slot)
        self.instance.set_phase("hold", 200)
        self.assertTrue(slot.continuous)
        slot.continuous = False
        self.instance.set_phase("hold", 200)
        self.assertFalse(slot.continuous)
        self.instance.set_phase("ramp", 400)
        self.instance.set_phase("hold", 400)
        self.assertTrue(slot.continuous)

    async def test_lag_violation_marks_hold_unhealthy_without_a_stream_error(self):
        slot = worker.Slot(1, audio_active=True, metadata_active=True, last_audio=10, last_metadata=10)
        slot.clock.feed(page(40, 9600), 10)
        self.instance.slots.append(slot)
        self.instance.phase = "hold"
        slot.continuous = True
        slot.clock.feed(page(41, 19200), 16)
        slot.last_audio = slot.last_metadata = 16
        sample = self.instance.sample(16, 0)
        self.assertEqual(sample["active_audio"], 1)
        self.assertEqual(sample["healthy_audio"], 0)
        self.assertEqual(sample["continuously_healthy"], 0)
        self.assertFalse(slot.continuous)
        self.assertEqual(sample["errors"], 0)

    async def test_stdin_eof_exits_without_opening_a_connection(self):
        command = [sys.executable, str(Path(__file__).with_name("radio-load-worker.py")),
                   "--url", "https://radio.example", "--worker-id", "0",
                   "--output", str(Path(self.temp.name) / "child")]
        process = await asyncio.create_subprocess_exec(*command, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await asyncio.wait_for(process.communicate(b""), 4)
        self.assertEqual(process.returncode, 0, stderr.decode())
        records = [json.loads(line) for line in stdout.splitlines()]
        self.assertEqual(records[0], {"type": "ready", "worker_id": 0, "slots": 0})

    async def test_healthy_count_is_intersection_not_minimum_of_marginals(self):
        now = time.monotonic()
        self.instance.slots = [
            worker.Slot(1, audio_active=True, last_audio=now),
            worker.Slot(2, metadata_active=True, last_metadata=now),
        ]
        sample = self.instance.sample(now, 0)
        self.assertEqual(sample["healthy_audio"], 1)
        self.assertEqual(sample["healthy_metadata"], 1)
        self.assertEqual(sample["healthy"], 0)
        self.assertGreater(sample["rss_mib"], 0)


if __name__ == "__main__":
    unittest.main()
