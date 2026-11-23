"""Explicit, hash-bound spend-limit setup; never part of the read-only tracker."""
from datetime import datetime, timedelta, timezone
from decimal import ROUND_CEILING
import hashlib
import json

from .adapters import AdapterError, bounded_call
from .credits import _client, _limit
from .policy import PolicyError, account_cost_max_age, decimal_amount, grant_expiry, timestamp


def plan_digest(plan):
    body = {key: value for key, value in plan.items() if key != "sha256"}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def evidence_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def build_limits_plan(funding, account, policy):
    now = datetime.now(timezone.utc)
    for key in ("organization_id", "project_id"):
        if funding.get(key) != policy.get(key) or account.get(key) != policy.get(key):
            raise PolicyError("funding_target_mismatch", "Limits setup must match the designated organization and project")
    if funding.get("funding_policy") != "existing_prepaid_only" or funding.get("billing_mode") != "prepaid" or funding.get("auto_recharge") != "disabled" or funding.get("automatic_purchases") != "disabled":
        raise PolicyError("automatic_charge_possible", "Limits setup requires verified existing prepaid credits with automatic purchases disabled")
    verified = timestamp(funding.get("verified_at"))
    observed = timestamp(account.get("observed_at"))
    if account.get("source") != "official_admin_api" or account.get("status") != "observed" or observed > now or (now - observed).total_seconds() > account_cost_max_age(policy):
        raise PolicyError("account_costs_stale", "Read supported account costs and current limits before building a setup plan")
    if verified > now:
        raise PolicyError("funding_observation_stale", "Credit confirmation cannot be in the future")
    grants = funding.get("grants")
    if not isinstance(grants, list) or not grants:
        raise PolicyError("funding_unverified", "Confirm the existing grants before setting spending controls")
    available = sum((decimal_amount(g.get("balance_usd")) for g in grants), start=decimal_amount(0))
    if any(decimal_amount(g.get("balance_usd")) and grant_expiry(g) <= now for g in grants):
        raise PolicyError("grant_expired", "Reconcile expired grants before adjusting spending controls")
    allocation = decimal_amount(funding.get("allocation_usd", available))
    if not allocation or allocation > available:
        raise PolicyError("allocation_invalid", "The allocation must fit the freshly confirmed existing credit balance")
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if timestamp(account.get("month_start")) != month_start:
        raise PolicyError("platform_limit_stale", "Account spending must cover the current UTC monthly cycle")
    plan = {"schema_version": 1, "organization_id": policy["organization_id"], "project_id": policy["project_id"],
            "funding_window_id": funding.get("funding_window_id"), "created_at": now.isoformat(),
            "funding_evidence_sha256": evidence_digest(funding),
            "expires_at": (now + timedelta(minutes=5)).isoformat(), "allocation_usd": str(allocation),
            "account_observed_at": account["observed_at"], "previous": {}, "desired": {}}
    for scope in ("organization", "project"):
        previous = account.get(scope + "_spend_limit")
        if not isinstance(previous, dict):
            raise PolicyError("hard_limit_unverified", "Read both current limit states before previewing changes")
        plan["previous"][scope] = previous
        spending = decimal_amount(account.get(scope + "_spend_usd"))
        cents = int(((spending + allocation) * 100).to_integral_value(rounding=ROUND_CEILING))
        plan["desired"][scope] = {"threshold_amount": cents, "currency": "USD", "interval": "month"}
    plan["sha256"] = plan_digest(plan)
    return plan


def apply_limits(plan, expected_sha256, policy, admin_key, *, checkpoint, client=None):
    """Perform at most two planned writes; uncertain effects are never replayed."""
    if policy.get("admin_account_access") == "read_only":
        raise PolicyError("admin_read_only", "Preserve the read-only key; use the one-time manual settings confirmation workflow")
    if not isinstance(plan, dict) or plan_digest(plan) != expected_sha256 or plan.get("sha256") != expected_sha256:
        raise PolicyError("limits_plan_drift", "Review the exact current limits plan before applying it")
    now = datetime.now(timezone.utc)
    if timestamp(plan.get("created_at")) > now or timestamp(plan.get("expires_at")) <= now:
        raise PolicyError("limits_plan_expired", "Refresh the account read and exact limit preview")
    for key in ("organization_id", "project_id"):
        if plan.get(key) != policy.get(key):
            raise PolicyError("funding_target_mismatch", "The limit plan targets a different account")
    if not admin_key:
        raise PolicyError("admin_credential_missing", "Explicit limit setup requires the designated Admin credential")
    owned = client is None
    client = client or _client(admin_key, policy)
    resources = {"organization": client.admin.organization.spend_limit,
                 "project": client.admin.organization.projects.spend_limit}
    args = {"organization": (), "project": (policy["project_id"],)}
    receipt = {"status": "prepared", "plan_sha256": expected_sha256, "applied": [], "observed": {}}
    try:
        for scope in resources:
            current = _limit(bounded_call(resources[scope].retrieve, 20, *args[scope], timeout=20))
            if current != plan["previous"][scope]:
                raise PolicyError("limits_remote_drift", "A spending control changed after preview; no planned writes were started")
        checkpoint(receipt)
        for scope in resources:
            receipt["status"], receipt["in_flight"] = "applying", scope
            checkpoint(receipt)
            result = _limit(bounded_call(resources[scope].update, 20, *args[scope], **plan["desired"][scope], timeout=20))
            desired = plan["desired"][scope]
            if result["enforcement"] != "enforcing" or decimal_amount(result["threshold_usd"]) * 100 != desired["threshold_amount"]:
                raise PolicyError("limits_readback_mismatch", "Limit update did not return the planned enforced threshold")
            receipt["applied"].append(scope)
            receipt["observed"][scope] = result
            receipt["in_flight"] = None
            checkpoint(receipt)
        for scope in resources:
            observed = _limit(bounded_call(resources[scope].retrieve, 20, *args[scope], timeout=20))
            if observed != receipt["observed"][scope]:
                raise PolicyError("limits_readback_mismatch", "Limit state changed during final readback; inspect the recorded account outcome")
        receipt["status"] = "applied"
        checkpoint(receipt)
        return receipt
    except (AdapterError, PolicyError) as exc:
        receipt["status"] = "uncertain" if receipt.get("in_flight") else "blocked"
        receipt["error_code"] = exc.code
        receipt["next_action"] = "Inspect current account limits against this receipt before any retry; inference remains disabled"
        checkpoint(receipt)
        raise PolicyError("limits_setup_incomplete", receipt["next_action"]) from None
    finally:
        if owned:
            client.close()
