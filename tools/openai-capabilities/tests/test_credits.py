import copy
from datetime import datetime, timezone
import os
import sys
import types
import unittest
from unittest.mock import Mock, patch

from openai_capabilities.credits import refresh_costs, track_status
from openai_capabilities.adapters import AdapterError
from openai_capabilities.policy import PolicyError


NOW = datetime(2026, 10, 30, 18, 0, tzinfo=timezone.utc)
OBSERVATIONS = {
    "organization_id": "org-test", "project_id": "proj-test",
    "observed_at": "2026-10-30T12:00:00+00:00", "timezone": "UTC",
    "grants": [{"amount_usd": "130", "balance_usd": "130", "expires_on": "2026-11-18", "funding_type": "promotional"},
               {"amount_usd": "5", "balance_usd": "4.99", "expires_on": "2027-10-31", "funding_type": "unknown"}],
}
POLICY = {"organization_id": "org-test", "project_id": "proj-test"}
LOCAL = {"spent_microusd": 2000000, "reserved_microusd": 500000, "pending_jobs": [{"job_id": "one"}]}


def page(amount, more=False, cursor=None, project="proj-test"):
    return {"data": [{"start_time": 1793318400, "end_time": 1793404800,
                      "results": [{"object": "organization.costs.result", "project_id": project,
                                   "amount": {"value": amount, "currency": "usd"}}]}],
            "has_more": more, "next_page": cursor}


def limit(amount=1000, enforcement="enforcing"):
    return {"currency": "USD", "interval": "month", "threshold_amount": amount,
            "enforcement": {"status": enforcement}}


def api_client():
    client = Mock()
    client.admin.organization.usage.costs.return_value = page("3")
    client.admin.organization.spend_limit.retrieve.return_value = limit()
    client.admin.organization.projects.spend_limit.retrieve.return_value = limit(0, "inactive")
    return client


class CreditsTests(unittest.TestCase):
    def setUp(self):
        self.clock = patch("openai_capabilities.credits._now", return_value=NOW)
        self.clock.start()
        self.addCleanup(self.clock.stop)

    def test_read_only_endpoints_unfiltered_org_costs_pagination_and_caps(self):
        client = api_client()
        client.admin.organization.usage.costs.side_effect = [page("3", True, "next"), page("2", project="other-project")]
        result = refresh_costs(OBSERVATIONS, POLICY, "synthetic-admin-key", client)
        self.assertEqual(result["cost_total_usd"], "5")
        self.assertEqual(result["organization_spend_limit"]["threshold_usd"], "10")
        self.assertEqual(result["project_spend_limit"]["enforcement"], "inactive")
        calls = client.admin.organization.usage.costs.call_args_list
        self.assertEqual(len(calls), 2)
        self.assertNotIn("project_ids", calls[0].kwargs)
        self.assertEqual(calls[0].kwargs["group_by"], ["project_id"])
        self.assertEqual(calls[1].kwargs["page"], "next")
        self.assertFalse(result["funding_activation_allowed"])
        self.assertFalse(result["grant_balance_verified"])
        self.assertEqual({call[0] for call in client.mock_calls}, {
            "admin.organization.usage.costs", "admin.organization.spend_limit.retrieve",
            "admin.organization.projects.spend_limit.retrieve"})

    def test_missing_key_target_mismatch_and_stale_observation_do_not_call(self):
        client = api_client()
        bad = copy.deepcopy(OBSERVATIONS)
        bad["observed_at"] = "2025-01-01T00:00:00Z"
        for obs, policy, key in [(OBSERVATIONS, POLICY, ""),
                                 (OBSERVATIONS, {**POLICY, "organization_id": "other"}, "admin"),
                                 (bad, POLICY, "admin")]:
            with self.subTest(obs=obs, policy=policy), self.assertRaises(PolicyError):
                refresh_costs(obs, policy, key, client)
        self.assertFalse(client.mock_calls)

    def test_partial_or_invalid_costs_never_return_a_total(self):
        for result in [page("3", True, None), page("3", True, "loop"),
                       {"data": [], "has_more": "false"},
                       {"data": [{"results": [{"object": "unexpected"}]}], "has_more": False}]:
            client = api_client()
            client.admin.organization.usage.costs.return_value = result
            with self.subTest(result=result), self.assertRaises(PolicyError):
                refresh_costs(OBSERVATIONS, POLICY, "admin", client)
            self.assertFalse(client.admin.organization.spend_limit.retrieve.called)

    def test_admin_constructor_suppresses_ambient_inference_keys_urls_proxies(self):
        sdk, http = types.ModuleType("openai"), types.ModuleType("httpx2")
        client = api_client()
        sdk.OpenAI = Mock(return_value=client)
        http.Client = Mock()
        with patch.dict(sys.modules, {"openai": sdk, "httpx2": http}), patch.dict(os.environ, {
                "OPENAI_API_KEY": "ambient-inference-canary", "OPENAI_ADMIN_KEY": "ambient-admin-canary",
                "OPENAI_BASE_URL": "https://untrusted.invalid", "HTTPS_PROXY": "https://untrusted.invalid",
                "OPENAI_CUSTOM_HEADERS": ""}):
            refresh_costs(OBSERVATIONS, POLICY, "designated-admin-canary")
        arguments = sdk.OpenAI.call_args.kwargs
        self.assertEqual(arguments["api_key"], "")
        self.assertEqual(arguments["admin_api_key"], "designated-admin-canary")
        self.assertEqual(arguments["base_url"], "https://api.openai.com/v1")
        self.assertEqual(arguments["organization"], "org-test")
        self.assertEqual(arguments["project"], "proj-test")
        self.assertEqual(arguments["max_retries"], 0)
        self.assertFalse(http.Client.call_args.kwargs["trust_env"])
        self.assertFalse(http.Client.call_args.kwargs["follow_redirects"])
        client.close.assert_called_once()

    def test_errors_redact_secret_and_custom_headers_block(self):
        class SecretError(Exception):
            status_code = 403
        client = api_client()
        client.admin.organization.usage.costs.side_effect = SecretError("sk-sensitive-canary")
        with self.assertRaises(PolicyError) as raised:
            refresh_costs(OBSERVATIONS, POLICY, "admin", client)
        self.assertEqual(raised.exception.code, "admin_access_denied")
        self.assertNotIn("sk-sensitive-canary", str(raised.exception))
        with patch.dict(os.environ, {"OPENAI_CUSTOM_HEADERS": '{"Authorization":"unsafe"}'}), self.assertRaises(PolicyError):
            refresh_costs(OBSERVATIONS, POLICY, "admin")

    def test_snapshot_no_baseline_does_not_subtract_full_day_or_local_spend(self):
        snapshot = refresh_costs(OBSERVATIONS, POLICY, "admin", api_client())
        result = track_status(OBSERVATIONS, LOCAL, snapshot)
        self.assertIsNone(result["estimated_remaining_usd"])
        self.assertEqual(result["observed_balance_usd"], "134.99")
        self.assertEqual(result["local_spent_usd"], "2")
        self.assertEqual(result["local_reserved_usd"], "0.5")
        self.assertEqual(result["grants"][1]["days_to_expiration"], 366)
        self.assertIn("full UTC day", result["estimate_note"])

    def test_verified_baseline_delta_without_double_counting_local_spend(self):
        observations = {**OBSERVATIONS, "baseline_verified_at": OBSERVATIONS["observed_at"], "baseline_cost_usd": "1"}
        snapshot = refresh_costs(observations, POLICY, "admin", api_client())
        result = track_status(observations, LOCAL, snapshot)
        self.assertEqual(result["estimated_remaining_usd"], "132.99")
        self.assertFalse(result["funding_activation_allowed"])
        for key, value in [("baseline_verified_at", "2026-10-30T13:00:00Z"), ("baseline_cost_usd", "4")]:
            with self.subTest(key=key), self.assertRaises(PolicyError):
                track_status({**observations, key: value}, LOCAL, snapshot)

    def test_expiry_renews_nothing_and_snapshot_target_cannot_change(self):
        observations = {**OBSERVATIONS, "baseline_verified_at": OBSERVATIONS["observed_at"], "baseline_cost_usd": "1"}
        snapshot = refresh_costs(observations, POLICY, "admin", api_client())
        expired = copy.deepcopy(observations)
        expired["grants"][0]["expires_on"] = "2026-10-30"
        result = track_status(expired, LOCAL, snapshot)
        self.assertIsNone(result["estimated_remaining_usd"])
        self.assertEqual(result["grants"][0]["state"], "expired_or_expires_today")
        with self.assertRaises(PolicyError):
            track_status(observations, LOCAL, {**snapshot, "organization_id": "other"})

    def test_prepaid_cost_refresh_tracks_org_and_project_month_without_filtering(self):
        client = api_client()
        monthly = page("3")
        monthly["data"][0]["results"].append({"object": "organization.costs.result", "project_id": "other-project",
                                               "amount": {"value": "2", "currency": "usd"}})
        client.admin.organization.usage.costs.side_effect = [page("1"), monthly]
        result = refresh_costs(OBSERVATIONS, {**POLICY, "funding_policy": "existing_prepaid_only"}, "admin", client)
        self.assertEqual(result["cost_total_usd"], "1")
        self.assertEqual(result["organization_spend_usd"], "5")
        self.assertEqual(result["project_spend_usd"], "3")
        self.assertEqual(result["month_start"], "2026-10-01T00:00:00+00:00")
        calls = client.admin.organization.usage.costs.call_args_list
        self.assertEqual(len(calls), 2)
        self.assertLess(calls[1].kwargs["start_time"], calls[0].kwargs["start_time"])
        self.assertNotIn("project_ids", calls[1].kwargs)

    def test_prepaid_remaining_uses_max_local_or_api_not_sum(self):
        funding = {"funding_policy": "existing_prepaid_only", "organization_id": "org-test", "project_id": "proj-test",
                   "funding_window_id": "manual-observation", "verified_at": OBSERVATIONS["observed_at"],
                   "grants": [dict(g, grant_id=f"local-{i}") for i, g in enumerate(OBSERVATIONS["grants"])],
                   "account_cost_baseline": {"window_start": "2026-10-30T00:00:00+00:00", "cost_total_usd": "1",
                                             "observed_at": "2026-10-30T11:59:00+00:00"}}
        snapshot = refresh_costs(OBSERVATIONS, POLICY, "admin", api_client())
        result = track_status(funding, LOCAL, snapshot)
        self.assertEqual(result["estimated_remaining_usd"], "132.99")
        self.assertEqual(result["spendable_estimate_after_reservations_usd"], "132.49")
        self.assertEqual(result["account_cost_basis"], "verified_observation_delta")
        snapshot["cost_total_usd"] = "1.50"  # API reporting lags known local $2.
        self.assertEqual(track_status(funding, LOCAL, snapshot)["estimated_remaining_usd"], "132.99")
        funding["account_cost_baseline"]["observed_at"] = "2026-10-30T12:01:00+00:00"
        result = track_status(funding, LOCAL, snapshot)
        self.assertIsNone(result["estimated_remaining_usd"])
        self.assertEqual(result["account_cost_basis"], "conservative_lower_bound")

        self.assertIn("no remaining balance", result["estimate_note"])
        funding["account_cost_baseline"]["observed_at"] = "2026-10-30T11:00:00+00:00"
        result = track_status(funding, LOCAL, snapshot)
        self.assertIsNone(result["estimated_remaining_usd"])
        self.assertEqual(result["account_cost_basis"], "conservative_lower_bound")

    def test_costs_succeed_when_limit_read_endpoints_are_confirmed_404(self):
        client = api_client()
        client.admin.organization.spend_limit.retrieve.side_effect = AdapterError("not_found", "Synthetic missing endpoint")
        client.admin.organization.projects.spend_limit.retrieve.side_effect = AdapterError("not_found", "Synthetic missing endpoint")
        result = refresh_costs(OBSERVATIONS, {**POLICY, "funding_policy": "existing_prepaid_only"}, "readonly-admin", client)
        self.assertEqual(result["cost_total_usd"], "3")
        self.assertEqual(result["source"], "official_admin_api")
        self.assertEqual(result["status"], "observed")
        self.assertFalse(result["limits_api_available"])
        for scope in ("organization", "project"):
            self.assertEqual(result[scope + "_spend_limit"],
                             {"availability": "unavailable", "http_status": 404, "source": "official_admin_api"})
            self.assertNotIn("threshold_usd", result[scope + "_spend_limit"])
            self.assertNotIn("enforcement", result[scope + "_spend_limit"])
        self.assertFalse(client.admin.organization.spend_limit.update.called)
        self.assertFalse(client.admin.organization.projects.spend_limit.update.called)

    def test_auth_transport_and_cost_endpoint_404_do_not_become_manual_limit_fallback(self):
        for stage, error in [("limit", "permission_denied"), ("limit", "execution_uncertain"), ("costs", "not_found")]:
            client = api_client()
            target = client.admin.organization.spend_limit.retrieve if stage == "limit" else client.admin.organization.usage.costs
            target.side_effect = AdapterError(error, "Synthetic read failure")
            with self.subTest(stage=stage, error=error), self.assertRaises(PolicyError):
                refresh_costs(OBSERVATIONS, POLICY, "readonly-admin", client)

    def test_account_read_diagnostic_is_safe_and_preserves_classification(self):
        client = api_client()
        client.admin.organization.usage.costs.side_effect = AdapterError(
            "execution_uncertain", "secret SDK body and credential",
            uncertain=True, failure_class="provider_transport", exception_type="APITimeoutError",
            provider_request_id="req_safe_42", transport_cause_type="ConnectTimeout")
        with self.assertRaises(PolicyError) as caught:
            refresh_costs(OBSERVATIONS, POLICY, "readonly-admin", client)
        self.assertEqual(caught.exception.code, "credits_execution_uncertain")
        self.assertEqual(caught.exception.diagnostics, {
            "failure_stage": "costs", "remote_outcome_uncertain": True, "retryable": False,
            "failure_class": "provider_transport", "exception_type": "APITimeoutError",
            "provider_request_id": "req_safe_42", "transport_cause_type": "ConnectTimeout"})
        self.assertNotIn("secret", str(caught.exception))
        self.assertNotIn("secret", str(caught.exception.diagnostics))

    def test_policy_error_rejects_untrusted_diagnostic_values(self):
        error = PolicyError("x", "safe", diagnostics={
            "failure_stage": "private prompt", "failure_class": "arbitrary", "exception_type": "SecretError",
            "http_status": True, "provider_request_id": "sk-secret", "body": "private"})
        self.assertIsNone(error.diagnostics)


if __name__ == "__main__":
    unittest.main()
