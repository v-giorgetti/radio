"""Checks the benchmark can distinguish intact audio from dropped stream pages."""
import asyncio
import contextlib
import importlib.util
import io
from pathlib import Path
import struct
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("benchmark", Path(__file__).with_name("benchmark-listeners.py"))
benchmark = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = benchmark
spec.loader.exec_module(benchmark)


def page(sequence, payload=b"audio", serial=123):
    return b"OggS\x00\x00" + bytes(8) + struct.pack("<II", serial, sequence) + bytes(4) + bytes([1, len(payload)]) + payload


class AudioContinuityTests(unittest.TestCase):
    def test_cached_headers_can_precede_a_later_live_page(self):
        check = benchmark.OggContinuity()
        stream = page(0, b"OpusHead") + page(1, b"OpusTags") + page(40) + page(41)
        for offset in range(0, len(stream), 7):
            check.feed(stream[offset:offset + 7])
        self.assertEqual(check.audio_pages, 2)

    def test_missing_live_audio_page_is_detected(self):
        check = benchmark.OggContinuity()
        check.feed(page(40))
        with self.assertRaisesRegex(ValueError, "sequence"):
            check.feed(page(42))

    def test_broken_ogg_capture_is_detected(self):
        with self.assertRaisesRegex(ValueError, "Ogg"):
            benchmark.OggContinuity().feed(b"not an ogg stream" + bytes(30))


class SafetyTests(unittest.TestCase):
    def parse(self, *options):
        argv = ["benchmark-listeners.py", "--url", "https://radio.example", "--ssh-target", "host",
                "--output", "/tmp/unused-benchmark-test", *options]
        with patch.object(sys, "argv", argv), contextlib.redirect_stderr(io.StringIO()):
            return benchmark.parse_args()

    def test_default_traffic_cap_remains_four_gib(self):
        self.assertEqual(self.parse().max_gib, 4)

    def test_eight_gib_traffic_cap_requires_explicit_opt_in(self):
        self.assertEqual(self.parse("--max-gib", "8").max_gib, 8)

    def test_traffic_cap_above_eight_gib_is_rejected(self):
        with self.assertRaises(SystemExit):
            self.parse("--max-gib", "8.01")

    def test_nonfinite_traffic_cap_is_rejected(self):
        for value in ("nan", "inf", "-inf"):
            with self.subTest(value=value), self.assertRaises(SystemExit):
                self.parse(f"--max-gib={value}")

    def test_other_load_bounds_remain_enforced(self):
        for options in (("--stages", "1001"), ("--rate", "20.01"), ("--max-seconds", "721")):
            with self.subTest(options=options), self.assertRaises(SystemExit):
                self.parse(*options)

    def test_fd_guard_works_without_waiting_for_http_probes(self):
        initial = {"containers": {"station": {"fd_limits": {"soft": "1024"}, "restart_count": 0}}}
        metrics = {"host_cpu_busy_pct": 10, "mem_available_mib": 2048, "containers": {
            "station": {"fd_count": 930, "restart_count": 0, "status": "running"}}}
        reason, _ = benchmark.remote_failure(metrics, initial, 0)
        self.assertIn("open-file", reason)

    def test_unavailable_fd_telemetry_stops_the_test(self):
        initial = {"containers": {"station": {"fd_limits": {"soft": "1024"}, "restart_count": 0}}}
        metrics = {"host_cpu_busy_pct": 10, "mem_available_mib": 2048, "containers": {
            "station": {"fd_count": None, "restart_count": 0, "status": "running"}}}
        reason, _ = benchmark.remote_failure(metrics, initial, 0)
        self.assertIn("unavailable", reason)

    def test_host_pressure_must_persist_for_three_samples(self):
        metrics = {"host_cpu_busy_pct": 90, "mem_available_mib": 2048, "containers": {}}
        count = 0
        for _ in range(2):
            reason, count = benchmark.remote_failure(metrics, {"containers": {}}, count)
            self.assertIsNone(reason)
        reason, _ = benchmark.remote_failure(metrics, {"containers": {}}, count)
        self.assertIn("sustained", reason)

    def test_explicit_cpu_ceiling_preserves_the_memory_guard(self):
        metrics = {"host_cpu_busy_pct": 90, "mem_available_mib": 2048, "containers": {}}
        self.assertIsNone(benchmark.remote_failure(metrics, {}, 2, cpu_limit=95)[0])
        metrics["mem_available_mib"] = 900
        self.assertIn("sustained", benchmark.remote_failure(metrics, {}, 2, cpu_limit=95)[0])


class DeliveryGapTests(unittest.TestCase):
    def test_worst_gap_keeps_its_time_phase_and_target_after_shorter_gaps(self):
        listener = benchmark.Listener(1, 100)
        listener.record_audio(101, 100, "ramp", 400)
        self.assertIsNone(listener.max_gap_at_elapsed_seconds)
        listener.record_audio(103, 100, "ramp", 400)
        listener.record_audio(103.5, 100, "hold", 400)
        self.assertEqual(listener.max_gap_seconds, 2)
        self.assertEqual(listener.max_gap_at_elapsed_seconds, 3)
        self.assertEqual(listener.max_gap_phase, "ramp")
        self.assertEqual(listener.max_gap_target, 400)
        self.assertEqual(listener.last_audio, 103.5)

    def test_a_larger_hold_gap_updates_the_context(self):
        listener = benchmark.Listener(1, 100)
        listener.record_audio(101, 100, "ramp", 400)
        listener.record_audio(101.5, 100, "ramp", 400)
        listener.record_audio(104.5, 100, "hold", 400)
        self.assertEqual(listener.max_gap_seconds, 3)
        self.assertEqual(listener.max_gap_at_elapsed_seconds, 4.5)
        self.assertEqual(listener.max_gap_phase, "hold")
        self.assertEqual(listener.max_gap_target, 400)


class HttpBodyTests(unittest.IsolatedAsyncioTestCase):
    async def test_chunk_boundaries_and_extensions_are_removed(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b"3;extension=yes\r\nabc\r\n2\r\nde\r\n0\r\n\r\n")
        reader.feed_eof()
        chunks = [chunk async for chunk in benchmark.body_chunks(reader, {"transfer-encoding": "chunked"})]
        self.assertEqual(b"".join(chunks), b"abcde")

    async def test_content_length_does_not_wait_for_connection_close(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b"hello")
        chunks = [chunk async for chunk in benchmark.body_chunks(reader, {"content-length": "5"})]
        self.assertEqual(b"".join(chunks), b"hello")

    async def test_truncated_chunk_is_rejected(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b"5\r\nabc")
        reader.feed_eof()
        with self.assertRaises(asyncio.IncompleteReadError):
            _ = [chunk async for chunk in benchmark.body_chunks(reader, {"transfer-encoding": "chunked"})]


if __name__ == "__main__":
    unittest.main()
