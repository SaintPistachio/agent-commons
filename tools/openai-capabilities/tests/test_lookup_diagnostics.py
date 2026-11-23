import copy
import json
import unittest
from openai_capabilities.service import Service

def job(metadata=None, status='uncertain'):
    return {'job_id': 'synthetic-job', 'status': status, 'api_id': None,
            'artifact': None, 'usage': None, 'actual_microusd': None, 'metadata': metadata or {}}

class LookupDiagnosticsTests(unittest.TestCase):
    def test_closed_recorded_cause_and_stage_survive_read_only_projection(self):
        fields = {'failure_class': 'local_deadline', 'exception_type': 'APITimeoutError',
                  'transport_cause_type': 'ReadTimeout', 'http_status': 504, 'failure_stage': 'sync_request'}
        value = job({**fields, 'error_code': 'execution_uncertain'})
        before = copy.deepcopy(value)
        result = Service._external_request_result(value)
        for key, expected in fields.items():
            self.assertEqual(result.get(key), expected)
        self.assertEqual(result['status'], 'uncertain')
        self.assertIsNone(result['usage'])
        self.assertIsNone(result['cost_usd'])
        self.assertEqual(value, before)
        self.assertEqual(Service._external_request_result(value), result)

    def test_unknown_and_unhashable_metadata_cannot_break_lookup_or_leak(self):
        sentinel = 'PRIVATE_DIAGNOSTIC_SENTINEL'
        for invalid in [sentinel, 'constructor', 5, True, [], {}, ['ReadTimeout']]:
            result = Service._external_request_result(job({'failure_class': invalid,
                'exception_type': invalid, 'transport_cause_type': invalid, 'http_status': invalid,
                'failure_stage': invalid, 'raw_error': sentinel, 'request_payload': sentinel}))
            for key in ('failure_class','exception_type','transport_cause_type','http_status','failure_stage','raw_error','request_payload'):
                self.assertNotIn(key, result)
            self.assertNotIn(sentinel, json.dumps(result))
            self.assertEqual(result['status'], 'uncertain')

    def test_legacy_missing_evidence_is_not_backfilled(self):
        for status in ('reserved', 'submitting', 'uncertain', 'failed', 'completed'):
            result = Service._external_request_result(job(status=status))
            self.assertEqual(result['status'], 'uncertain' if status in ('reserved','submitting') else status)
            for key in ('failure_class','exception_type','transport_cause_type','http_status','failure_stage'):
                self.assertNotIn(key, result)
        self.assertEqual(Service._external_request_result(None), {'status': 'not_found'})

    def test_http_bounds_and_other_known_cause_remain_observations(self):
        for code in (100, 429, 599):
            result = Service._external_request_result(job({'http_status': code, 'failure_class': 'provider_transport'}))
            self.assertEqual(result['http_status'], code)
            self.assertEqual(result['failure_class'], 'provider_transport')
            self.assertEqual(result['status'], 'uncertain')
        for code in (99, 600, 200.5, True, '429'):
            self.assertNotIn('http_status', Service._external_request_result(job({'http_status': code})))

if __name__ == '__main__':
    unittest.main()
