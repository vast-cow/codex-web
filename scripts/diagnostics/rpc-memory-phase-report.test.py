"""Check timing/censoring math used in the memory acceptance evidence."""
import importlib.util
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("phase_report", Path(__file__).with_name("rpc-memory-phase-report.py"))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class ExcursionTests(unittest.TestCase):
    def rows(self, values):
        return [dict(time=index * 100, current=value * report.MIB) for index, value in enumerate(values)]

    def test_complete_crossing_has_sample_bounds_and_excess_integral(self):
        episode, = report.excursions(self.rows([1270, 1290, 1300, 1280]))
        self.assertAlmostEqual(episode["durationSeconds"], .2)
        self.assertAlmostEqual(episode["durationLowerSeconds"], .1)
        self.assertAlmostEqual(episode["durationUpperSeconds"], .3)
        self.assertAlmostEqual(episode["excessMiBSeconds"], 3)
        self.assertEqual(episode["peak"], 1300 * report.MIB)

    def test_censored_capture_cannot_claim_a_duration_upper_bound(self):
        episode, = report.excursions(self.rows([1290, 1300, 1300]))
        self.assertTrue(episode["censoredStart"])
        self.assertTrue(episode["censoredEnd"])
        self.assertIsNone(episode["durationUpperSeconds"])
        self.assertAlmostEqual(episode["durationLowerSeconds"], .2)

    def test_equality_is_below_or_at_limit_and_separates_excursions(self):
        rows = self.rows([1280, 1281, 1280, 1281, 1280])
        self.assertEqual(len(report.excursions(rows)), 2)
        summary = report.window(rows)
        self.assertAlmostEqual(summary["secondsAbove"], .2)
        self.assertAlmostEqual(summary["fractionAbove"], .5)


if __name__ == "__main__":
    unittest.main()
