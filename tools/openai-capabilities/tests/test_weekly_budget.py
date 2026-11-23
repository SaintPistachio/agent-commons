from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

from openai_capabilities.ledger import Ledger
from openai_capabilities.policy import PolicyError


UTC = timezone.utc
START = datetime(2026, 10, 30, 20, 0, tzinfo=UTC)


class FrozenDateTime(datetime):
    current = START

    @classmethod
    def now(cls, tz=None):
        return cls.current.astimezone(tz) if tz else cls.current.replace(tzinfo=None)


@contextmanager
def frozen_time(value):
    FrozenDateTime.current = value
    with patch("openai_capabilities.ledger.datetime", FrozenDateTime), \
            patch("openai_capabilities.policy.datetime", FrozenDateTime):
        yield


def _month_start(now):
    return now.astimezone(UTC).replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def prepaid_policy():
    return {"organization_id": "org-synthetic", "project_id": "project-synthetic",
            "funding_policy": "existing_prepaid_only", "allocation_margin": "0.05",
            "activation_max_usd": "1", "request_timeout_seconds": 30,
            "retry_elapsed_seconds": 60, "max_transient_retries": 2,
            "account_cost_max_age_seconds": 300}


def funding(now, *, window_id="weekly-observation-one", promo="130", long="4.99",
            allocation=None, promo_expiry="2026-11-18T00:00:00+00:00", long_expiry="2027-10-31"):
    month_start = _month_start(now)
    grants = [
        {"grant_id": "synthetic-promo", "funding_type": "promotional", "balance_usd": promo,
         "expires_at": promo_expiry},
        {"grant_id": "synthetic-unknown", "funding_type": "unknown", "balance_usd": long,
         "expires_on": long_expiry},
    ]
    balance = Decimal(promo) + Decimal(long)
    return {"funding_policy": "existing_prepaid_only", "funding_window_id": window_id,
            "organization_id": "org-synthetic", "project_id": "project-synthetic",
            "source": "synthetic user-confirmed grant snapshot",
            "verified_at": (now - timedelta(seconds=30)).isoformat(), "billing_mode": "prepaid",
            "auto_recharge": "disabled", "automatic_purchases": "disabled", "grants": grants,
            "allocation_usd": allocation or str(balance),
            "organization_limit_usd": "200", "organization_spend_usd": "0",
            "project_limit_usd": "200", "project_spend_usd": "0",
            "platform_hard_limit_enforced": True,
            "platform_limit_reset_at": (month_start + timedelta(days=32)).isoformat(),
            "account_cost_baseline": {"window_start": month_start.isoformat(), "cost_total_usd": "0",
                                      "observed_at": (now - timedelta(seconds=60)).isoformat()}}


def costs(snapshot, now, *, total="0", monthly_spend="0"):
    limit = {"threshold_usd": "200", "enforcement": "enforcing", "currency": "USD", "interval": "month"}
    return {"source": "official_admin_api", "status": "observed",
            "organization_id": snapshot["organization_id"], "project_id": snapshot["project_id"],
            "observed_at": now.isoformat(), "window_end": now.isoformat(),
            "window_start": snapshot["account_cost_baseline"]["window_start"],
            "cost_total_usd": total, "month_start": _month_start(now).isoformat(),
            "organization_spend_usd": monthly_spend, "project_spend_usd": monthly_spend,
            "organization_spend_limit": dict(limit), "project_spend_limit": dict(limit)}


def request(name):
    return {"capability": "responses", "model": "synthetic-model", "tier": "default",
            "purpose": {"kind": "weekly-budget-test", "description": "Synthetic budget case " + name},
            "payload": {"input": "Synthetic only: " + name, "max_output_tokens": 10}}


class WeeklyBudgetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "ledger.sqlite"
        self.ledger = Ledger(self.path, prepaid_policy())
        with frozen_time(START):
            observed = funding(START)
            self.ledger.refresh_funding(observed)
            self.ledger.update_account_costs(costs(observed, START))
            self.ledger.set_enabled(True)

    def tearDown(self):
        self.temp.cleanup()

    def refresh_costs(self, now, *, total="0", monthly_spend="0"):
        observed = self.ledger.funding()
        self.ledger.update_account_costs(costs(observed, now, total=total, monthly_spend=monthly_spend))

    def test_dry_run_does_not_activate_and_first_reservation_uses_each_grants_ceil_windows(self):
        with frozen_time(START):
            before = self.ledger.status()["weekly_budget"]
            self.assertEqual(before["status"], "activation_pending")
            self.assertTrue(before["activation_pending"])
            self.assertTrue(before["window_is_provisional"])
            self.assertIsNone(before["activated_at"])
            self.assertEqual(before["provisional_anchor_at"], before["window_start"])
            with self.ledger._db() as db:
                self.assertIsNone(self.ledger._setting(db, "weekly_budget"))

            self.assertEqual(self.ledger.check_reservation(request("dry-run"), 1_000_000)["status"], "eligible")
            with self.ledger._db() as db:
                self.assertIsNone(self.ledger._setting(db, "weekly_budget"))

            self.ledger.reserve(request("activate"), 1_000_000)
            weekly = self.ledger.status()["weekly_budget"]
            self.assertEqual(weekly["status"], "active")
            self.assertFalse(weekly["activation_pending"])
            self.assertEqual(weekly["timezone"], "America/Chicago")
            self.assertEqual(weekly["window_index"], 0)
            self.assertEqual(weekly["grant_estimates"][0]["windows_remaining"], 3)
            self.assertEqual(weekly["grant_estimates"][1]["windows_remaining"], 53)
            self.assertEqual(weekly["grant_estimates"][0]["weekly_contribution_usd"], "43.333333")
            self.assertEqual(weekly["grant_estimates"][1]["weekly_contribution_usd"], "0.09415")
            self.assertEqual(weekly["weekly_limit_usd"], "43.427483")
            self.assertEqual(weekly["spent_or_reserved_usd"], "1")
            self.assertEqual(weekly["window_held_reservations_usd"], "1")
            self.assertEqual(weekly["all_unresolved_reservations_usd"], "1")
            self.assertFalse(weekly["window_is_provisional"])
            self.assertEqual(weekly["activated_at"], weekly["window_start"])
            self.assertTrue(weekly["grant_balances_are_estimates"])

    def test_exhausted_window_blocks_new_inference_until_rollover_and_keeps_uncertain_hold(self):
        with frozen_time(START):
            initial = self.ledger.status()["weekly_budget"]["weekly_limit_usd"]
            limit = int(Decimal(initial) * 1_000_000)
            job = self.ledger.reserve(request("consume-current-week"), limit)
            self.ledger.update_job(job["job_id"], "uncertain")
            with self.assertRaises(PolicyError) as caught:
                self.ledger.reserve(request("blocked-current-week"), 1)
            self.assertEqual(caught.exception.code, "weekly_budget_exhausted")
            weekly = self.ledger.status()["weekly_budget"]
            self.assertTrue(weekly["weekly_exhausted"])
            self.assertEqual(weekly["available_for_new_requests_usd"], "0")

            next_week = START.astimezone(ZoneInfo("America/Chicago")) + timedelta(days=7)
            FrozenDateTime.current = next_week
            self.refresh_costs(next_week)
            resumed = self.ledger.reserve(request("next-week"), 1_000_000)
            self.assertEqual(resumed["status"], "reserved")
            weekly = self.ledger.status()["weekly_budget"]
            self.assertEqual(weekly["window_index"], 1)
            self.assertEqual(weekly["spent_or_reserved_usd"], "1")
            self.assertEqual(weekly["grant_estimates"][0]["windows_remaining"], 2)
            self.assertEqual(weekly["grant_estimates"][1]["windows_remaining"], 52)
            # The held prior-week reservation reduced the new allocation once,
            # while it is not counted again as current-week usage.
            self.assertGreater(Decimal(weekly["weekly_limit_usd"]), Decimal("0"))
            self.assertLess(Decimal(weekly["weekly_limit_usd"]), Decimal("43.427483"))

    def test_unused_balance_is_redistributed_at_next_window_not_midweek(self):
        with frozen_time(START):
            first = self.ledger.reserve(request("small-first-week"), 5_000_000)
            self.ledger.update_job(first["job_id"], "completed", actual_microusd=5_000_000)
            before = self.ledger.status()["weekly_budget"]
            self.assertEqual(before["weekly_limit_usd"], "43.427483")
            self.assertEqual(before["spent_or_reserved_usd"], "5")
            next_week = START.astimezone(ZoneInfo("America/Chicago")) + timedelta(days=7)
            FrozenDateTime.current = next_week
            self.refresh_costs(next_week, total="5", monthly_spend="0")
            self.ledger.reserve(request("rollover"), 1_000_000)
            after = self.ledger.status()["weekly_budget"]
            self.assertEqual(after["window_index"], 1)
            self.assertGreater(Decimal(after["weekly_limit_usd"]), Decimal(before["weekly_limit_usd"]))
            self.assertEqual(after["grant_estimates"][0]["windows_remaining"], 2)
            self.assertEqual(after["grant_estimates"][1]["windows_remaining"], 52)

    def test_two_ledger_connections_cannot_admit_more_than_one_weekly_cap(self):
        with frozen_time(START):
            cap = int(Decimal(self.ledger.status()["weekly_budget"]["weekly_limit_usd"]) * 1_000_000)

            def reserve(index):
                instance = Ledger(self.path, prepaid_policy())
                try:
                    return instance.reserve(request("parallel-" + str(index)), 30_000_000, async_job=True)["job_id"]
                except PolicyError as exc:
                    return exc.code

            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(reserve, range(2)))
            self.assertEqual(sum(result != "weekly_budget_exhausted" for result in results), 1)
            self.assertEqual(results.count("weekly_budget_exhausted"), 1)
            self.assertEqual(self.ledger.status()["reserved_microusd"], 30_000_000)
            self.assertEqual(self.ledger.status()["weekly_budget"]["weekly_limit_usd"], "43.427483")
            self.assertGreater(cap, 30_000_000)

    def test_reenable_and_new_verified_balance_do_not_reset_activation_or_current_week_cap(self):
        with frozen_time(START):
            job = self.ledger.reserve(request("settled-before-refresh"), 1_000_000)
            self.ledger.update_job(job["job_id"], "completed", actual_microusd=1_000_000)
            original = self.ledger.status()["weekly_budget"]
            anchor = original["activated_at"]
            cap = original["weekly_limit_usd"]

            later = START + timedelta(minutes=2)
            FrozenDateTime.current = later
            self.refresh_costs(later, total="1", monthly_spend="1")
            updated = funding(later, window_id="weekly-observation-two", promo="129", long="4.99",
                              allocation="133.99")
            updated["account_cost_baseline"] = {"window_start": _month_start(later).isoformat(),
                "cost_total_usd": "1", "observed_at": (later - timedelta(seconds=30)).isoformat()}
            updated["organization_spend_usd"] = "1"
            updated["project_spend_usd"] = "1"
            self.ledger.refresh_funding(updated)
            self.ledger.update_account_costs(costs(updated, later, total="1", monthly_spend="1"))
            self.ledger.set_enabled(False)
            self.ledger.set_enabled(True)
            current = self.ledger.status()["weekly_budget"]
            self.assertEqual(current["activated_at"], anchor)
            self.assertEqual(current["weekly_limit_usd"], cap)
            self.assertEqual(current["window_index"], 0)

    def test_malformed_persisted_budget_fails_closed(self):
        with frozen_time(START):
            self.ledger.reserve(request("create-weekly-state"), 1_000_000, async_job=True)
            with self.ledger._db(True) as db:
                state = self.ledger._setting(db, "weekly_budget")
                state["weekly_limit_microusd"] = True
                self.ledger._save(db, "weekly_budget", state)
            with self.assertRaises(PolicyError) as caught:
                self.ledger.check_reservation(request("reject-corrupt-state"), 1)
            self.assertEqual(caught.exception.code, "weekly_budget_state_invalid")
            self.assertEqual(self.ledger.status()["weekly_budget"]["error_code"], "weekly_budget_state_invalid")

    def test_timeout_is_request_bounded_and_included_in_admission_horizon(self):
        short = request("short-timeout")
        long = {**request("long-timeout"), "local_timeout_seconds": 300}
        self.assertGreater(self.ledger.execution_horizon(long), self.ledger.execution_horizon(short))
        for invalid in (0, 901, 1.5, True):
            with self.subTest(invalid=invalid), self.assertRaises(PolicyError) as caught:
                self.ledger.execution_horizon({**request("invalid-timeout"), "local_timeout_seconds": invalid})
            self.assertEqual(caught.exception.code, "invalid_execution_bounds")

    def test_local_week_boundary_tracks_dst_and_partial_expiry_uses_ceil(self):
        anchor = datetime(2026, 10, 30, 15, 0, tzinfo=ZoneInfo("America/Chicago"))
        before_dst = datetime(2026, 11, 6, 14, 59, tzinfo=ZoneInfo("America/Chicago"))
        at_boundary = datetime(2026, 11, 6, 15, 0, tzinfo=ZoneInfo("America/Chicago"))
        before_start, before_reset = self.ledger._weekly_window(anchor, before_dst)[1:]
        next_index, next_start, next_reset = self.ledger._weekly_window(anchor, at_boundary)
        self.assertEqual(before_start.utcoffset(), timedelta(hours=-5))
        self.assertEqual(before_reset.utcoffset(), timedelta(hours=-6))
        self.assertEqual(next_index, 1)
        self.assertEqual(next_start, before_reset)
        self.assertEqual(next_start.hour, 15)
        self.assertEqual(next_reset.hour, 15)
        self.assertEqual(next_reset.utcoffset(), timedelta(hours=-6))

        partial_expiry = datetime(2026, 11, 18, 0, 0, tzinfo=UTC)
        self.assertEqual(self.ledger._weekly_windows_until(partial_expiry, anchor), 3)
        self.assertEqual(self.ledger._weekly_windows_until(partial_expiry, next_start), 2)
        self.assertEqual(self.ledger._weekly_windows_until(next_start, next_start), 0)


if __name__ == "__main__":
    unittest.main()
