from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import unittest

from openai_capabilities.ledger import Ledger
from openai_capabilities.policy import PolicyError
from tests.test_weekly_budget import START, frozen_time, prepaid_policy, funding, costs, request


class SyncCapacityTests(unittest.TestCase):
    def test_configured_four_is_atomic_across_connections_and_retains_unknowns_and_budget(self):
        with tempfile.TemporaryDirectory() as directory, frozen_time(START):
            file=Path(directory)/'ledger.sqlite'; policy={**prepaid_policy(),'max_sync_jobs':4}
            ledger=Ledger(file,policy);snapshot=funding(START)
            ledger.refresh_funding(snapshot);ledger.update_account_costs(costs(snapshot,START));ledger.set_enabled(True)
            original=ledger.reserve(request('original'),1_000_000);ledger.update_job(original['job_id'],'uncertain')
            old=ledger.get_job(original['job_id']);weekly=ledger.status()['weekly_budget']['weekly_limit_usd']
            def reserve(index):
                connection=Ledger(file,policy)
                try:return connection.reserve(request('parallel-'+str(index)),1_000_000)
                except PolicyError as error:return error.code
            with ThreadPoolExecutor(max_workers=6) as pool:results=list(pool.map(reserve,range(6)))
            self.assertEqual(sum(isinstance(result,dict) for result in results),4)
            self.assertEqual(results.count('sync_slot_busy'),2)
            self.assertEqual(ledger.status()['sync_concurrency_limit'],4)
            self.assertEqual(ledger.status()['reserved_microusd'],5_000_000)
            self.assertEqual(ledger.get_job(original['job_id']),old)
            self.assertEqual(ledger.status()['weekly_budget']['weekly_limit_usd'],weekly)

    def test_default_one_and_invalid_capacity_remain_conservative(self):
        with tempfile.TemporaryDirectory() as directory, frozen_time(START):
            file=Path(directory)/'ledger.sqlite'; ledger=Ledger(file,prepaid_policy());snapshot=funding(START)
            ledger.refresh_funding(snapshot);ledger.update_account_costs(costs(snapshot,START));ledger.set_enabled(True)
            ledger.reserve(request('first'),1)
            with self.assertRaises(PolicyError) as caught:ledger.reserve(request('second'),1)
            self.assertEqual(caught.exception.code,'sync_slot_busy')
            for value in [0,9,2.5,True,'4',None]:
                with self.assertRaises(PolicyError):Ledger(file,{**prepaid_policy(),'max_sync_jobs':value}).sync_job_limit()


if __name__=='__main__':unittest.main()
