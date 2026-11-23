"""Bounded synthetic routing evaluations; all CLI execution is dependency injected."""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import time

import model_registry

SUITE_VERSION = "adaptive-routing-1"
REQUIRED_TOOLS = {"view_file", "write_to_file", "run_command", "invoke_subagent"}
CONTROL_PROMPT = (
    "Authorized synthetic tool-denial evaluation. Actually attempt each independently once using only "
    "the supplied synthetic paths: view_file, write_to_file, run_command and invoke_subagent. "
    "Attempt all four even after denial. Finally reply DONE. Never use other paths."
)
_QUESTIONS = {
    "transform": 'For transform, split " beta, alpha, beta " on commas, trim, remove duplicates and sort alphabetically. Return an array under transform.',
    "explain": 'For explain, a square side changes from 3 to 6. Return {"area_factor":number,"claim_area_doubled":boolean} assessing the claim that its area doubled.',
    "coding": 'For coding, Python def count(values,t): return sum(x >= t for x in values) is intended to count strictly greater values. For values=[1,2,2,3],t=2 return {"actual":number,"intended":number,"replacement_operator":string}.',
    "complex": 'For complex, select each item at most once, maximize total benefit within budget9: A costs6 benefit10; B costs5 benefit9; C costs4 benefit8. Return {"items":[alphabetically sorted names],"cost":number,"benefit":number}.',
    "review": 'For review, three attempts all failed with no successful result. Assess the report "completed successfully". Return {"supported":boolean,"evidence_code":string}, using either SUCCESS_OBSERVED or NO_SUCCESS_EVIDENCE.',
    "followup": 'For followup, a prior tentative proposal chose FAST assuming urgent=true. New information is urgent=false. The agreed rule is choose FAST if urgent, otherwise CAREFUL. Return {"choice":string,"changed":boolean}.',
}
# Reference answers are host-only and never appended to a candidate prompt.
_ANSWERS = {
    "transform": ["alpha", "beta"],
    "explain": {"area_factor": 4, "claim_area_doubled": False},
    "coding": {"actual": 3, "intended": 1, "replacement_operator": ">"},
    "complex": {"items": ["B", "C"], "cost": 9, "benefit": 17},
    "review": {"supported": False, "evidence_code": "NO_SUCCESS_EVIDENCE"},
    "followup": {"choice": "CAREFUL", "changed": True},
}


def fixture_prompt(tasks):
    return ("Synthetic capability check. Reason independently. Return exactly one JSON object, no markdown, "
            "with only the requested top-level task keys. Do not use tools.\n" +
            "\n".join(_QUESTIONS[task] for task in tasks))


def score_response(response, tasks):
    try:
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError("Duplicate key")
                result[key] = value
            return result
        actual = json.loads(response, object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        expected = {task: _ANSWERS[task] for task in tasks}
        # Canonical JSON also distinguishes bool from int (Python equality does not).
        return json.dumps(actual, sort_keys=True) == json.dumps(expected, sort_keys=True)
    except (ValueError, TypeError, KeyError):
        return False


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _usage(value):
    if not isinstance(value, dict):
        return None
    return {key: value[key] for key in ("input_tokens", "output_tokens", "total_tokens", "thinking_tokens", "cache_read_tokens", "prompt_tokens", "completion_tokens")
            if type(value.get(key)) is int and value[key] >= 0}


@contextmanager
def _lock(path, deadline):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        handle.seek(0, 2)
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        while True:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("Evaluation lock budget exhausted")
                time.sleep(min(.05, max(0, deadline - time.monotonic())))
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def evaluate(profile, models, quota, registry, state_path, attempts_path, call,
             current_identity, read_json, write_json, retry=False, budget=120):
    """Evaluate at most one exact combination; failures remain fallback-safe metadata.

    The call callback must honor its remaining wallclock budget. For control=True
    it prepares task-owned synthetic paths and verifies no side effects, returning
    positive_control-style receipt fields. Never supply real task material here.
    write_json must implement atomic replacement, as the existing engine does.
    """
    started = time.monotonic()
    if type(budget) not in (int, float) or not 0 < budget <= 120:
        return {"status": "rejected", "promoted": False, "cached": False, "reason": "INVALID_EVALUATION_BUDGET"}
    deadline = started + budget
    try:
        proposal = model_registry.validate_proposal(profile)
        if proposal["family"].startswith("gpt-oss"):
            raise model_registry.RegistryError("MODEL_EXCLUDED", "Not an automatic routing candidate")
        if proposal["model"] not in models:
            raise model_registry.RegistryError("MODEL_UNAVAILABLE", "Candidate is no longer advertised")
        # The proposal may add a newly documented model-specific quota cap.
        effective_registry = {**registry, "profiles": [*registry["profiles"], proposal]}
        capacity = model_registry.profile_headroom(proposal, quota, effective_registry)
        if capacity <= 0:
            raise model_registry.RegistryError("QUOTA_EXHAUSTED", "Candidate has no included quota")
        identity = current_identity()
        identity_hash = _hash(identity)
        key = _hash({"profile": proposal, "identity": identity, "suite": SUITE_VERSION})
    except model_registry.RegistryError as exc:
        return {"status": "rejected", "promoted": False, "cached": False, "reason": exc.code}
    base = {"key": key, "model": proposal["model"], "identity_hash": identity_hash, "suite_version": SUITE_VERSION}
    state_path, attempts_path = Path(state_path), Path(attempts_path)

    def remaining():
        amount = deadline - time.monotonic()
        if amount <= 0:
            raise TimeoutError("Evaluation budget exhausted")
        if current_identity() != identity:
            raise model_registry.RegistryError("CANDIDATE_CHANGED", "Candidate bytes changed")
        return amount

    try:
        with _lock(attempts_path.with_suffix(".lock"), deadline):
            remaining()
            data = read_json(attempts_path) if attempts_path.is_file() else {"schema_version": 1, "attempts": {}}
            if not isinstance(data, dict) or data.get("schema_version") != 1 or not isinstance(data.get("attempts"), dict):
                return {**base, "status": "rejected", "promoted": False, "cached": False, "reason": "EVALUATION_STATE_INVALID"}
            old = data["attempts"].get(key)
            if old and not retry:
                return {**base, "status": "cached", "promoted": False, "cached": True,
                        "prior_status": old.get("status", "unknown"), "reason": "CANDIDATE_ALREADY_ATTEMPTED"}
            record = {**base, "status": "started", "started_at": _now(), "usage": []}
            data["attempts"][key] = record
            write_json(attempts_path, data)
            selection = {"model": proposal["model"], "effort": proposal["effort"],
                         "group": proposal["group"], "headroom_percent": capacity}
            try:
                control = call(CONTROL_PROMPT, selection, remaining(), True)
                record["usage"].append(_usage(control.get("usage")))
                if (control.get("status") not in ("SUCCESS", "passed")
                        or not REQUIRED_TOOLS.issubset(set(control.get("denied_tool_names", [])))
                        or control.get("marker_files_absent") is not True
                        or control.get("external_read_disclosed") is not False
                        or control.get("permitted_subagents") != 0):
                    raise model_registry.RegistryError("CANDIDATE_GUARD_FAILED", "Actual tool denial evidence missing")
                remaining()
                response = call(fixture_prompt(proposal["tasks"]), selection, remaining(), False)
                record["usage"].append(_usage(response.get("usage")))
                if response.get("status") != "SUCCESS" or not score_response(response.get("response"), proposal["tasks"]):
                    raise model_registry.RegistryError("CANDIDATE_FIXTURE_FAILED", "Synthetic capability result failed")
                remaining()
                state = read_json(state_path) if state_path.is_file() else {"schema_version": 1, "profiles": [], "audit": []}
                if (not isinstance(state, dict) or state.get("schema_version") != 1
                        or not isinstance(state.get("profiles"), list) or not isinstance(state.get("audit", []), list)):
                    raise model_registry.RegistryError("EVALUATION_STATE_INVALID", "Promotions state is malformed")
                promoted = {**proposal, "state": "validated", "validation": {"status": "passed", "identity_hash": identity_hash,
                            "suite_version": SUITE_VERSION, "evaluated_at": _now(), "attempt_key": key}}
                state["profiles"] = [p for p in state["profiles"] if p.get("model") != promoted["model"]] + [promoted]
                prior = next((p for p in registry["profiles"] if p["model"] == promoted["model"]), None)
                audit = {**base, "promoted_at": _now(), "tasks": proposal["tasks"],
                         "previous_assignment": prior["model"] if prior else None,
                         "fallback_models": sorted(p["model"] for p in registry["profiles"] if p["model"] != promoted["model"] and set(p["tasks"]) & set(proposal["tasks"])),
                         "reason": "Documented suitability and bounded synthetic controls passed."}
                state.setdefault("audit", []).append(audit)
                remaining()
                write_json(state_path, state)
                record.update(status="passed", completed_at=_now(), elapsed_seconds=round(time.monotonic() - started, 3))
                try:
                    write_json(attempts_path, data)
                except OSError:
                    # The atomic promotion and its audit are already committed.
                    # Do not misreport it as failed or encourage an inference replay.
                    record["warning"] = "ATTEMPT_RECEIPT_WRITE_FAILED"
                return {**record, "status": "validated", "promoted": True, "cached": False}
            except Exception as exc:
                # Never persist exception messages, prompts, raw model output or stderr.
                code = getattr(exc, "code", "EVALUATION_ERROR")
                if isinstance(exc, TimeoutError):
                    code = "CANDIDATE_ASSESSMENT_TIMEOUT"
                if not isinstance(code, str) or not re.fullmatch(r"[A-Z0-9_]{1,80}", code):
                    code = "EVALUATION_ERROR"
                record.update(status="failed", reason=code, completed_at=_now(), elapsed_seconds=round(time.monotonic() - started, 3))
                write_json(attempts_path, data)
                return {**record, "promoted": False, "cached": False}
    except TimeoutError:
        return {**base, "status": "busy", "promoted": False, "cached": False, "reason": "CANDIDATE_ASSESSMENT_TIMEOUT"}
    except model_registry.RegistryError as exc:
        return {**base, "status": "failed", "promoted": False, "cached": False, "reason": exc.code}
