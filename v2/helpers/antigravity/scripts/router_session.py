"""Opt-in durable conversation binding for the guarded official helper.

This module does not invoke a provider, grant tools, alter acceptance, or retry.
The existing helper remains responsible for all acceptance/quota/guard checks.
"""
from __future__ import annotations
import hashlib
import json
import os
import re
from pathlib import Path
import time
import uuid
import threading

SESSION_CONTINUATION_POLICY = 'coordinator-admitted-no-local-turn-ceiling/1'
SESSION_PERSISTENCE_POLICY = 'router-session-durable-progress/2'
# Operational buffering bounds, never generation/continuation allowances.
PROGRESS_BATCH_EVENTS = 32
PROGRESS_BATCH_BYTES = 65536
PROGRESS_FLUSH_SECONDS = 0.25

def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def _write(path, value):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with temporary.open('x', encoding='utf-8') as f:
        json.dump(value, f, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temporary, path)

def validate_arguments(args):
    values = [args.router_session_state, args.router_attempt_id, args.router_scope]
    if any(values) or args.conversation_id:
        if not all(values) or args.action != 'run':
            raise ValueError('ROUTER_ARGUMENTS_INCOMPLETE')
        if args.tool_profile or args.capability_profile or args.output_contract:
            raise ValueError('ROUTER_REASONING_ONLY')
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', args.router_attempt_id):
            raise ValueError('ROUTER_ATTEMPT_ID_INVALID')
        if args.conversation_id:
            uuid.UUID(args.conversation_id)

class Session:
    def __init__(self, path, attempt, scope, conversation, identity, selection, prompt):
        self.path = Path(path).absolute()
        if not self.path.parent.is_dir():
            raise ValueError('ROUTER_STATE_PARENT_MISSING')
        for part in [self.path, *self.path.parents]:
            if part.is_symlink() or (hasattr(part, 'is_junction') and part.is_junction()):
                raise ValueError('ROUTER_STATE_REPARSE_POINT')
        if str(self.path).startswith('\\\\'):
            raise ValueError('ROUTER_STATE_NETWORK_PATH')
        self.events = self.path.with_suffix(self.path.suffix + '.events.jsonl')
        self.attempt = attempt
        self.conversation = conversation
        self.binding = {'scope': scope, 'identity': identity, 'model': selection['model'], 'effort': selection['effort']}
        self.payload_hash = _hash({'prompt': prompt, 'binding': self.binding})
        self.lock = None
        self.sequence = 0
        self.previous_hash = None
        self.state = None
        self.replayed = None
        self.qualification_control = None
        self.control_initialized = False
        self.after_complete = None
        self.completed_committed = False
        self.pending = []
        self.pending_bytes = 0
        self.event_bytes = 0
        self.progress_seen = False
        self.mutex = threading.RLock()
        self.timer = None
        self.flush_error = None

    def __enter__(self):
        self.lock = open(str(self.path) + '.lock', 'a+b')
        self.lock.seek(0)
        if os.name == 'nt':
            import msvcrt
            if os.fstat(self.lock.fileno()).st_size == 0:
                self.lock.write(b'0'); self.lock.flush()
            self.lock.seek(0)
            try: msvcrt.locking(self.lock.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                self.lock.close(); self.lock = None
                raise ValueError('ROUTER_SESSION_BUSY')
        else:
            import fcntl
            try: fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                self.lock.close(); self.lock = None
                raise ValueError('ROUTER_SESSION_BUSY')
        try:
            if self.events.exists():
                raw = self.events.read_bytes()
                if raw and not raw.endswith(b'\n'):
                    raise ValueError('ROUTER_EVENT_CHAIN_INCOMPLETE')
                self.event_bytes = len(raw)
                for line in raw.decode('utf-8').splitlines():
                    event = json.loads(line)
                    event_hash = event.pop('hash')
                    if event['sequence'] != self.sequence + 1 or event['previous_hash'] != self.previous_hash or event_hash != _hash(event):
                        raise ValueError('ROUTER_EVENT_CHAIN_INVALID')
                    self.sequence += 1; self.previous_hash = event_hash
            if self.path.exists():
                self.state = json.loads(self.path.read_text('utf-8'))
                if self.state.get('version') not in (1, 2):
                    raise ValueError('ROUTER_STATE_VERSION_UNSUPPORTED')
                if self.state['sequence'] != self.sequence or self.state['event_hash'] != self.previous_hash:
                    raise ValueError('ROUTER_STATE_EVENT_MISMATCH')
                if self.state.get('version') == 2 and self.state.get('event_bytes') != self.event_bytes:
                    raise ValueError('ROUTER_STATE_EVENT_MISMATCH')
                if self.state['binding'] != self.binding:
                    raise ValueError('ROUTER_BINDING_CHANGED')
                previous = self.state['attempts'].get(self.attempt)
                if previous:
                    if self.conversation and self.state.get('conversation_id') != self.conversation:
                        raise ValueError('ROUTER_EXACT_SESSION_REQUIRED')
                    if previous['payload_hash'] != self.payload_hash:
                        raise ValueError('ROUTER_IDEMPOTENCY_CONFLICT')
                    if previous.get('receipt'):
                        self.replayed = previous['receipt']; return self
                    if previous.get('receipt_ref'):
                        self.replayed = self.read_receipt(previous['receipt_ref']); return self
                    raise ValueError('ROUTER_OUTCOME_UNKNOWN_NO_REPLAY')
                if not self.conversation or self.state.get('conversation_id') != self.conversation:
                    raise ValueError('ROUTER_EXACT_SESSION_REQUIRED')
                if self.state['status'] != 'completed':
                    raise ValueError('ROUTER_OUTCOME_UNKNOWN_NO_REPLAY')
                # Every generating continuation remains coordinator-admitted.
                # Retained history is evidence, not a lifetime attempt allowance.
            else:
                if self.conversation or self.sequence:
                    raise ValueError('ROUTER_SESSION_NOT_OWNED')
                self.state = {'version': 2, 'binding': self.binding, 'conversation_id': None, 'attempts': {}}
            # Retain old embedded receipts verbatim. Newly completed attempts use
            # immutable files; no historical payload is discarded during upgrade.
            self.state['version'] = 2
            self.state['persistence_policy'] = SESSION_PERSISTENCE_POLICY
            self.state['status'] = 'intent'
            self.state['attempts'][self.attempt] = {'payload_hash': self.payload_hash}
            self.record('intent', {'conversation_id': self.conversation})
            return self
        except BaseException:
            self.__exit__(None, None, None); raise

    def record(self, kind, metadata, durable=True):
        with self.mutex:
            if self.flush_error:
                raise OSError('ROUTER_PROGRESS_PERSISTENCE_FAILED') from self.flush_error
            event = {'sequence': self.sequence + 1, 'previous_hash': self.previous_hash, 'attempt_id': self.attempt,
                     'time': time.time(), 'kind': kind, 'metadata': metadata}
            event['hash'] = _hash(event)
            encoded = (json.dumps(event, sort_keys=True) + '\n').encode('utf-8')
            self.pending.append(encoded); self.pending_bytes += len(encoded)
            self.sequence += 1; self.previous_hash = event['hash']
            if durable or len(self.pending) >= PROGRESS_BATCH_EVENTS or self.pending_bytes >= PROGRESS_BATCH_BYTES:
                self.flush_progress()
            elif self.timer is None:
                self.timer = threading.Timer(PROGRESS_FLUSH_SECONDS, self._timed_flush)
                self.timer.daemon = True; self.timer.start()

    def _timed_flush(self):
        with self.mutex:
            self.timer = None
            try: self.flush_progress()
            except BaseException as error: self.flush_error = error

    def flush_progress(self):
        with self.mutex:
            if self.flush_error:
                raise OSError('ROUTER_PROGRESS_PERSISTENCE_FAILED') from self.flush_error
            if self.timer is not None:
                self.timer.cancel(); self.timer = None
            if not self.pending:
                return
            # A crash between these two durable writes leaves a mismatched tail,
            # never a completed/replayable attempt. Readers publish only the
            # checkpoint watermark, not an appended but uncommitted terminal.
            try:
                with self.events.open('ab') as f:
                    f.write(b''.join(self.pending)); f.flush(); os.fsync(f.fileno())
                self.event_bytes += self.pending_bytes
                self.state['sequence'] = self.sequence; self.state['event_hash'] = self.previous_hash
                self.state['event_bytes'] = self.event_bytes
                _write(self.path, self.state)
            except BaseException as error:
                self.flush_error = error
                raise
            self.pending.clear(); self.pending_bytes = 0

    def read_receipt(self, reference):
        expected = self.path.name + '.receipts/' + reference.get('sha256', '') + '.json'
        if reference.get('path') != expected or not re.fullmatch(r'[0-9a-f]{64}', reference.get('sha256', '')):
            raise ValueError('ROUTER_RECEIPT_REFERENCE_INVALID')
        file = self.path.parent / expected
        for part in (file, file.parent):
            if part.is_symlink() or (hasattr(part, 'is_junction') and part.is_junction()):
                raise ValueError('ROUTER_STATE_REPARSE_POINT')
        raw = file.read_bytes()
        if len(raw) != reference.get('bytes') or hashlib.sha256(raw).hexdigest() != reference['sha256']:
            raise ValueError('ROUTER_RECEIPT_CHANGED')
        receipt = json.loads(raw)
        receipt['router']['receipt_ref'] = reference
        return receipt

    def save_receipt(self, receipt):
        raw = json.dumps(receipt, sort_keys=True).encode('utf-8')
        digest = hashlib.sha256(raw).hexdigest()
        directory = self.path.with_name(self.path.name + '.receipts')
        if directory.is_symlink() or (hasattr(directory, 'is_junction') and directory.is_junction()):
            raise ValueError('ROUTER_STATE_REPARSE_POINT')
        directory.mkdir(exist_ok=True)
        file = directory / (digest + '.json')
        try:
            with file.open('xb') as f:
                f.write(raw); f.flush(); os.fsync(f.fileno())
        except FileExistsError:
            if file.read_bytes() != raw:
                raise ValueError('ROUTER_RECEIPT_CHANGED')
        return {'path': directory.name + '/' + file.name, 'sha256': digest, 'bytes': len(raw)}

    def started(self, pid):
        self.state['process_id'] = pid
        self.record('process_started', {'pid': pid})

    def event(self, event):
        # Metadata-only cursor, never chain-of-thought/prompt/tool payloads.
        metadata = {'event': event.get('event'), 'terminal': 'result' in event}
        if event.get('event') == 'init':
            reported = event.get('conversation_id')
            uuid.UUID(reported)
            if self.conversation and reported != self.conversation:
                raise ValueError('ROUTER_SESSION_MISMATCH')
            self.state['conversation_id'] = reported
            metadata['conversation_id'] = reported
        step = event.get('step_update')
        if isinstance(step,dict) and step.get('state') == 'DONE' and isinstance(step.get('usage'),dict):
            metadata.update({k:step.get(k) for k in ('conversation_id','step_index','step_type','usage')})
        if isinstance(event.get('result'),dict):
            metadata.update({k:event['result'].get(k) for k in ('conversation_id','usage','status')})
        # First progress remains immediately observable for owned cancellation.
        # Init/ack, usage, terminal, and non-progress protocol events are durable.
        ordinary = event.get('event') in ('step_update', 'text_delta') and not metadata['terminal'] and 'usage' not in metadata
        immediate = not ordinary or not self.progress_seen
        if ordinary: self.progress_seen = True
        self.record('provider_event', metadata, durable=immediate)

    def submitting(self, init):
        reported = init.get('conversation_id')
        if self.conversation and reported and self.conversation != reported:
            raise ValueError('ROUTER_SESSION_MISMATCH')
        if not self.state.get('conversation_id'):
            raise ValueError('ROUTER_INIT_SESSION_MISSING')
        if self.qualification_control is not None:
            import qualification_bridge
            profile = qualification_bridge.control_configuration(self)
            if (profile != self.qualification_control or init.get('agent') != profile['agent']
                    or not isinstance(init.get('tools'), list)
                    or not set(profile['required_tools']).issubset(set(init['tools']))):
                raise ValueError('ROUTER_CONTROL_INITIALIZATION_UNVERIFIED')
            self.control_initialized = True
            self.record('control_initialized', {'agent': init['agent'], 'required_tools': profile['required_tools'],
                'advertised_required_tools': True, 'permission_mode': init.get('permission_mode'), 'mode': profile['mode']})
        self.state['status'] = 'submission_started'
        self.record('submission_intent', {'model': init.get('model'), 'agent': init.get('agent')})

    def bind_qualification_control(self, profile):
        import qualification_bridge
        if (self.qualification_control is not None or profile != qualification_bridge.control_configuration(self)
                or self.state.get('status') != 'intent' or self.conversation is not None):
            raise ValueError('ROUTER_CONTROL_AUTHORITY_REQUIRED')
        self.qualification_control = profile
        self.record('control_configuration', profile)

    def complete(self, receipt):
        # A timer may checkpoint ordinary progress. It must never observe the
        # in-memory completed status before its terminal record is committed.
        with self.mutex:
            return self._complete(receipt)

    def _complete(self, receipt):
        conversation = receipt.get('conversation_id')
        uuid.UUID(conversation)
        if (self.conversation and conversation != self.conversation) or (self.state.get('conversation_id') and conversation != self.state['conversation_id']):
            raise ValueError('ROUTER_SESSION_MISMATCH')
        if receipt.get('status') != 'SUCCESS' or not receipt.get('terminal_received'):
            raise ValueError('ROUTER_TERMINAL_UNVERIFIED')
        if receipt.get('guard') != 'deny-all' or receipt.get('permitted_tools') != []:
            raise ValueError('ROUTER_GUARD_VIOLATION')
        audit = receipt.get('tool_audit')
        if self.qualification_control is None:
            if audit:
                raise ValueError('ROUTER_GUARD_VIOLATION')
        else:
            import qualification_bridge
            profile = qualification_bridge.control_configuration(self)
            if (profile != self.qualification_control or not self.control_initialized
                    or receipt.get('qualification_control') != profile or receipt.get('execution_mode') != 'default'
                    or receipt.get('reported_agent') != profile['agent']
                    or not set(profile['required_tools']).issubset(set(receipt.get('tools', [])))):
                raise ValueError('ROUTER_CONTROL_RECEIPT_UNVERIFIED')
            # Empty audit remains a retained native completion whose independent
            # control check FAILS. Only the exact four real deny receipts may be
            # retained as a nonempty audit; no allow/unknown tool is permitted.
            if not isinstance(audit, list) or (audit and (len(audit) != 4
                    or {row.get('tool_name') for row in audit} != set(profile['required_tools'])
                    or any(row.get('decision') != 'deny' for row in audit))):
                raise ValueError('ROUTER_CONTROL_GUARD_VIOLATION')
        self.state['conversation_id'] = conversation
        # Official headless protocol: result.usage is cumulative, step_update.usage is per-step.
        # https://antigravity.google/docs/cli/headless/#read-the-results
        usage = receipt.get('usage')
        previous = self.state.get('previous_observed_usage')
        delta = {}
        if isinstance(usage,dict):
            for key,value in usage.items():
                baseline = previous.get(key) if isinstance(previous,dict) else 0
                if isinstance(value,(int,float)) and not isinstance(value,bool) and isinstance(baseline,(int,float)) and not isinstance(baseline,bool):
                    if value < baseline or value < 0:
                        raise ValueError('ROUTER_USAGE_COUNTER_REGRESSION')
                    delta[key] = value - baseline
        self.state['last_observed_usage'] = receipt.get('usage')
        receipt['router'] = {'attempt_id': self.attempt, 'session_id': conversation,
            'usage_semantics': 'cumulative' if isinstance(usage,dict) else 'unknown', 'native_cumulative_usage': usage,
            'prior_observed_usage': previous, 'known_usage_delta': delta,
            'usage_semantics_source': 'https://antigravity.google/docs/cli/headless/#read-the-results', 'event_cursor': self.sequence + 1}
        self.state['previous_observed_usage'] = receipt.get('usage')
        reference = self.save_receipt(receipt)
        self.state['attempts'][self.attempt]['receipt_ref'] = reference
        self.state['status'] = 'completed'
        self.record('terminal', {'session_id': conversation, 'usage': receipt.get('usage'), 'receipt_ref': reference})
        self.completed_committed = True
        receipt['router']['receipt_ref'] = reference
        if self.after_complete is not None:
            self.after_complete(receipt)
        return receipt

    def __exit__(self, kind, error, trace):
        if self.lock:
            try:
                if error and self.state and not self.completed_committed and not self.flush_error:
                    self.state['status'] = 'outcome_unknown'
                    self.record('failure', {'error_type': type(error).__name__})
                else:
                    self.flush_progress()
            finally:
                with self.mutex:
                    if self.timer is not None:
                        self.timer.cancel(); self.timer = None
                if os.name == 'nt':
                    import msvcrt
                    self.lock.seek(0); msvcrt.locking(self.lock.fileno(), msvcrt.LK_UNLCK, 1)
                self.lock.close(); self.lock = None

def invoke(call, args, identity, prompt, selection, cwd, timeout, **kwargs):
    if not args.router_session_state:
        return call(prompt, selection, cwd, timeout, **kwargs)
    with Session(args.router_session_state, args.router_attempt_id, args.router_scope,
                 args.conversation_id, identity, selection, prompt) as session:
        if session.replayed:
            return session.replayed
        return session.complete(call(prompt, selection, cwd, timeout, router_session=session, **kwargs))
