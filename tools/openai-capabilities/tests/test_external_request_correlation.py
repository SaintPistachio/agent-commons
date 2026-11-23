import concurrent.futures
import contextlib
import copy
from datetime import datetime, timezone
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch
from uuid import uuid4

from openai_capabilities.cli import main
from openai_capabilities.ledger import Ledger
from openai_capabilities.policy import PolicyError, external_request_id_sha256
from openai_capabilities.service import Service
from test_policy_ledger import prepaid_policy
from test_service import FakeAdapter, account_snapshot, funding, request


class ExternalRequestCorrelationTests(unittest.TestCase):
    def setUp(self):
        fixed_now = datetime(2026, 10, 15, 12, tzinfo=timezone.utc)

        class Clock(datetime):
            @classmethod
            def now(cls, tz=None):
                return fixed_now.astimezone(tz) if tz else fixed_now.replace(tzinfo=None)

        for target in ("openai_capabilities.ledger.datetime", "openai_capabilities.policy.datetime",
                       "openai_capabilities.service.datetime", "test_service.datetime",
                       "test_policy_ledger.datetime"):
            patcher = patch(target, Clock)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        self.policy = prepaid_policy()
        self.policy_file = self.root / "policy.json"
        self.policy_file.write_text(json.dumps(self.policy), encoding="utf-8")
        self.adapter = FakeAdapter()
        self.service = Service(self.state, policy=self.policy, root=self.root,
            adapter_factory=lambda: self.adapter,
            credential_loader=lambda *_args, **_kwargs: "synthetic-credential",
            account_preflight=account_snapshot)
        self.funded = funding(self.policy)
        self.service.ledger.refresh_funding(self.funded)
        self.service.ledger.update_account_costs(account_snapshot(self.funded))
        self.service.ledger.set_enabled(True)

    def tearDown(self):
        self.temp.cleanup()

    def invoke_request(self, external_id=None):
        value = request()
        if external_id is not None:
            value["external_request_id"] = external_id
        return value

    def test_same_external_id_returns_recorded_result_without_a_second_provider_call(self):
        operation_id = str(uuid4())
        request_value = self.invoke_request(operation_id)
        first = self.service.invoke(request_value)
        second = self.service.invoke(copy.deepcopy(request_value))
        self.assertEqual(first["status"], "completed")
        self.assertEqual(second["status"], "completed")
        self.assertEqual(second["job_id"], first["job_id"])
        self.assertEqual(second["artifact"], first["artifact"])
        self.assertEqual(len(self.adapter.calls), 1)
        stored = self.service.ledger.get_job(first["job_id"])
        with self.service.ledger._db() as db:
            persisted_hash = db.execute("SELECT external_request_id_sha256 FROM jobs WHERE job_id=?",
                                        (first["job_id"],)).fetchone()[0]
        self.assertEqual(persisted_hash, external_request_id_sha256(operation_id))
        self.assertNotIn("external_request_id_sha256", stored)
        self.assertNotIn(operation_id, json.dumps(stored["request_meta"]))
        self.assertNotIn("input", stored["request_meta"].get("payload", {}))

    def test_same_external_id_with_changed_purpose_or_payload_conflicts(self):
        operation_id = str(uuid4())
        original = self.invoke_request(operation_id)
        result = self.service.invoke(original)
        changed_payload = copy.deepcopy(original)
        changed_payload["payload"]["input"] = ["different synthetic input"]
        with self.assertRaises(PolicyError) as caught:
            self.service.invoke(changed_payload)
        self.assertEqual(caught.exception.code, "external_request_conflict")
        changed_purpose = copy.deepcopy(original)
        changed_purpose["purpose"]["description"] = "A different synthetic operation"
        with self.assertRaises(PolicyError) as caught:
            self.service.invoke(changed_purpose)
        self.assertEqual(caught.exception.code, "external_request_conflict")
        self.assertEqual(self.service.ledger.get_job(result["job_id"])["status"], "completed")
        self.assertEqual(len(self.adapter.calls), 1)

    def test_batch_collection_reuses_its_operation_id_without_resubmission(self):
        document = {"external_request_id": str(uuid4()), "requests": [
            {"custom_id": "first", "request": request("batch")}]}
        first = self.service.batch_submit(document)
        second = self.service.batch_submit(copy.deepcopy(document))
        self.assertEqual(first["status"], "validating")
        self.assertEqual(second["status"], "pending")
        self.assertEqual(second["job_id"], first["job_id"])
        self.assertEqual(len(self.adapter.calls), 1)

    def test_lost_reply_lookup_is_metadata_only_and_unknown_submission_stays_held(self):
        operation_id = str(uuid4())
        value = self.invoke_request(operation_id)
        job, reused = self.service.ledger.reserve_external_request(
            {**value, "local_timeout_seconds": 30}, 100_000)
        self.assertFalse(reused)
        self.service.ledger.update_job(job["job_id"], "submitting",
                                       metadata={"pricing_request": {"capability": "embeddings"}})
        result = self.service.lookup_external_request(operation_id)
        self.assertEqual(result["status"], "uncertain")
        self.assertEqual(result["recorded_status"], "submitting")
        self.assertEqual(result["job_id"], job["job_id"])
        self.assertIn("will not be resubmitted", result["next_action"])
        self.assertEqual(self.service.ledger.status()["reserved_microusd"], 100_000)
        self.assertEqual(self.adapter.calls, [])
        repeated = self.service.invoke(value)
        self.assertEqual(repeated["status"], "uncertain")
        self.assertEqual(repeated["job_id"], job["job_id"])
        self.assertEqual(self.adapter.calls, [])

    def test_cli_lookup_returns_not_found_or_recorded_metadata_without_request_content(self):
        operation_id = str(uuid4())
        job, _ = self.service.ledger.reserve_external_request(
            {**self.invoke_request(operation_id), "local_timeout_seconds": 30}, 100_000)
        self.service.ledger.update_job(job["job_id"], "submitting")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = main(["--state-dir", str(self.state), "--policy", str(self.policy_file),
                         "lookup", "--external-request-id", operation_id])
        result = json.loads(out.getvalue())
        self.assertEqual(code, 2)
        self.assertEqual(result["status"], "uncertain")
        self.assertEqual(result["job_id"], job["job_id"])
        self.assertNotIn("purpose", result)
        self.assertNotIn("request_meta", result)
        self.assertNotIn("payload", result)

        missing_out = io.StringIO()
        with contextlib.redirect_stdout(missing_out):
            missing_code = main(["--state-dir", str(self.state), "--policy", str(self.policy_file), "lookup",
                                 "--external-request-id", str(uuid4())])
        self.assertEqual(missing_code, 0)
        self.assertEqual(json.loads(missing_out.getvalue()), {"status": "not_found"})

    def test_concurrent_same_id_reserves_exactly_once(self):
        operation_id = str(uuid4())
        value = {**self.invoke_request(operation_id), "local_timeout_seconds": 30}
        barrier = threading.Barrier(2)

        def reserve(_):
            ledger = Ledger(self.state / "usage.sqlite3", self.policy)
            barrier.wait(timeout=5)
            return ledger.reserve_external_request(value, 100_000)

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(reserve, range(2)))
        self.assertEqual(results[0][0]["job_id"], results[1][0]["job_id"])
        self.assertEqual(sorted(reused for _, reused in results), [False, True])
        self.assertEqual(self.service.ledger.status()["reserved_microusd"], 100_000)

    def test_concurrent_service_invokes_submit_once_and_share_one_local_job(self):
        operation_id = str(uuid4())
        request_value = self.invoke_request(operation_id)
        barrier = threading.Barrier(2)

        def invoke(_):
            barrier.wait(timeout=5)
            return self.service.invoke(copy.deepcopy(request_value))

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(invoke, range(2)))
        self.assertEqual(results[0]["job_id"], results[1]["job_id"])
        self.assertEqual(len(self.adapter.calls), 1)
        with self.service.ledger._db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 1)
        self.assertIn("completed", {result["status"] for result in results})

    def test_different_external_id_does_not_bypass_existing_purpose_payload_duplicate_guard(self):
        first = self.service.ledger.reserve(self.invoke_request(), 100_000)
        self.service.ledger.update_job(first["job_id"], "uncertain")
        second = self.invoke_request(str(uuid4()))
        second["max_cost_usd"] = "1"
        second["model"] = "synthetic-other-model"
        second["tier"] = "batch"
        with self.assertRaises(PolicyError) as caught:
            self.service.ledger.reserve_external_request(second, 100_000)
        self.assertEqual(caught.exception.code, "duplicate_request")
        self.assertEqual(self.service.ledger.status()["reserved_microusd"], 100_000)

    def test_external_request_id_requires_canonical_uuid_or_lowercase_sha256(self):
        for invalid in ("", str(uuid4()).upper(), "not-an-operation-id", "F" * 64, "a" * 65):
            with self.subTest(invalid=invalid), self.assertRaises(PolicyError) as caught:
                self.service.prepare({**request(), "external_request_id": invalid})
            self.assertEqual(caught.exception.code, "invalid_external_request_id")

    def test_existing_ledger_schema_migrates_without_changing_job_rows(self):
        path = self.root / "legacy.sqlite"
        db = sqlite3.connect(path)
        try:
            db.executescript("""
                CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE jobs (
                    job_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    grant_id TEXT NOT NULL, status TEXT NOT NULL, async_job INTEGER NOT NULL,
                    reservation_microusd INTEGER NOT NULL, actual_microusd INTEGER,
                    request_meta TEXT NOT NULL, api_id TEXT, usage TEXT, artifact TEXT,
                    metadata TEXT NOT NULL DEFAULT '{}');
                INSERT INTO jobs(job_id,created_at,updated_at,grant_id,status,async_job,reservation_microusd,request_meta)
                VALUES ('legacy-job','2026-01-01T00:00:00+00:00','2026-01-01T00:00:00+00:00',
                        'legacy-grant','uncertain',0,5000,'{}');
            """)
        finally:
            db.close()
        ledger = Ledger(path, self.policy)
        job = ledger.get_job("legacy-job")
        self.assertEqual(job["status"], "uncertain")
        self.assertEqual(job["reservation_microusd"], 5000)
        self.assertNotIn("external_request_id_sha256", job)
        with ledger._db() as db:
            indexes = {row["name"] for row in db.execute("PRAGMA index_list(jobs)")}
            self.assertIsNone(db.execute(
                "SELECT external_request_id_sha256 FROM jobs WHERE job_id='legacy-job'").fetchone()[0])
        self.assertIn("jobs_external_request_id_sha256", indexes)


if __name__ == "__main__":
    unittest.main()
