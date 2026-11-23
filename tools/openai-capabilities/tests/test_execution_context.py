import copy
import json
import unittest
from unittest.mock import patch
from openai_capabilities.execution_context import execution_context, recorded_execution_context
from openai_capabilities.adapters import SDKAdapter
from openai_capabilities.service import Service

def context(**changes):
    return execution_context(changes.pop('organization', 'org-synthetic'), changes.pop('project', 'proj_synthetic'),
        root=changes.pop('root', '.'), executable=changes.pop('executable', 'synthetic-python'),
        sdk_version=changes.pop('sdk_version', '1.2.3'), **changes)

class ExecutionContextTests(unittest.TestCase):
    def test_account_installation_and_sdk_configuration_are_distinct_without_private_values(self):
        original=context()
        for change in ({'organization':'org-other'},{'project':'proj_other'},{'root':'other-root'},{'executable':'other-python'}):
            self.assertNotEqual(context(**change)['scope_sha256'],original['scope_sha256'])
        changed=context(sdk_version='1.2.4')
        self.assertEqual(changed['scope_sha256'],original['scope_sha256'])
        self.assertNotEqual(changed['configuration_sha256'],original['configuration_sha256'])
        self.assertEqual(context(),original)
        for private in ('org-synthetic','proj_synthetic','synthetic-python'):
            self.assertNotIn(private,json.dumps(original))

    def test_missing_or_malformed_destinations_and_sdk_never_invent_context(self):
        for invalid in (None,True,1,{},[],'','org with spaces','org\nprivate'):
            self.assertIsNone(context(organization=invalid))
            self.assertIsNone(context(project=invalid))
        self.assertIsNone(context(api_base='https://unapproved.invalid/v1'))
        self.assertIsNone(context(sdk_version='private/version'))

    def test_lookup_preserves_only_recorded_context_and_never_backfills_legacy(self):
        recorded=context()
        job={'job_id':'synthetic','status':'completed','api_id':None,'artifact':None,'usage':None,'actual_microusd':None,
             'metadata':{'execution_context':recorded}}
        before=copy.deepcopy(job)
        self.assertEqual(Service._external_request_result(job)['execution_context'],recorded)
        self.assertEqual(job,before)
        for invalid in (None,True,'raw',[],{},dict(recorded,organization='PRIVATE'),dict(recorded,scope_sha256='bad')):
            job['metadata']={'execution_context':invalid}
            self.assertNotIn('execution_context',Service._external_request_result(job))
        job['metadata']={}
        self.assertNotIn('execution_context',Service._external_request_result(job))

    def test_injected_client_cannot_claim_official_adapter_execution(self):
        adapter=SDKAdapter('synthetic-key','org-synthetic','proj_synthetic',client=object())
        self.assertIsNone(adapter.execution_context)

    def test_submission_persists_adapter_context_before_the_request_runs(self):
        recorded=context();events=[]
        class Ledger:
            def reserve(self,request,amount):events.append(('reserved',amount));return {'job_id':'synthetic'}
            def update_job(self,job_id,status,metadata=None):events.append(('recorded',copy.deepcopy(metadata)))
        class Adapter:
            execution_context=recorded
            def call(self,request):
                self_context=events[-1][1]['execution_context']
                self.assertion=(self_context==recorded)
                events.append(('called',self.assertion));return {'status':'completed'}
        service=Service.__new__(Service);service.ledger=Ledger();service.prepare=lambda r:(r,1)
        service._submission_preflight=lambda:None;service._adapter=lambda _:Adapter()
        service._retry=lambda fn,**_:fn();service._complete=lambda *args:args[-1]
        self.assertEqual(service.invoke({'tier':'default','capability':'responses','model':'synthetic-model',
            'purpose':{'kind':'coding_assistance'},'payload':{'max_output_tokens':128}})['status'],'completed')
        self.assertEqual(events[0],('reserved',1));self.assertEqual(events[1][1]['execution_context'],recorded)
        self.assertEqual(events[2],('called',True))

    def test_official_constructor_context_uses_the_same_explicit_sdk_destination(self):
        with patch('openai.OpenAI') as constructor:
            adapter=SDKAdapter('synthetic-key','org-synthetic','proj_synthetic')
            try:
                self.assertEqual(constructor.call_args.kwargs['organization'],'org-synthetic')
                self.assertEqual(constructor.call_args.kwargs['project'],'proj_synthetic')
                self.assertEqual(constructor.call_args.kwargs['base_url'],'https://api.openai.com/v1')
                self.assertEqual(adapter.execution_context,execution_context('org-synthetic','proj_synthetic'))
            finally:
                constructor.call_args.kwargs['http_client'].close()
                adapter.close()

    def test_provider_result_cannot_replace_saved_execution_context_or_missing_accounting(self):
        recorded=context()
        class Ledger:
            def __init__(self):self.job={'metadata':{'execution_context':recorded}}
            def update_job(self,_id,_status,metadata=None,**fields):
                self.job.update(fields);self.job['metadata'].update(metadata or {});return self.job
            def get_job(self,_id):return self.job
        service=Service.__new__(Service);service.ledger=Ledger();service._artifact=lambda *_:'synthetic-artifact'
        result=service._complete('synthetic',{},1,{'status':'completed','usage':None,'execution_context':context(project='proj_forged')})
        self.assertEqual(result['execution_context'],recorded)
        self.assertIsNone(result['cost_usd'])
        self.assertIn('reservation retained',result['next_action'])
        service.ledger.job['metadata']={}
        result=service._complete('synthetic',{},1,{'status':'completed','usage':None,'execution_context':recorded})
        self.assertNotIn('execution_context',result)

if __name__=='__main__':unittest.main()
