"""Opaque execution provenance only; never a credential or admission grant."""
import hashlib
from importlib.metadata import version, PackageNotFoundError
import json
import os
from pathlib import Path
import re
import sys

SCHEMA = 'original-helper-execution-context/1'
SDK_CONTRACT_VERSION = 'official-openai-tool-free/1'
API_BASE = 'https://api.openai.com/v1'

def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()

def execution_context(organization, project, *, root=None, executable=None, sdk_version=None, api_base=API_BASE):
    # Only explicit SDK destinations participate. No key, environment credential,
    # funding snapshot, budget, model response or current timestamp is read.
    if api_base != API_BASE or any(type(value) is not str or re.fullmatch(r'[A-Za-z0-9_-]{1,200}', value) is None
                                   for value in (organization, project)):
        return None
    try:
        selected_version = version('openai') if sdk_version is None else sdk_version
        if type(selected_version) is not str or re.fullmatch(r'[A-Za-z0-9.+_-]{1,80}', selected_version) is None:
            return None
        selected_root = os.path.normcase(str(Path(root or Path(__file__).resolve().parent.parent).resolve()))
        selected_python = os.path.normcase(str(Path(executable or sys.executable).resolve()))
    except (OSError, ValueError, PackageNotFoundError):
        return None
    scope = _digest([SCHEMA, selected_root, selected_python, organization, project, API_BASE])
    return {'schema': SCHEMA, 'scope_sha256': scope,
            'configuration_sha256': _digest([SDK_CONTRACT_VERSION, scope, selected_version])}

def recorded_execution_context(metadata):
    # A saved old job cannot acquire today's account/configuration identity.
    if type(metadata) is not dict:
        return {}
    value = metadata.get('execution_context')
    if type(value) is not dict or set(value) != {'schema', 'scope_sha256', 'configuration_sha256'} or value.get('schema') != SCHEMA:
        return {}
    if any(type(value.get(key)) is not str or re.fullmatch(r'[a-f0-9]{64}', value[key]) is None
           for key in ('scope_sha256', 'configuration_sha256')):
        return {}
    return {'execution_context': dict(value)}
