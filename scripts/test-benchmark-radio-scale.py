"""Checks scale-test admission and hold criteria independently of a live station."""
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location("scale", Path(__file__).with_name("benchmark-radio-scale.py"))
scale = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = scale
spec.loader.exec_module(scale)


class AdmissionTests(unittest.TestCase):
    def test_rate_is_global_and_reduces_when_server_is_busy(self):
        self.assertEqual(scale.admission_rate(20, 30, 0, 0, 20, 2), 20)
        self.assertLess(scale.admission_rate(20, 70, 0, 0, 20, 2), 20)

    def test_widespread_unhealthy_streams_pause_new_joins(self):
        self.assertEqual(scale.admission_rate(20, 30, .06, 0, 20, 2), 0)

    def test_isolated_slow_streams_reduce_rate_without_blocking_the_requested_ramp(self):
        self.assertEqual(scale.admission_rate(20, 30, .02, 1.5, 20, 2), 5)

    def test_a_saturated_worker_pauses_admission(self):
        self.assertEqual(scale.admission_rate(20, 30, 0, 0, 96, 2), 0)
        self.assertEqual(scale.admission_rate(20, 30, 0, 0, 20, 300), 0)

    def test_brief_scheduler_jitter_below_client_deadline_does_not_stop_growth(self):
        self.assertEqual(scale.admission_rate(20, 30, 0, 0, 20, 100), 20)

    def test_busy_server_can_progress_slowly_below_the_pause_threshold(self):
        self.assertEqual(scale.admission_rate(20, 80, 0, 0, 20, 2), 1)

    def test_fast_staged_startup_reaches_requested_rate_with_resource_guards(self):
        self.assertEqual(scale.admission_rate(200, 30, 0, 0, 20, 2, fast=True), 200)
        self.assertEqual(scale.admission_rate(200, 70, 0, 0, 20, 2, fast=True), 50)
        self.assertEqual(scale.admission_rate(200, 83, 0, 0, 20, 2, fast=True), 0)


class HoldTests(unittest.TestCase):
    def test_cleanup_summary_uses_audio_and_metadata_health(self):
        test = scale.ScaleTest.__new__(scale.ScaleTest)
        test.args = SimpleNamespace(defer_metadata=True)
        test.slots = [5]
        test.phase = 'cleanup'
        test.worker_samples = {0: {'active_audio':5, 'active_metadata':0,
            'healthy_audio':5, 'healthy_metadata':0, 'healthy':0}}
        self.assertEqual(test.aggregate()['healthy'], 0)

    def test_all_connections_and_continuity_are_reported_separately(self):
        data = {'active_audio':1000, 'active_metadata':1000, 'healthy':998, 'continuous':990}
        self.assertTrue(scale.hold_passes(data, 1000))
        data['continuous'] = 950
        self.assertFalse(scale.hold_passes(data, 1000))

    def test_slots_alone_cannot_pass_a_hold(self):
        self.assertFalse(scale.hold_passes({'active_audio':800, 'active_metadata':800, 'healthy':800, 'continuous':800}, 1000))


if __name__ == '__main__':
    unittest.main()
