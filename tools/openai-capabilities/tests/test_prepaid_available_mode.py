from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch
import tempfile
import unittest
from openai_capabilities.ledger import Ledger
from openai_capabilities.policy import PolicyError
from tests.test_weekly_budget import START, frozen_time, prepaid_policy, funding, costs, request

class PrepaidAvailableModeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.path=Path(self.temp.name)/'ledger.sqlite'
        self.policy={**prepaid_policy(),'spending_mode':'prepaid-available','max_sync_jobs':2}
        self.ledger=Ledger(self.path,self.policy)
        with frozen_time(START):
            snapshot=funding(START)
            self.ledger.refresh_funding(snapshot)
            self.ledger.update_account_costs(costs(snapshot,START))
            self.ledger.set_enabled(True)
    def tearDown(self):
        self.temp.cleanup()
    def test_weekly_cap_is_advisory_and_unknown_reservation_is_unchanged(self):
        with frozen_time(START):
            limit=int(Decimal(self.ledger.status()['weekly_budget']['weekly_limit_usd'])*1000000)
            held=self.ledger.reserve(request('consume-advisory-week'),limit)
            self.ledger.update_job(held['job_id'],'uncertain')
            before=self.ledger.get_job(held['job_id'])
            admitted=self.ledger.reserve(request('prepaid-above-week'),1000000)
            self.assertEqual(admitted['status'],'reserved')
            self.assertEqual(self.ledger.get_job(held['job_id']),before)
            state=self.ledger.status()
            self.assertEqual(state['spending_mode'],'prepaid-available')
            self.assertEqual(state['weekly_budget']['status'],'exhausted')
            self.assertGreater(Decimal(state['prepaid_available_usd']),0)
            self.assertEqual(state['weekly_budget']['available_for_new_requests_usd'],'0')
    def test_total_prepaid_limit_still_blocks_and_reservation_cannot_be_spent_twice(self):
        with frozen_time(START):
            available=int(Decimal(self.ledger.status()['prepaid_available_usd'])*1000000)
            held=self.ledger.reserve(request('reserve-all-allowed'),available)
            self.ledger.update_job(held['job_id'],'uncertain')
            with self.assertRaises(PolicyError) as caught:
                self.ledger.reserve(request('beyond-prepaid'),1)
            self.assertEqual(caught.exception.code,'allocation_exhausted')
            self.assertEqual(self.ledger.status()['prepaid_available_usd'],'0')
    def test_independent_connections_enforce_global_limit_atomically(self):
        with frozen_time(START):
            def reserve(index):
                ledger=Ledger(self.path,self.policy)
                try:
                    return ledger.reserve(request('parallel-prepaid-'+str(index)),80000000)['job_id']
                except PolicyError as exc:
                    return exc.code
            with ThreadPoolExecutor(max_workers=2) as workers:
                results=list(workers.map(reserve,range(2)))
            self.assertEqual(results.count('allocation_exhausted'),1)
            self.assertEqual(self.ledger.status()['reserved_microusd'],80000000)
    def test_legacy_mode_and_explicit_weekly_keep_the_existing_weekly_gate(self):
        with frozen_time(START):
            legacy=Ledger(self.path,prepaid_policy())
            self.assertNotIn('spending_mode',legacy.status())
            for policy in (prepaid_policy(),{**prepaid_policy(),'spending_mode':'weekly'}):
                ledger=Ledger(self.path,policy)
                with self.assertRaises(PolicyError) as caught:
                    ledger.check_reservation(request('weekly-still-blocked'),80000000)
                self.assertEqual(caught.exception.code,'weekly_budget_exhausted')
    def test_invalid_mode_fails_closed_without_reservation(self):
        with frozen_time(START):
            for mode in ('unlimited',None,False,{},[]):
                ledger=Ledger(self.path,{**prepaid_policy(),'spending_mode':mode})
                with self.assertRaises(PolicyError) as caught:
                    ledger.reserve(request('invalid-mode'),1000000)
                self.assertEqual(caught.exception.code,'spending_mode_invalid')
            self.assertEqual(self.ledger.status()['reserved_microusd'],0)
    def test_service_exposes_only_an_observation_not_a_policy_mutation(self):
        from openai_capabilities.service import Service
        with frozen_time(START):
            service=Service(state_dir=self.path.parent,root=self.path.parent,policy=self.policy,
                            registry={'verified_at':'synthetic','models':{}},credential_loader=lambda *a,**k:'synthetic')
            # Reuse only this test's synthetic ledger, never a real helper home.
            service.ledger=self.ledger
            result=service.status()
            self.assertEqual(result['status'],'ready')
            self.assertEqual(result['spending_mode'],'prepaid-available')
            self.assertGreater(Decimal(result['prepaid_available_usd']),0)
    def test_stale_account_costs_still_block(self):
        with frozen_time(START+timedelta(seconds=301)):
            with self.assertRaises(PolicyError) as caught:
                self.ledger.reserve(request('stale-account'),1000000)
            self.assertEqual(caught.exception.code,'account_costs_stale')
    def test_grant_expiry_still_bounds_full_execution(self):
        with frozen_time(START):
            late={**request('late-deadline'),'deadline':(START+timedelta(days=25)).isoformat()}
            with self.assertRaises(PolicyError) as caught:
                self.ledger.reserve(late,1000000)
            self.assertEqual(caught.exception.code,'grant_deadline_exceeded')
    def test_stale_cost_status_remains_structured_without_optional_observation(self):
        from openai_capabilities.service import Service
        with frozen_time(START+timedelta(seconds=301)):
            for mode in ('weekly','prepaid-available'):
                policy={**self.policy,'spending_mode':mode}
                ledger=Ledger(self.path,policy)
                state=ledger.status()
                self.assertEqual(state['weekly_budget']['status'],'unverified')
                self.assertNotIn('spending_mode',state)
                self.assertNotIn('prepaid_available_usd',state)
                service=Service(state_dir=self.path.parent,root=self.path.parent,policy=policy,
                                registry={'verified_at':'synthetic','models':{}},credential_loader=lambda *a,**k:'synthetic')
                service.ledger=ledger
                observed=service.status()
                self.assertEqual(observed['status'],'blocked')
                self.assertIn('account_costs_stale',[item['code'] for item in observed['blockers']])
                self.assertNotIn('spending_mode',observed)
                self.assertNotIn('prepaid_available_usd',observed)
                with self.assertRaises(PolicyError) as caught:
                    ledger.reserve(request('stale-'+mode),1000000)
                self.assertEqual(caught.exception.code,'account_costs_stale')
    def test_reporting_failure_omits_both_optional_fields_without_fabricating_zero(self):
        with frozen_time(START):
            for mode in ('weekly','prepaid-available'):
                ledger=Ledger(self.path,{**self.policy,'spending_mode':mode})
                with patch.object(ledger,'_prepaid_available',side_effect=PolicyError('account_costs_stale','synthetic')):
                    state=ledger.status()
                    self.assertEqual(state['weekly_budget']['status'],'unverified')
                    self.assertNotIn('spending_mode',state)
                    self.assertNotIn('prepaid_available_usd',state)
    def test_unknown_request_is_not_replayed_when_weekly_gate_is_advisory(self):
        with frozen_time(START):
            original=self.ledger.reserve(request('unknown-original'),1000000)
            self.ledger.update_job(original['job_id'],'uncertain')
            before=self.ledger.get_job(original['job_id'])
            with self.assertRaises(PolicyError) as caught:
                self.ledger.reserve(request('unknown-original'),1000000)
            self.assertEqual(caught.exception.code,'duplicate_request')
            self.assertEqual(self.ledger.get_job(original['job_id']),before)

if __name__=='__main__': unittest.main()
