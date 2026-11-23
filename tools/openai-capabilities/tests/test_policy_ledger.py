import concurrent.futures
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from openai_capabilities.ledger import Ledger
from openai_capabilities.policy import PolicyError, estimate, grant_expiry, reconcile_cost, usage_priority, validate_funding, validate_request


RATES = {"input": "2", "output": "10", "cache_read": ".1", "cache_write_30m": "2.5", "cache_write_12h": "5"}
REGISTRY = {"models": {"test": {"capabilities": {
    "responses": {"tiers": {"default": RATES}, "max_output_tokens": 1000, "max_input_tokens": 100000,
                  "long_context_threshold": 50000, "long_context_rates": {"default": {**RATES, "input": "4", "output": "15"}}},
    "embeddings": {"tiers": {"default": {"input": ".02", "output": "0"}, "batch": {"input": ".01", "output": "0"}}}
}}}}


def request(tier="default", capability="responses"):
    return {"capability": capability, "model": "test", "tier": tier,
            "purpose": {"kind": "contract_test", "description": "Validate the application's endpoint contract"},
            "payload": {"input": "synthetic data", **({"max_output_tokens": 100} if capability == "responses" else {})}}


def policy():
    return {"organization_id": "org-test", "project_id": "proj-test", "allocation_margin": "0.05"}


def funding():
    now = datetime.now(timezone.utc)
    return {"organization_id": "org-test", "project_id": "proj-test", "grant_id": "grant-test",
            "source": "Synthetic account evidence", "grant_balance_usd": "1", "allocation_usd": "1",
            "expires_at": (now + timedelta(days=10)).isoformat(),
            "verified_at": (now - timedelta(minutes=5)).isoformat(),
            "purchased_balance": "absent", "auto_recharge": "disabled",
            "platform_hard_limit_enforced": True, "platform_limit_usd": "1",
            "platform_spend_usd": "0",
            "platform_limit_reset_at": (now + timedelta(days=5)).isoformat()}


def prepaid_policy():
    return {**policy(), "funding_policy": "existing_prepaid_only", "activation_max_usd": "1"}


def prepaid_funding(now=None):
    now = now or datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    reset = (month_start.replace(year=month_start.year + 1, month=1) if month_start.month == 12
             else month_start.replace(month=month_start.month + 1))
    return {"funding_policy": "existing_prepaid_only", "funding_window_id": "observation-one",
            "organization_id": "org-test", "project_id": "proj-test", "source": "Synthetic account evidence",
            "verified_at": (now - timedelta(seconds=30)).isoformat(), "billing_mode": "prepaid",
            "auto_recharge": "disabled", "automatic_purchases": "disabled",
            "grants": [{"grant_id": "local-promo", "funding_type": "promotional", "balance_usd": "8",
                        "expires_at": (now + timedelta(days=6)).isoformat()},
                       {"grant_id": "local-purchased", "funding_type": "purchased", "balance_usd": "2",
                        "expires_on": (now + timedelta(days=6)).date().isoformat()}],
            "allocation_usd": "10", "organization_limit_usd": "20", "organization_spend_usd": "0",
            "project_limit_usd": "20", "project_spend_usd": "0", "platform_hard_limit_enforced": True,
            "platform_limit_reset_at": reset.isoformat(),
            "account_cost_baseline": {"window_start": month_start.isoformat(), "cost_total_usd": "0",
                                      "observed_at": (now - timedelta(seconds=60)).isoformat()}}


def account_costs(snapshot, *, total="0", org="0", project="0", now=None):
    now = now or datetime.now(timezone.utc)
    limit = {"threshold_usd": "20", "enforcement": "enforcing", "currency": "USD", "interval": "month"}
    return {"source": "official_admin_api", "status": "observed", "organization_id": "org-test", "project_id": "proj-test",
            "observed_at": now.isoformat(), "window_end": now.isoformat(),
            "window_start": snapshot["account_cost_baseline"]["window_start"], "cost_total_usd": total,
            "month_start": now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat(),
            "organization_spend_usd": org, "project_spend_usd": project,
            "organization_spend_limit": limit, "project_spend_limit": dict(limit)}


@contextmanager
def month_safe_prepaid_ledger(root, name):
    fixed_now = datetime(2026, 10, 15, 12, tzinfo=timezone.utc)

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed_now if tz is not None else fixed_now.replace(tzinfo=None)

    with patch("openai_capabilities.ledger.datetime", Clock), patch("openai_capabilities.policy.datetime", Clock):
        ledger = Ledger(Path(root) / f"{name}.sqlite", prepaid_policy())
        snapshot = prepaid_funding(fixed_now)
        ledger.refresh_funding(snapshot)
        ledger.update_account_costs(account_costs(snapshot, now=fixed_now))
        ledger.set_enabled(True)
        yield ledger, snapshot, fixed_now


class PolicyTests(unittest.TestCase):
    def test_funding_fails_closed_and_independent_clocks(self):
        good = funding()
        validate_funding(good, policy())
        for field, value in [("purchased_balance", "present"), ("purchased_balance", "unknown"),
                             ("auto_recharge", "unknown"), ("platform_hard_limit_enforced", False),
                             ("organization_id", "another"), ("grant_balance_usd", "NaN")]:
            with self.subTest(field=field, value=value), self.assertRaises(PolicyError):
                validate_funding({**good, field: value}, policy())
        expired = {**good, "expires_at": (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()}
        with self.assertRaisesRegex(PolicyError, "expired"):
            validate_funding(expired, policy())
        # A future platform reset cannot make the expired promotional grant valid.
        expired["platform_limit_reset_at"] = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
        with self.assertRaises(PolicyError) as caught:
            validate_funding(expired, policy())
        self.assertEqual(caught.exception.code, "grant_expired")

    def test_purpose_tiers_output_and_overrides(self):
        validate_request(request(), REGISTRY)
        for change in [{"purpose": {"kind": "coding", "description": "Fix code"}}, {"tier": "auto"},
                       {"tier": "flex"}, {"model": "unknown"}, {"payload": {"input": "x"}},
                       {"payload": {"max_output_tokens": 10, "api_key": "SYNTHETIC_CANARY"}}]:
            with self.subTest(change=change), self.assertRaises(PolicyError):
                validate_request({**request(), **change}, REGISTRY)

    def test_estimate_uses_no_cache_hits_and_reserves_retries(self):
        req = request()
        amount = estimate(req, REGISTRY, retries=0)
        self.assertGreater(amount, 1000)
        self.assertGreaterEqual(estimate(req, REGISTRY), amount * 3 - 2)
        with self.assertRaises(PolicyError) as caught:
            estimate({**req, "max_cost_usd": ".000001"}, REGISTRY)
        self.assertEqual(caught.exception.code, "job_cap_exceeded")

    def test_cache_categories_are_disjoint_and_output_includes_reasoning(self):
        usage = {"input_tokens": 1000, "output_tokens": 100,
                 "output_tokens_details": {"reasoning_tokens": 80},
                 "input_tokens_details": {"cached_tokens": 200, "cache_write_tokens": 300,
                                          "cache_write_tokens_details": {"ttl_30m_tokens": 100, "ttl_12h_tokens": 200}}}
        # 500*2 + 200*.1 + 100*2.5 + 200*5 + 100*10 = 3270 microUSD.
        self.assertEqual(reconcile_cost(request(), REGISTRY, usage), 3270)
        usage["input_tokens_details"]["cached_tokens"] = 800
        with self.assertRaises(PolicyError):
            reconcile_cost(request(), REGISTRY, usage)

    def test_long_context_and_zero_output_endpoint(self):
        self.assertEqual(reconcile_cost(request(), REGISTRY, {"input_tokens": 60000, "output_tokens": 100}), 241500)
        self.assertEqual(reconcile_cost(request(capability="embeddings"), REGISTRY, {"input_tokens": 1000, "output_tokens": 900}), 20)

    def test_coding_assistance_requires_bounded_concrete_responses_deliverable(self):
        original = request() | {"max_cost_usd": "1", "purpose": {"kind": "coding_assistance",
            "description": "  Check the concurrency fix independently before integration.  ",
            "deliverable": "  A patch review identifying reproducible race conditions.  "}}
        before = json.dumps(original, sort_keys=True)
        normalized = validate_request(original, REGISTRY)
        self.assertEqual(normalized["purpose"]["deliverable"], "A patch review identifying reproducible race conditions.")
        self.assertEqual(normalized["purpose"]["description"], "Check the concurrency fix independently before integration.")
        self.assertGreater(estimate(normalized, REGISTRY), 0)
        self.assertEqual(json.dumps(original, sort_keys=True), before)
        for change in [
            {"purpose": {**original["purpose"], "deliverable": " "}},
            {"purpose": {"kind": "coding_assistance", "description": "Review the patch"}},
            {"purpose": {**original["purpose"], "description": " "}},
            {"capability": "embeddings"}, {"capability": "decisions"},
            {"purpose": {**original["purpose"], "kind": "coding"}},
            {"purpose": {**original["purpose"], "kind": "subscription_overflow"}},
            *({"max_cost_usd": value} for value in ("0", "-1", "NaN", True)),
        ]:
            with self.subTest(change=change), self.assertRaises(PolicyError):
                validate_request(original | change, REGISTRY)
        no_cap = {key: value for key, value in original.items() if key != "max_cost_usd"}
        with self.assertRaises(PolicyError) as caught:
            validate_request(no_cap, REGISTRY)
        self.assertEqual(caught.exception.code, "coding_budget_required")
        with self.assertRaises(PolicyError) as caught:
            estimate(original | {"max_cost_usd": ".000001"}, REGISTRY)
        self.assertEqual(caught.exception.code, "job_cap_exceeded")

    def test_usage_priority_expiration_boundaries_are_advisory_and_do_not_mutate_funding(self):
        now = datetime(2026, 10, 30, 12, tzinfo=timezone.utc)
        for delta, expected in [(timedelta(days=31), "normal"), (timedelta(days=30, seconds=1), "normal"),
                                (timedelta(days=30), "elevated"), (timedelta(days=14, seconds=1), "elevated"),
                                (timedelta(days=14), "high"), (timedelta(days=7, seconds=1), "high"),
                                (timedelta(days=7), "urgent"), (timedelta(0), "blocked"),
                                (timedelta(days=-1), "blocked")]:
            snapshot = {"grants": [{"balance_usd": "10", "expires_at": (now + delta).isoformat()}]}
            before = json.dumps(snapshot, sort_keys=True)
            with self.subTest(delta=delta):
                result = usage_priority(snapshot, now=now)
                self.assertEqual(result["level"], expected)
                self.assertEqual(result["basis"], "recorded_grant_snapshot")
                self.assertTrue(result["advisory_only"])
                self.assertEqual(result["expires_at"], (now + delta).isoformat())
                self.assertEqual(result["days_until_expiry"], round(delta.total_seconds() / 86400, 6))
                self.assertEqual(json.dumps(snapshot, sort_keys=True), before)

    def test_usage_priority_ignores_zero_balances_and_does_not_invent_missing_expirations(self):
        now = datetime(2026, 10, 30, 12, tzinfo=timezone.utc)
        grants = [{"balance_usd": "0", "expires_on": "malformed-but-zero"},
                  {"balance_usd": "2", "expires_at": (now + timedelta(days=40)).isoformat()},
                  {"balance_usd": "1", "expires_on": "2026-11-05"}]
        self.assertEqual(usage_priority({"grants": grants}, now=now)["level"], "urgent")
        grants.append({"balance_usd": "1", "expires_on": "2026-10-29"})
        self.assertEqual(usage_priority({"grants": grants}, now=now)["level"], "blocked")
        for snapshot in [None, {}, {"grants": []}, {"grants": [{"balance_usd": "0"}]},
                         {"grants": [None]}, {"grants": [{"balance_usd": "NaN", "expires_on": "2026-11-05"}]},
                         {"grants": [{"balance_usd": "1"}]},
                         {"grants": [{"balance_usd": "1", "expires_on": "bad-date"}]}]:
            with self.subTest(snapshot=snapshot):
                result = usage_priority(snapshot, now=now)
                self.assertEqual(result["level"], "unverified")
                self.assertIsNone(result["expires_at"])
                self.assertIsNone(result["days_until_expiry"])
                self.assertTrue(result["advisory_only"])
        blocked = prepaid_funding() | {"auto_recharge": "enabled"}
        usage_priority(blocked)  # A priority signal cannot bypass the funding gate.
        with self.assertRaises(PolicyError) as caught:
            validate_funding(blocked, prepaid_policy())
        self.assertEqual(caught.exception.code, "automatic_charge_possible")

    def test_grant_calendar_date_contract_rejects_alternate_iso_notations(self):
        for value in ("2026-W44-5", "20261030", "2026-02-29"):
            with self.subTest(value=value), self.assertRaises(PolicyError) as caught:
                grant_expiry({"expires_on": value})
            self.assertEqual(caught.exception.code, "grant_expiration_unverified")
        for value in ("2026-10-30", "2028-02-29"):
            with self.subTest(value=value):
                self.assertEqual(grant_expiry({"expires_on": value}).isoformat(), value + "T00:00:00+00:00")

    def test_usage_priority_handles_utc_conversion_overflow_as_unverified(self):
        snapshot = {"grants": [{"balance_usd": "1", "expires_on": "2026-11-18"}]}
        before = json.dumps(snapshot, sort_keys=True)
        for now in (datetime.min.replace(tzinfo=timezone(timedelta(hours=1))),
                    datetime.max.replace(tzinfo=timezone(timedelta(hours=-1)))):
            with self.subTest(now=now):
                result = usage_priority(snapshot, now=now)
                self.assertEqual(result["level"], "unverified")
                self.assertIsNone(result["expires_at"])
                self.assertIsNone(result["days_until_expiry"])
                self.assertTrue(result["advisory_only"])
                self.assertEqual(json.dumps(snapshot, sort_keys=True), before)


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "ledger.sqlite"
        self.db = Ledger(self.path, policy())
        self.snapshot = funding()
        self.db.refresh_funding(self.snapshot)
        self.db.set_enabled(True)

    def tearDown(self):
        self.tmp.cleanup()

    def test_atomic_admission_with_two_process_equivalent_connections(self):
        def reserve(index):
            ledger = Ledger(self.path, policy())
            candidate = request("batch", "embeddings")
            candidate["purpose"]["description"] += f" {index}"
            candidate["payload"]["input"] += f" {index}"
            try:
                return ledger.reserve(candidate, 600000, async_job=True)["job_id"]
            except PolicyError as error:
                return error.code
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(reserve, range(2)))
        self.assertEqual(results.count("allocation_exhausted"), 1)
        self.assertEqual(self.db.status()["reserved_microusd"], 600000)

    def test_uncertain_sync_keeps_reservation_and_slot_across_restart(self):
        job = self.db.reserve(request(), 100000)
        self.db.update_job(job["job_id"], "uncertain", api_id="resp-synthetic")
        restarted = Ledger(self.path, policy())
        same_task = json.loads(json.dumps(request()))
        same_task.update({"model": "changed-model", "tier": "flex", "max_cost_usd": "2",
                          "deadline": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()})
        same_task["payload"]["max_output_tokens"] = 900
        with self.assertRaises(PolicyError) as caught:
            restarted.reserve(same_task, 10000)
        self.assertEqual(caught.exception.code, "duplicate_request")

        changed_purpose = json.loads(json.dumps(request()))
        changed_purpose["purpose"]["description"] = "A different task using the same provider input"
        with self.assertRaises(PolicyError) as caught:
            restarted.reserve(changed_purpose, 10000)
        self.assertEqual(caught.exception.code, "duplicate_request")

        batch_retry = request("batch", "embeddings")
        with self.assertRaises(PolicyError) as caught:
            restarted.reserve(batch_retry, 10000, async_job=True, identity_requests=[batch_retry])
        self.assertEqual(caught.exception.code, "duplicate_request")

        self.assertEqual(restarted.pending()[0]["api_id"], "resp-synthetic")
        self.assertEqual(restarted.status()["reserved_microusd"], 100000)

        distinct = request()
        distinct["purpose"] = {"kind": "contract_test", "description": "Check a separate endpoint contract"}
        distinct["payload"]["input"] = "different synthetic input"
        allowed = restarted.reserve(distinct, 10000)
        self.assertEqual(allowed["status"], "reserved")
        self.assertEqual(restarted.get_job(job["job_id"])["status"], "uncertain")
        self.assertEqual(restarted.status()["reserved_microusd"], 110000)

        restarted.update_job(job["job_id"], "completed", actual_microusd=25000, usage={"input_tokens": 100})
        self.assertEqual(restarted.status()["reserved_microusd"], 10000)
        self.assertEqual(restarted.status()["spent_microusd"], 25000)
        restarted.update_job(allowed["job_id"], "completed", actual_microusd=10000)
        restarted.reserve(request(), 10000)

    def test_active_sync_invocation_still_serializes_unrelated_requests(self):
        job = self.db.reserve(request(), 100000)
        distinct = request()
        distinct["purpose"] = {"kind": "contract_test", "description": "A separate active task"}
        distinct["payload"]["input"] = "separate input"
        with self.assertRaises(PolicyError) as caught:
            self.db.reserve(distinct, 10000)
        self.assertEqual(caught.exception.code, "sync_slot_busy")
        self.assertEqual(self.db.get_job(job["job_id"])["status"], "reserved")
        self.assertEqual(self.db.status()["reserved_microusd"], 100000)

    def test_legacy_uncertain_sync_uses_purpose_without_fabricating_payload_hash(self):
        original = request()
        job = self.db.reserve(original, 100000)
        with self.db._db(True) as db:
            db.execute("UPDATE jobs SET status='uncertain',request_meta=? WHERE job_id=?",
                       (json.dumps({"capability": original["capability"], "purpose": original["purpose"],
                                    "model": original["model"], "tier": original["tier"]}), job["job_id"]))

        with self.assertRaises(PolicyError) as caught:
            self.db.reserve(original, 10000)
        self.assertEqual(caught.exception.code, "duplicate_request")
        distinct = request()
        distinct["purpose"] = {"kind": "contract_test", "description": "A different legacy-classified task"}
        distinct["payload"]["input"] = "distinct input"
        allowed = self.db.reserve(distinct, 10000)
        self.assertEqual(allowed["status"], "reserved")
        old = self.db.get_job(job["job_id"])
        self.assertIsNone(old["request_meta"].get("request_identity_version"))
        self.assertEqual(self.db.status()["reserved_microusd"], 110000)

    def test_unkeyed_legacy_uncertain_sync_fails_closed(self):
        job = self.db.reserve(request(), 100000)
        with self.db._db(True) as db:
            db.execute("UPDATE jobs SET status='uncertain',request_meta=? WHERE job_id=?",
                       (json.dumps({"capability": "responses", "model": "test", "tier": "default"}), job["job_id"]))
        distinct = request()
        distinct["purpose"] = {"kind": "contract_test", "description": "Different task"}
        distinct["payload"]["input"] = "different input"
        with self.assertRaises(PolicyError) as caught:
            self.db.reserve(distinct, 10000)
        self.assertEqual(caught.exception.code, "duplicate_scope_unresolved")
        self.assertEqual(self.db.status()["reserved_microusd"], 100000)

    def test_concurrent_duplicate_reservations_are_atomic(self):
        def reserve(_):
            ledger = Ledger(self.path, policy())
            try:
                return ("reserved", ledger.reserve(request(), 10000)["job_id"])
            except PolicyError as error:
                return ("blocked", error.code)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(reserve, range(2)))
        self.assertEqual([result[0] for result in results].count("reserved"), 1)
        blocked = [result[1] for result in results if result[0] == "blocked"]
        self.assertEqual(len(blocked), 1)
        self.assertIn(blocked[0], {"duplicate_request", "sync_slot_busy"})
        self.assertEqual(self.db.status()["reserved_microusd"], 10000)

    def test_disable_keeps_retrieval_and_terminal_unknown_cost_holds_budget(self):
        job = self.db.reserve(request("batch", "embeddings"), 100000, async_job=True)
        self.db.set_enabled(False)
        self.db.update_job(job["job_id"], "cancelled", api_id="batch-synthetic", metadata={"input_file_id": "file-synthetic"})
        self.assertEqual(self.db.get_job(job["job_id"])["metadata"]["input_file_id"], "file-synthetic")
        self.assertEqual(self.db.status()["reserved_microusd"], 100000)
        with self.assertRaises(PolicyError) as caught:
            self.db.reserve(request(), 10000)
        self.assertEqual(caught.exception.code, "execution_disabled")

    def test_reverification_does_not_reset_consumption(self):
        job = self.db.reserve(request(), 100000)
        self.db.update_job(job["job_id"], "completed", actual_microusd=900000)
        self.db.refresh_funding(self.snapshot)
        with self.assertRaises(PolicyError):
            self.db.reserve(request(), 60000)
        self.assertEqual(self.db.status()["spent_microusd"], 900000)
        with self.assertRaises(PolicyError):
            self.db.refresh_funding({**self.snapshot, "expires_at": (datetime.now(timezone.utc) + timedelta(days=11)).isoformat()})

    def test_no_private_payload_in_ledger_and_deadline_coverage(self):
        req = request()
        req["payload"]["input"] = "PRIVATE_PAYLOAD_CANARY"
        job = self.db.reserve(req, 10000)
        self.assertNotIn("PRIVATE_PAYLOAD_CANARY", json.dumps(self.db.get_job(job["job_id"])))
        req["deadline"] = (datetime.now(timezone.utc) + timedelta(days=20)).isoformat()
        with self.assertRaises(PolicyError) as caught:
            self.db.reserve(req, 10000, async_job=True)
        self.assertEqual(caught.exception.code, "grant_deadline_exceeded")


    def test_batch_reserves_entire_completion_window(self):
        short_grant = {**self.snapshot, "grant_id": "grant-short", "expires_at": (datetime.now(timezone.utc) + timedelta(hours=12)).isoformat()}
        self.db.refresh_funding(short_grant)
        with self.assertRaises(PolicyError) as caught:
            self.db.reserve(request("batch", "embeddings"), 10000, async_job=True)
        self.assertEqual(caught.exception.code, "grant_deadline_exceeded")

    def test_batch_deadline_includes_upload_and_create(self):
        short = {**request("batch", "embeddings"),
                 "deadline": (datetime.now(timezone.utc) + timedelta(hours=24, seconds=30)).isoformat()}
        with self.assertRaises(PolicyError) as caught:
            self.db.reserve(short, 10000, async_job=True)
        self.assertEqual(caught.exception.code, "deadline_too_short")
        ending = {**self.snapshot, "grant_id": "batch-upload-window",
                  "expires_at": (datetime.now(timezone.utc) + timedelta(hours=24, seconds=30)).isoformat()}
        self.db.refresh_funding(ending)
        with self.assertRaises(PolicyError) as caught:
            self.db.reserve(request("batch", "embeddings"), 10000, async_job=True)
        self.assertEqual(caught.exception.code, "grant_deadline_exceeded")

    def test_new_grant_keeps_uncertain_reservations_and_existing_platform_spend(self):
        old = self.db.reserve(request(), 600000)
        self.db.update_job(old["job_id"], "uncertain")
        self.db.refresh_funding({**self.snapshot, "grant_id": "grant-new"})
        distinct = request()
        distinct["purpose"]["description"] = "A distinct task after grant refresh"
        distinct["payload"]["input"] = "different synthetic data"
        with self.assertRaises(PolicyError) as caught:
            self.db.reserve(distinct, 600000)
        self.assertEqual(caught.exception.code, "allocation_exhausted")
        self.assertEqual(self.db.status()["reserved_microusd"], 600000)
        with self.assertRaises(PolicyError) as caught:
            self.db.refresh_funding({**self.snapshot, "platform_spend_usd": ".1"})
        self.assertEqual(caught.exception.code, "allocation_invalid")

    def test_sync_funding_covers_full_timeout_retries_and_fallback_window(self):
        bounded = {**policy(), "request_timeout_seconds": 30, "max_transient_retries": 2,
                   "retry_elapsed_seconds": 60, "standard_fallback": True}
        ledger = Ledger(self.path, bounded)
        short = {**self.snapshot, "grant_id": "short-sync",
                 "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=200)).isoformat()}
        ledger.refresh_funding(short)
        # Standard's 3*30s + 60s window fits; authorized Flex->Standard needs twice that.
        ledger.reserve(request(), 10000)
        job = ledger.pending()[0]
        ledger.update_job(job["job_id"], "completed", actual_microusd=0)
        fallback = {**request("flex"), "allow_standard_fallback": True}
        with self.assertRaises(PolicyError) as caught:
            ledger.reserve(fallback, 10000)
        self.assertEqual(caught.exception.code, "grant_deadline_exceeded")
        with self.assertRaises(PolicyError) as caught:
            ledger.reserve({**request(), "deadline": (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat()}, 10000)
        self.assertEqual(caught.exception.code, "deadline_too_short")
        short["grant_id"] = "too-short-standard"
        short["expires_at"] = (datetime.now(timezone.utc) + timedelta(seconds=100)).isoformat()
        ledger.refresh_funding(short)
        with self.assertRaises(PolicyError) as caught:
            ledger.reserve(request(), 10000)
        self.assertEqual(caught.exception.code, "grant_deadline_exceeded")


class PrepaidTests(unittest.TestCase):
    def setUp(self):
        fixed_now = datetime(2026, 10, 15, 12, tzinfo=timezone.utc)

        class Clock(datetime):
            @classmethod
            def now(cls, tz=None):
                return fixed_now.astimezone(tz) if tz else fixed_now.replace(tzinfo=None)

        for target in ("openai_capabilities.ledger.datetime", "openai_capabilities.policy.datetime",
                       f"{__name__}.datetime"):
            patcher = patch(target, Clock)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = Ledger(Path(self.tmp.name) / "prepaid.sqlite", prepaid_policy())
        self.snapshot = prepaid_funding()
        self.db.refresh_funding(self.snapshot)
        self.db.update_account_costs(account_costs(self.snapshot))
        self.db.set_enabled(True)

    def test_newer_balance_closes_old_unresolved_holds_but_keeps_live_and_retrievable_ones(self):
        db = Ledger(Path(self.tmp.name) / "prepaid.sqlite", {**prepaid_policy(), "max_sync_jobs": 8})

        def task(name):
            body = request()
            body["purpose"]["description"] = f"Synthetic task {name}"
            body["payload"]["input"] = f"synthetic input {name}"
            return body

        now = datetime.now(timezone.utc)
        jobs = {name: db.reserve(task(name), 100000)["job_id"] for name in ("lost", "stuck", "live", "retrievable", "recent")}
        db.update_job(jobs["lost"], "uncertain")
        db.update_job(jobs["recent"], "uncertain")
        db.update_job(jobs["stuck"], "submitting")
        db.update_job(jobs["live"], "submitting")
        db.update_job(jobs["retrievable"], "uncertain", api_id="resp_synthetic")
        old, recent = (now - timedelta(hours=2)).isoformat(), (now - timedelta(seconds=60)).isoformat()
        with db._db(True) as raw:
            raw.execute("UPDATE jobs SET created_at=?, updated_at=?", (old, old))
            raw.execute("UPDATE jobs SET updated_at=? WHERE job_id=?", (recent, jobs["live"]))  # inside its 150 s window
            # Ended 10 minutes before the observation: its window closed, but the 1 hour billing grace has not passed.
            raw.execute("UPDATE jobs SET updated_at=? WHERE job_id=?", ((now - timedelta(minutes=10)).isoformat(), jobs["recent"]))

        newer = {**self.snapshot, "funding_window_id": "observation-two", "verified_at": (now - timedelta(seconds=10)).isoformat()}
        db.refresh_funding(newer)
        state = {name: db.get_job(job_id) for name, job_id in jobs.items()}
        for name in ("lost", "stuck"):
            self.assertEqual((state[name]["status"], state[name]["actual_microusd"]), ("failed", 0), name)
            closed = state[name]["metadata"]["superseded_by_balance"]
            self.assertEqual(closed["funding_window_id"], "observation-two")
            self.assertEqual(closed["previous_funding_window_id"], "observation-one")
            self.assertIn("placeholder", closed["actual_cost"])
        self.assertEqual(state["live"]["status"], "submitting", "a job inside its execution window may still be running")
        self.assertEqual(state["retrievable"]["status"], "uncertain", "a response ID can still be resumed for its real cost")
        self.assertEqual(state["recent"]["status"], "uncertain", "its charge may not show in the observed balance yet")
        self.assertEqual(db.status()["reserved_microusd"], 300000)

        db.update_account_costs(account_costs(newer))
        with self.assertRaises(PolicyError) as caught:
            db.reserve(task("lost"), 100000)
        self.assertEqual(caught.exception.code, "duplicate_request", "a closed hold never frees its task for a retry")
        self.assertEqual(db.reserve(task("fresh"), 100000)["status"], "reserved")

        # Re-recording the same observation closes nothing new; a job created after the observation is untouched.
        db.refresh_funding(newer)
        self.assertEqual(db.status()["reserved_microusd"], 400000)

    def test_existing_mixed_and_unknown_prepaid_allowed_but_automatic_charges_block(self):
        validate_funding(self.snapshot, prepaid_policy())
        mixed = json.loads(json.dumps(self.snapshot))
        mixed["grants"][1]["funding_type"] = "unknown"
        validate_funding(mixed, prepaid_policy())
        for key, value in [("billing_mode", "postpaid"), ("auto_recharge", "enabled"),
                           ("automatic_purchases", "unknown")]:
            with self.subTest(key=key), self.assertRaises(PolicyError):
                validate_funding({**self.snapshot, key: value}, prepaid_policy())
        with self.assertRaises(PolicyError) as raised:
            validate_funding(funding(), prepaid_policy())
        self.assertEqual(raised.exception.code, "funding_policy_unverified")

    def test_expiry_and_month_reset_never_renew_prepaid_credits(self):
        stale = json.loads(json.dumps(self.snapshot))
        stale["grants"][0] = {"grant_id": "local-expired", "funding_type": "promotional", "balance_usd": "8",
                              "expires_on": datetime.now(timezone.utc).date().isoformat()}
        with self.assertRaises(PolicyError) as raised:
            validate_funding(stale, prepaid_policy())
        self.assertEqual(raised.exception.code, "grant_expired")
        stale["platform_limit_reset_at"] = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
        with self.assertRaises(PolicyError) as raised:
            validate_funding(stale, prepaid_policy())
        self.assertEqual(raised.exception.code, "grant_expired")

    def test_api_local_max_and_pending_are_counted_once(self):
        with month_safe_prepaid_ledger(self.tmp.name, "api-local-max") as (ledger, snapshot, now):
            job = ledger.reserve(request(), 2000000)
            ledger.update_job(job["job_id"], "completed", actual_microusd=1000000)
            ledger.update_account_costs(account_costs(snapshot, total="1", org="1", project="1", now=now))
            # 9.5 allocation after margin, minus max(1 local,1 API), not minus 2.
            first = request("batch", "embeddings")
            first["purpose"]["description"] = "Create vectors for first allocation case"
            ledger.reserve(first, 8000000, async_job=True)
            second = request("batch", "embeddings")
            second["purpose"]["description"] = "Create vectors for second allocation case"
            second["payload"]["input"] = "a different synthetic batch input"
            with self.assertRaises(PolicyError) as raised:
                ledger.reserve(second, 600000, async_job=True)
            self.assertEqual(raised.exception.code, "allocation_exhausted")

    def test_external_org_spend_and_local_api_lag_protect_monthly_project_cap(self):
        job = self.db.reserve(request(), 2000000)
        self.db.update_job(job["job_id"], "completed", actual_microusd=1000000)
        snapshot = account_costs(self.snapshot, total="2", org="2", project="0")
        snapshot["project_spend_limit"]["threshold_usd"] = "2"
        self.db.update_account_costs(snapshot)
        with self.assertRaises(PolicyError) as raised:
            self.db.reserve(request(), 1100000)
        self.assertEqual(raised.exception.code, "allocation_exhausted")

    def test_refresh_same_observation_cannot_reset_or_shrink_again_and_new_balance_rebases(self):
        job = self.db.reserve(request(), 1000000)
        self.db.update_job(job["job_id"], "completed", actual_microusd=400000)
        self.db.refresh_funding(self.snapshot)
        self.assertEqual(self.db.status()["spent_microusd"], 400000)
        changed = json.loads(json.dumps(self.snapshot))
        changed["grants"][0]["balance_usd"] = "7.6"
        changed["allocation_usd"] = "9.6"
        with self.assertRaises(PolicyError):
            self.db.refresh_funding(changed)
        changed["funding_window_id"] = "observation-two"
        changed["verified_at"] = datetime.now(timezone.utc).isoformat()
        changed["account_cost_baseline"]["cost_total_usd"] = ".4"
        changed["organization_spend_usd"] = changed["project_spend_usd"] = ".4"
        self.db.refresh_funding(changed)
        self.assertEqual(self.db.status()["spent_microusd"], 0)
        with self.assertRaises(PolicyError) as raised:
            self.db.reserve(request(), 10000)
        self.assertEqual(raised.exception.code, "account_costs_unverified")
        self.db.update_account_costs(account_costs(changed, total=".4", org=".4", project=".4"))
        self.db.reserve(request(), 9000000)  # 9.6*.95=9.12; no second subtraction of the prior .4.

    def test_preflight_staleness_cost_regression_and_activation_cap_survive_refresh(self):
        job = self.db.reserve({**request(), "activation": True}, 800000)
        self.db.update_job(job["job_id"], "completed", actual_microusd=800000)
        with self.assertRaises(PolicyError) as raised:
            self.db.reserve({**request(), "activation": True}, 300000)
        self.assertEqual(raised.exception.code, "activation_budget_exhausted")
        self.db.update_account_costs(account_costs(self.snapshot, total=".8", org=".8", project=".8"))
        with self.assertRaises(PolicyError) as raised:
            self.db.update_account_costs(account_costs(self.snapshot, total=".1", org=".1", project=".1"))
        self.assertEqual(raised.exception.code, "account_costs_regressed")
        with self.assertRaises(PolicyError) as raised:
            self.db.update_account_costs(account_costs(self.snapshot, total=".8", org=".8", project=".1"))
        self.assertEqual(raised.exception.code, "account_costs_regressed")
        refreshed = json.loads(json.dumps(self.snapshot))
        refreshed["funding_window_id"] = "post-activation-observation"
        refreshed["verified_at"] = datetime.now(timezone.utc).isoformat()
        refreshed["grants"][0]["balance_usd"] = "7.2"
        refreshed["allocation_usd"] = "9.2"
        refreshed["account_cost_baseline"]["cost_total_usd"] = ".8"
        self.db.refresh_funding(refreshed)
        self.db.update_account_costs(account_costs(refreshed, total=".8", org=".8", project=".8"))
        with self.assertRaises(PolicyError) as raised:
            self.db.reserve({**request(), "activation": True}, 300000)
        self.assertEqual(raised.exception.code, "activation_budget_exhausted")
        stale = account_costs(self.snapshot)
        self.db.policy["account_cost_max_age_seconds"] = 5
        stale["window_end"] = (datetime.now(timezone.utc) - timedelta(seconds=10)).isoformat()
        with self.assertRaises(PolicyError) as raised:
            self.db.update_account_costs(stale)
        self.assertEqual(raised.exception.code, "account_costs_stale")

    def test_pending_reservations_survive_fresh_balance_rebase(self):
        with month_safe_prepaid_ledger(self.tmp.name, "pending-rebase") as (ledger, snapshot, now):
            initial = request("batch", "embeddings")
            initial["purpose"]["description"] = "Create vectors for a pending rebase case"
            ledger.reserve(initial, 8000000, async_job=True)
            refreshed = json.loads(json.dumps(snapshot))
            refreshed["funding_window_id"] = "pending-rebase"
            refreshed["verified_at"] = now.isoformat()
            ledger.refresh_funding(refreshed)
            ledger.update_account_costs(account_costs(refreshed, now=now))
            self.assertEqual(ledger.status()["reserved_microusd"], 8000000)
            second = request("batch", "embeddings")
            second["purpose"]["description"] = "Create vectors for another pending rebase case"
            second["payload"]["input"] = "another synthetic batch"
            with self.assertRaises(PolicyError) as raised:
                ledger.reserve(second, 2000000, async_job=True)
            self.assertEqual(raised.exception.code, "allocation_exhausted")

    def test_setup_delay_allows_later_baseline_as_conservative_admission_only(self):
        later = json.loads(json.dumps(self.snapshot))
        later["funding_window_id"] = "delayed-api-setup"
        later["verified_at"] = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        later["account_cost_baseline"]["observed_at"] = (datetime.now(timezone.utc) - timedelta(seconds=10)).isoformat()
        later["account_cost_baseline"]["cost_total_usd"] = "1"
        # Simulate the original confirmed observation being recorded after setup;
        # it must not need a fabricated new confirmation timestamp.
        fresh_db = Ledger(Path(self.tmp.name) / "delayed.sqlite", prepaid_policy())
        fresh_db.refresh_funding(later)
        fresh_db.update_account_costs(account_costs(later, total="1", org="1", project="1"))
        fresh_db.set_enabled(True)
        self.assertEqual(fresh_db.status()["account_cost_basis"], "conservative_lower_bound")
        # The entire $1 window is conservatively held against the $9.5 usable
        # allocation; subtracting that $1 baseline would incorrectly admit $9.
        with self.assertRaises(PolicyError) as raised:
            fresh_db.reserve(request(), 9000000)
        self.assertEqual(raised.exception.code, "allocation_exhausted")
        fresh_db.reserve(request(), 8000000)

    def test_old_before_manual_baseline_is_conservative_and_does_not_expire_consent(self):
        earlier = json.loads(json.dumps(self.snapshot))
        earlier["account_cost_baseline"]["observed_at"] = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        validate_funding(earlier, prepaid_policy())
        fresh_db = Ledger(Path(self.tmp.name) / "earlier.sqlite", prepaid_policy())
        fresh_db.refresh_funding(earlier)
        self.assertEqual(fresh_db.status()["account_cost_basis"], "conservative_lower_bound")

    def test_limit_api_unavailable_requires_current_explicit_manual_enforcement(self):
        snapshot = account_costs(self.snapshot)
        unavailable = {"availability": "unavailable", "http_status": 404, "source": "official_admin_api"}
        snapshot["organization_spend_limit"] = dict(unavailable)
        snapshot["project_spend_limit"] = dict(unavailable)
        snapshot["limits_api_available"] = False
        with self.assertRaises(PolicyError) as raised:
            self.db.update_account_costs(snapshot)
        self.assertEqual(raised.exception.code, "hard_limit_unverified")
        confirmed = json.loads(json.dumps(self.snapshot))
        confirmed["funding_window_id"] = "manual-current-month-caps"
        confirmed["verified_at"] = datetime.now(timezone.utc).isoformat()
        confirmed["limit_verification"] = {"source": "user_confirmation", "verified_at": confirmed["verified_at"]}
        self.db.refresh_funding(confirmed)
        self.db.update_account_costs(account_costs(confirmed) | {
            "organization_spend_limit": dict(unavailable), "project_spend_limit": dict(unavailable), "limits_api_available": False})
        job = self.db.reserve(request(), 10000)
        self.assertEqual(self.db.status()["effective_limits"]["project"]["source"], "user_confirmation")
        self.db.update_job(job["job_id"], "completed", actual_microusd=0)
        # The stored supported readback retains only unavailability facts.
        with self.db._db() as db:
            evidence = self.db._setting(db, "account_costs")["snapshot"]["project_spend_limit"]
        self.assertEqual(evidence, unavailable)
        self.assertNotIn("threshold_usd", evidence)
        now = datetime.now(timezone.utc)
        for when in [(now + timedelta(days=1)).isoformat(), (now.replace(day=1) - timedelta(days=1)).isoformat()]:
            with self.subTest(when=when), self.assertRaises(PolicyError):
                self.db._effective_limit("project", snapshot, confirmed | {
                    "limit_verification": {"source": "user_confirmation", "verified_at": when}}, now)

    def test_live_api_caps_always_override_manual_fallback_and_month_reset_stops_admission(self):
        confirmed = json.loads(json.dumps(self.snapshot))
        confirmed["funding_window_id"] = "manual-then-api"
        confirmed["verified_at"] = datetime.now(timezone.utc).isoformat()
        confirmed["limit_verification"] = {"source": "user_confirmation", "verified_at": confirmed["verified_at"]}
        self.db.refresh_funding(confirmed)
        snapshot = account_costs(confirmed)
        snapshot["project_spend_limit"]["threshold_usd"] = ".01"
        self.db.update_account_costs(snapshot)
        self.assertEqual(self.db.status()["effective_limits"]["project"]["source"], "official_admin_api")
        with self.assertRaises(PolicyError) as raised:
            self.db.reserve(request(), 20000)
        self.assertEqual(raised.exception.code, "allocation_exhausted")
        inactive = json.loads(json.dumps(snapshot))
        inactive["project_spend_limit"]["enforcement"] = "inactive"
        with self.assertRaises(PolicyError):
            self.db.update_account_costs(inactive)
        reset = confirmed | {"platform_limit_reset_at": (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()}
        with self.assertRaises(PolicyError) as raised:
            validate_funding(reset, prepaid_policy())
        self.assertEqual(raised.exception.code, "platform_limit_stale")

    def test_inactive_runtime_status_accepts_matching_hash_bound_configured_ui_controls(self):
        confirmed = json.loads(json.dumps(self.snapshot))
        confirmed["funding_window_id"] = "configured-ui-controls"
        confirmed["verified_at"] = datetime.now(timezone.utc).isoformat()
        confirmed["limit_verification"] = {
            "source": "user_confirmation", "verified_at": confirmed["verified_at"],
            "api_status_interpretation": "configuration_verified_separately",
            "ui_evidence": {"organization": {"path": "evidence/organization.png", "sha256": "a" * 64},
                            "project": {"path": "evidence/project.png", "sha256": "b" * 64}}}
        self.db.refresh_funding(confirmed)
        snapshot = account_costs(confirmed)
        for scope in ("organization", "project"):
            snapshot[scope + "_spend_limit"]["enforcement"] = "inactive"
        self.db.update_account_costs(snapshot)
        job = self.db.reserve(request(), 10000)
        self.db.update_job(job["job_id"], "completed", actual_microusd=0)
        for scope in ("organization", "project"):
            self.assertEqual(self.db.status()["effective_limits"][scope]["source"], "user_screenshot_verified_with_api_inactive")
        with self.db._db() as db:
            raw = self.db._setting(db, "account_costs")["snapshot"]
        self.assertEqual(raw["organization_spend_limit"]["enforcement"], "inactive")
        self.assertEqual(raw["project_spend_limit"]["enforcement"], "inactive")
        wrong = json.loads(json.dumps(snapshot))
        wrong["project_spend_limit"]["threshold_usd"] = "19"
        with self.assertRaises(PolicyError) as caught:
            self.db.update_account_costs(wrong)
        self.assertEqual(caught.exception.code, "hard_limit_ui_mismatch")

        now = datetime.now(timezone.utc)
        changes = []
        for name in ("organization", "project"):
            missing = json.loads(json.dumps(confirmed))
            del missing["limit_verification"]["ui_evidence"][name]["sha256"]
            changes.append(missing)
        missing = json.loads(json.dumps(confirmed))
        del missing["limit_verification"]["api_status_interpretation"]
        changes.append(missing)
        for when in [(now + timedelta(minutes=1)).isoformat()]:
            old = json.loads(json.dumps(confirmed))
            old["limit_verification"]["verified_at"] = when
            changes.append(old)
        for changed in changes:
            with self.subTest(changed=changed), self.assertRaises(PolicyError):
                self.db._effective_limit("project", snapshot, changed, now)

    def test_monthly_rollover_refreshes_only_cycle_and_preserves_credit_and_activation_windows(self):
        october = datetime(2026, 10, 30, 12, tzinfo=timezone.utc)
        november = datetime(2026, 11, 1, 12, tzinfo=timezone.utc)
        clock = [october]

        class Clock(datetime):
            @classmethod
            def now(cls, tz=None):
                return clock[0].astimezone(tz) if tz else clock[0].replace(tzinfo=None)

        observed = json.loads(json.dumps(self.snapshot))
        observed.update({"funding_window_id": "october-existing-credits",
                         "verified_at": (october - timedelta(seconds=30)).isoformat(),
                         "platform_limit_reset_at": "2026-11-01T00:00:00+00:00",
                         "organization_spend_usd": "8", "project_spend_usd": "8"})
        observed["grants"][0]["expires_at"] = "2026-11-18T00:00:00+00:00"
        observed["grants"][1]["expires_on"] = "2027-10-31"
        observed["account_cost_baseline"] = {"window_start": "2026-10-30T00:00:00+00:00",
                                              "observed_at": (october - timedelta(seconds=60)).isoformat(),
                                              "cost_total_usd": "0"}
        observed["limit_verification"] = {"source": "user_confirmation", "verified_at": observed["verified_at"],
            "api_status_interpretation": "configuration_verified_separately",
            "ui_evidence": {"organization": {"path": "evidence/org.png", "sha256": "a" * 64},
                            "project": {"path": "evidence/project.png", "sha256": "b" * 64}}}

        def api(total, monthly):
            result = account_costs(observed, total=total, org=monthly, project=monthly)
            result["observed_at"] = result["window_end"] = clock[0].isoformat()
            result["month_start"] = clock[0].replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
            for scope in ("organization", "project"):
                result[scope + "_spend_limit"]["enforcement"] = "inactive"
            return result

        with patch("openai_capabilities.ledger.datetime", Clock), patch("openai_capabilities.policy.datetime", Clock):
            ledger = Ledger(Path(self.tmp.name) / "rollover.sqlite", prepaid_policy())
            ledger.refresh_funding(observed)
            ledger.update_account_costs(api("0", "8"))
            ledger.set_enabled(True)
            job = ledger.reserve(request() | {"activation": True}, 500000)
            ledger.update_job(job["job_id"], "completed", actual_microusd=400000)
            batch_activation = request("batch", "embeddings") | {"activation": True}
            batch_activation["purpose"]["description"] = "Test a separate Batch activation contract"
            ledger.reserve(batch_activation, 300000, async_job=True)
            ledger.update_account_costs(api(".4", "8.4"))
            original = ledger.funding()
            clock[0] = november
            # A stale monthly counter is refreshable while the actual credits remain active.
            validate_funding(original, prepaid_policy(), allow_platform_stale=True)
            with self.assertRaises(PolicyError) as caught:
                ledger.validate_ready_funding()
            self.assertEqual(caught.exception.code, "account_costs_stale")
            ledger.update_account_costs(api(".4", "0"))
            self.assertEqual(ledger.validate_ready_funding().isoformat(), "2026-12-01T00:00:00+00:00")
            self.assertEqual(ledger.status()["monthly_cycle"]["reset_at"], "2026-12-01T00:00:00+00:00")
            self.assertEqual(ledger.funding(), original)
            self.assertEqual(ledger.status()["spent_microusd"], 400000)
            self.assertEqual(ledger.status()["reserved_microusd"], 300000)
            self.assertEqual(ledger.status()["activation_consumed_microusd"], 700000)
            with self.assertRaises(PolicyError) as caught:
                ledger.reserve(request() | {"activation": True}, 400000)
            self.assertEqual(caught.exception.code, "activation_budget_exhausted")
            ledger.reserve(request(), 300000)
            # A counter reset never renews the original expiring prepaid grant.
            clock[0] = datetime(2026, 11, 19, tzinfo=timezone.utc)
            with self.assertRaises(PolicyError) as caught:
                validate_funding(original, prepaid_policy(), allow_platform_stale=True)
            self.assertEqual(caught.exception.code, "grant_expired")
            # Without a readable matching cap, October-only manual proof cannot
            # authenticate November's unavailable control.
            missing = api(".4", "0")
            missing["project_spend_limit"] = {"availability": "unavailable", "http_status": 404, "source": "official_admin_api"}
            with self.assertRaises(PolicyError) as caught:
                ledger._effective_limit("project", missing, original, november)
            self.assertEqual(caught.exception.code, "hard_limit_verification_stale")



if __name__ == "__main__":
    unittest.main()
