"""Coexist with user-installed hooks without making the owned guard optional."""
import hashlib
import json
from pathlib import Path
import re

def verify(view, owned_rows, skill_root, profile):
    actual=[x for x in view.strip().splitlines() if x]
    if len(actual)!=len(set(actual)) or len(owned_rows)!=len(set(owned_rows)):
        raise ValueError('Duplicate loaded hook')
    if not set(owned_rows)<=set(actual):
        raise ValueError('Owned guard missing or changed')
    extras=sorted(set(actual)-set(owned_rows))
    if not extras:
        return []
    policy=json.loads((Path(skill_root)/'plugin-compatibility.json').read_text(encoding='utf-8-sig'))
    if not isinstance(policy,dict) or policy.get('schema')!=1:
        raise ValueError('Invalid plugin compatibility record')
    rows=policy.get('hook_rows')
    files=policy.get('hook_files')
    if (not isinstance(rows,list) or any(not isinstance(x,str) or len(x.split('\t'))!=6
        or x.startswith('codex-helper-') for x in rows) or not set(extras)<=set(rows)
        or not isinstance(files,dict) or not files):
        raise ValueError('Additional lifecycle hooks require review')
    # The current setup hook is harmless only on its missing-config branch:
    # it injects setup text rather than synchronizing host plugin/MCP state.
    configuration=policy.get('startup_configuration_must_be_absent')
    if configuration is not None:
        expected=Path(profile)/'.config/data-agent-kit/config.json'
        if Path(configuration)!=expected or expected.exists() or expected.is_symlink():
            raise ValueError('Configured startup maintenance requires separate effect review')
    root=Path(profile)/'.gemini/config/plugins'
    for name,expected in files.items():
        p=Path(name)
        if (not p.is_absolute() or '..' in p.parts or not p.is_relative_to(root)
            or not isinstance(expected,str) or not re.fullmatch(r'[0-9a-f]{64}',expected)):
            raise ValueError('Invalid plugin hook source')
        for item in (p,*p.parents):
            if item.is_symlink() or (hasattr(item,'is_junction') and item.is_junction()):
                raise ValueError('Linked plugin hook source')
        if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=expected:
            raise ValueError('Plugin hook changed; review before submission')
    return extras
