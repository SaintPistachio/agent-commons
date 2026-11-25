import io
import json
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from gemini_capabilities import api, cli, dpapi  # noqa: E402
from gemini_capabilities.dpapi import HelperError  # noqa: E402
from gemini_capabilities.ledger import DEFAULT_POLICY, iso  # noqa: E402

FAKE_KEY = "AIza" + "x" * 35
OTHER_KEY = "AIza" + "y" * 35
POLICY = {**DEFAULT_POLICY, "request_timeout_seconds": 5}
REGISTRY = {"verified_at": "2026-11-25", "models": {
    "m": {"prices": [{"from": "2026-11-01", "input": "2.00", "output": "10.00", "cached_input": "0.10"},
                     {"from": "2026-12-01", "input": "4.00", "output": "20.00", "cached_input": "0.20"}]}}}


def snapshot(window="w1", balance="10.00", expires="2027-11-01", verified=None):
    return {"funding_window_id": window, "source": "test", "verified_at": verified or iso(datetime.now(timezone.utc) - timedelta(minutes=1)),
            "allocation_usd": balance, "grants": [{"grant_id": "g1", "balance_usd": balance, "expires_on": expires}]}


class Reply:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return json.dumps(self.body).encode()


def opener_with(generate_reply):
    def opener(request, timeout):
        assert request.get_header("X-goog-api-key") in (FAKE_KEY, OTHER_KEY)
        if request.full_url.endswith(":countTokens"):
            return Reply({"totalTokens": 100})
        return generate_reply(request)
    return opener


OK = opener_with(lambda r: Reply({"candidates": [{"content": {"parts": [{"text": "hi"}]}, "finishReason": "STOP"}],
                                  "usageMetadata": {"promptTokenCount": 1000, "candidatesTokenCount": 100, "thoughtsTokenCount": 50}}))


def raising(make):
    def generate(request):
        raise make(request)
    return opener_with(generate)


class HelperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.patches = [patch.object(dpapi, "protect", lambda b: b[::-1]), patch.object(dpapi, "unprotect", lambda b: b[::-1])]
        for p in self.patches:
            p.start()
        self.helper = cli.Helper(self.temp.name, dict(POLICY), REGISTRY, opener=OK)
        self.helper.save_key(FAKE_KEY)
        self.helper.refresh_funding(snapshot())
        self.helper.ledger.set_enabled(True)

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.temp.cleanup()

    def test_authorization_key_uses_the_same_protected_storage(self):
        auth_key = "AQ.synthetic-authorization-key"
        self.assertEqual(self.helper.save_key(auth_key)["status"], "saved")
        self.assertEqual(self.helper.key(), auth_key)
        self.assertIn("credential_changed", self.helper.status()["blockers"])
        with self.assertRaises(HelperError):
            self.helper.save_key(auth_key + "\r\nX-Injected: value")
        self.assertEqual(self.helper.key(), auth_key)

    def test_preflight_does_not_send_disabled_or_over_budget_prompts(self):
        with patch.object(api, "count_tokens") as count:
            self.helper.ledger.set_enabled(False)
            with self.assertRaises(HelperError) as disabled:
                self.helper.invoke(self.request())
            self.assertEqual(disabled.exception.code, "disabled")
            self.helper.ledger.set_enabled(True)
            with self.assertRaises(HelperError) as over_budget:
                self.helper.invoke(self.request(max_cost_usd="0.000001"))
            self.assertEqual(over_budget.exception.code, "job_cap_exceeded")
            count.assert_not_called()

    def test_prepaid_and_promotional_balances_share_the_rolling_budget(self):
        funding = snapshot(window="with-prepay", balance="10", verified=iso(datetime.now(timezone.utc)))
        funding["grants"].append({"grant_id": "prepay", "kind": "prepaid", "balance_usd": "5", "expires_on": "2027-12-01"})
        funding["allocation_usd"] = "15"
        self.helper.refresh_funding(funding)
        credits = self.helper.ledger.credits()
        self.assertEqual(credits["observed_credit_by_kind_usd"], {"promotional": "10", "prepaid": "5"})
        self.assertEqual(credits["observed_balance_usd"], "15")
        self.assertEqual(credits["spendable_estimate_after_reservations_usd"], "14.25")
        self.assertEqual(credits["monthly_budget"]["available_for_new_requests_usd"], "10")

    def request(self, job="j1", **extra):
        return {"job_id": job, "model": "m", "prompt": "p" * 300, "max_cost_usd": "1.00", "purpose": "test",
                "deliverable": "text", "max_output_tokens": 1000, "thinking_budget": 1000, **extra}

    def run_cli(self, *argv):
        out = io.StringIO()
        with patch("sys.stdout", out):
            code = cli.main(list(argv), helper=self.helper)
        return code, json.loads(out.getvalue())

    def test_completed_job_settles_actual_cost(self):
        with patch("gemini_capabilities.cli.now_utc", return_value=datetime(2026, 11, 25, tzinfo=timezone.utc)):
            result = self.helper.invoke(self.request())
        self.assertEqual(result["status"], "completed")
        # 1000 input at $2/M + 150 output (incl. thinking) at $10/M = 0.0035
        self.assertEqual(result["cost_usd"], "0.0035")
        self.assertEqual(self.helper.ledger.job("j1")["actual_usd"], "0.0035")

    def test_reservation_counts_tokens_and_the_higher_scheduled_price(self):
        at = datetime(2026, 11, 25, tzinfo=timezone.utc)
        # Dec 1 prices: 100 input at $4/M + 2000 output+thinking at $20/M = 0.0404, * 1.15 = 0.04646
        self.assertEqual(api.reservation_microusd(REGISTRY["models"]["m"], at, 100, 2000, "0.15"), 46460)

    def test_refusals(self):
        for request, code in ((self.request(max_cost_usd="0.0001"), "job_cap_exceeded"),
                              (self.request(job="j2", model="unknown"), "model_unregistered")):
            with self.assertRaises(HelperError) as caught:
                self.helper.invoke(request)
            self.assertEqual(caught.exception.code, code)
        self.helper.invoke(self.request(job="j3"))
        with self.assertRaises(HelperError) as caught:
            self.helper.invoke(self.request(job="j3"))
        self.assertEqual(caught.exception.code, "duplicate_request")
        self.helper.ledger.set_enabled(False)
        with self.assertRaises(HelperError) as caught:
            self.helper.invoke(self.request(job="j4"))
        self.assertEqual(caught.exception.code, "disabled")

    def test_funds_and_rolling_budget(self):
        self.helper.refresh_funding(snapshot(window="w2", balance="0.01", verified=iso(datetime.now(timezone.utc))))
        with self.assertRaises(HelperError) as caught:
            self.helper.invoke(self.request(job="j5", max_output_tokens=20000))
        self.assertEqual(caught.exception.code, "insufficient_funds")
        self.helper.policy["monthly_target_usd"] = "0.01"
        self.helper.refresh_funding(snapshot(window="w3", balance="100.00", verified=iso(datetime.now(timezone.utc) + timedelta(seconds=1))))
        with self.assertRaises(HelperError) as caught:
            self.helper.invoke(self.request(job="j6", max_output_tokens=20000))
        self.assertEqual(caught.exception.code, "monthly_budget_exhausted")

    def test_charges_near_a_new_snapshot_still_count(self):
        self.helper.invoke(self.request(job="before"))
        self.helper.refresh_funding(snapshot(window="w2", verified=iso(datetime.now(timezone.utc))))
        # Charged within the billing lag before the new observation: still subtracted from the new balance.
        self.assertEqual(self.helper.ledger.credits()["spent_since_snapshot_usd"], "0.0035")

    def test_expired_stale_or_rekeyed_funding_blocks(self):
        self.helper.refresh_funding(snapshot(window="w2", expires="2026-01-01", verified=iso(datetime.now(timezone.utc))))
        with self.assertRaises(HelperError) as caught:
            self.helper.invoke(self.request(job="j7"))
        self.assertEqual(caught.exception.code, "grant_expired")
        self.helper.refresh_funding(snapshot(window="w3", verified=iso(datetime.now(timezone.utc) + timedelta(seconds=1))))
        with self.assertRaises(HelperError):
            self.helper.refresh_funding(snapshot(window="w4", verified=iso(datetime.now(timezone.utc) - timedelta(days=40))))
        with patch("gemini_capabilities.ledger.now_utc", return_value=datetime.now(timezone.utc) + timedelta(days=40)):
            self.assertIn("funding_stale", self.helper.ledger.blockers())
        self.helper.save_key(OTHER_KEY)
        self.assertIn("credential_changed", self.helper.status()["blockers"])
        with self.assertRaises(HelperError) as caught:
            self.helper.invoke(self.request(job="j8"))
        self.assertEqual(caught.exception.code, "credential_changed")

    def test_funding_validation(self):
        for bad in (snapshot(window="w1"), {**snapshot(window="x"), "allocation_usd": "20.00"},
                    snapshot(window="y", verified="2099-01-01T00:00:00Z"), {**snapshot(window="z"), "grants": []}):
            with self.assertRaises(HelperError):
                self.helper.refresh_funding(bad)

    def test_uncertain_keeps_reservation_and_needs_evidence(self):
        self.helper.opener = raising(lambda r: urllib.error.URLError("reset"))
        self.assertEqual(self.helper.invoke(self.request(job="u1"))["status"], "uncertain")
        job = self.helper.ledger.job("u1")
        self.assertEqual((job["status"], job["actual_usd"]), ("uncertain", None))
        self.assertGreater(float(self.helper.ledger.credits()["reserved_usd"]), 0)
        with self.assertRaises(HelperError):
            self.helper.invoke(self.request(job="u1"))
        self.assertEqual(self.run_cli("settle-uncertain", "--job-id", "u1", "--actual-usd", "0.01", "--evidence", " ")[1]["error_code"], "evidence_required")
        code, out = self.run_cli("settle-uncertain", "--job-id", "u1", "--actual-usd", "0.01", "--evidence", "AI Studio billing shows $0.01")
        self.assertEqual((code, out["status"]), (0, "settled"))
        self.assertEqual(self.run_cli("settle-uncertain", "--job-id", "u1", "--actual-usd", "0.02", "--evidence", "second settlement")[1]["error_code"], "not_uncertain")
        self.assertEqual(self.helper.ledger.credits()["reserved_usd"], "0")

    def test_missing_usage_or_unclear_http_is_uncertain(self):
        self.helper.opener = opener_with(lambda r: Reply({"candidates": []}))
        self.assertEqual(self.helper.invoke(self.request(job="m1"))["status"], "uncertain")
        self.helper.opener = raising(lambda r: urllib.error.HTTPError(r.full_url, 409, "conflict", {}, None))
        self.assertEqual(self.helper.invoke(self.request(job="m2"))["status"], "uncertain")

    def test_stuck_submitting_job_can_be_settled_after_the_timeout(self):
        self.helper.ledger.reserve(self.request(job="s1"), 1000, cli.Helper.fingerprint(FAKE_KEY))
        evidence = "process crashed; billing shows nothing"
        self.assertEqual(self.run_cli("settle-uncertain", "--job-id", "s1", "--actual-usd", "0", "--evidence", evidence)[1]["error_code"], "not_uncertain")
        with patch("gemini_capabilities.ledger.now_utc", return_value=datetime.now(timezone.utc) + timedelta(minutes=5)):
            self.assertEqual(self.run_cli("settle-uncertain", "--job-id", "s1", "--actual-usd", "0", "--evidence", evidence)[1]["status"], "settled")

    def test_overrun_pauses_new_requests(self):
        self.helper.opener = opener_with(lambda r: Reply({"candidates": [{"content": {"parts": [{"text": "x"}]}}],
                                                           "usageMetadata": {"promptTokenCount": 10_000_000, "candidatesTokenCount": 0}}))
        self.assertIn("overrun", self.helper.invoke(self.request(job="o1"))["warning"])
        with self.assertRaises(HelperError) as caught:
            self.helper.invoke(self.request(job="o2"))
        self.assertEqual(caught.exception.code, "overrun")

    def test_http_refusal_settles_at_zero(self):
        self.helper.opener = raising(lambda r: urllib.error.HTTPError(r.full_url, 400, "bad", {}, None))
        with self.assertRaises(HelperError) as caught:
            self.helper.invoke(self.request(job="r1"))
        self.assertEqual(caught.exception.code, "http_400")
        self.assertEqual(self.helper.ledger.job("r1")["actual_usd"], "0")

    def test_weekly_pace_for_display(self):
        weekly = self.helper.ledger.credits()["weekly_budget"]
        self.assertEqual(weekly["weekly_limit_usd"], "2.333333")
        self.assertEqual(weekly["available_for_new_requests_usd"], "2.333333")
        self.helper.invoke(self.request(job="w1"))
        self.assertEqual(self.helper.ledger.credits()["weekly_budget"]["available_for_new_requests_usd"], "2.329833")

    def test_redirects_are_refused(self):
        request = urllib.request.Request("https://generativelanguage.googleapis.com/v1beta/models", headers={"x-goog-api-key": FAKE_KEY})
        with self.assertRaises(urllib.error.HTTPError):
            api._NoRedirect().redirect_request(request, None, 302, "Found", {}, "https://example.com/")

    def test_key_never_appears_in_output(self):
        outputs = [self.run_cli("status")[1], self.run_cli("credits")[1]]
        self.helper.opener = lambda request, timeout: (_ for _ in ()).throw(urllib.error.HTTPError(request.full_url, 403, FAKE_KEY, {}, None))
        outputs.append(self.run_cli("models")[1])
        for out in outputs:
            self.assertNotIn(FAKE_KEY, json.dumps(out))
        with self.assertRaises(HelperError) as caught:
            self.helper.save_key("not-a-key")
        self.assertNotIn("not-a-key", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
