"""Policy-gated orchestration with durable admission before every submission."""
from __future__ import annotations

from datetime import datetime, timezone
from contextlib import contextmanager
import copy
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import time
import uuid

from .adapters import AdapterError, SDKAdapter, bounded_call, normalize_result, validate_payload, reported_configuration
from .ledger import Ledger
from .execution_context import execution_context, recorded_execution_context
from .credentials import load_credential
from .policy import (PolicyError, estimate, external_request_id_sha256, microusd_to_usd,
                     reconcile_cost, timestamp, usage_priority, validate_funding, validate_request)


PACKAGE_ROOT = Path(__file__).resolve().parent.parent
PROJECT_ROOT = PACKAGE_ROOT.parent.parent


class LocalDeadlineBeforeSubmission(AdapterError):
    """Only code before the first adapter call may classify this as no-submit."""
    def __init__(self):
        super().__init__("local_deadline_before_submission", "Local execution budget exhausted before submission.",
                         failure_class="local_deadline")


def local_submission_deadline(value):
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z", value):
        raise PolicyError("invalid_local_deadline", "Use canonical UTC with millisecond precision.")
    try:
        stamp = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    except ValueError:
        raise PolicyError("invalid_local_deadline", "Use a valid canonical UTC date.") from None
    # Best-effort headroom for terminal persistence/draining, not a disk/host guarantee.
    return time.monotonic() + (stamp - datetime.now(timezone.utc)).total_seconds() - 2


def require_local_budget(deadline):
    if deadline is not None and time.monotonic() >= deadline:
        raise LocalDeadlineBeforeSubmission()


@contextmanager
def account_cost_refresh_lock(state_dir, timeout=90):
    """Serialize metadata fetch/publication across helper processes, not inference.

    OS ownership is released on process exit. Never take over a lock using a PID
    or age heuristic; a timeout blocks admission without touching reservations.
    """
    path = Path(state_dir) / "account-cost-refresh.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        if path.stat().st_size == 0:
            handle.write(b"\0")
            handle.flush()
        deadline = time.monotonic() + timeout
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
            except OSError as exc:
                if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    raise
                if time.monotonic() >= deadline:
                    raise PolicyError("account_cost_refresh_busy", "Accounting refresh is busy; no API request was submitted") from None
                time.sleep(min(0.05, max(0, deadline - time.monotonic())))
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def read_json(path):
    path = Path(path)
    if path.stat().st_size > 16 * 1024 * 1024:
        raise PolicyError("input_too_large", "JSON input exceeds the helper's 16 MiB limit")
    return json.loads(path.read_text(encoding="utf-8-sig"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def credential(policy, root=PROJECT_ROOT, *, admin=False, acl_checker=None):
    return load_credential(policy, root, admin=admin, acl_checker=acl_checker)


def _scrub(value, key=None):
    if isinstance(value, str):
        if key:
            value = value.replace(key, "[REDACTED]")
        return re.sub(r"\bsk-[A-Za-z0-9_-]{8,}", "[REDACTED]", value)
    if isinstance(value, list):
        return [_scrub(item, key) for item in value]
    if isinstance(value, dict):
        return {k: _scrub(v, key) for k, v in value.items()}
    return value


def request_metadata(request):
    """Only controls needed for pricing/recovery; never persist source input."""
    meta = {**{k: request[k] for k in ("capability", "model", "tier", "purpose")},
            "payload": {k: copy.deepcopy(v) for k, v in request["payload"].items()
                        if k in {"max_output_tokens", "prompt_cache_options", "dimensions", "text"}}}
    if request["capability"] == "responses" and request["payload"].get("tools"):
        meta["function_tools"] = [t["name"] for t in request["payload"]["tools"]]
    if "local_timeout_seconds" in request:
        meta["local_timeout_seconds"] = request["local_timeout_seconds"]
    if request["capability"] == "embeddings":
        inputs = request["payload"]["input"]
        meta["validation_input_count"] = 1 if isinstance(inputs, str) else len(inputs)
    return meta


class Service:
    def __init__(self, state_dir=None, policy=None, registry=None, adapter_factory=None, root=PROJECT_ROOT,
                 credential_loader=None, account_preflight=None):
        self.policy = copy.deepcopy(policy if policy is not None else read_json(PACKAGE_ROOT / "policy.json"))
        if self.policy.get("api_base_url", "https://api.openai.com/v1") != "https://api.openai.com/v1":
            raise PolicyError("destination_invalid", "Only the official OpenAI API destination is supported")
        if self.policy.get("funding_policy") != "existing_prepaid_only":
            raise PolicyError("funding_policy_invalid", "Configure existing prepaid credits with automatic purchases disabled")
        self.registry = copy.deepcopy(registry if registry is not None else read_json(PACKAGE_ROOT / "registry.json"))
        self.state_dir = Path(state_dir or PACKAGE_ROOT / ".local").resolve()
        self.root = Path(root)
        self.ledger = Ledger(self.state_dir / "usage.sqlite3", self.policy)
        self.adapter_factory = adapter_factory
        self.credential_loader = credential_loader or credential
        self.account_preflight = account_preflight

    def prepare(self, request):
        request = validate_request(request, self.registry)
        request.setdefault("local_timeout_seconds", self.policy.get("request_timeout_seconds", 30))
        validate_payload(request)
        if request["capability"] == "embeddings":
            inputs = request["payload"]["input"]
            inputs = [inputs] if isinstance(inputs, str) else inputs
            bound = self.registry["models"][request["model"]]["capabilities"]["embeddings"]["max_input_tokens_per_item"]
            if any(len(item.encode("utf-8")) > bound for item in inputs):
                raise PolicyError("embedding_item_too_large", "Conservative per-item token bound exceeds the registered embedding limit; split the input")
        amount = estimate(request, self.registry)
        if "allow_standard_fallback" in request and not isinstance(request["allow_standard_fallback"], bool):
            raise PolicyError("invalid_fallback", "allow_standard_fallback must be a boolean")
        if request.get("allow_standard_fallback"):
            if request["tier"] != "flex" or not self.policy.get("standard_fallback", False):
                raise PolicyError("fallback_not_allowed", "Standard fallback requires Flex and an enabled task policy")
            # Reserve the larger route before submitting, so a no-charge Flex
            # capacity rejection cannot turn into an unfunded Standard request.
            amount = max(amount, estimate({**request, "tier": "default"}, self.registry))
        return request, amount

    def dry_run(self, request, *, local_deadline_utc=None):
        deadline = local_submission_deadline(local_deadline_utc)
        request, amount = self.prepare(request)
        if deadline is not None and request["tier"] == "batch":
            raise PolicyError("batch_local_deadline_unsupported", "Local execution deadlines apply only to synchronous requests.")
        require_local_budget(deadline)
        try:
            reservation = self.ledger.check_reservation(request, amount)
        except PolicyError as exc:
            reservation = {"status": "blocked", "error_code": exc.code}
        return {"status": "dry_run", "capability": request["capability"], "model": request["model"],
                "tier": request["tier"], "reservation_usd": microusd_to_usd(amount), "api_calls": 0,
                "admission": self.status()["blockers"], "reservation_admission": reservation}

    def status(self):
        state = self.ledger.status()
        blockers = []
        try:
            self.ledger.validate_ready_funding()
        except PolicyError as exc:
            blockers.append({"code": exc.code, "message": str(exc)})
        try:
            self.credential_loader(self.policy, self.root)
            has_key = True
        except PolicyError as exc:
            has_key = False
            blockers.append({"code": exc.code, "message": str(exc)})
        try:
            self.credential_loader(self.policy, self.root, admin=True)
            has_admin = True
        except PolicyError as exc:
            has_admin = False
            blockers.append({"code": exc.code, "message": "Admin cost-preflight credential is unavailable: " + str(exc)})
        if not state["enabled"]:
            blockers.append({"code": "execution_disabled", "message": "New API submissions are disabled"})
        observations_path = self.state_dir / "credit-observations.json"
        observations = read_json(observations_path) if observations_path.is_file() else None
        return {"status": "ready" if not blockers else "blocked", "enabled": state["enabled"],
                "sync_concurrency_limit": state.get("sync_concurrency_limit", 1),
                **({key: state[key] for key in ('spending_mode', 'prepaid_available_usd')} if 'spending_mode' in state else {}),
                "credential_present": has_key, "admin_credential_present": has_admin,
                "account_cost_basis": state.get("account_cost_basis", "unverified"),
                "effective_limits": state.get("effective_limits", {}),
                "monthly_cycle": state.get("monthly_cycle", {}),
                "weekly_budget": state.get("weekly_budget"),
                "usage_priority": usage_priority(state["funding"]),
                "activation_consumed_usd": microusd_to_usd(state.get("activation_consumed_microusd", 0)),
                "organization_id": self.policy.get("organization_id"),
                "project_id": self.policy.get("project_id"), "blockers": blockers,
                **recorded_execution_context({"execution_context": execution_context(self.policy.get("organization_id"), self.policy.get("project_id"))}),
                "registry_verified_at": self.registry.get("verified_at"),
                "capabilities": {model: {cap: list(data["tiers"]) for cap, data in entry["capabilities"].items()}
                                 for model, entry in self.registry["models"].items()},
                "funding": state["funding"], "credit_observations": observations,
                "local_spent_usd": microusd_to_usd(state["spent_microusd"]),
                "local_reserved_usd": microusd_to_usd(state["reserved_microusd"]),
                "pending_jobs": state["pending_jobs"], "balance_is_estimate": True}

    @staticmethod
    def _external_request_result(job):
        if job is None:
            return {"status": "not_found"}
        metadata = job.get("metadata") or {}
        recorded_status = job["status"]
        unknown_before_receipt = recorded_status in {"reserved", "submitting"} and not job.get("api_id")
        status = "uncertain" if unknown_before_receipt else recorded_status
        usage = job.get("usage")
        safe_usage = None
        if isinstance(usage, dict):
            counters = ("prompt_tokens", "completion_tokens", "input_tokens", "output_tokens",
                        "total_tokens", "cached_tokens", "reasoning_tokens")
            safe_usage = {key: value for key, value in usage.items()
                          if key in counters and isinstance(value, int) and not isinstance(value, bool) and value >= 0}
            if not safe_usage:
                safe_usage = None
        error_code = metadata.get("error_code")
        if not isinstance(error_code, str) or re.fullmatch(r"[a-z0-9_]{1,64}", error_code) is None:
            error_code = None
        actual = job.get("actual_microusd")
        if actual is not None:
            next_action = None
        elif status == "uncertain":
            next_action = "Inspect the recorded remote outcome; the reservation remains held and this operation will not be resubmitted"
        else:
            next_action = "resume " + job["job_id"]
        # Read-only projection reuses the adapter's closed namespaces. A lookup
        # cannot recover missing diagnostics, resubmit work or release its hold.
        fields = ("failure_class", "exception_type", "transport_cause_type")
        diagnostic = AdapterError("lookup_diagnostics", "",
            **{key: metadata.get(key) if isinstance(metadata.get(key), str) else None for key in fields},
            http_status=metadata.get("http_status"))
        safe_diagnostics = {key: getattr(diagnostic, key) for key in (*fields, "http_status")
                            if getattr(diagnostic, key) is not None}
        if isinstance(metadata.get("failure_stage"), str) and metadata["failure_stage"] in {"sync_request", "batch_submission"}:
            safe_diagnostics["failure_stage"] = metadata["failure_stage"]
        return {"status": status, "recorded_status": recorded_status, "job_id": job["job_id"],
                "api_id": job.get("api_id"), "artifact": job.get("artifact"), "usage": safe_usage,
                "cost_usd": microusd_to_usd(actual) if actual is not None else None,
                "error_code": error_code, "next_action": next_action,
                **safe_diagnostics,
                **recorded_execution_context(metadata),
                **reported_configuration({"model": metadata.get("reported_model"),
                                          "reasoning": {"effort": metadata.get("selected_effort")}})}

    def lookup_external_request(self, external_request_id):
        job = self.ledger.lookup_external_request(external_request_id)
        return self._external_request_result(job)

    def enable(self):
        self.credential_loader(self.policy, self.root)
        validate_funding(self.ledger.funding(), self.policy, allow_platform_stale=True)
        self._account_refresh()
        self.ledger.validate_ready_funding()
        self.ledger.set_enabled(True)
        return self.status()

    def credits(self):
        from .credits import track_status
        observations = self.ledger.funding() or read_json(self.state_dir / "credit-observations.json")
        snapshot = self.state_dir / "account-costs.json"
        result = track_status(observations, self.ledger.status(), read_json(snapshot) if snapshot.is_file() else None)
        try:
            self.credential_loader(self.policy, self.root, admin=True)
            result["admin_credential_present"] = True
        except PolicyError:
            result["admin_credential_present"] = False
            result["account_refresh_blocker"] = "A separate designated Admin credential must be securely saved before refresh-costs"
        return result

    def refresh_costs(self, *, client=None):
        from .credits import refresh_costs
        with account_cost_refresh_lock(self.state_dir):
            key = self.credential_loader(self.policy, self.root, admin=True)
            observation = self.ledger.funding() or read_json(self.state_dir / "credit-observations.json")
            result = refresh_costs(observation, self.policy, key, client=client)
            if self.ledger.funding():
                self.ledger.update_account_costs(result)
            # Publish only a snapshot accepted by the ledger's regression guard.
            write_json(self.state_dir / "account-costs.json", result)
            return self.credits()

    def configure_limits(self, funding, *, apply=False, expected_sha256=None):
        from .account_setup import apply_limits, build_limits_plan, evidence_digest
        from .credits import refresh_costs
        key = self.credential_loader(self.policy, self.root, admin=True)
        account = refresh_costs(funding, self.policy, key)
        current = build_limits_plan(funding, account, self.policy)
        plan_path = self.state_dir / "limits-plan.json"
        manual_required = (not account.get("limits_api_available", True)
                           or self.policy.get("admin_account_access") == "read_only")
        if not apply or manual_required:
            write_json(self.state_dir / "account-costs.json", account)
            write_json(plan_path, current)
            return {"status": "manual_setup_required" if manual_required else "preview", "plan": str(plan_path),
                    "next_action": "Set the previewed organization and project limits once in Platform settings, enforce both, then confirm-limits" if manual_required else None,
                    **current}
        saved = read_json(plan_path)
        if (saved.get("funding_evidence_sha256") != evidence_digest(funding)
                or current["desired"] != saved.get("desired") or current["previous"] != saved.get("previous")):
            raise PolicyError("limits_plan_drift", "Account state changed; create and review a fresh limits preview")
        self.ledger.set_enabled(False)
        receipt = apply_limits(saved, expected_sha256, self.policy, key,
            checkpoint=lambda value: write_json(self.state_dir / "limits-receipt.json", value))
        latest = refresh_costs(funding, self.policy, key)
        write_json(self.state_dir / "account-costs.json", latest)
        self._record_funding(funding, account, latest, saved["allocation_usd"])
        return {**receipt, "funding_status": "recorded_disabled"}

    def _record_funding(self, funding, baseline, account, allocation, *, manual_limits=None, ui_evidence=None):
        now = datetime.now(timezone.utc)
        start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        reset = start.replace(year=start.year + 1, month=1) if start.month == 12 else start.replace(month=start.month + 1)
        recorded = {**funding, "allocation_usd": allocation, "platform_hard_limit_enforced": True,
            "platform_limit_reset_at": reset.isoformat(), "platform_reset_basis": "conservative UTC monthly boundary",
            "account_cost_baseline": {"window_start": baseline["window_start"], "observed_at": baseline["window_end"],
                                      "cost_total_usd": baseline["cost_total_usd"]}}
        if manual_limits is not None:
            recorded["limit_verification"] = {"source": "user_confirmation", "verified_at": now.isoformat()}
            if ui_evidence is not None:
                recorded["limit_verification"]["ui_evidence"] = ui_evidence
                recorded["limit_verification"]["api_status_interpretation"] = "configuration_verified_separately"
        for scope in ("organization", "project"):
            recorded[scope + "_limit_usd"] = str(manual_limits[scope]) if manual_limits is not None else account[scope + "_spend_limit"]["threshold_usd"]
            recorded[scope + "_spend_usd"] = account[scope + "_spend_usd"]
        self.ledger._validate_account_costs(account, recorded, now)
        self.ledger.refresh_funding(recorded)
        self.ledger.update_account_costs(account)

    def confirm_limits(self, funding, expected_sha256, organization_limit_usd, project_limit_usd, *, enforced=False, ui_evidence=None):
        from .account_setup import evidence_digest, plan_digest
        from .credits import refresh_costs
        from .policy import decimal_amount
        saved = read_json(self.state_dir / "limits-plan.json")
        if (not enforced or plan_digest(saved) != expected_sha256 or saved.get("sha256") != expected_sha256
                or saved.get("funding_evidence_sha256") != evidence_digest(funding)):
            raise PolicyError("limits_confirmation_invalid", "Confirm both enforced limits against the exact reviewed plan and funding evidence")
        reported = {"organization": decimal_amount(organization_limit_usd), "project": decimal_amount(project_limit_usd)}
        for scope, amount in reported.items():
            if amount * 100 != saved["desired"][scope]["threshold_amount"]:
                raise PolicyError("limits_confirmation_mismatch", "Reported limits differ from the reviewed values; refresh the preview")
        verified_images = None
        if ui_evidence is not None:
            if (ui_evidence.get("source") != "user_supplied_screenshots"
                    or any(ui_evidence.get(k) != self.policy[k] for k in ("organization_id", "project_id"))):
                raise PolicyError("limits_evidence_invalid", "Screenshot evidence must identify the selected account and project")
            verified_images = {}
            for scope, amount in reported.items():
                image = ui_evidence.get("limits", {}).get(scope, {})
                path = self.state_dir / image.get("path", "")
                if (not path.resolve().is_relative_to(self.state_dir / "evidence") or path.is_symlink()
                        or not path.is_file() or image.get("enforced") is not True
                        or decimal_amount(image.get("threshold_usd")) != amount
                        or hashlib.sha256(path.read_bytes()).hexdigest() != image.get("sha256")):
                    raise PolicyError("limits_evidence_invalid", "A required limit screenshot or its recorded content changed")
                verified_images[scope] = {"path": image["path"], "sha256": image["sha256"]}
        key = self.credential_loader(self.policy, self.root, admin=True)
        account = refresh_costs(funding, self.policy, key)
        allocation = decimal_amount(saved["allocation_usd"])
        for scope, amount in reported.items():
            api_limit = account[scope + "_spend_limit"]
            if api_limit.get("availability") != "unavailable":
                same_value = decimal_amount(api_limit["threshold_usd"]) == amount
                allowed_state = (api_limit.get("enforcement") == "enforcing" or
                                 (api_limit.get("enforcement") == "inactive" and verified_images is not None))
                if not same_value or not allowed_state:
                    raise PolicyError("limits_confirmation_mismatch", "Available API limit evidence contradicts the verified configuration")
            allocation = min(allocation, amount - decimal_amount(account[scope + "_spend_usd"]))
        if allocation <= 0:
            raise PolicyError("allocation_exhausted", "The confirmed caps leave no available allocation after current spending")
        self.ledger.set_enabled(False)
        self._record_funding(funding, account, account, str(allocation), manual_limits=reported, ui_evidence=verified_images)
        write_json(self.state_dir / "account-costs.json", account)
        return {"status": "recorded_disabled", "limits_source": "user_confirmation",
                "allocation_usd": str(allocation), "next_action": "enable after credential and live readiness checks"}

    def _account_refresh(self):
        if self.account_preflight is not None:
            with account_cost_refresh_lock(self.state_dir):
                self.ledger.update_account_costs(self.account_preflight(self.ledger.funding()))
        else:
            self.refresh_costs()

    def _submission_preflight(self):
        if not self.ledger.status()["enabled"]:
            raise PolicyError("execution_disabled", "New API submissions are disabled")
        validate_funding(self.ledger.funding(), self.policy, allow_platform_stale=True)
        self._account_refresh()
        self.ledger.validate_ready_funding()

    def _adapter(self, request=None):
        if self.adapter_factory:
            return self.adapter_factory()
        key = self.credential_loader(self.policy, self.root)
        timeout = (request or {}).get("local_timeout_seconds", self.policy.get("request_timeout_seconds", 30))
        return SDKAdapter(key, self.policy["organization_id"], self.policy["project_id"],
                          timeout_seconds=timeout)

    def _job_adapter_request(self, job):
        metadata = job.get("metadata") or {}
        if not job.get("async_job"):
            return metadata.get("pricing_request") or {}
        items = metadata.get("items")
        if isinstance(items, dict):
            default_timeout = self.policy.get("request_timeout_seconds", 30)
            values = [item.get("local_timeout_seconds", default_timeout)
                      for item in items.values() if isinstance(item, dict)]
            if values:
                return {"local_timeout_seconds": max(values)}
        return {}

    def _artifact(self, job_id, result):
        path = self.state_dir / "artifacts" / (job_id + ".json")
        write_json(path, _scrub(result))
        return str(path)

    def _retry(self, action, *, local_deadline=None):
        deadline = time.monotonic() + min(60, max(0, self.policy.get("retry_elapsed_seconds", 60)))
        attempts = min(2, max(0, self.policy.get("max_transient_retries", 2)))
        for attempt in range(attempts + 1):
            try:
                return action()
            except AdapterError as exc:
                delay = min(2 ** attempt, 4)
                if exc.uncertain or not exc.retryable or attempt == attempts or time.monotonic() + delay > deadline or (local_deadline is not None and time.monotonic() + delay >= local_deadline):
                    raise
                time.sleep(delay)
                if local_deadline is not None and time.monotonic() >= local_deadline:
                    raise

    def _failed(self, job_id, exc, *, stage):
        known_rejection = isinstance(exc, LocalDeadlineBeforeSubmission) or exc.code in {"credit_balance_exhausted", "insufficient_quota", "project_spend_limit_exceeded",
            "organization_spend_limit_exceeded", "organization_usage_limit_exceeded", "authentication_failed",
            "invalid_api_key", "invalid_request_error", "permission_denied", "invalid_payload",
            "rate_limit_exceeded", "resource_unavailable", "not_found"}
        if exc.code in {"credit_balance_exhausted", "insufficient_quota", "project_spend_limit_exceeded", "organization_spend_limit_exceeded", "organization_usage_limit_exceeded"}:
            self.ledger.set_enabled(False)
        uncertain = exc.uncertain or not known_rejection
        diagnostic = {"error_code": exc.code, "failure_stage": stage,
            "remote_outcome_uncertain": bool(uncertain),
            **({"failure_class": exc.failure_class} if exc.failure_class else {}),
            **({"exception_type": exc.exception_type} if exc.exception_type else {}),
            **({"http_status": exc.http_status} if exc.http_status is not None else {}),
            **({"transport_cause_type": exc.transport_cause_type} if exc.transport_cause_type else {}),
            "retryable": bool(exc.retryable),
            **({"input_file_id": exc.input_file_id} if exc.input_file_id else {})}
        if exc.provider_request_id:
            diagnostic["provider_request_id"] = exc.provider_request_id
        job = self.ledger.update_job(job_id, "uncertain" if uncertain else "failed", api_id=exc.api_id,
            actual_microusd=None if uncertain else 0,
            metadata=diagnostic)
        return {"status": job["status"], "job_id": job_id, "api_id": job["api_id"], "error_code": exc.code,
                "failure_stage": stage, "failure_class": exc.failure_class,
                "exception_type": exc.exception_type, "http_status": exc.http_status,
                "transport_cause_type": exc.transport_cause_type,
                **recorded_execution_context(job.get("metadata") or {}),
                "next_action": "Inspect the recorded remote outcome before any resubmission" if uncertain else str(exc)}

    def invoke(self, request, *, local_deadline_utc=None):
        deadline = local_submission_deadline(local_deadline_utc)
        request, amount = self.prepare(request)
        if request["tier"] == "batch":
            raise PolicyError("batch_command_required", "Use batch-submit for asynchronous requests")
        if "external_request_id" in request:
            existing = self.ledger.lookup_external_request(request["external_request_id"])
            if existing is not None:
                self.ledger.require_external_request_match(existing, [request])
                return self._external_request_result(existing)
        require_local_budget(deadline)
        self._submission_preflight()
        require_local_budget(deadline)
        adapter = self._adapter(request)
        require_local_budget(deadline)
        if "external_request_id" in request:
            job, reused = self.ledger.reserve_external_request(request, amount)
            if reused:
                return self._external_request_result(job)
        else:
            job = self.ledger.reserve(request, amount)
        job_id = job["job_id"]
        self.ledger.update_job(job_id, "submitting", metadata={"pricing_request": request_metadata(request),
            **recorded_execution_context({"execution_context": getattr(adapter, "execution_context", None)})})
        # Invocation-scoped state survives retry and authorized Flex fallback.
        last_error = None
        def call(selected):
            nonlocal last_error
            if deadline is None:
                return adapter.call(selected)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if last_error is not None:
                    raise last_error
                raise LocalDeadlineBeforeSubmission()
            try:
                return bounded_call(adapter.call, min(selected["local_timeout_seconds"], remaining), selected)
            except AdapterError as exc:
                last_error = exc
                raise
        try:
            try:
                result = self._retry(lambda: call(request), local_deadline=deadline)
            except AdapterError as exc:
                if (exc.code != "resource_unavailable" or exc.uncertain or request["tier"] != "flex"
                        or not request.get("allow_standard_fallback") or not self.policy.get("standard_fallback", False)):
                    raise
                fallback = {**request, "tier": "default"}
                result = self._retry(lambda: call(fallback), local_deadline=deadline)
                result["standard_fallback_used"] = True
                result["service_tier"] = result.get("service_tier") or "default"
        except AdapterError as exc:
            return self._failed(job_id, exc, stage="sync_request")
        return self._complete(job_id, request, amount, result)

    def _complete(self, job_id, request, amount, result):
        usage = result.get("usage")
        artifact = self._artifact(job_id, result)
        self.ledger.update_job(job_id, "running", api_id=result.get("api_id"), usage=usage, artifact=artifact,
            metadata={"result_status": result.get("status"), "actual_tier": result.get("service_tier"),
                      **reported_configuration({"model": result.get("reported_model"),
                                                "reasoning": {"effort": result.get("selected_effort")}})})
        # If usage is missing or unrecognized, hold the reservation for reconciliation.
        actual = None
        if usage:
            priced = copy.deepcopy(request)
            returned_tier = result.get("service_tier")
            if returned_tier and returned_tier != request["tier"]:
                if not result.get("standard_fallback_used"):
                    self.ledger.set_enabled(False)
                if returned_tier not in self.registry["models"][request["model"]]["capabilities"][request["capability"]]["tiers"]:
                    self.ledger.update_job(job_id, "uncertain", metadata={"error_code": "unpriced_returned_tier"})
                    return {"status": "uncertain", "job_id": job_id, "artifact": artifact,
                            "next_action": "Unexpected processing tier; new submissions disabled and reservation retained"}
                priced["tier"] = returned_tier
            actual = reconcile_cost(priced, self.registry, usage)
            if actual > amount:
                self.ledger.set_enabled(False)
        terminal = "completed" if result.get("status") == "completed" else "failed"
        self.ledger.update_job(job_id, terminal, api_id=result.get("api_id"), usage=usage,
            actual_microusd=actual, artifact=artifact, metadata={"result_status": result.get("status"), "actual_tier": result.get("service_tier"),
                      **reported_configuration({"model": result.get("reported_model"),
                                                "reasoning": {"effort": result.get("selected_effort")}})})
        safe_result = _scrub(result)
        safe_result.pop("execution_context", None)  # Provider data cannot attest the helper destination.
        return {**safe_result, "job_id": job_id, "artifact": artifact,
                **recorded_execution_context((self.ledger.get_job(job_id).get("metadata") or {})),
                "reservation_usd": microusd_to_usd(amount), "cost_usd": microusd_to_usd(actual) if actual is not None else None,
                "next_action": None if actual is not None else "Reconcile missing usage; reservation retained"}

    def batch_submit(self, document):
        if not isinstance(document, dict) or not isinstance(document.get("requests"), list) or not 1 <= len(document["requests"]) <= 1000:
            raise PolicyError("invalid_batch", "Supply requests containing 1 to 1000 custom_id/request items")
        if "external_request_id" in document:
            external_request_id_sha256(document["external_request_id"])
        items, seen, total = [], set(), 0
        for item in document["requests"]:
            ident = item.get("custom_id") if isinstance(item, dict) else None
            if not isinstance(ident, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", ident) or ident in seen:
                raise PolicyError("invalid_custom_id", "Batch identifiers must be unique short ASCII identifiers")
            seen.add(ident)
            request, amount = self.prepare(item.get("request"))
            if "external_request_id" in request:
                raise PolicyError("external_request_id_scope", "For Batch, place one external_request_id on the request collection")
            if request["tier"] != "batch":
                raise PolicyError("batch_tier_required", "Every batch item must explicitly select batch processing")
            items.append({"custom_id": ident, "request": request})
            total += amount
        if len({(x["request"]["capability"], x["request"]["model"]) for x in items}) != 1:
            raise PolicyError("mixed_batch", "Use one endpoint and model per batch")
        local_timeout = max(x["request"]["local_timeout_seconds"] for x in items)
        horizon_request = {**items[0]["request"], "local_timeout_seconds": local_timeout}
        horizon = datetime.now(timezone.utc) + self.ledger.execution_horizon(horizon_request, async_job=True)
        deadlines = [timestamp(x["request"]["deadline"], "deadline") for x in items if "deadline" in x["request"]]
        if any(deadline < horizon for deadline in deadlines):
            raise PolicyError("deadline_too_short", "Every Batch item must allow the full completion window and bounded submission time")
        admission = dict(items[0]["request"])
        admission["local_timeout_seconds"] = local_timeout
        if "external_request_id" in document:
            admission["external_request_id"] = document["external_request_id"]
        admission["activation"] = any(x["request"].get("activation", False) for x in items)
        if deadlines:
            admission["deadline"] = max(deadlines).isoformat()
        if "external_request_id" in admission:
            existing = self.ledger.lookup_external_request(admission["external_request_id"])
            if existing is not None:
                self.ledger.require_external_request_match(existing, [item["request"] for item in items])
                return self._external_request_result(existing)
        self._submission_preflight()
        adapter = self._adapter(admission)
        if "external_request_id" in admission:
            job, reused = self.ledger.reserve_external_request(
                admission, total, async_job=True, identity_requests=[item["request"] for item in items])
            if reused:
                return self._external_request_result(job)
        else:
            job = self.ledger.reserve(admission, total, async_job=True,
                                      identity_requests=[item["request"] for item in items])
        job_id = job["job_id"]
        self.ledger.update_job(job_id, "submitting", metadata={"items": {
            x["custom_id"]: request_metadata(x["request"]) for x in items}})
        try:
            result = adapter.batch_submit([{**x["request"], "custom_id": x["custom_id"]} for x in items], job_id,
                checkpoint=lambda data: self.ledger.update_job(job_id, "submitting", metadata=data))
        except AdapterError as exc:
            return self._failed(job_id, exc, stage="batch_submission")
        self.ledger.update_job(job_id, "pending", api_id=result["api_id"], metadata=result)
        return {**result, "job_id": job_id, "reservation_usd": microusd_to_usd(total), "next_action": "resume " + job_id}

    def resume(self, job_id, action="resume"):
        job = self.ledger.get_job(job_id)
        if action.startswith("batch-") and not job["async_job"]:
            raise PolicyError("batch_job_required", "This operation requires a recorded Batch job")
        if job["actual_microusd"] is not None:
            return {"status": job["status"], "job_id": job_id, "artifact": job["artifact"],
                    "cost_usd": microusd_to_usd(job["actual_microusd"]), "next_action": None}
        if job["async_job"] and not job["api_id"]:
            adapter = self._adapter(self._job_adapter_request(job))
            try:
                found = adapter.batch_reconcile(job_id, job["metadata"].get("input_file_id"))
            except AdapterError as exc:
                return {"status": "blocked", "job_id": job_id, "error_code": exc.code,
                        "next_action": "Inspect remote Batch metadata; reservation retained and no duplicate submitted"}
            if found.get("api_id"):
                job = self.ledger.update_job(job_id, "pending", api_id=found["api_id"], metadata=found)
        if not job["async_job"] and isinstance(job["api_id"], str) and job["api_id"].startswith("resp_"):
            request = job["metadata"]["pricing_request"]
            adapter = self._adapter(request)
            try:
                raw = adapter.retrieve_response(job["api_id"])
                result = normalize_result(request, raw)
            except AdapterError as exc:
                return {"status": "blocked", "job_id": job_id, "api_id": job["api_id"], "error_code": exc.code,
                        "next_action": "Recorded response cannot be retrieved; reservation retained and no duplicate submitted"}
            return self._complete(job_id, request, job["reservation_microusd"], result)
        if not job["async_job"] or not job["api_id"]:
            return {"status": job["status"], "job_id": job_id, "api_id": job["api_id"],
                    "next_action": "Reconcile the recorded remote outcome; automatic duplicate submission is disabled"}
        adapter = self._adapter(self._job_adapter_request(job))
        try:
            if action == "batch-cancel":
                result = adapter.batch_cancel(job["api_id"])
                self.ledger.update_job(job_id, "cancelling", metadata={"remote_status": result.get("status")})
                return {**result, "job_id": job_id, "next_action": "resume " + job_id}
            remote = adapter.batch_status(job["api_id"])
            state = remote.get("status")
            if state not in {"completed", "cancelled", "expired", "failed"} or action == "batch-status":
                self.ledger.update_job(job_id, "pending" if state not in {"cancelled", "expired", "failed"} else state,
                                       metadata={"remote_status": state})
                return {**remote, "job_id": job_id, "next_action": "resume " + job_id}
            results = adapter.batch_results(job["api_id"])
        except AdapterError as exc:
            # Retrieval/cancellation errors never settle or discard a submission's budget.
            return {"status": "blocked", "job_id": job_id, "api_id": job["api_id"],
                    "error_code": exc.code, "next_action": "Retry result inspection; reservation retained"}
        expected = job["metadata"]["items"]
        successes, failures, usage, costs = {}, dict(results.get("failed", {})), {}, []
        for ident, body in results.get("successful", {}).items():
            if ident not in expected:
                raise PolicyError("unexpected_batch_item", "Remote result contains an unrecorded identifier; reservation retained")
            normalized = normalize_result(expected[ident], body)
            if normalized.get("status") == "completed":
                successes[ident] = normalized
            else:
                failures[ident] = normalized
            if normalized.get("usage"):
                usage[ident] = normalized["usage"]
                costs.append(reconcile_cost(expected[ident], self.registry, normalized["usage"]))
        known_ids = set(successes) | set(failures)
        if known_ids - set(expected):
            raise PolicyError("unexpected_batch_item", "Remote result contains an unrecorded identifier; reservation retained")
        missing = sorted(set(expected) - known_ids)
        # Failed/cancelled items without authoritative usage are retained conservatively.
        reconciled = not missing and len(costs) == len(expected)
        actual = sum(costs) if reconciled else None
        artifact = self._artifact(job_id, {**results, "successful": successes, "failed": failures, "missing": missing})
        self.ledger.update_job(job_id, state, usage=usage, actual_microusd=actual, artifact=artifact,
                               metadata={"remote_status": state, "missing_items": missing})
        return {"status": "partial" if failures and state == "completed" else state, "job_id": job_id, "api_id": job["api_id"], "artifact": artifact,
                "successful_count": len(successes), "failed_count": len(failures), "missing_items": missing,
                "cost_usd": microusd_to_usd(actual) if actual is not None else None,
                "next_action": "Review failed items before task completion" if reconciled and failures else None if reconciled else "Inspect failed/missing item usage; reservation retained"}
