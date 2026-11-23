import json
from datetime import datetime, timezone
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

HELPER_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HELPER_ROOT / "scripts"))
import antigravity as ag
import model_registry as registry


GEMINI = "Gemini Models"
ARGON = "Gemini 4 Argon"
CLAUDE = "Claude and GPT models"
WEEKLY = "Weekly Limit Remaining"
FIVE_HOUR = "Five Hour Limit Remaining"
ARGON_WEEKLY = "Gemini 4 Argon Weekly Limit"
RESET = "2026-11-21T00:00:00Z"


class FixedDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 11, 20, tzinfo=timezone.utc).astimezone(tz)


def usage_text(gemini_week=1, gemini_five=100, claude_week=73, argon_week=90):
    def line(group, limit, value):
        window = value if value == "disabled" else f"{value}%\t{RESET}"
        return f"{group}\t{limit}\t{window}"

    return "\n".join([
        line(GEMINI, WEEKLY, gemini_week),
        line(GEMINI, FIVE_HOUR, gemini_five),
        line(CLAUDE, WEEKLY, claude_week),
        line(CLAUDE, FIVE_HOUR, 84),
        line(ARGON, ARGON_WEEKLY, argon_week),
    ])


class UsagePoolsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with patch.object(registry, "datetime", FixedDatetime):
            cls.routing = registry.load_registry(
                HELPER_ROOT / "routing-seed.json", None,
                lambda path: json.loads(path.read_text(encoding="utf-8")))
        cls.profiles = {profile["model"]: profile for profile in cls.routing["profiles"]}
        cls.models = dict.fromkeys(cls.profiles, "Synthetic display name")

    def headroom(self, model, quota):
        return registry.profile_headroom(self.profiles[model], quota, self.routing)

    def probe_selector(self, quota, calls):
        def choose(group):
            calls.append(group)
            try:
                return registry.select_probe(group, "transform", self.models, quota, self.routing)
            except registry.RegistryError as exc:
                raise ag.HelperError(exc.code, str(exc)) from exc
        return choose

    def test_disabled_window_closes_only_its_own_pool(self):
        text = usage_text(gemini_five="disabled").replace("\tdisabled", "\t\tdisabled")
        quota = ag.parse_quota(text)
        self.assertEqual(quota[1], {"group": GEMINI, "limit": FIVE_HOUR,
                                    "remaining_percent": 0.0, "resets_at": None,
                                    "state": "disabled"})
        self.assertEqual(ag.safe_diagnostics({"quota_before": quota})["quota_before"], quota)
        self.assertEqual(self.headroom("gemini-3.8-flash-low", quota), 0.0)
        self.assertEqual(self.headroom("claude-sonnet-5-5-low", quota), 73.0)
        self.assertEqual(self.headroom("gemini-4-argon-high", quota), 90.0)

    def test_null_reset_requires_disabled_state(self):
        row = {"group": GEMINI, "limit": FIVE_HOUR, "remaining_percent": 0.0, "resets_at": None}
        self.assertIsNone(ag.safe_diagnostics({"quota_after": [row]})["quota_after"])

    def test_argon_routes_with_gemini_weekly_closed(self):
        for weekly in (0, "disabled"):
            with self.subTest(weekly=weekly):
                quota = ag.parse_quota(usage_text(gemini_week=weekly))
                result = registry.select("complex", self.models, quota, self.routing, family="gemini-4-argon")
                self.assertEqual(result["model"], "gemini-4-argon-high")
                self.assertEqual(result["group"], ARGON)
                self.assertEqual(result["headroom_percent"], 90.0)

    def test_unexpected_quota_lines_and_duplicates_fail_closed(self):
        for extra in ("unexpected usage summary", f"{GEMINI}\t{FIVE_HOUR}\textra\tdisabled",
                      f"{GEMINI}\t{FIVE_HOUR}\t100%\t{RESET}"):
            with self.subTest(extra=extra), patch.object(ag, "_save_quota_shape"):
                with self.assertRaises(ag.HelperError) as caught:
                    ag.parse_quota(usage_text(gemini_five="disabled") + "\n" + extra)
                self.assertEqual(caught.exception.code, "QUOTA_UNKNOWN")

    def test_select_probe_picks_argon(self):
        quota = ag.parse_quota(usage_text(gemini_week=0))
        result = registry.select_probe(ARGON, "transform", self.models, quota, self.routing)
        self.assertEqual(result["group"], ARGON)
        self.assertIn(result["model"], ("gemini-4-argon-high", "gemini-4-argon-medium"))

    def test_first_probe_prefers_gemini_then_uses_argon(self):
        for weekly, expected in ((1, [GEMINI]), (0, [GEMINI, ARGON]), ("disabled", [GEMINI, ARGON])):
            with self.subTest(weekly=weekly):
                calls = []
                quota = ag.parse_quota(usage_text(gemini_week=weekly))
                result = ag._select_acceptance_probe(self.probe_selector(quota, calls))
                self.assertEqual(calls, expected)
                self.assertEqual(result["group"], expected[-1])

    def test_second_probe_prefers_claude_then_uses_unused_gemini_side_pool(self):
        for first, claude_week, expected in ((GEMINI, 73, [CLAUDE]),
                                             (GEMINI, 0, [CLAUDE, ARGON]),
                                             (ARGON, 0, [CLAUDE, GEMINI])):
            with self.subTest(first=first, claude_week=claude_week):
                calls = []
                quota = ag.parse_quota(usage_text(claude_week=claude_week))
                result = ag._select_acceptance_probe(self.probe_selector(quota, calls), first_group=first)
                self.assertEqual(calls, expected)
                self.assertEqual(result["group"], expected[-1])

    def test_first_probe_fails_when_both_gemini_side_pools_are_closed(self):
        calls = []
        quota = ag.parse_quota(usage_text(gemini_week=0, argon_week=0))
        with self.assertRaises(ag.HelperError) as caught:
            ag._select_acceptance_probe(self.probe_selector(quota, calls))
        self.assertEqual(caught.exception.code, "NO_ELIGIBLE_MODEL")
        self.assertEqual(calls, [GEMINI, ARGON])

    def test_probe_does_not_skip_unknown_quota(self):
        calls = []
        quota = ag.parse_quota(usage_text() + f"\nUnknown Pool\tUnknown Window\t90%\t{RESET}")
        with self.assertRaises(ag.HelperError) as caught:
            ag._select_acceptance_probe(self.probe_selector(quota, calls))
        self.assertEqual(caught.exception.code, "QUOTA_UNKNOWN")
        self.assertEqual(calls, [GEMINI])


if __name__ == "__main__":
    unittest.main()
