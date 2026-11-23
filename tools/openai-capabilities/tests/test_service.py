"""Offline acceptance across CLI, persistence, adapters and accounting."""
from synthetic_keys import synthetic_key, synthetic_env_prefix
import contextlib
import copy
from datetime import datetime, timedelta, timezone
import io
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from openai_capabilities.adapters import AdapterError
from openai_capabilities.cli import main
from openai_capabilities.policy import PolicyError
from openai_capabilities.service import PACKAGE_ROOT, Service, credential, read_json, request_metadata
from openai_capabilities.credentials import credential_path
from test_policy_ledger import prepaid_funding, account_costs, prepaid_policy


def funding(policy, now=None):
    return {**prepaid_funding(now), "organization_id": policy["organization_id"], "project_id": policy["project_id"]}


def account_snapshot(funded, now=None):
    return {**account_costs(funded, now=now), "organization_id": funded["organization_id"], "project_id": funded["project_id"]}


@contextlib.contextmanager
def month_safe_service(test):
    fixed_now = datetime(2026, 10, 15, 12, tzinfo=timezone.utc)

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed_now if tz is not None else fixed_now.replace(tzinfo=None)

    original_preflight = test.service.account_preflight
    test.service.account_preflight = lambda snapshot: account_snapshot(snapshot, now=fixed_now)
    try:
        with patch("openai_capabilities.ledger.datetime", Clock), \
             patch("openai_capabilities.policy.datetime", Clock), \
             patch("openai_capabilities.service.datetime", Clock):
            test.activate_synthetic(fixed_now)
            yield
    finally:
        test.service.account_preflight = original_preflight


def request(tier="default"):
    return {"capability": "embeddings", "model": "text-embedding-3-small", "tier": tier,
            "purpose": {"kind": "service_output", "description": "Create numeric vectors for the application index"},
            "payload": {"input": ["PRIVATE_SYNTHETIC_SOURCE_A", "PRIVATE_SYNTHETIC_SOURCE_B"], "dimensions": 2}}


class FakeAdapter:
    def __init__(self):
        self.calls = []
        self.error = None
        self.upload_checkpoint = None
        self.result = {"status": "completed", "api_id": "req_test", "usage": {"prompt_tokens": 10},
                       "service_tier": None, "output": [[1., 2.], [3., 4.]]}

    def call(self, req):
        self.calls.append(req)
        if self.error:
            raise self.error
        return copy.deepcopy(self.result)

    def batch_submit(self, requests, local_job_id, checkpoint):
        self.calls.append(requests)
        assert all("capability" in x and "custom_id" in x for x in requests)
        checkpoint({"input_file_id": "file_test"})
        if self.error:
            raise self.error
        return {"status": "validating", "api_id": "batch_test", "input_file_id": "file_test"}

    def batch_status(self, ident):
        return {"status": "completed", "api_id": ident}

    def batch_results(self, ident):
        return {"status": "completed", "api_id": ident, "failed": {}, "successful": {
            "second": {"data": [{"index": 1, "embedding": [1, 2]}, {"index": 0, "embedding": [3, 4]}], "usage": {"prompt_tokens": 8}},
            "first": {"data": [{"index": 0, "embedding": [5, 6]}, {"index": 1, "embedding": [7, 8]}], "usage": {"prompt_tokens": 9}}}}

    def batch_reconcile(self, job_id, file_id):
        assert file_id == "file_test"
        return {"status": "completed", "api_id": "batch_recovered"}


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        # Test admission modes independently of the operator's mutable policy.
        self.policy = prepaid_policy()
        self.policy_file = self.root / "policy.json"
        self.policy_file.write_text(json.dumps(self.policy), encoding="utf-8")
        credential_path(self.policy, self.root).parent.mkdir(parents=True)
        self.adapter = FakeAdapter()
        self.service = self.new_service()

    def tearDown(self):
        self.temp.cleanup()

    def new_service(self):
        return Service(self.root / "state", policy=self.policy, root=self.root,
                       adapter_factory=lambda: self.adapter,
                       credential_loader=lambda policy, root, admin=False: credential(policy, root, admin=admin, acl_checker=lambda *_: True),
                       account_preflight=account_snapshot)

    def activate_synthetic(self, now=None):
        funded = funding(self.policy, now)
        self.service.ledger.refresh_funding(funded)
        self.service.ledger.update_account_costs(account_snapshot(funded, now))
        self.service.ledger.set_enabled(True)

    def test_disabled_and_invalid_native_requests_make_zero_calls(self):
        result = self.service.dry_run(request())
        self.assertEqual(result["api_calls"], 0)
        with self.assertRaises(PolicyError):
            self.service.invoke(request())
        native = {**request(), "purpose": {"kind": "coding", "description": "Fix PowerShell"}}
        with self.assertRaises(PolicyError):
            self.service.invoke(native)
        self.assertEqual(self.adapter.calls, [])

    def test_cli_disable_succeeds_even_when_credentials_and_funding_are_missing(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(main(["--state-dir", str(self.root / "cli"), "--policy", str(self.policy_file), "disable"]), 0)
        self.assertEqual(json.loads(out.getvalue())["status"], "disabled")
        self.assertFalse(json.loads(out.getvalue())["enabled"])

    def test_cli_escapes_non_ascii_completion_for_legacy_console_code_pages(self):
        request_path = self.root / "request.json"
        request_path.write_text(json.dumps(request()), encoding="utf-8")
        expected = {"status": "completed", "job_id": "synthetic-job", "output": "review → accepted"}

        class Cp1252Console(io.StringIO):
            @property
            def encoding(self):
                return "cp1252"

            def write(self, value):
                value.encode(self.encoding)
                return super().write(value)

        out = Cp1252Console()
        with patch("openai_capabilities.cli.Service") as service_type:
            service_type.return_value.invoke.return_value = expected
            with contextlib.redirect_stdout(out):
                code = main(["--state-dir", str(self.root / "cli-unicode"), "--policy", str(self.policy_file),
                             "invoke", "--request", str(request_path)])

        self.assertEqual(code, 0)
        serialized = out.getvalue()
        self.assertTrue(serialized.isascii())
        self.assertEqual(json.loads(serialized), expected)

    def test_expiration_priority_is_visible_without_enabling_or_submitting(self):
        fixed_now = datetime(2026, 10, 15, 12, tzinfo=timezone.utc)
        funded = funding(self.policy, fixed_now)
        class Clock(datetime):
            @classmethod
            def now(cls, tz=None):
                return fixed_now if tz is not None else fixed_now.replace(tzinfo=None)

        with patch("openai_capabilities.ledger.datetime", Clock), \
             patch("openai_capabilities.policy.datetime", Clock):
            self.service.ledger.refresh_funding(funded)
            state = self.service.status()
        self.assertEqual(state["usage_priority"]["level"], "urgent")
        self.assertEqual(state["weekly_budget"], self.service.ledger.status()["weekly_budget"])
        self.assertTrue(state["usage_priority"]["advisory_only"])
        self.assertFalse(state["enabled"])
        self.assertEqual(self.service.ledger.funding(), funded)
        self.assertEqual(self.adapter.calls, [])

    def test_status_blocks_when_admin_preflight_credential_is_missing(self):
        self.activate_synthetic()
        credential_path(self.policy, self.root).write_text(((synthetic_env_prefix('OPENAI_API_KEY')) + synthetic_key('proj-SYNTHETIC_STATUS') + '\n'), encoding="utf-8")
        result = self.service.status()
        self.assertTrue(result["credential_present"])
        self.assertFalse(result["admin_credential_present"])
        self.assertEqual(result["status"], "blocked")
        self.assertIn("admin_credential_missing", {b["code"] for b in result["blockers"]})

    def test_unavailable_limit_apis_require_explicit_manual_proof_without_faking_api_values(self):
        funded = funding(self.policy)
        credential_path(self.policy, self.root, admin=True).write_text(((synthetic_env_prefix('OPENAI_ADMIN_KEY')) + synthetic_key('admin-SYNTHETIC_LIMITS') + '\n'), encoding="utf-8")
        api = account_snapshot(funded)
        unavailable = {"availability": "unavailable", "http_status": 404, "source": "official_admin_api"}
        api["organization_spend_limit"] = dict(unavailable)
        api["project_spend_limit"] = dict(unavailable)
        api["limits_api_available"] = False
        with patch("openai_capabilities.credits.refresh_costs", return_value=api), patch("openai_capabilities.account_setup.apply_limits") as writer:
            preview = self.service.configure_limits(funded)
            self.assertEqual(preview["status"], "manual_setup_required")
            result = self.service.configure_limits(funded, apply=True, expected_sha256=preview["sha256"])
            self.assertEqual(result["status"], "manual_setup_required")
            writer.assert_not_called()
            with self.assertRaises(PolicyError):
                self.service.confirm_limits(funded, result["sha256"], "10", "10", enforced=False)
            with self.assertRaises(PolicyError):
                self.service.confirm_limits(funded, result["sha256"], "20", "10", enforced=True)
            accepted = self.service.confirm_limits(funded, result["sha256"], "10", "10", enforced=True)
        self.assertEqual(accepted["status"], "recorded_disabled")
        self.assertFalse(self.service.ledger.status()["enabled"])
        self.assertEqual(self.service.ledger.funding()["limit_verification"]["source"], "user_confirmation")
        self.assertEqual(read_json(self.root / "state/account-costs.json")["organization_spend_limit"], unavailable)

    def test_supplied_screenshots_verify_configuration_separately_from_api_runtime_status(self):
        funded = funding(self.policy)
        credential_path(self.policy, self.root, admin=True).write_text(((synthetic_env_prefix('OPENAI_ADMIN_KEY')) + synthetic_key('admin-SYNTHETIC_UI_PROOF') + '\n'), encoding="utf-8")
        account = account_snapshot(funded)
        # Real responses finish after the queried cost window. Baseline must
        # describe coverage, not the later response-completion timestamp.
        account["window_end"] = (datetime.now(timezone.utc) - timedelta(seconds=3)).isoformat()
        for scope in ("organization", "project"):
            account[scope + "_spend_limit"] = {"threshold_usd": "10", "enforcement": "inactive", "currency": "USD", "interval": "month"}
        proof = {"source": "user_supplied_screenshots", "organization_id": self.policy["organization_id"],
                 "project_id": self.policy["project_id"], "limits": {}}
        evidence = self.root / "state/evidence"
        evidence.mkdir()
        for scope in ("organization", "project"):
            image = evidence / (scope + ".png")
            image.write_bytes(("SYNTHETIC_UI_EVIDENCE_" + scope).encode())
            proof["limits"][scope] = {"path": "evidence/" + image.name, "sha256": hashlib.sha256(image.read_bytes()).hexdigest(),
                                      "enforced": True, "threshold_usd": "10"}
        with patch("openai_capabilities.credits.refresh_costs", return_value=account):
            preview = self.service.configure_limits(funded)
            with self.assertRaises(PolicyError):
                self.service.confirm_limits(funded, preview["sha256"], "10", "10", enforced=True)
            bad = copy.deepcopy(proof)
            bad["limits"]["project"]["sha256"] = "0" * 64
            with self.assertRaises(PolicyError):
                self.service.confirm_limits(funded, preview["sha256"], "10", "10", enforced=True, ui_evidence=bad)
            result = self.service.confirm_limits(funded, preview["sha256"], "10", "10", enforced=True, ui_evidence=proof)
        self.assertEqual(result["status"], "recorded_disabled")
        self.assertEqual(self.service.ledger.funding()["account_cost_baseline"]["observed_at"], account["window_end"])
        self.assertEqual(read_json(self.root / "state/account-costs.json")["organization_spend_limit"]["enforcement"], "inactive")
        self.assertEqual(self.service.ledger.status()["effective_limits"]["organization"]["source"], "user_screenshot_verified_with_api_inactive")

    def test_sync_result_accounting_and_private_source_not_logged(self):
        self.activate_synthetic()
        result = self.service.invoke(request())
        self.assertEqual(result["status"], "completed")
        restarted = self.new_service()
        self.assertEqual(restarted.resume(result["job_id"])["status"], "completed")
        self.assertEqual(restarted.ledger.pending(), [])
        for file in (self.root / "state").rglob("*"):
            if file.is_file():
                self.assertNotIn(b"PRIVATE_SYNTHETIC_SOURCE", file.read_bytes())

    def test_timeout_persists_without_replay(self):
        self.activate_synthetic()
        self.adapter.error = AdapterError("execution_uncertain", "Safe error", uncertain=True)
        result = self.service.invoke(request())
        self.assertEqual(result["status"], "uncertain")
        restarted = self.new_service()
        restarted.resume(result["job_id"])
        self.assertEqual(len(self.adapter.calls), 1)
        with self.assertRaises(PolicyError):
            restarted.invoke(request())

    def test_request_scoped_local_timeout_is_bounded_and_passed_to_sdk(self):
        default_request, _ = self.service.prepare(request())
        self.assertEqual(default_request["local_timeout_seconds"], 30)
        long_request, _ = self.service.prepare({**request(), "local_timeout_seconds": 900})
        self.assertEqual(long_request["local_timeout_seconds"], 900)
        for invalid in (0, 901, True, 30.5, "300"):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(PolicyError, "local_timeout_seconds must be an integer"):
                self.service.prepare({**request(), "local_timeout_seconds": invalid})

        original_factory = self.service.adapter_factory
        original_loader = self.service.credential_loader
        try:
            self.service.adapter_factory = None
            self.service.credential_loader = lambda *_args, **_kwargs: "synthetic-project-key"
            with patch("openai_capabilities.service.SDKAdapter") as sdk:
                self.service._adapter(long_request)
                self.assertEqual(sdk.call_args.kwargs["timeout_seconds"], 900)
                self.service._adapter(default_request)
                self.assertEqual(sdk.call_args.kwargs["timeout_seconds"], 30)
            from openai_capabilities.adapters import SDKAdapter
            one_second, _ = self.service.prepare({**request(), "local_timeout_seconds": 1})
            with patch("openai_capabilities.service.SDKAdapter",
                       side_effect=lambda *args, **kwargs: SDKAdapter(*args, client=object(), **kwargs)):
                adapter = self.service._adapter(one_second)
            self.assertEqual(adapter.timeout_seconds, 1)
            with self.assertRaises(AdapterError) as caught:
                adapter._perform(lambda: time.sleep(1.1))
            self.assertTrue(caught.exception.uncertain)
            self.assertEqual(caught.exception.failure_class, "local_deadline")
        finally:
            self.service.adapter_factory = original_factory
            self.service.credential_loader = original_loader

        metadata = request_metadata(long_request)
        self.assertEqual(metadata["local_timeout_seconds"], 900)
        self.assertNotIn("input", metadata.get("payload", {}))

    def test_long_local_deadline_timeout_keeps_uncertainty_and_never_replays(self):
        self.activate_synthetic()
        long_request = {**request(), "local_timeout_seconds": 180}
        self.adapter.error = AdapterError("execution_uncertain", "safe local deadline", uncertain=True,
                                          failure_class="local_deadline")
        result = self.service.invoke(long_request)
        self.assertEqual(result["status"], "uncertain")
        self.assertEqual(result["failure_class"], "local_deadline")
        self.assertEqual(len(self.adapter.calls), 1)
        job = self.service.ledger.get_job(result["job_id"])
        self.assertEqual(job["metadata"]["pricing_request"]["local_timeout_seconds"], 180)
        self.assertIsNone(job["actual_microusd"])
        with self.assertRaisesRegex(PolicyError, "unresolved|reservation|uncertain|purpose|intent|payload"):
            self.service.invoke(long_request)
        self.assertEqual(len(self.adapter.calls), 1)

    def test_uncertain_diagnostics_persist_only_allowlisted_failure_details(self):
        self.activate_synthetic()
        self.adapter.error = AdapterError("execution_uncertain", "secret SDK payload must not persist",
            uncertain=True, failure_class="provider_http", exception_type="InternalServerError",
            http_status=503, provider_request_id="req_safe_123")
        result = self.service.invoke(request())
        self.assertEqual(result["failure_stage"], "sync_request")
        self.assertEqual(result["failure_class"], "provider_http")
        self.assertEqual(result["exception_type"], "InternalServerError")
        self.assertEqual(result["http_status"], 503)
        row = self.service.ledger.get_job(result["job_id"])
        self.assertEqual(row["status"], "uncertain")
        self.assertEqual(row["metadata"]["provider_request_id"], "req_safe_123")
        self.assertTrue(row["metadata"]["remote_outcome_uncertain"])
        self.assertNotIn("secret SDK payload", str(row["metadata"]))
        self.assertIsNone(row["actual_microusd"])

    def test_uncertain_sync_reservation_allows_distinct_task_without_losing_hold(self):
        self.activate_synthetic()
        original = request()
        self.adapter.error = AdapterError("execution_uncertain", "Safe error", uncertain=True)
        uncertain = self.service.invoke(original)
        self.assertEqual(uncertain["status"], "uncertain")
        held = self.service.ledger.get_job(uncertain["job_id"])["reservation_microusd"]
        pending_before = self.service.ledger.pending()

        distinct = request()
        distinct["purpose"] = {"kind": "service_output", "description": "Build vectors for a separate synthetic demo"}
        distinct["payload"]["input"] = ["A different synthetic source"]
        dry_run = self.service.dry_run(distinct)
        self.assertEqual(dry_run["api_calls"], 0)
        self.assertEqual(dry_run["reservation_admission"]["status"], "eligible")
        self.assertEqual(self.service.ledger.pending(), pending_before)

        self.adapter.error = None
        completed = self.service.invoke(distinct)
        self.assertEqual(completed["status"], "completed")
        self.assertEqual([job["job_id"] for job in self.service.ledger.pending()], [uncertain["job_id"]])
        self.assertEqual(self.service.ledger.get_job(uncertain["job_id"])["reservation_microusd"], held)
        self.assertEqual(self.service.ledger.status()["reserved_microusd"], held)

        replay = self.service.dry_run(original)
        self.assertEqual(replay["reservation_admission"], {"status": "blocked", "error_code": "duplicate_request"})
        calls_before = len(self.adapter.calls)
        with self.assertRaises(PolicyError) as caught:
            self.service.invoke(original)
        self.assertEqual(caught.exception.code, "duplicate_request")
        self.assertEqual(len(self.adapter.calls), calls_before)

    def test_funding_error_disables_without_retry_and_releases_rejected_request(self):
        self.activate_synthetic()
        for code in ("credit_balance_exhausted", "insufficient_quota"):
            with self.subTest(code=code):
                self.service.ledger.set_enabled(True)
                self.adapter.calls.clear()
                self.adapter.error = AdapterError(code, "No funds")
                result = self.service.invoke(request())
                self.assertEqual(result["status"], "failed")
                self.assertFalse(self.service.ledger.status()["enabled"])
                self.assertEqual(len(self.adapter.calls), 1)
                self.assertEqual(self.service.ledger.pending(), [])

    def test_known_capacity_retry_is_bounded_and_auth_does_not_retry(self):
        self.activate_synthetic()
        self.adapter.error = AdapterError("resource_unavailable", "Capacity", retryable=True)
        with patch("openai_capabilities.service.time.sleep"):
            self.service.invoke(request())
        self.assertEqual(len(self.adapter.calls), 3)
        self.adapter.calls.clear()
        self.adapter.error = AdapterError("invalid_api_key", "Rejected")
        self.service.invoke(request())
        self.assertEqual(len(self.adapter.calls), 1)
        self.assertEqual(self.service.ledger.pending(), [])

    def test_batch_checkpoint_restart_collection_ids_and_disable(self):
        with month_safe_service(self):
            document = {"requests": [{"custom_id": ident, "request": request("batch")} for ident in ("first", "second")]}
            submitted = self.service.batch_submit(document)
            self.service.ledger.set_enabled(False)
            restarted = self.new_service()
            result = restarted.resume(submitted["job_id"])
            self.assertEqual(result["successful_count"], 2)
            self.assertEqual(result["missing_items"], [])
            artifact = read_json(result["artifact"])
            self.assertEqual(artifact["successful"]["first"]["output"], [[5, 6], [7, 8]])
            self.assertEqual(restarted.ledger.pending(), [])

    def test_every_batch_item_deadline_is_validated_before_upload(self):
        self.activate_synthetic()
        short = {**request("batch"), "deadline": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()}
        document = {"requests": [{"custom_id": "first", "request": request("batch")}, {"custom_id": "second", "request": short}]}
        with self.assertRaises(PolicyError) as caught:
            self.service.batch_submit(document)
        self.assertEqual(caught.exception.code, "deadline_too_short")
        self.assertEqual(self.adapter.calls, [])
        self.assertEqual(self.service.ledger.pending(), [])

    def test_invalid_batch_output_is_separate_from_valid_results_and_charges_usage(self):
        with month_safe_service(self):
            submitted = self.service.batch_submit({"requests": [{"custom_id": ident, "request": request("batch")} for ident in ("first", "second")]})
            original = self.adapter.batch_results
            def malformed(ident):
                result = original(ident)
                result["successful"]["second"]["data"][0]["embedding"] = [1]
                return result
            self.adapter.batch_results = malformed
            result = self.service.resume(submitted["job_id"])
            self.assertEqual(result["status"], "partial")
            self.assertEqual(result["successful_count"], 1)
            self.assertEqual(result["failed_count"], 1)
            self.assertIsNotNone(result["cost_usd"])

    def test_unknown_batch_create_reconciles_existing_job_without_resubmit(self):
        with month_safe_service(self):
            self.adapter.error = AdapterError("execution_uncertain", "Unknown", uncertain=True)
            result = self.service.batch_submit({"requests": [{"custom_id": ident, "request": request("batch")} for ident in ("first", "second")]})
            self.assertEqual(result["status"], "uncertain")
            self.adapter.error = None
            resumed = self.new_service().resume(result["job_id"])
            self.assertEqual(resumed["api_id"], "batch_recovered")
            self.assertEqual(len(self.adapter.calls), 1)

    def test_explicit_file_credential_never_uses_ambient_key_or_admin(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": (synthetic_key('proj-AMBIENT_CANARY'))}):
            with self.assertRaises(PolicyError):
                credential(self.policy, self.root)
        path = credential_path(self.policy, self.root)
        path.write_text(((synthetic_env_prefix('OPENAI_API_KEY')) + synthetic_key('admin-ADMIN_CANARY') + '\n'), encoding="utf-8")
        with self.assertRaises(PolicyError):
            credential(self.policy, self.root)
        path.write_text(((synthetic_env_prefix('OPENAI_API_KEY')) + synthetic_key('proj-DESIGNATED_CANARY') + '\n'), encoding="utf-8")
        self.assertEqual(credential(self.policy, self.root, acl_checker=lambda *_: True), (synthetic_key('proj-DESIGNATED_CANARY')))

    def test_secret_canary_redacted_from_results_artifacts_and_cli_errors(self):
        self.activate_synthetic()
        self.adapter.result["output"] = (synthetic_key('proj-SYNTHETIC_SECRET_CANARY'))
        result = self.service.invoke(request())
        self.assertNotIn("SYNTHETIC_SECRET_CANARY", json.dumps(result))
        self.assertNotIn("SYNTHETIC_SECRET_CANARY", Path(result["artifact"]).read_text())
        bad = self.root / "bad.json"
        bad.write_text(('{"secret":"' + synthetic_key('proj-SYNTHETIC_SECRET_CANARY') + '",}'), encoding="utf-8")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(main(["--state-dir", str(self.root / "cli"), "--policy", str(self.policy_file),
                                   "dry-run", "--request", str(bad)]), 2)
        self.assertNotIn("SYNTHETIC_SECRET_CANARY", out.getvalue())

    def test_unexpected_actual_tier_is_costed_and_disables_future_submissions(self):
        self.activate_synthetic()
        req = {"capability": "responses", "model": "gpt-6-luna", "tier": "flex", "purpose": request()["purpose"],
               "payload": {"input": "Synthetic contract", "max_output_tokens": 100}}
        self.adapter.result = {"status": "completed", "api_id": "resp_test", "service_tier": "default", "output": "OK",
                               "usage": {"input_tokens": 100, "output_tokens": 100}}
        result = self.service.invoke(req)
        self.assertEqual(result["cost_usd"], "0.00006")
        self.assertFalse(self.service.ledger.status()["enabled"])

    def test_standard_fallback_requires_task_policy_and_reserves_before_submission(self):
        req = {"capability": "responses", "model": "gpt-6-luna", "tier": "flex", "purpose": request()["purpose"],
               "allow_standard_fallback": True, "payload": {"input": "Synthetic contract", "max_output_tokens": 100}}
        with self.assertRaises(PolicyError):
            self.service.prepare(req)
        self.policy["standard_fallback"] = True
        self.service = self.new_service()
        self.activate_synthetic()
        calls = []
        def call(candidate):
            calls.append(candidate["tier"])
            if candidate["tier"] == "flex":
                raise AdapterError("resource_unavailable", "Capacity", retryable=True)
            return {"status": "completed", "api_id": "resp_test", "service_tier": "default", "output": "OK",
                    "usage": {"input_tokens": 10, "output_tokens": 10}}
        self.adapter.call = call
        with patch("openai_capabilities.service.time.sleep"):
            result = self.service.invoke(req)
        self.assertTrue(result["standard_fallback_used"])
        self.assertEqual(calls, ["flex", "flex", "flex", "default"])
        self.assertTrue(self.service.ledger.status()["enabled"])
        default_reservation = self.service.dry_run({**req, "tier": "default", "allow_standard_fallback": False})["reservation_usd"]
        self.assertEqual(result["reservation_usd"], default_reservation)

    def test_admin_tracker_is_separate_and_cannot_enable_inference(self):
        from unittest.mock import Mock
        from openai_capabilities.service import write_json
        now = datetime.now(timezone.utc)
        observations = {"organization_id": self.policy["organization_id"], "project_id": self.policy["project_id"],
            "observed_at": (now - timedelta(minutes=5)).isoformat(),
            "grants": [{"amount_usd": "1", "balance_usd": "1", "expires_on": (now + timedelta(days=3)).date().isoformat()}]}
        write_json(self.root / "state/credit-observations.json", observations)
        credential_path(self.policy, self.root).write_text(((synthetic_env_prefix('OPENAI_API_KEY')) + synthetic_key('proj-SYNTHETIC_INFERENCE') + '\n'), encoding="utf-8")
        with self.assertRaises(PolicyError) as caught:
            self.service.refresh_costs(client=Mock())
        self.assertEqual(caught.exception.code, "admin_credential_missing")
        credential_path(self.policy, self.root, admin=True).write_text(((synthetic_env_prefix('OPENAI_ADMIN_KEY')) + synthetic_key('proj-WRONG_TYPE') + '\n'), encoding="utf-8")
        with self.assertRaises(PolicyError):
            self.service.refresh_costs(client=Mock())
        credential_path(self.policy, self.root, admin=True).write_text(((synthetic_env_prefix('OPENAI_ADMIN_KEY')) + synthetic_key('admin-SYNTHETIC_ADMIN') + '\n'), encoding="utf-8")
        client = Mock()
        client.admin.organization.usage.costs.return_value = {"data": [], "has_more": False}
        limit = {"currency": "USD", "interval": "month", "threshold_amount": 100, "enforcement": {"status": "enforcing"}}
        client.admin.organization.spend_limit.retrieve.return_value = limit
        client.admin.organization.projects.spend_limit.retrieve.return_value = limit
        result = self.service.refresh_costs(client=client)
        self.assertFalse(result["funding_activation_allowed"])
        self.assertFalse(self.service.ledger.status()["enabled"])
        self.assertEqual(self.adapter.calls, [])
        self.assertNotIn("SYNTHETIC_ADMIN", json.dumps(result))

    def test_cli_includes_only_sanitized_account_read_diagnostics(self):
        from contextlib import redirect_stdout
        from io import StringIO
        from unittest.mock import Mock, patch
        from openai_capabilities import cli
        error = PolicyError("credits_execution_uncertain", "Safe message", diagnostics={
            "failure_stage": "costs", "remote_outcome_uncertain": True,
            "failure_class": "provider_transport", "exception_type": "APITimeoutError",
            "http_status": 503, "provider_request_id": "req_safe_42", "secret": "must-not-appear"})
        service = Mock()
        service.refresh_costs.side_effect = error
        output = StringIO()
        with patch.object(cli, "read_json", return_value={}), patch.object(cli, "Service", return_value=service), \
                redirect_stdout(output):
            status = cli.main(["refresh-costs"])
        self.assertEqual(status, 2)
        value = json.loads(output.getvalue())
        self.assertEqual(value["diagnostics"], {
            "failure_stage": "costs", "remote_outcome_uncertain": True,
            "failure_class": "provider_transport", "exception_type": "APITimeoutError",
            "http_status": 503, "provider_request_id": "req_safe_42"})
        self.assertNotIn("secret", output.getvalue())

    def test_function_tools_request_metadata_supports_resume(self):
        self.activate_synthetic()
        req = {
            "capability": "responses",
            "model": "gpt-6-luna",
            "tier": "default",
            "max_cost_usd": "0.10",
            "purpose": {"kind": "coding_assistance", "description": "Inspect code with read tool", "deliverable": "Summary"},
            "payload": {
                "input": "Read a.txt",
                "max_output_tokens": 128,
                "tools": [{
                    "type": "function",
                    "name": "read_file",
                    "strict": True,
                    "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"], "additionalProperties": False},
                }],
            },
        }
        prepared, _ = self.service.prepare(req)
        meta = request_metadata(prepared)
        self.assertEqual(meta["function_tools"], ["read_file"])
        self.assertNotIn("tools", meta["payload"])

        self.adapter.error = AdapterError("execution_uncertain", "Lost reply", uncertain=True, api_id="resp_tool_resume")
        uncertain = self.service.invoke(req)
        self.assertEqual(uncertain["status"], "uncertain")

        self.adapter.error = None
        self.adapter.retrieve_response = lambda api_id: {
            "id": api_id,
            "status": "completed",
            "usage": {"input_tokens": 25, "output_tokens": 10},
            "output": [{"type": "function_call", "call_id": "call_r1", "name": "read_file", "arguments": '{"path":"a.txt"}'}],
        }
        resumed = self.new_service().resume(uncertain["job_id"])
        self.assertEqual(resumed["status"], "completed")
        artifact = read_json(resumed["artifact"])
        self.assertEqual(artifact["output"], {
            "text": "",
            "function_calls": [{"call_id": "call_r1", "name": "read_file", "arguments": '{"path":"a.txt"}'}],
        })


if __name__ == "__main__":
    unittest.main()
