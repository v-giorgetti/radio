"""Checks native cohort rates and parsing of unfinished streaming responses."""
import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location("h2helpers", Path(__file__).with_name("h2load-radio-helpers.py"))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)

SAMPLE = """Application protocol: h2
requests: 0 total, 20 started, 0 done, 0 succeeded, 0 failed, 0 errored, 0 timeout
status codes: 20 2xx, 0 3xx, 0 4xx, 0 5xx
traffic: 1.19MB (1245699) total, 256B (256) headers (space savings 91.69%), 1.18MB (1241479) data
"""


class CohortTests(unittest.TestCase):
    def test_5k_10k_15k_cohorts_have_target_based_rates(self):
        for previous, target, rate, per_client, duration in (
            (0, 5000, 1000, 20, 5), (5000, 10000, 2000, 40, 2.5),
            (10000, 15000, 3000, 60, 5 / 3),
        ):
            with self.subTest(target=target):
                plan = helpers.cohort_plan(previous, target)
                self.assertEqual(plan["clients"], 50)
                self.assertEqual(plan["streams_per_session"], 100)
                self.assertEqual(plan["additional_streams"], 5000)
                self.assertEqual(plan["desired_stream_rate"], rate)
                self.assertEqual(plan["rps_per_client"], per_client)
                self.assertAlmostEqual(plan["expected_fill_seconds"], duration)

    def test_invalid_levels_are_rejected(self):
        for previous, target in ((0, 0), (5000, 5000), (10000, 5000), (-100, 5000),
                                 (0, 15100), (1, 5000), (0, 5050), (False, 5000), (0, 5000.0)):
            with self.subTest(previous=previous, target=target), self.assertRaises(ValueError):
                helpers.cohort_plan(previous, target)

    def test_invalid_fill_duration_is_rejected(self):
        for duration in (0, -1, float("nan"), float("inf"), "5", True):
            with self.subTest(duration=duration), self.assertRaises(ValueError):
                helpers.cohort_plan(0, 5000, duration)


class ParsingTests(unittest.TestCase):
    def test_unfinished_infinite_responses_are_not_failures(self):
        result = helpers.parse_h2load(SAMPLE)
        self.assertEqual(result["protocol"], "h2")
        self.assertEqual(result["requests"], {"total": 0, "started": 20, "done": 0,
            "succeeded": 0, "failed": 0, "errored": 0, "timeout": 0})
        self.assertEqual(result["status_codes"]["2xx"], 20)
        self.assertEqual(result["header_errors"], 0)
        self.assertEqual(result["traffic_total_bytes"], 1245699)
        self.assertEqual(result["traffic_data_bytes"], 1241479)
        self.assertEqual(result["missing"], [])

    def test_error_headers_and_transport_failures_are_preserved(self):
        text = SAMPLE.replace("0 failed, 0 errored, 0 timeout", "9 failed, 1 errored, 1 timeout")
        text = text.replace("0 4xx, 0 5xx", "3 4xx, 5 5xx")
        result = helpers.parse_h2load(text)
        self.assertEqual(result["header_errors"], 8)
        self.assertEqual(result["requests"]["errored"], 1)
        self.assertEqual(result["requests"]["timeout"], 1)

    def test_missing_protocol_and_zero_body_traffic_are_flagged(self):
        text = SAMPLE.replace("Application protocol: h2\n", "").replace("1.18MB (1241479) data", "0B (0) data")
        result = helpers.parse_h2load(text)
        self.assertIsNone(result["protocol"])
        self.assertEqual(result["traffic_data_bytes"], 0)
        self.assertIn("protocol", result["missing"])
        self.assertIn("traffic_data_bytes", result["missing"])

    def test_partial_output_does_not_invent_zero_error_counters(self):
        result = helpers.parse_h2load("Application protocol: h2\nrequests: 20 started\n")
        self.assertIsNone(result["requests"]["failed"])
        self.assertIsNone(result["header_errors"])
        self.assertIn("requests", result["missing"])
        self.assertIn("status_codes", result["missing"])
        self.assertIn("traffic_data_bytes", result["missing"])


if __name__ == "__main__":
    unittest.main()
