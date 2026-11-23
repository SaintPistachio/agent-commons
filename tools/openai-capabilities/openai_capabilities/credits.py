"""On-demand, read-only API cost tracking, separate from billable execution.

Legacy observations retain their documented display-only behavior. Explicit
existing-prepaid observations carry a stable account-cost baseline and individual
grant expirations. Admission readbacks include unfiltered organization costs and
current-month organization/project costs plus enforced limits. Display estimates
subtract the greater of known local spending or the API delta, never their sum.
An API baseline after a balance observation cannot establish an exact remaining
balance. Neither this module nor a cost refresh activates billable submissions.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
import logging
import os
import time
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .policy import PolicyError, account_cost_basis, decimal_amount, grant_expiry, microusd_to_usd, timestamp, uses_local_prepaid_budget
from .adapters import AdapterError, bounded_call


API_BASE = "https://api.openai.com/v1"
MAX_PAGES = 20
MAX_WINDOW_DAYS = 180
MAX_ELAPSED_SECONDS = 60


def _now():
    return datetime.now(timezone.utc)


def _object(value):
    if isinstance(value, dict):
        return value
    if callable(getattr(value, "model_dump", None)):
        result = value.model_dump(mode="json")
        if isinstance(result, dict):
            return result
    raise PolicyError("credits_response_invalid", "Account API returned an unsupported response shape")


def _targets(observations, policy=None):
    if not isinstance(observations, dict):
        raise PolicyError("credits_observation_missing", "A verified, nonsecret credit observation is required")
    for name in ("organization_id", "project_id"):
        if not isinstance(observations.get(name), str) or not observations[name].strip():
            raise PolicyError("credits_target_missing", "Credit observations must identify an organization and project")
        if policy is not None and observations[name] != policy.get(name):
            raise PolicyError("credits_target_mismatch", "Credit observation target differs from the designated policy target")


def _window(observations):
    observed = timestamp(observations.get("observed_at", observations.get("verified_at")), "observed_at")
    now = _now()
    if observed > now:
        raise PolicyError("credits_observation_invalid", "Credit observation cannot be in the future")
    baseline = observations.get("account_cost_baseline", {})
    start = timestamp(baseline["window_start"], "baseline window_start") if "window_start" in baseline else observed.replace(hour=0, minute=0, second=0, microsecond=0)
    if (now - start).total_seconds() > MAX_WINDOW_DAYS * 86400:
        raise PolicyError("credits_observation_stale", "The account-cost window exceeds 180 days; a new verified observation is required")
    return observed, start, now


def _limit(value):
    value = _object(value)
    amount = value.get("threshold_amount")
    state = value.get("enforcement", {}).get("status") if isinstance(value.get("enforcement"), dict) else None
    if (isinstance(amount, bool) or not isinstance(amount, int) or amount < 0
            or value.get("currency") != "USD" or value.get("interval") != "month"
            or state not in {"inactive", "enforcing"}):
        raise PolicyError("credits_response_invalid", "Hard-limit API returned an unsupported limit or enforcement state")
    return {"threshold_usd": str(Decimal(amount) / 100), "currency": "USD",
            "interval": "month", "enforcement": state}


def _client(admin_key, policy):
    # Explicit empty inference key suppresses environment fallback. Never expose
    # this client to inference adapters or offer arbitrary request destinations.
    if os.environ.get("OPENAI_CUSTOM_HEADERS"):
        raise PolicyError("ambient_headers_forbidden", "Remove ambient OpenAI custom headers before account tracking")
    try:
        for name in ("openai", "httpx2", "httpcore2"):
            logger = logging.getLogger(name)
            logger.handlers = [logging.NullHandler()]
            logger.propagate = False
            logger.disabled = True
        from openai import OpenAI
        import httpx2
    except ImportError:
        raise PolicyError("sdk_missing", "Install the pinned official SDK in the helper environment") from None
    return OpenAI(api_key="", admin_api_key=admin_key,
                  organization=policy["organization_id"], project=policy["project_id"],
                  base_url=API_BASE, max_retries=0, timeout=20,
                  http_client=httpx2.Client(trust_env=False, follow_redirects=False, timeout=20))


def refresh_costs(observations, policy, admin_key, client=None):
    """Read Costs and hard limits; returns a snapshot and never writes account state.

    The parent loads an explicitly designated admin-only credential. There is no
    ambient-key fallback, grant renewal inference, or funding activation here.
    An injected client is a test seam, not an exposed CLI option.
    """
    _targets(observations, policy)
    if not isinstance(admin_key, str) or not admin_key.strip():
        raise PolicyError("admin_credential_missing", "A separate, explicitly designated Admin API credential is required for cost tracking")
    observed, start, end = _window(observations)
    owned = client is None
    client = client if client is not None else _client(admin_key, policy)
    began = time.monotonic()
    pages_used = 0
    read_stage = "costs"

    def remaining():
        seconds = MAX_ELAPSED_SECONDS - (time.monotonic() - began)
        if seconds <= 0:
            raise PolicyError("credits_refresh_incomplete", "Account tracking exceeded its bounded read window; no partial total was accepted")
        return min(20, seconds)

    def query_costs(window_start):
        nonlocal pages_used
        total, project = Decimal(0), Decimal(0)
        page, cursors, records = None, set(), set()
        while pages_used < MAX_PAGES:
            pages_used += 1
            arguments = {"start_time": int(window_start.timestamp()), "end_time": int(end.timestamp()),
                         "bucket_width": "1d", "limit": 180, "group_by": ["project_id"],
                         "timeout": remaining()}
            if page is not None:
                arguments["page"] = page
            result = _object(bounded_call(client.admin.organization.usage.costs, remaining(), **arguments))
            buckets = result.get("data")
            if not isinstance(buckets, list) or not isinstance(result.get("has_more"), bool):
                raise PolicyError("credits_response_invalid", "Costs API returned invalid pagination or buckets")
            for bucket in buckets:
                if not isinstance(bucket, dict) or not isinstance(bucket.get("results"), list):
                    raise PolicyError("credits_response_invalid", "Costs API returned an invalid bucket")
                for row in bucket["results"]:
                    if not isinstance(row, dict) or row.get("object") != "organization.costs.result":
                        raise PolicyError("credits_response_invalid", "Costs API returned an unexpected result kind")
                    amount = row.get("amount")
                    if not isinstance(amount, dict) or amount.get("currency") != "usd":
                        raise PolicyError("credits_response_invalid", "Costs API did not return a USD cost amount")
                    identity = (bucket.get("start_time"), bucket.get("end_time"), row.get("project_id"))
                    if identity in records:
                        raise PolicyError("credits_refresh_incomplete", "Costs API repeated a grouped record; no partial total was accepted")
                    records.add(identity)
                    value = decimal_amount(amount.get("value"), "cost amount")
                    total += value
                    if row.get("project_id") == observations["project_id"]:
                        project += value
            if not result["has_more"]:
                return total, project
            page = result.get("next_page")
            if not isinstance(page, str) or not page or page in cursors:
                raise PolicyError("credits_refresh_incomplete", "Costs API pagination was incomplete or repeated")
            cursors.add(page)
        raise PolicyError("credits_refresh_incomplete", "Costs API exceeded the bounded page limit; no partial total was accepted")

    def read_limit(operation, *args):
        try:
            return _limit(bounded_call(operation, remaining(), *args, timeout=remaining()))
        except AdapterError as exc:
            # A confirmed missing read endpoint is not a cap value or an access
            # failure. Keep the unavailable API fact separate from manual proof.
            if exc.code == "not_found":
                return {"availability": "unavailable", "http_status": 404, "source": "official_admin_api"}
            raise

    try:
        total, project_total = query_costs(start)
        monthly = None
        if policy.get("funding_policy") == "existing_prepaid_only":
            month_start = end.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
            month_org, month_project = (total, project_total) if start == month_start else query_costs(month_start)
            monthly = {"month_start": month_start.isoformat(), "organization_spend_usd": str(month_org),
                       "project_spend_usd": str(month_project)}
        if uses_local_prepaid_budget(policy):
            # Cost observations remain mandatory. Do not claim a platform cap or
            # call an unavailable cap endpoint when local-only control is authorized.
            org_limit = {"availability": "not_requested", "source": "local_prepaid_budget"}
            project_limit = dict(org_limit)
        else:
            read_stage = "organization_limit"
            org_limit = read_limit(client.admin.organization.spend_limit.retrieve)
            read_stage = "project_limit"
            project_limit = read_limit(client.admin.organization.projects.spend_limit.retrieve, observations["project_id"])
        remaining()
    except PolicyError:
        raise
    except Exception as exc:
        # SDK errors can contain keys, URLs, headers, and private account data.
        # Keep only a fixed diagnostic class; do not format the exception.
        status = getattr(exc, "status_code", None)
        if status in {401, 403} or (isinstance(exc, AdapterError) and exc.code in {"authentication_failed", "invalid_api_key", "permission_denied"}):
            raise PolicyError("admin_access_denied", "The designated Admin credential lacks account-read access; no alternate key was tried") from None
        if isinstance(exc, AdapterError):
            diagnostics = {"failure_stage": read_stage,
                "remote_outcome_uncertain": bool(exc.uncertain),
                "retryable": bool(exc.retryable),
                **({"failure_class": exc.failure_class} if exc.failure_class else {}),
                **({"exception_type": exc.exception_type} if exc.exception_type else {}),
                **({"http_status": exc.http_status} if exc.http_status is not None else {}),
                **({"transport_cause_type": exc.transport_cause_type} if exc.transport_cause_type else {}),
                **({"provider_request_id": exc.provider_request_id} if exc.provider_request_id else {})}
            raise PolicyError("credits_" + exc.code,
                "Account read failed during " + read_stage + "; classified error " + exc.code + ". Prior observations remain unchanged",
                diagnostics=diagnostics) from None
        if isinstance(exc, (AttributeError, TypeError)):
            raise PolicyError("credits_sdk_contract_error", "The installed SDK rejected the account-read call shape during " + read_stage) from None
        raise PolicyError("credits_refresh_failed", "The bounded account API read failed; prior observations remain unchanged") from None
    finally:
        if owned:
            try:
                client.close()
            except Exception:
                pass
    return {"schema_version": 1, "status": "observed", "source": "official_admin_api",
            "organization_id": observations["organization_id"], "project_id": observations["project_id"],
            "observed_at": _now().isoformat(), "window_start": start.isoformat(),
            "window_end": end.isoformat(), "cost_total_usd": str(total),
            **(monthly or {}),
            "organization_spend_limit": org_limit, "project_spend_limit": project_limit,
            "limits_api_available": None if uses_local_prepaid_budget(policy) else all(limit.get("availability") != "unavailable" for limit in (org_limit, project_limit)),
            "platform_limits_required": not uses_local_prepaid_budget(policy),
            "grant_balance_verified": False, "funding_activation_allowed": False,
            "next_action": "Grant balances, expirations, funding sources, and Auto Recharge are not returned by these APIs"}


def _track_prepaid_status(observations, local_status, api_snapshot=None):
    _targets(observations)
    now = _now()
    verified = timestamp(observations.get("verified_at"), "verified_at")
    if verified > now:
        raise PolicyError("credits_observation_invalid", "Credit observation cannot be in the future")
    grants = observations.get("grants")
    if not isinstance(grants, list) or not 1 <= len(grants) <= 100:
        raise PolicyError("credits_observation_invalid", "Provide the observed existing prepaid grants")
    rows, balance, expired, seen = [], Decimal(0), False, set()
    for grant in grants:
        if not isinstance(grant, dict) or not isinstance(grant.get("grant_id"), str) or not grant["grant_id"] or grant["grant_id"] in seen:
            raise PolicyError("credits_observation_invalid", "Each grant needs a unique local observation identifier")
        seen.add(grant["grant_id"])
        remaining = decimal_amount(grant.get("balance_usd"), "grant balance_usd")
        expires = grant_expiry(grant)
        days = (expires.date() - now.date()).days
        expired |= bool(remaining and expires <= now)
        balance += remaining
        rows.append({"grant_id": grant.get("grant_id"), "balance_usd": str(remaining),
                     "funding_type": grant.get("funding_type", "unknown"),
                     "expires_at": expires.isoformat(), "days_to_expiration": days,
                     "state": "expired" if expires <= now else "expiring_soon" if days <= 7 else "available_at_observation"})
    local = decimal_amount(microusd_to_usd(local_status.get("spent_microusd", 0)))
    reserved = decimal_amount(microusd_to_usd(local_status.get("reserved_microusd", 0)))
    result = {"status": "snapshot", "organization_id": observations["organization_id"],
              "project_id": observations["project_id"], "funding_window_id": observations.get("funding_window_id"),
              "grant_observed_at": observations["verified_at"], "expiration_date_basis": "UTC start for date-only evidence",
              "grants": sorted(rows, key=lambda row: row["expires_at"]), "observed_balance_usd": str(balance),
              "local_spent_usd": str(local), "local_reserved_usd": str(reserved),
              "pending_jobs": len(local_status.get("pending_jobs", [])), "account_cost_snapshot": api_snapshot,
              "estimated_remaining_usd": None, "funding_activation_allowed": False,
              "account_cost_basis": "unverified", "estimate_note": "Refresh supported account costs; grant balances remain observed evidence"}
    if api_snapshot is None:
        return result
    _targets(api_snapshot, observations)
    baseline = observations.get("account_cost_baseline")
    if not isinstance(baseline, dict):
        return result
    baseline_at = timestamp(baseline.get("observed_at"), "baseline observed_at")
    if (timestamp(api_snapshot.get("window_start")) != timestamp(baseline.get("window_start"))
            or timestamp(api_snapshot.get("window_end")) < baseline_at
            or timestamp(api_snapshot.get("observed_at")) > now):
        raise PolicyError("credits_snapshot_mismatch", "Account-cost snapshot does not extend this balance observation's baseline")
    total = decimal_amount(api_snapshot.get("cost_total_usd"), "account costs")
    original = decimal_amount(baseline.get("cost_total_usd"), "baseline costs")
    if total < original:
        raise PolicyError("credits_baseline_invalid", "Account costs decreased; verify a fresh balance and baseline before estimating")
    if account_cost_basis(observations) == "conservative_lower_bound":
        result["account_cost_basis"] = "conservative_lower_bound"
        result["estimate_note"] = "API baseline follows the manual balance observation or predates it by more than five minutes; admission conservatively bounds full-window costs, but no remaining balance is calculated from those unaligned observations"
    elif expired:
        result["account_cost_basis"] = "expiry_requires_reconciliation"
        result["estimate_note"] = "A recorded balance expired; verify surviving prepaid credits before estimating or submitting new work"
    else:
        consumed = max(local, total - original)
        result["account_cost_basis"] = "verified_observation_delta"
        result["estimated_remaining_usd"] = str(max(Decimal(0), balance - consumed))
        result["spendable_estimate_after_reservations_usd"] = str(max(Decimal(0), balance - consumed - reserved))
        result["estimate_note"] = "Verified balance minus the greater of local settled spending since its baseline and organization-wide API cost delta; pending reservations are separate, and unreported external usage remains possible"
    return result


def track_status(observations, local_status, api_snapshot=None):
    """Combine grant snapshots and local/account usage without double subtraction."""
    if isinstance(observations, dict) and observations.get("funding_policy") == "existing_prepaid_only":
        return _track_prepaid_status(observations, local_status, api_snapshot)
    _targets(observations)
    observed = timestamp(observations.get("observed_at"), "observed_at")
    now = _now()
    if observed > now:
        raise PolicyError("credits_observation_invalid", "Credit observation cannot be in the future")
    date_basis = observations.get("timezone", "UTC")
    try:
        zone = timezone.utc if date_basis == "UTC" else ZoneInfo(date_basis)
    except ZoneInfoNotFoundError:
        # Windows Python can lack the optional IANA database. Expiry days remain
        # usable without installing another dependency; disclose their UTC basis.
        zone, date_basis = timezone.utc, "UTC (requested timezone database unavailable)"
    except TypeError:
        raise PolicyError("credits_observation_invalid", "Credit observation timezone must be a name") from None
    today = now.astimezone(zone).date()
    grants = observations.get("grants")
    if not isinstance(grants, list) or len(grants) > 100:
        raise PolicyError("credits_observation_invalid", "Credit observations must contain at most 100 grants")
    results = []
    balance = Decimal(0)
    expiry_since_observation = False
    for grant in grants:
        if not isinstance(grant, dict):
            raise PolicyError("credits_observation_invalid", "Credit grant must be an object")
        try:
            expires = date.fromisoformat(grant.get("expires_on"))
        except (TypeError, ValueError):
            raise PolicyError("credits_observation_invalid", "Credit grant expiration must be a calendar date") from None
        amount = decimal_amount(grant.get("amount_usd"), "grant amount")
        remaining = decimal_amount(grant.get("balance_usd"), "grant balance")
        if remaining > amount:
            raise PolicyError("credits_observation_invalid", "Observed grant balance exceeds the issued amount")
        days = (expires - today).days
        balance += remaining
        expiry_since_observation |= expires <= today
        results.append({"amount_usd": str(amount), "balance_usd": str(remaining),
                        "expires_on": expires.isoformat(), "days_to_expiration": days,
                        "funding_type": grant.get("funding_type", "unknown"),
                        "state": "expired_or_expires_today" if days <= 0 else "expiring_soon" if days <= 7 else "available_at_observation"})
    results.sort(key=lambda row: row["expires_on"])
    if not isinstance(local_status, dict):
        raise PolicyError("credits_local_status_invalid", "Local accounting status must be an object")
    result = {"status": "snapshot", "organization_id": observations["organization_id"],
              "project_id": observations["project_id"], "grant_observed_at": observations["observed_at"],
              "expiration_date_basis": date_basis,
              "grants": results, "observed_balance_usd": str(balance),
              "local_spent_usd": microusd_to_usd(local_status.get("spent_microusd", 0)),
              "local_reserved_usd": microusd_to_usd(local_status.get("reserved_microusd", 0)),
              "pending_jobs": len(local_status.get("pending_jobs", [])),
              "account_cost_snapshot": None, "estimated_remaining_usd": None,
              "funding_activation_allowed": False,
              "estimate_note": "A grant snapshot is not a live balance; local usage and pending reservations are shown separately"}
    if api_snapshot is None:
        return result
    _targets(api_snapshot, observations)
    api_observed = timestamp(api_snapshot.get("observed_at"), "API observed_at")
    start = timestamp(api_snapshot.get("window_start"), "cost window_start")
    end = timestamp(api_snapshot.get("window_end"), "cost window_end")
    expected = observed.replace(hour=0, minute=0, second=0, microsecond=0)
    if start != expected or end < observed or end > api_observed or api_observed > now:
        raise PolicyError("credits_snapshot_mismatch", "Account-cost snapshot does not cover this grant observation window")
    total = decimal_amount(api_snapshot.get("cost_total_usd"), "account costs")
    result["account_cost_snapshot"] = api_snapshot
    if "baseline_cost_usd" in observations:
        baseline_at = timestamp(observations.get("baseline_verified_at"), "baseline_verified_at")
        baseline = decimal_amount(observations["baseline_cost_usd"], "baseline costs")
        if baseline_at != observed or baseline > total:
            raise PolicyError("credits_baseline_invalid", "Cost baseline must match the grant observation instant and not exceed current costs")
        if not expiry_since_observation:
            delta = total - baseline
            result["estimated_remaining_usd"] = str(max(Decimal(0), balance - delta))
            result["estimate_note"] = "Estimate from verified grant snapshot minus organization API cost delta; assumes no later grants, purchases, refunds, adjustments, or expiry; local costs are already included"
        else:
            result["estimate_note"] = "A recorded grant has reached its expiry date; a new verified grant observation is required before estimating remaining funds"
    else:
        result["estimate_note"] = "Costs include the observation's full UTC day; no contemporaneous cost baseline exists, so subtracting them from a mid-day balance would be misleading"
    return result
