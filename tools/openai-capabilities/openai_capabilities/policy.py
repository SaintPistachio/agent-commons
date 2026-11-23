"""Fail-closed admission and deterministic pricing; monetary values are micro-USD."""
from __future__ import annotations

from datetime import date, datetime, time, timezone
from decimal import Decimal, InvalidOperation, ROUND_CEILING
import hashlib
import json
import re
from uuid import UUID


class PolicyError(ValueError):
    def __init__(self, code: str, message: str, *, diagnostics=None):
        self.code = code
        self.diagnostics = self._safe_diagnostics(diagnostics)
        super().__init__(message)

    @staticmethod
    def _safe_diagnostics(value):
        if not isinstance(value, dict):
            return None
        result = {}
        if value.get("failure_stage") in {"costs", "organization_limit", "project_limit"}:
            result["failure_stage"] = value["failure_stage"]
        for key in ("remote_outcome_uncertain", "retryable"):
            if type(value.get(key)) is bool:
                result[key] = value[key]
        if value.get("failure_class") in {
                "provider_transport", "provider_http", "provider_error", "local_deadline", "local_result_missing"}:
            result["failure_class"] = value["failure_class"]
        if value.get("exception_type") in {
                "APITimeoutError", "APIConnectionError", "ReadTimeout", "ConnectTimeout", "WriteTimeout",
                "PoolTimeout", "NetworkError", "HTTPStatusError", "APIStatusError", "APIError",
                "BadRequestError", "AuthenticationError", "PermissionDeniedError", "NotFoundError",
                "ConflictError", "UnprocessableEntityError", "RateLimitError", "InternalServerError",
                "ServerError"}:
            result["exception_type"] = value["exception_type"]
        if value.get("transport_cause_type") in {
                "ConnectError", "ConnectTimeout", "ReadError", "ReadTimeout", "WriteError", "WriteTimeout",
                "PoolTimeout", "NetworkError", "ProxyError", "RemoteProtocolError", "LocalProtocolError",
                "ProtocolError", "PermissionError", "ConnectionRefusedError", "ConnectionResetError",
                "TimeoutError", "gaierror", "SSLError", "OSError"}:
            result["transport_cause_type"] = value["transport_cause_type"]
        status = value.get("http_status")
        if type(status) is int and 100 <= status <= 599:
            result["http_status"] = status
        request_id = value.get("provider_request_id")
        if isinstance(request_id, str) and re.fullmatch(r"req_[A-Za-z0-9_-]{1,176}", request_id):
            result["provider_request_id"] = request_id
        sizing = value.get("reservation_sizing")
        money = r"(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?"
        if (isinstance(sizing, dict) and sizing.get("schema") == "openai-reservation-sizing/1"
                and sizing.get("currency") == "USD" and sizing.get("estimate_is_charge") is False
                and type(sizing.get("max_attempts")) is int and 1 <= sizing["max_attempts"] <= 32
                and all(isinstance(sizing.get(k), str) and re.fullmatch(money, sizing[k])
                        for k in ("required_reservation_usd", "requested_max_cost_usd"))):
            result["reservation_sizing"] = {k: sizing[k] for k in (
                "schema", "currency", "required_reservation_usd", "requested_max_cost_usd",
                "max_attempts", "estimate_is_charge")}
        return result or None


def decimal_amount(value, field="amount") -> Decimal:
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        raise PolicyError("invalid_amount", f"{field} must be a finite nonnegative decimal") from None
    if not number.is_finite() or number < 0:
        raise PolicyError("invalid_amount", f"{field} must be a finite nonnegative decimal")
    return number


def usd_to_microusd(value) -> int:
    return int((decimal_amount(value) * 1_000_000).to_integral_value(rounding=ROUND_CEILING))


def microusd_to_usd(value: int) -> str:
    return str(Decimal(value) / 1_000_000)


def external_request_id_sha256(value) -> str:
    """Validate a caller-owned stable operation ID and return its storage key."""
    if not isinstance(value, str) or len(value) not in {36, 64}:
        raise PolicyError("invalid_external_request_id", "external_request_id must be a canonical UUID or lowercase SHA-256")
    is_hash = re.fullmatch(r"[0-9a-f]{64}", value) is not None
    is_uuid = False
    if not is_hash:
        try:
            is_uuid = str(UUID(value)) == value
        except (ValueError, AttributeError, TypeError):
            pass
    if not (is_hash or is_uuid):
        raise PolicyError("invalid_external_request_id", "external_request_id must be a canonical UUID or lowercase SHA-256")
    return hashlib.sha256(value.encode("ascii")).hexdigest()


def timestamp(value, field="timestamp") -> datetime:
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if result.tzinfo is None:
            raise ValueError()
        return result.astimezone(timezone.utc)
    except (TypeError, AttributeError, ValueError):
        raise PolicyError("invalid_timestamp", f"{field} must include an explicit UTC offset") from None


def _validate_promotional_funding(snapshot: dict, policy: dict, now=None) -> None:
    now = now or datetime.now(timezone.utc)
    if not isinstance(snapshot, dict):
        raise PolicyError("funding_unverified", "Verify a promotional-only funding snapshot before submitting")
    for field in ("organization_id", "project_id", "grant_id", "source"):
        if not isinstance(snapshot.get(field), str) or not snapshot[field].strip():
            raise PolicyError("funding_unverified", f"Funding evidence is missing {field}")
    for field in ("organization_id", "project_id"):
        if not policy.get(field) or snapshot[field] != policy[field]:
            raise PolicyError("funding_target_mismatch", f"Funding {field} must match the designated policy target")
    if snapshot.get("purchased_balance") != "absent":
        raise PolicyError("paid_funding_possible", "Purchased funds must be verified absent")
    if snapshot.get("auto_recharge") != "disabled":
        raise PolicyError("paid_funding_possible", "Auto Recharge must be verified disabled")
    if snapshot.get("platform_hard_limit_enforced") is not True:
        raise PolicyError("hard_limit_unverified", "Verify the enforced platform hard limit, separately from alerts")
    verified = timestamp(snapshot.get("verified_at"), "verified_at")
    expires = timestamp(snapshot.get("expires_at"), "expires_at")
    reset = timestamp(snapshot.get("platform_limit_reset_at"), "platform_limit_reset_at")
    if verified > now or verified >= expires:
        raise PolicyError("funding_unverified", "Funding verification time is invalid")
    if expires <= now:
        raise PolicyError("grant_expired", "Promotional funding has expired; refresh evidence for the actual new grant")
    if reset <= now:
        raise PolicyError("platform_limit_stale", "Refresh platform limit evidence after its reset; this does not renew the grant")
    balance = decimal_amount(snapshot.get("grant_balance_usd"), "grant_balance_usd")
    allocation = decimal_amount(snapshot.get("allocation_usd"), "allocation_usd")
    limit = decimal_amount(snapshot.get("platform_limit_usd"), "platform_limit_usd")
    platform_spend = decimal_amount(snapshot.get("platform_spend_usd"), "platform_spend_usd")
    if not allocation or allocation > balance or allocation > limit - platform_spend:
        raise PolicyError("allocation_invalid", "Allocation must be positive and fit verified promotional balance and the platform limit after existing spending")
    margin = decimal_amount(policy.get("allocation_margin", "0.05"), "allocation_margin")
    if margin >= 1:
        raise PolicyError("allocation_invalid", "allocation_margin must be less than one")


def grant_expiry(grant: dict) -> datetime:
    """Date-only evidence stops at UTC start of that date; never guess an end time."""
    if ("expires_at" in grant) == ("expires_on" in grant):
        raise PolicyError("grant_expiration_unverified", "Provide exactly one grant expiration timestamp or calendar date")
    if "expires_at" in grant:
        return timestamp(grant["expires_at"], "grant expires_at")
    try:
        parsed = date.fromisoformat(grant["expires_on"])
        if parsed.isoformat() != grant["expires_on"]:
            raise ValueError()
        return datetime.combine(parsed, time.min, timezone.utc)
    except (ValueError, TypeError):
        raise PolicyError("grant_expiration_unverified", "Grant expires_on must be an ISO calendar date") from None


def funding_expiry(snapshot: dict) -> datetime:
    if snapshot.get("funding_policy") == "existing_prepaid_only":
        return min(grant_expiry(g) for g in snapshot["grants"] if decimal_amount(g["balance_usd"]) > 0)
    return timestamp(snapshot["expires_at"], "expires_at")


def funding_identity(snapshot: dict) -> str:
    return snapshot["funding_window_id"] if snapshot.get("funding_policy") == "existing_prepaid_only" else snapshot["grant_id"]


def usage_priority(funding, *, now=None) -> dict:
    """Advisory urgency from recorded expiration; never permission to submit work."""
    result = {"level": "unverified", "expires_at": None, "days_until_expiry": None,
              "basis": "recorded_grant_snapshot", "advisory_only": True}
    try:
        now = now or datetime.now(timezone.utc)
        if now.utcoffset() is None:
            return result
        now = now.astimezone(timezone.utc)
        grants = funding.get("grants") if isinstance(funding, dict) else None
        if not isinstance(grants, list) or not 1 <= len(grants) <= 100:
            return result
        expirations = []
        for grant in grants:
            if not isinstance(grant, dict):
                return result
            if decimal_amount(grant.get("balance_usd"), "recorded grant balance") > 0:
                expirations.append(grant_expiry(grant))
        if not expirations:
            return result
        expires = min(expirations)
        seconds = (expires - now).total_seconds()
        level = ("blocked" if seconds <= 0 else "urgent" if seconds <= 7 * 86400 else
                 "high" if seconds <= 14 * 86400 else "elevated" if seconds <= 30 * 86400 else "normal")
        return {**result, "level": level, "expires_at": expires.isoformat(),
                "days_until_expiry": round(seconds / 86400, 6)}
    except (PolicyError, AttributeError, TypeError, ValueError, OverflowError):
        return result


def account_cost_max_age(policy: dict) -> float:
    seconds = decimal_amount(policy.get("account_cost_max_age_seconds", 300), "account_cost_max_age_seconds")
    if not seconds:
        raise PolicyError("account_cost_policy_invalid", "Account cost evidence lifetime must be positive")
    return float(seconds)


def account_cost_basis(snapshot: dict) -> str:
    """Alignment affects estimate precision, never invents a later balance check."""
    baseline_at = timestamp(snapshot["account_cost_baseline"]["observed_at"], "baseline observed_at")
    verified = timestamp(snapshot["verified_at"], "verified_at")
    age = (verified - baseline_at).total_seconds()
    return "verified_observation_delta" if 0 <= age <= 300 else "conservative_lower_bound"


def uses_local_prepaid_budget(policy: dict) -> bool:
    """Explicit operator opt-in; requests and funding observations cannot select it."""
    mode = policy.get("platform_limit_policy", "enforced_platform_caps")
    if mode == "enforced_platform_caps":
        return False
    authorization = policy.get("local_prepaid_authorization")
    if (mode != "local_prepaid_budget" or policy.get("funding_policy") != "existing_prepaid_only"
            or not isinstance(authorization, dict) or authorization.get("source") != "user_confirmation"
            or not isinstance(authorization.get("reference"), str) or not authorization["reference"].strip()
            or any(authorization.get(key) != policy.get(key) or not policy.get(key)
                   for key in ("organization_id", "project_id"))
            or authorization.get("auto_recharge") != "disabled"
            or authorization.get("automatic_purchases") != "disabled"):
        raise PolicyError("local_prepaid_authorization_missing", "Explicit account-bound local prepaid budget authorization is required")
    return True


def validate_funding(snapshot: dict, policy: dict, now=None, *, allow_platform_stale=False) -> None:
    """Do not reinterpret old promotional-only evidence as broader spending consent."""
    if policy.get("funding_policy", "promotional_only") != "existing_prepaid_only":
        return _validate_promotional_funding(snapshot, policy, now)
    now = now or datetime.now(timezone.utc)
    if not isinstance(snapshot, dict) or snapshot.get("funding_policy") != "existing_prepaid_only":
        raise PolicyError("funding_policy_unverified", "Record fresh existing-prepaid funding evidence; an old snapshot is not automatically upgraded")
    for field in ("organization_id", "project_id", "funding_window_id", "source"):
        if not isinstance(snapshot.get(field), str) or not snapshot[field].strip():
            raise PolicyError("funding_unverified", f"Funding evidence is missing {field}")
    for field in ("organization_id", "project_id"):
        if not policy.get(field) or snapshot[field] != policy[field]:
            raise PolicyError("funding_target_mismatch", f"Funding {field} must match the designated policy target")
    if snapshot.get("billing_mode") != "prepaid" or snapshot.get("auto_recharge") != "disabled" or snapshot.get("automatic_purchases") != "disabled":
        raise PolicyError("automatic_charge_possible", "Verify prepaid billing, disabled Auto Recharge, and no automatic credit purchases")
    verified = timestamp(snapshot.get("verified_at"), "verified_at")
    local_budget = uses_local_prepaid_budget(policy)
    reset = timestamp(snapshot.get("platform_limit_reset_at"), "platform_limit_reset_at")
    if verified > now:
        raise PolicyError("funding_unverified", "Funding observation cannot be in the future")
    if reset <= now and not allow_platform_stale and not local_budget:
        raise PolicyError("platform_limit_stale", "Refresh monthly limit evidence after its reset; this does not renew prepaid credits")
    if not local_budget and snapshot.get("platform_hard_limit_enforced") is not True:
        raise PolicyError("hard_limit_unverified", "Verify enforced organization and project limits, separately from alerts")
    grants = snapshot.get("grants")
    if not isinstance(grants, list) or not 1 <= len(grants) <= 100:
        raise PolicyError("funding_unverified", "Provide the existing prepaid credit grants and their expirations")
    seen, balance = set(), Decimal(0)
    for grant in grants:
        if not isinstance(grant, dict) or not isinstance(grant.get("grant_id"), str) or not grant["grant_id"].strip() or grant["grant_id"] in seen:
            raise PolicyError("grant_identity_invalid", "Each observed grant needs a unique local observation identifier")
        seen.add(grant["grant_id"])
        if grant.get("funding_type") not in {"promotional", "purchased", "unknown"}:
            raise PolicyError("funding_unverified", "Grant subtype must be promotional, purchased, or unknown existing prepaid credit")
        amount = decimal_amount(grant.get("balance_usd"), "grant balance_usd")
        expiry = grant_expiry(grant)
        if amount and expiry <= now:
            raise PolicyError("grant_expired", "A recorded balance reached its expiration; reconcile surviving credits before submitting")
        balance += amount
    allocation = decimal_amount(snapshot.get("allocation_usd"), "allocation_usd")
    if not allocation or allocation > balance:
        raise PolicyError("allocation_invalid", "Allocation must be positive and fit verified existing prepaid credits")
    for scope in (() if local_budget else ("organization", "project")):
        limit = decimal_amount(snapshot.get(scope + "_limit_usd"), scope + "_limit_usd")
        spend = decimal_amount(snapshot.get(scope + "_spend_usd"), scope + "_spend_usd")
        if not limit or allocation > limit - spend:
            raise PolicyError("allocation_invalid", f"Allocation exceeds the enforced {scope} limit after observed monthly spending")
    margin = decimal_amount(policy.get("allocation_margin", "0.05"), "allocation_margin")
    if margin >= 1:
        raise PolicyError("allocation_invalid", "allocation_margin must be less than one")
    baseline = snapshot.get("account_cost_baseline")
    if not isinstance(baseline, dict):
        raise PolicyError("account_baseline_unverified", "Record a supported account-cost baseline alongside the balance observation")
    baseline_at = timestamp(baseline.get("observed_at"), "baseline observed_at")
    window_start = timestamp(baseline.get("window_start"), "baseline window_start")
    decimal_amount(baseline.get("cost_total_usd"), "baseline cost_total_usd")
    if baseline_at > now or window_start > min(baseline_at, verified) or baseline_at >= funding_expiry(snapshot):
        raise PolicyError("account_baseline_unverified", "The cost window must cover both observations within the active existing-credit period")


def _capability(request: dict, registry: dict) -> dict:
    try:
        return registry["models"][request["model"]]["capabilities"][request["capability"]]
    except (KeyError, TypeError):
        raise PolicyError("unsupported_capability", "The model/capability combination is not in the verified registry") from None


def validate_request(request: dict, registry: dict) -> dict:
    if not isinstance(request, dict):
        raise PolicyError("invalid_request", "Request must be a JSON object")
    if "external_request_id" in request:
        external_request_id_sha256(request["external_request_id"])
    purpose = request.get("purpose", {})
    if not isinstance(purpose, dict) or purpose.get("kind") not in {
        "service_output", "application_integration", "api_control", "contract_test", "coding_assistance"
    } or not isinstance(purpose.get("description"), str) or not purpose["description"].strip():
        raise PolicyError("purpose_required", "Provide a concrete API task or bounded coding-assistance purpose; generic coding and subscription overflow do not qualify")
    if purpose["kind"] == "coding_assistance":
        if request.get("capability") != "responses":
            raise PolicyError("coding_capability_invalid", "Coding assistance is supported only through Responses")
        if not isinstance(purpose.get("deliverable"), str) or not purpose["deliverable"].strip():
            raise PolicyError("coding_deliverable_required", "Describe the concrete coding-assistance deliverable")
        if "max_cost_usd" not in request or not decimal_amount(request["max_cost_usd"], "max_cost_usd"):
            raise PolicyError("coding_budget_required", "Coding assistance requires an explicit positive max_cost_usd")
    if request.get("capability") not in {"embeddings", "decisions", "responses"}:
        raise PolicyError("unsupported_capability", "Only embeddings, decisions, and application-facing responses are implemented")
    if request.get("tier") not in {"default", "flex", "batch"}:
        raise PolicyError("unsupported_tier", "Select explicit default, flex, or a supported batch tier")
    payload = request.get("payload")
    if not isinstance(payload, dict):
        raise PolicyError("invalid_payload", "payload must be a JSON object")
    cap = _capability(request, registry)
    if request["tier"] not in cap.get("tiers", {}):
        raise PolicyError("unsupported_tier", "This endpoint/model does not support the selected processing tier")
    if any(key in payload for key in ("api_key", "base_url", "organization", "project", "service_tier", "model")):
        raise PolicyError("forbidden_override", "Payload cannot override credentials, destination, target, model, or processing tier")
    if request["capability"] == "responses":
        output = payload.get("max_output_tokens")
        if isinstance(output, bool) or not isinstance(output, int) or output <= 0 or output > cap.get("max_output_tokens", 32768):
            raise PolicyError("output_limit_required", "Responses requires a positive max_output_tokens within the registered model limit")
    if "max_cost_usd" in request and not decimal_amount(request["max_cost_usd"], "max_cost_usd"):
        raise PolicyError("invalid_amount", "max_cost_usd must be positive")
    if "local_timeout_seconds" in request:
        local_timeout = request["local_timeout_seconds"]
        if isinstance(local_timeout, bool) or not isinstance(local_timeout, int) or not 1 <= local_timeout <= 900:
            raise PolicyError("invalid_local_timeout", "local_timeout_seconds must be an integer from 1 through 900")
    if "deadline" in request:
        timestamp(request["deadline"], "deadline")
    if "activation" in request and (not isinstance(request["activation"], bool) or request["activation"] and purpose["kind"] != "contract_test"):
        raise PolicyError("activation_invalid", "Activation requests must explicitly identify a contract test")
    result = dict(request)
    result["purpose"] = {"kind": purpose["kind"], "description": purpose["description"].strip()}
    if purpose["kind"] == "coding_assistance":
        result["purpose"]["deliverable"] = purpose["deliverable"].strip()
    return result


def input_token_bound(request: dict) -> int:
    # UTF-8 bytes upper-bound ordinary text tokenization; overhead covers message framing.
    payload = {k: v for k, v in request["payload"].items() if k not in {
        "max_output_tokens", "prompt_cache_options", "prompt_cache_key", "prompt_cache_retention",
        "reasoning", "store", "background", "encoding_format", "dimensions"
    }}
    try:
        return len(json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")) + 1024
    except (ValueError, TypeError):
        raise PolicyError("invalid_payload", "Payload must contain finite JSON values") from None


def _rates(request: dict, registry: dict, input_tokens: int) -> dict:
    cap = _capability(request, registry)
    rates = dict(cap["tiers"][request["tier"]])
    threshold = cap.get("long_context_threshold")
    if threshold and input_tokens > threshold:
        if "long_context_rates" not in cap or request["tier"] not in cap["long_context_rates"]:
            raise PolicyError("unpriced_context", "Long-context rates are not verified for this operation")
        rates.update(cap["long_context_rates"][request["tier"]])
    return rates


def estimate(request: dict, registry: dict, *, retries=2) -> int:
    request = validate_request(request, registry)
    tokens = input_token_bound(request)
    cap = _capability(request, registry)
    if tokens > cap.get("max_input_tokens", 128000):
        raise PolicyError("input_limit_exceeded", "Conservative input bound exceeds the registered endpoint/model limit")
    rates = _rates(request, registry, tokens)
    # No assumed cache hit: reserve the most expensive possible cache-write category.
    input_rate = max(decimal_amount(rates.get(k, rates["input"])) for k in (
        "input", "cache_write_30m", "cache_write_12h"
    ))
    output = request["payload"].get("max_output_tokens", 0) if request["capability"] == "responses" else 0
    cost = tokens * input_rate + output * decimal_amount(rates.get("output", 0))
    # USD / million tokens equals micro-USD / token. Retry exposure is reserved, not spent.
    reserve = int((cost * (retries + 1)).to_integral_value(rounding=ROUND_CEILING))
    if request.get("max_cost_usd") is not None and reserve > usd_to_microusd(request["max_cost_usd"]):
        raise PolicyError("job_cap_exceeded", "Estimated reservation exceeds this job's max_cost_usd",
                          diagnostics={"reservation_sizing": {
                              "schema": "openai-reservation-sizing/1", "currency": "USD",
                              "required_reservation_usd": microusd_to_usd(reserve),
                              "requested_max_cost_usd": microusd_to_usd(usd_to_microusd(request["max_cost_usd"])),
                              "max_attempts": retries + 1, "estimate_is_charge": False}})
    return max(1, reserve)


def reconcile_cost(request: dict, registry: dict, usage: dict) -> int:
    def count(value, name):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise PolicyError("invalid_usage", f"{name} must be a nonnegative integer")
        return value
    total = count(usage.get("input_tokens", usage.get("prompt_tokens")), "input_tokens")
    detail = usage.get("input_tokens_details", usage.get("prompt_tokens_details", {})) or {}
    cached = count(detail.get("cached_tokens", 0), "cached_tokens")
    writes = count(detail.get("cache_write_tokens", 0), "cache_write_tokens")
    subtotals = detail.get("cache_write_tokens_details", {}) or {}
    short = count(subtotals.get("ttl_30m_tokens", subtotals.get("ephemeral_30m_input_tokens", subtotals.get("30m", 0))), "30m writes")
    long = count(subtotals.get("ttl_12h_tokens", subtotals.get("ephemeral_12h_input_tokens", subtotals.get("12h", 0))), "12h writes")
    if short + long > writes:
        raise PolicyError("invalid_usage", "Cache-write subtotals exceed aggregate writes")
    if cached + writes > total:
        raise PolicyError("invalid_usage", "Cache categories exceed total input tokens")
    output = count(usage.get("output_tokens", usage.get("completion_tokens", 0)), "output_tokens")
    rates = _rates(request, registry, total)
    uncached = total - cached - writes
    unknown_writes = writes - short - long
    default = decimal_amount(rates["input"])
    short_rate = decimal_amount(rates.get("cache_write_30m", default))
    long_rate = decimal_amount(rates.get("cache_write_12h", default))
    amount = uncached * default + cached * decimal_amount(rates.get("cache_read", default))
    amount += short * short_rate + long * long_rate + unknown_writes * max(short_rate, long_rate)
    # output_tokens already includes reasoning. Never add reasoning_tokens again.
    amount += output * decimal_amount(rates.get("output", 0))
    return int(amount.to_integral_value(rounding=ROUND_CEILING))
