"""Exercise installed SDK serialization using an in-memory HTTP transport."""
from synthetic_keys import synthetic_key
import json
import unittest
from unittest.mock import patch

import httpx2

from openai_capabilities.adapters import SDKAdapter


class SDKContractTests(unittest.TestCase):
    def test_core_requests_with_real_sdk_and_no_network(self):
        seen = []
        def handle(req):
            self.assertEqual(req.url.host, "api.openai.com")
            self.assertEqual(req.headers["authorization"], ('Bearer ' + synthetic_key('proj-SYNTHETIC_TEST_KEY')))
            self.assertEqual(req.headers["openai-organization"], "org-test")
            self.assertEqual(req.headers["openai-project"], "proj-test")
            body = json.loads(req.content)
            seen.append((req.url.path, body))
            if req.url.path == "/v1/embeddings":
                result = {"object": "list", "data": [{"object": "embedding", "index": 0, "embedding": [1., 2.]}],
                          "model": "text-embedding-3-small", "usage": {"prompt_tokens": 5, "total_tokens": 5}}
            elif req.url.path == "/v1/decisions":
                result = {"id": "decision_test", "answers": [{"type": "predicate", "name": "valid", "probability": .8}],
                          "usage": {"input_tokens": 8, "output_tokens": 0}}
            else:
                self.assertEqual(req.url.path, "/v1/responses")
                self.assertEqual(body["service_tier"], "default")
                self.assertFalse(body["store"])
                result = {"id": "resp_test", "status": "completed", "service_tier": "default",
                    "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "OK", "annotations": []}]}],
                    "usage": {"input_tokens": 10, "output_tokens": 2, "total_tokens": 12}}
            return httpx2.Response(200, json=result)
        original = httpx2.Client
        class OfflineClient(original):
            def __init__(self, **kwargs):
                super().__init__(transport=httpx2.MockTransport(handle), **kwargs)
        with patch("httpx2.Client", OfflineClient):
            adapter = SDKAdapter((synthetic_key('proj-SYNTHETIC_TEST_KEY')), "org-test", "proj-test")
        try:
            for req in [
                {"capability": "embeddings", "model": "text-embedding-3-small", "tier": "default", "payload": {"input": "Synthetic", "dimensions": 2}},
                {"capability": "decisions", "model": "gpt-6-luna", "tier": "default", "payload": {"input": "Synthetic", "questions": [{"type": "predicate", "name": "valid", "instructions": "Is it valid?"}]}},
                {"capability": "responses", "model": "gpt-6-luna", "tier": "default", "payload": {"input": "Synthetic", "max_output_tokens": 100}},
            ]:
                self.assertEqual(adapter.call(req)["status"], "completed")
        finally:
            adapter.close()
        self.assertEqual(len(seen), 3)


if __name__ == "__main__":
    unittest.main()
