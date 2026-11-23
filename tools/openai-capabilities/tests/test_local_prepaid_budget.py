import copy
from datetime import timedelta
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from openai_capabilities.ledger import Ledger
from openai_capabilities.policy import PolicyError, uses_local_prepaid_budget, validate_funding
from tests.test_weekly_budget import START, frozen_time, prepaid_policy, funding, costs, request
from tests.test_credits import api_client, OBSERVATIONS, NOW, POLICY
from openai_capabilities.credits import refresh_costs


def local_policy():
    original = prepaid_policy()
    return {**original, 'platform_limit_policy': 'local_prepaid_budget',
            'local_prepaid_authorization': {'source': 'user_confirmation', 'reference': 'synthetic-consent',
                'organization_id': original['organization_id'], 'project_id': original['project_id'],
                'auto_recharge': 'disabled', 'automatic_purchases': 'disabled'}}


class LocalPrepaidBudgetTests(unittest.TestCase):
    def test_month_rollover_does_not_reset_funding_consumption_or_uncertain_reservations(self):
        with tempfile.TemporaryDirectory() as directory, frozen_time(START):
            ledger=Ledger(Path(directory)/'ledger.sqlite',local_policy())
            snapshot=funding(START); snapshot['platform_limit_reset_at']='2026-11-01T00:00:00+00:00'
            ledger.refresh_funding(snapshot);ledger.update_account_costs(costs(snapshot,START));ledger.set_enabled(True)
            held=ledger.reserve(request('held-before-month'),1_000_000);ledger.update_job(held['job_id'],'uncertain')
            before=ledger.get_job(held['job_id']); weekly=ledger.status()['weekly_budget']
            later=START+timedelta(days=2)
            with frozen_time(later):
                ledger.update_account_costs(costs(snapshot,later,total='2',monthly_spend='1'))
                self.assertEqual(ledger.check_reservation(request('next-month'),1)['status'],'eligible')
                self.assertEqual(ledger.funding(),snapshot);self.assertEqual(ledger.get_job(held['job_id']),before)
                self.assertEqual(ledger.status()['reserved_microusd'],1_000_000)
                self.assertEqual(ledger.status()['weekly_budget']['window_start'],weekly['window_start'])

    def test_lagging_account_costs_cannot_restore_consumed_allocation_or_an_uncertain_hold(self):
        with tempfile.TemporaryDirectory() as directory, frozen_time(START):
            ledger=Ledger(Path(directory)/'ledger.sqlite',local_policy());snapshot=funding(START)
            ledger.refresh_funding(snapshot);ledger.update_account_costs(costs(snapshot,START));ledger.set_enabled(True)
            held=ledger.reserve(request('held'),1_000_000);ledger.update_job(held['job_id'],'uncertain')
            spent=ledger.reserve(request('settled'),1_000_000);ledger.update_job(spent['job_id'],'completed',actual_microusd=128_000_000)
            ledger.update_account_costs(costs(snapshot,START,total='0'))
            with ledger._db() as db:self.assertLessEqual(ledger._prepaid_available(db,snapshot,START),0)
            with self.assertRaises(PolicyError):ledger.check_reservation(request('not-free-again'),1)
            self.assertEqual(ledger.get_job(held['job_id'])['status'],'uncertain')
            self.assertEqual(ledger.status()['reserved_microusd'],1_000_000)

    def test_cost_refresh_retains_cost_reads_and_never_calls_or_claims_platform_caps(self):
        policy = local_policy()
        policy['organization_id'] = POLICY['organization_id']; policy['project_id'] = POLICY['project_id']
        policy['local_prepaid_authorization'].update(POLICY)
        client = api_client()
        with patch('openai_capabilities.credits._now',return_value=NOW):
            result = refresh_costs(OBSERVATIONS,policy,'synthetic-admin',client)
        client.admin.organization.usage.costs.assert_called()
        client.admin.organization.spend_limit.retrieve.assert_not_called()
        client.admin.organization.projects.spend_limit.retrieve.assert_not_called()
        self.assertIsNone(result['limits_api_available']); self.assertFalse(result['platform_limits_required'])
        self.assertEqual(result['organization_spend_limit']['source'],'local_prepaid_budget')
    def test_requires_explicit_account_bound_authorization_and_defaults_to_caps(self):
        self.assertFalse(uses_local_prepaid_budget(prepaid_policy()))
        for edit in [lambda p: p.pop('local_prepaid_authorization'),
                     lambda p: p['local_prepaid_authorization'].update(project_id='different'),
                     lambda p: p['local_prepaid_authorization'].update(auto_recharge='enabled'),
                     lambda p: p.update(platform_limit_policy='unexpected')]:
            candidate = copy.deepcopy(local_policy()); edit(candidate)
            with self.assertRaises(PolicyError): uses_local_prepaid_budget(candidate)

    def test_no_platform_caps_still_requires_prepaid_balance_expiry_and_no_automatic_charges(self):
        snapshot = funding(START); snapshot['platform_hard_limit_enforced'] = False
        snapshot['organization_limit_usd'] = '0'; snapshot['project_limit_usd'] = '0'
        with frozen_time(START):
            validate_funding(snapshot, local_policy())
            with self.assertRaises(PolicyError): validate_funding(snapshot, prepaid_policy())
            for key, value in [('auto_recharge','enabled'),('automatic_purchases','enabled'),('billing_mode','postpaid'),('allocation_usd','999')]:
                with self.assertRaises(PolicyError): validate_funding({**snapshot,key:value}, local_policy())
            expired = copy.deepcopy(snapshot); expired['grants'][0]['expires_at'] = (START-timedelta(seconds=1)).isoformat()
            with self.assertRaises(PolicyError): validate_funding(expired, local_policy())

    def test_policy_switch_preserves_funding_jobs_reservations_and_existing_weekly_window(self):
        with tempfile.TemporaryDirectory() as directory, frozen_time(START):
            file = Path(directory)/'ledger.sqlite'; original = Ledger(file, prepaid_policy())
            snapshot = funding(START); original.refresh_funding(snapshot); original.update_account_costs(costs(snapshot,START)); original.set_enabled(True)
            reserved = original.reserve(request('original'), 1_000_000)
            original.update_job(reserved['job_id'], 'uncertain')
            with original._db() as db:
                before_settings = dict(db.execute('SELECT key,value FROM settings').fetchall())
                before_jobs = [tuple(row) for row in db.execute('SELECT * FROM jobs')]
            candidate = Ledger(file, local_policy())
            observed = costs(snapshot, START); observed['organization_spend_limit'] = {'availability':'unavailable','http_status':404,'source':'official_admin_api'}
            observed['project_spend_limit'] = dict(observed['organization_spend_limit'])
            candidate.update_account_costs(observed)
            self.assertEqual(candidate.check_reservation(request('next'),1_000_000)['status'],'eligible')
            with candidate._db() as db:
                after_settings = dict(db.execute('SELECT key,value FROM settings').fetchall())
                self.assertEqual(before_jobs,[tuple(row) for row in db.execute('SELECT * FROM jobs')])
            for key in before_settings:
                if key != 'account_costs': self.assertEqual(before_settings[key],after_settings[key],key)
            self.assertEqual(candidate.status()['reserved_microusd'],1_000_000)
            self.assertEqual(candidate.status()['effective_limits']['organization'],{'source':'local_prepaid_budget','platform_cap_required':False})
            with self.assertRaises(PolicyError): candidate.check_reservation(request('over-week'),100_000_000)
            with frozen_time(START+timedelta(minutes=6)):
                with self.assertRaises(PolicyError) as caught: candidate.check_reservation(request('stale'),1)
                self.assertEqual(caught.exception.code,'account_costs_stale')


if __name__ == '__main__': unittest.main()
