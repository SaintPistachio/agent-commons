"""Offline checks for explicit setup writes, separate from normal tracking."""
from synthetic_keys import synthetic_key
import copy
from datetime import datetime, timedelta, timezone
import unittest
from types import SimpleNamespace

from openai_capabilities.account_setup import apply_limits, build_limits_plan
from openai_capabilities.policy import PolicyError
from test_policy_ledger import prepaid_funding, prepaid_policy, account_costs


class Resource:
    def __init__(self, amount):
        self.value = {"threshold_amount": amount, "currency": "USD", "interval": "month", "enforcement": {"status": "enforcing"}}
        self.writes = []
        self.error = None

    def retrieve(self, *args, **kwargs):
        return copy.deepcopy(self.value)

    def update(self, *args, **kwargs):
        self.writes.append(kwargs)
        if self.error:
            raise self.error
        self.value["threshold_amount"] = kwargs["threshold_amount"]
        return copy.deepcopy(self.value)


class AccountSetupTests(unittest.TestCase):
    def setUp(self):
        self.funding = prepaid_funding()
        self.policy = prepaid_policy()
        self.account = account_costs(self.funding, org="2", project="1")
        self.plan = build_limits_plan(self.funding, self.account, self.policy)
        self.org, self.project = Resource(2000), Resource(2000)
        self.client = SimpleNamespace(admin=SimpleNamespace(organization=SimpleNamespace(
            spend_limit=self.org, projects=SimpleNamespace(spend_limit=self.project))))
        self.receipts = []

    def checkpoint(self, value):
        self.receipts.append(copy.deepcopy(value))

    def test_preview_uses_monthly_spending_plus_existing_balance_not_card_charges(self):
        self.assertEqual(self.plan["desired"]["organization"]["threshold_amount"], 1200)
        self.assertEqual(self.plan["desired"]["project"]["threshold_amount"], 1100)
        self.assertEqual(self.org.writes, [])
        result = apply_limits(self.plan, self.plan["sha256"], self.policy, (synthetic_key('admin-SYNTHETIC_SETUP')),
                              client=self.client, checkpoint=self.checkpoint)
        self.assertEqual(result["status"], "applied")
        self.assertEqual(len(self.org.writes), 1)
        self.assertEqual(len(self.project.writes), 1)
        self.assertEqual(self.receipts[0]["status"], "prepared")
        self.assertEqual(self.receipts[-1]["status"], "applied")

    def test_hash_target_and_remote_drift_stop_before_writes(self):
        with self.assertRaises(PolicyError):
            apply_limits(self.plan, "0" * 64, self.policy, "admin", client=self.client, checkpoint=self.checkpoint)
        self.org.value["threshold_amount"] = 999
        with self.assertRaises(PolicyError):
            apply_limits(self.plan, self.plan["sha256"], self.policy, "admin", client=self.client, checkpoint=self.checkpoint)
        self.assertEqual(self.org.writes, [])
        self.assertEqual(self.project.writes, [])

    def test_read_only_admin_policy_never_attempts_cap_writes(self):
        with self.assertRaises(PolicyError) as caught:
            apply_limits(self.plan, self.plan["sha256"], {**self.policy, "admin_account_access": "read_only"},
                         "admin", client=self.client, checkpoint=self.checkpoint)
        self.assertEqual(caught.exception.code, "admin_read_only")
        self.assertEqual(self.org.writes, [])
        self.assertEqual(self.project.writes, [])

    def test_partial_uncertain_write_preserves_receipt_and_is_not_retried(self):
        class APITimeoutError(Exception):
            pass
        self.project.error = APITimeoutError("SYNTHETIC_PRIVATE_DIAGNOSTIC")
        with self.assertRaises(PolicyError) as caught:
            apply_limits(self.plan, self.plan["sha256"], self.policy, "admin", client=self.client, checkpoint=self.checkpoint)
        self.assertNotIn("PRIVATE_DIAGNOSTIC", str(caught.exception))
        self.assertEqual(len(self.org.writes), 1)
        self.assertEqual(len(self.project.writes), 1)
        self.assertEqual(self.receipts[-1]["status"], "uncertain")
        self.assertEqual(self.receipts[-1]["applied"], ["organization"])

    def test_expired_credits_automatic_purchase_and_stale_reads_block_preview(self):
        for changed in [
            {**self.funding, "auto_recharge": "enabled"},
            {**self.funding, "automatic_purchases": "enabled"},
            {**self.funding, "grants": [{"balance_usd": "1", "expires_on": "2020-01-01"}]},
        ]:
            with self.subTest(changed=changed), self.assertRaises(PolicyError):
                build_limits_plan(changed, self.account, self.policy)
        stale = {**self.account, "observed_at": (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()}
        with self.assertRaises(PolicyError):
            build_limits_plan(self.funding, stale, self.policy)


if __name__ == "__main__":
    unittest.main()
