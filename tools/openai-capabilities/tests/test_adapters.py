import copy
import json
import os
import sys
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch

from openai_capabilities.adapters import AdapterError, SDKAdapter, bounded_call, normalize_result, validate_payload


def request(capability="responses", tier="default", payload=None):
    return {"capability": capability, "model": "text-embedding-3-small" if capability == "embeddings" else "gpt-6-luna",
            "tier": tier, "payload": payload or {"input": "synthetic", "max_output_tokens": 128}}


class AdapterTests(unittest.TestCase):
    def test_whole_operation_deadline_retains_remote_uncertainty(self):
        finished, release = threading.Event(), threading.Event()
        daemon = []
        def slowly_completing_call(**kwargs):
            daemon.append(threading.current_thread().daemon)
            try:
                release.wait(.5)
                return {"id": "resp_late", "status": "completed", "output": []}
            finally:
                finished.set()
        client = Mock()
        client.responses.create.side_effect = slowly_completing_call
        adapter = SDKAdapter("secret-canary", "org-test", "proj-test", client=client, timeout_seconds=.03)
        started = time.monotonic()
        try:
            with self.assertRaises(AdapterError) as caught:
                adapter.call(request())
            self.assertLess(time.monotonic() - started, .3)
            self.assertEqual(caught.exception.code, "execution_uncertain")
            self.assertTrue(caught.exception.uncertain)
            self.assertFalse(caught.exception.retryable)
            self.assertNotIn("secret-canary", str(caught.exception))
            self.assertEqual(daemon, [True])
            client.responses.create.assert_called_once()
        finally:
            release.set()
            self.assertTrue(finished.wait(1), "bounded test worker must finish")

    def test_bounded_call_passes_results_and_sanitizes_errors(self):
        self.assertEqual(bounded_call(lambda value: value, .5, 7), 7)
        def failure():
            raise RuntimeError("private-canary")
        with self.assertRaises(AdapterError) as caught:
            bounded_call(failure, .5)
        self.assertNotIn("private-canary", str(caught.exception))
        with self.assertRaises(AdapterError):
            bounded_call(lambda: None, float("inf"))

    def test_fixed_destination_credentials_and_transport(self):
        fake_openai, fake_http = types.ModuleType("openai"), types.ModuleType("httpx2")
        fake_openai.OpenAI = Mock()
        fake_http.Client = Mock()
        with patch.dict(sys.modules, {"openai": fake_openai, "httpx2": fake_http}), patch.dict(os.environ, {
            "OPENAI_BASE_URL": "https://untrusted.invalid", "OPENAI_API_KEY": "ambient-canary", "OPENAI_ADMIN_KEY": "admin-canary",
            "HTTPS_PROXY": "https://untrusted.invalid"}):
            SDKAdapter("designated-canary", "org-test", "proj-test")
        kwargs = fake_openai.OpenAI.call_args.kwargs
        self.assertEqual(kwargs["api_key"], "designated-canary")
        self.assertEqual(kwargs["admin_api_key"], "")
        self.assertEqual(kwargs["base_url"], "https://api.openai.com/v1")
        self.assertEqual(kwargs["max_retries"], 0)
        self.assertEqual(kwargs["organization"], "org-test")
        self.assertEqual(kwargs["project"], "proj-test")
        self.assertFalse(fake_http.Client.call_args.kwargs["trust_env"])
        self.assertFalse(fake_http.Client.call_args.kwargs["follow_redirects"])

    def test_fail_closed_models_tools_media_and_cache_tiers(self):
        cases = [request(tier="auto"), request("decisions", "batch", {"input": "x", "questions": []}),
                 request(payload={"input": "x", "max_output_tokens": 128, "tools": [{"type": "web_search"}]}),
                 request(payload={"input": [{"role": "user", "content": [{"type": "input_image", "image_url": "https://untrusted.invalid/a"}]}], "max_output_tokens": 128}),
                 request("decisions", payload={"input": "x", "questions": [{"type": "predicate", "name": "a", "instructions": "Check x"}], "prompt_cache_options": {"ttl": "12h"}})]
        for candidate in cases:
            with self.subTest(candidate=candidate), self.assertRaises(AdapterError):
                validate_payload(candidate)
        body = validate_payload(request(tier="flex"))
        self.assertEqual(body["service_tier"], "flex")
        self.assertFalse(body["store"])
        self.assertEqual(body["prompt_cache_options"]["mode"], "explicit")

    def test_embeddings_are_numeric_ordered_and_dimension_checked(self):
        req = request("embeddings", payload={"input": ["a", "b"], "dimensions": 2})
        body = {"data": [{"index": 1, "embedding": [1.0, 2.0]}, {"index": 0, "embedding": [3.0, 4.0]}], "usage": {"prompt_tokens": 2}}
        result = normalize_result(req, body)
        self.assertEqual(result["output"], [[3.0, 4.0], [1.0, 2.0]])
        self.assertEqual(result["usage"], {"prompt_tokens": 2})
        body["data"][0]["embedding"] = [float("nan"), 1]
        self.assertEqual(normalize_result(req, body)["status"], "invalid_result")

    def test_decisions_typed_results_refusals_and_validation(self):
        questions = [{"type": "predicate", "name": "p", "instructions": "Check"},
                     {"type": "choice", "name": "c", "instructions": "Pick", "choices": [{"value": True}, {"value": "true"}]},
                     {"type": "score", "name": "s", "instructions": "Score", "levels": [{"label": "low", "description": "low"}, {"label": "high", "description": "high"}]}]
        req = request("decisions", payload={"input": "x", "questions": questions})
        validate_payload(req)
        body = {"answers": [{"type": "predicate", "name": "p", "probability": .9},
                            {"type": "choice", "name": "c", "choice": True, "confidence": .8,
                             "probabilities": [{"value": True, "probability": .9}, {"value": "true", "probability": .1}]},
                            {"type": "score", "name": "s", "score": .7, "confidence": .5,
                             "probabilities": [{"value": 0, "probability": .3}, {"value": 1, "probability": .7}]}], "usage": {"input_tokens": 10}}
        self.assertEqual(normalize_result(req, body)["status"], "completed")
        broken = copy.deepcopy(body)
        broken["answers"][1]["choice"] = 1
        self.assertEqual(normalize_result(req, broken)["status"], "invalid_result")
        body["answers"][0] = {"type": "refusal", "name": "p"}
        self.assertEqual(normalize_result(req, body)["status"], "refused")

    def test_structured_response_validates_schema_and_preserves_usage_on_incomplete(self):
        req = request(payload={"input": "x", "max_output_tokens": 128, "text": {"format": {
            "type": "json_schema", "name": "record", "strict": True, "schema": {"type": "object", "properties": {"count": {"type": "integer"}}, "required": ["count"], "additionalProperties": False}}}})
        validate_payload(req)
        body = {"id": "resp_test", "status": "completed", "service_tier": "flex", "usage": {"output_tokens": 5}, "output": [{"content": [{"type": "output_text", "text": '{"count":2}'}]}]}
        self.assertEqual(normalize_result(req, body)["output"], {"count": 2})
        body["output"][0]["content"][0]["text"] = '{"count":"2"}'
        self.assertEqual(normalize_result(req, body)["status"], "invalid_result")
        body["status"] = "incomplete"
        result = normalize_result(req, body)
        self.assertEqual(result["status"], "incomplete")
        self.assertEqual(result["usage"], {"output_tokens": 5})
        self.assertEqual(result["service_tier"], "flex")

    def test_sdk_errors_are_classified_without_key_or_private_payload(self):
        client = Mock()
        class APIError(Exception):
            status_code = 429
            code = "credit_balance_exhausted"
        client.responses.create.side_effect = APIError("secret-canary private payload")
        adapter = SDKAdapter("secret-canary", "org-test", "proj-test", client=client)
        with self.assertRaises(AdapterError) as caught:
            adapter.call(request())
        self.assertEqual(caught.exception.code, "credit_balance_exhausted")
        self.assertFalse(caught.exception.retryable)
        self.assertNotIn("secret-canary", str(caught.exception))
        class APITimeoutError(Exception):
            pass
        client.responses.create.side_effect = APITimeoutError("secret-canary")
        with self.assertRaises(AdapterError) as caught:
            adapter.call(request())
        self.assertTrue(caught.exception.uncertain)
        self.assertFalse(caught.exception.retryable)
        self.assertEqual(caught.exception.failure_class, "provider_transport")
        self.assertEqual(caught.exception.exception_type, "APITimeoutError")
        class ServerError(Exception):
            status_code = 502
        client.responses.create.side_effect = ServerError("private-canary")
        with self.assertRaises(AdapterError) as caught:
            adapter.call(request())
        self.assertTrue(caught.exception.uncertain)
        self.assertFalse(caught.exception.retryable)
        self.assertEqual(caught.exception.failure_class, "provider_http")
        self.assertEqual(caught.exception.http_status, 502)
        self.assertEqual(caught.exception.exception_type, "ServerError")

    def test_local_deadline_and_missing_result_have_distinct_safe_classes(self):
        with self.assertRaises(AdapterError) as caught:
            bounded_call(lambda: time.sleep(.03), .001)
        self.assertEqual(caught.exception.failure_class, "local_deadline")
        with self.assertRaises(AdapterError) as caught:
            bounded_call(lambda: (_ for _ in ()).throw(KeyboardInterrupt()), .5)
        self.assertEqual(caught.exception.failure_class, "local_result_missing")

    def test_connection_error_keeps_only_allowlisted_nested_transport_cause(self):
        client = Mock()
        class APIConnectionError(Exception):
            pass
        try:
            raise ConnectionRefusedError("private endpoint details")
        except ConnectionRefusedError as root:
            try:
                raise APIConnectionError("secret URL and headers") from root
            except APIConnectionError as error:
                client.responses.create.side_effect = error
        adapter = SDKAdapter("designated-canary", "org-test", "proj-test", client=client)
        with self.assertRaises(AdapterError) as caught:
            adapter.call(request())
        self.assertEqual(caught.exception.failure_class, "provider_transport")
        self.assertEqual(caught.exception.exception_type, "APIConnectionError")
        self.assertEqual(caught.exception.transport_cause_type, "ConnectionRefusedError")
        self.assertNotIn("private endpoint", str(caught.exception))

    def test_http_not_found_is_actionable_without_private_sdk_details(self):
        client = Mock()
        class NotFoundError(Exception):
            status_code = 404
            body = {"error": {"message": "sk-admin-privateCanary private request payload", "code": "unrecognized_remote_code"}}
        client.batches.retrieve.side_effect = NotFoundError("sk-admin-privateCanary private response details")
        adapter = SDKAdapter("sk-proj-testCanary", "org-test", "proj-test", client=client)
        with self.assertRaises(AdapterError) as caught:
            adapter.batch_status("batch_test")
        self.assertEqual(caught.exception.code, "not_found")
        self.assertEqual(caught.exception.http_status, 404)
        self.assertFalse(caught.exception.retryable)
        self.assertFalse(caught.exception.uncertain)
        self.assertNotIn("privateCanary", str(caught.exception))
        self.assertNotIn("payload", str(caught.exception))
        self.assertIsNone(AdapterError("safe", "safe", http_status="404").http_status)
        self.assertIsNone(AdapterError("safe", "safe", http_status=999).http_status)
        self.assertIsNone(AdapterError("safe", "safe", http_status=True).http_status)

    def test_batch_upload_checkpoint_stable_ids_and_unordered_collection(self):
        client = Mock()
        client.files.create.return_value = {"id": "file_test"}
        client.batches.create.return_value = {"id": "batch_test", "status": "validating"}
        requests = [request("embeddings", "batch", {"input": ["first"], "dimensions": 2}), request("embeddings", "batch", {"input": ["second"], "dimensions": 2})]
        requests[0]["custom_id"], requests[1]["custom_id"] = "first", "second"
        checkpoints = []
        adapter = SDKAdapter("canary", "org-test", "proj-test", client=client)
        result = adapter.batch_submit(requests, "local-test", checkpoints.append)
        self.assertEqual(checkpoints, [{"input_file_id": "file_test", "item_ids": ["first", "second"]}])
        self.assertEqual(result["api_id"], "batch_test")
        lines = [json.loads(s) for s in client.files.create.call_args.kwargs["file"][1].decode().splitlines()]
        self.assertEqual(lines[0]["custom_id"], "first")
        self.assertNotIn("service_tier", lines[0]["body"])
        client.batches.retrieve.return_value = {"id": "batch_test", "status": "completed", "output_file_id": "file_output", "error_file_id": "file_errors"}
        output = types.SimpleNamespace(text='\n'.join(json.dumps({"custom_id": i, "response": {"status_code": 200, "body": {"id": i}}}) for i in ["second", "first"]))
        errors = types.SimpleNamespace(text=json.dumps({"custom_id": "third", "error": {"message": "private-canary"}}))
        client.files.content.side_effect = [output, errors]
        collected = adapter.batch_results("batch_test")
        self.assertEqual(set(collected["successful"]), {"first", "second"})
        self.assertEqual(collected["successful"]["first"]["id"], "first")
        self.assertNotIn("private-canary", json.dumps(collected))

    def test_batch_rejects_mixed_models_and_duplicate_output_ids(self):
        client = Mock()
        adapter = SDKAdapter("canary", "org-test", "proj-test", client=client)
        items = [request("responses", "batch"), request("responses", "batch")]
        items[1]["model"] = "gpt-6.1-sol"
        with self.assertRaises(AdapterError):
            adapter.batch_submit(items, "local-test")
        client.files.create.assert_not_called()
        client.batches.retrieve.return_value = {"id": "batch_test", "status": "completed", "output_file_id": "file_output"}
        line = json.dumps({"custom_id": "duplicate", "response": {"status_code": 200, "body": {}}})
        client.files.content.return_value = types.SimpleNamespace(text=line + "\n" + line)
        with self.assertRaises(AdapterError) as caught:
            adapter.batch_results("batch_test")
        self.assertEqual(caught.exception.code, "invalid_batch_results")

    def test_reconcile_batch_requires_both_identifiers_and_complete_unique_search(self):
        client = Mock()
        adapter = SDKAdapter("canary", "org-test", "proj-test", client=client)
        wrong = {"id": "batch_wrong", "status": "in_progress", "input_file_id": "file_other", "metadata": {"local_job_id": "local-test"}}
        match = {"id": "batch_match", "status": "completed", "input_file_id": "file_test", "metadata": {"local_job_id": "local-test"}}
        client.batches.list.side_effect = [{"data": [wrong], "has_more": True}, {"data": [match], "has_more": False}]
        result = adapter.batch_reconcile("local-test", "file_test")
        self.assertEqual(result["api_id"], "batch_match")
        self.assertEqual(client.batches.list.call_args.kwargs["after"], "batch_wrong")
        client.batches.create.assert_not_called()
        client.batches.list.side_effect = None
        for page, code in [({"data": [wrong], "has_more": False}, "batch_submission_not_found"),
                           ({"data": [match, {**match, "id": "batch_other"}], "has_more": False}, "ambiguous_batch_submission"),
                           ({"data": [match], "has_more": True}, "batch_reconciliation_incomplete")]:
            client.batches.list.return_value = page
            with self.subTest(code=code), self.assertRaises(AdapterError) as caught:
                adapter.batch_reconcile("local-test", "file_test", max_pages=1)
            self.assertEqual(caught.exception.code, code)
            self.assertTrue(caught.exception.uncertain)

    def test_retrieve_response_only_uses_existing_response_identifier(self):
        client = Mock()
        client.responses.retrieve.return_value = {"id": "resp_test", "status": "completed"}
        adapter = SDKAdapter("canary", "org-test", "proj-test", client=client)
        self.assertEqual(adapter.retrieve_response("resp_test")["status"], "completed")
        with self.assertRaises(AdapterError):
            adapter.retrieve_response("req_request_id")
        client.responses.create.assert_not_called()

    def test_embedding_resume_uses_validation_count_without_saved_private_input(self):
        req = {"capability": "embeddings", "validation_input_count": 1, "payload": {"dimensions": 2}}
        result = normalize_result(req, {"data": [{"index": 0, "embedding": [1.0, 2.0]}], "usage": {"prompt_tokens": 2}})
        self.assertEqual(result["status"], "completed")

    def test_documented_examples_validate(self):
        from pathlib import Path
        for path in (Path(__file__).resolve().parents[1] / "examples").glob("*.json"):
            value = json.loads(path.read_text(encoding="utf-8"))
            items = [i["request"] for i in value["requests"]] if "requests" in value else [value]
            for item in items:
                with self.subTest(path=path.name):
                    validate_payload(item)


if __name__ == "__main__":
    unittest.main()


class RegisteredModelTests(unittest.TestCase):
    def test_responses_models_come_from_the_verified_registry(self):
        from openai_capabilities.adapters import _registered_responses_models
        registered = _registered_responses_models()
        self.assertIn("gpt-6.2-sol", registered)
        self.assertIn("gpt-6.2-astra", registered)
        body = validate_payload({"capability": "responses", "model": "gpt-6.2-sol", "tier": "default",
                                 "payload": {"input": "synthetic", "max_output_tokens": 100}})
        self.assertEqual(body["model"], "gpt-6.2-sol")
        with self.assertRaises(Exception):
            validate_payload({"capability": "responses", "model": "gpt-9-unregistered", "tier": "default",
                              "payload": {"input": "synthetic", "max_output_tokens": 100}})


class FunctionToolTests(unittest.TestCase):
    @staticmethod
    def _tool(name="read_file"):
        return {
            "type": "function",
            "name": name,
            "description": "Read a file in the job folder.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
                "additionalProperties": False,
            },
            "strict": True,
        }

    def test_valid_function_tools_and_turn_history(self):
        req = request(payload={
            "input": [
                {"role": "user", "content": [{"type": "input_text", "text": "Inspect README.md"}]},
                {"role": "assistant", "content": [{"type": "output_text", "text": "Checking."}]},
                {"type": "function_call", "call_id": "call_1", "name": "read_file", "arguments": '{"path":"README.md"}'},
                {"type": "function_call_output", "call_id": "call_1", "output": "1|Hello"},
            ],
            "instructions": "Use tools to answer.",
            "max_output_tokens": 512,
            "tools": [self._tool()],
            "tool_choice": "auto",
            "parallel_tool_calls": True,
        })
        body = validate_payload(req)
        self.assertEqual(len(body["tools"]), 1)
        self.assertEqual(body["tool_choice"], "auto")
        self.assertTrue(body["parallel_tool_calls"])
        self.assertFalse(body["store"])
        named = validate_payload(request(payload={
            "input": "Use tool", "max_output_tokens": 128,
            "tools": [self._tool()], "tool_choice": {"type": "function", "name": "read_file"},
        }))
        self.assertEqual(named["tool_choice"], {"type": "function", "name": "read_file"})

    def test_rejects_hosted_and_invalid_function_tools_and_history(self):
        schema_fmt = {"format": {"type": "json_schema", "name": "x", "strict": True,
                                 "schema": {"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"], "additionalProperties": False}}}
        bad_cases = [
            {"input": "x", "max_output_tokens": 128, "tools": []},
            {"input": "x", "max_output_tokens": 128, "tools": [{"type": "web_search"}]},
            {"input": "x", "max_output_tokens": 128, "tools": [{**self._tool(), "strict": False}]},
            {"input": "x", "max_output_tokens": 128, "tools": [self._tool("dup"), self._tool("dup")]},
            {"input": "x", "max_output_tokens": 128, "tools": [self._tool()], "text": schema_fmt},
            {"input": "x", "max_output_tokens": 128, "tool_choice": "auto"},
            {"input": "x", "max_output_tokens": 128, "tools": [self._tool()], "tool_choice": {"type": "function", "name": "missing"}},
            {"input": "x", "max_output_tokens": 128, "parallel_tool_calls": True},
            {"input": "x", "max_output_tokens": 128, "tools": [self._tool()], "parallel_tool_calls": "yes"},
            {"input": [{"type": "function_call", "call_id": "c1", "name": "read_file", "arguments": "{}"}], "max_output_tokens": 128},
            {"input": [{"type": "function_call", "call_id": "c1", "name": "other", "arguments": "{}"}], "max_output_tokens": 128, "tools": [self._tool()]},
            {"input": [
                {"type": "function_call", "call_id": "c1", "name": "read_file", "arguments": "{}"},
                {"type": "function_call", "call_id": "c1", "name": "read_file", "arguments": "{}"},
            ], "max_output_tokens": 128, "tools": [self._tool()]},
            {"input": [{"type": "function_call_output", "call_id": "missing", "output": "ok"}], "max_output_tokens": 128, "tools": [self._tool()]},
            {"input": [
                {"type": "function_call", "call_id": "c1", "name": "read_file", "arguments": "{}"},
                {"type": "function_call_output", "call_id": "c1", "output": "a"},
                {"type": "function_call_output", "call_id": "c1", "output": "b"},
            ], "max_output_tokens": 128, "tools": [self._tool()]},
            {"input": [{"type": "function_call", "call_id": "c1", "name": "read_file", "arguments": "x" * 65537}], "max_output_tokens": 128, "tools": [self._tool()]},
            {"input": [
                {"type": "function_call", "call_id": "c1", "name": "read_file", "arguments": "{}"},
                {"type": "function_call_output", "call_id": "c1", "output": "x" * 262145},
            ], "max_output_tokens": 128, "tools": [self._tool()]},
        ]
        for payload in bad_cases:
            with self.subTest(payload=payload), self.assertRaises(AdapterError):
                validate_payload(request(payload=payload))

    def test_normalize_result_with_function_tools_and_resume_metadata(self):
        req = request(payload={"input": "Read file", "max_output_tokens": 128, "tools": [self._tool()]})
        body = {
            "id": "resp_tool_1",
            "status": "completed",
            "output": [
                {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Calling reader."}]},
                {"type": "function_call", "call_id": "call_abc", "name": "read_file", "arguments": '{"path":"a.txt"}'},
            ],
            "usage": {"input_tokens": 20, "output_tokens": 10},
        }
        res = normalize_result(req, body)
        self.assertEqual(res["status"], "completed")
        self.assertEqual(res["output"], {
            "text": "Calling reader.",
            "function_calls": [{"call_id": "call_abc", "name": "read_file", "arguments": '{"path":"a.txt"}'}],
        })
        # Final answer without calls preserves dict shape when tools were sent or restored via function_tools metadata.
        final_res = normalize_result({"capability": "responses", "function_tools": ["read_file"], "payload": {"max_output_tokens": 128}}, {
            "id": "resp_tool_2",
            "status": "completed",
            "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Done."}]}],
            "usage": {"input_tokens": 30, "output_tokens": 5},
        })
        self.assertEqual(final_res["output"], {"text": "Done.", "function_calls": []})
        malformed = normalize_result(req, {"id": "resp_bad", "status": "completed", "output": [{"type": "function_call", "call_id": "", "name": "read_file", "arguments": "{}"}]})
        self.assertEqual(malformed["status"], "invalid_result")
        self.assertIsNone(malformed["output"])
