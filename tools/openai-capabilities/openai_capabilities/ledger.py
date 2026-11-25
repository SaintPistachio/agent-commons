"""Local, atomic budget reservations and durable metadata without stored prompts."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, datetime as DateTime, timedelta, timezone
from decimal import Decimal, ROUND_FLOOR
import hashlib
import json
from pathlib import Path
import re
import sqlite3
from uuid import uuid4
from zoneinfo import ZoneInfo

from .policy import (PolicyError, account_cost_basis, account_cost_max_age, decimal_amount, funding_expiry,
                     external_request_id_sha256, funding_identity, grant_expiry, timestamp, usd_to_microusd,
                     validate_funding, uses_local_prepaid_budget)


TERMINAL = {"completed", "failed", "cancelled", "expired"}
STATES = TERMINAL | {"reserved", "submitting", "pending", "running", "uncertain", "cancelling", "partial"}
ACTIVE_SYNC_STATES = {"reserved", "submitting", "pending", "running", "cancelling"}
# A superseded hold must have ended this long before the balance observation, so its charge had time to post.
SUPERSEDE_GRACE = timedelta(hours=1)
REQUEST_IDENTITY_VERSION = 1
_PAYLOAD_CONTROL_FIELDS = {
    "max_output_tokens", "reasoning", "service_tier", "prompt_cache_options",
    "prompt_cache_key", "prompt_cache_retention", "store", "background",
}
WEEKLY_BUDGET_TIMEZONE = ZoneInfo("America/Chicago")
WEEKLY_BUDGET_DAYS = 7
WEEKLY_BUDGET_STATE_KEY = "weekly_budget"
WEEKLY_BUDGET_SCHEMA = 1


def _json(value):
    return json.dumps(value, allow_nan=False, separators=(",", ":"))


def _identity_hash(value):
    canonical = json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _intent_hash(purpose):
    if not isinstance(purpose, dict):
        return None
    kind, description = purpose.get("kind"), purpose.get("description")
    if not isinstance(kind, str) or not kind.strip() or not isinstance(description, str) or not description.strip():
        return None
    # Purpose is the stable task identity. Effort, model, tier, budget and the
    # more detailed deliverable do not turn a retry into a different task.
    intent = {"kind": kind.strip(), "description": " ".join(description.split())}
    return _identity_hash(intent)


def _request_identity(request):
    payload = request.get("payload")
    if not isinstance(payload, dict):
        return None
    intent = _intent_hash(request.get("purpose"))
    if intent is None:
        return None
    content = {key: value for key, value in payload.items() if key not in _PAYLOAD_CONTROL_FIELDS}
    return {"intent_sha256": intent,
            "payload_sha256": _identity_hash({"capability": request.get("capability"), "payload": content})}


def _valid_sha256(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


class Ledger:
    def __init__(self, path, policy: dict):
        self.path = Path(path)
        self.policy = policy
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS jobs (
                    job_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    grant_id TEXT NOT NULL, status TEXT NOT NULL, async_job INTEGER NOT NULL,
                    reservation_microusd INTEGER NOT NULL, actual_microusd INTEGER,
                    request_meta TEXT NOT NULL, api_id TEXT, usage TEXT, artifact TEXT,
                    metadata TEXT NOT NULL DEFAULT '{}', external_request_id_sha256 TEXT);
            """)
        with self._db(True) as db:
            columns = {row["name"] for row in db.execute("PRAGMA table_info(jobs)")}
            if "external_request_id_sha256" not in columns:
                db.execute("ALTER TABLE jobs ADD COLUMN external_request_id_sha256 TEXT")
            db.execute("CREATE UNIQUE INDEX IF NOT EXISTS jobs_external_request_id_sha256 "
                       "ON jobs(external_request_id_sha256) WHERE external_request_id_sha256 IS NOT NULL")

    @contextmanager
    def _db(self, immediate=False):
        db = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA busy_timeout=15000")
            db.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
            yield db
            if db.in_transaction:
                db.commit()
        except BaseException:
            if db.in_transaction:
                db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def _setting(db, key, default=None):
        row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    @staticmethod
    def _save(db, key, value):
        db.execute("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, _json(value)))

    def funding(self):
        with self._db() as db:
            return self._setting(db, "funding", {})

    def refresh_funding(self, snapshot: dict):
        validate_funding(snapshot, self.policy)
        with self._db(True) as db:
            current = self._setting(db, "funding", {})
            if snapshot.get("funding_policy") == "existing_prepaid_only":
                identity = funding_identity(snapshot)
                previous = self._setting(db, "funding_window:" + identity)
                if previous:
                    # Reusing an observation never rebases its already-counted local spending.
                    if previous["snapshot"] != snapshot:
                        raise PolicyError("funding_window_changed", "Changed balance, baseline, or limits require a new verified observation identifier")
                else:
                    if current and timestamp(snapshot["verified_at"]) <= timestamp(current["verified_at"]):
                        raise PolicyError("funding_observation_old", "A new balance observation must be newer than the current one")
                    self._save(db, "funding_window:" + identity, {"snapshot": snapshot,
                        "local_spent_baseline": self._spent_before(db, timestamp(snapshot["verified_at"]))})
                    self._supersede_unresolved(db, snapshot, current.get("funding_window_id") if current else None)
                if current and current.get("funding_window_id") != identity:
                    self._save(db, "account_costs", None)
            elif current.get("grant_id") == snapshot["grant_id"] and current:
                # Reverification cannot turn consumption into a fresh allocation.
                if (current["organization_id"], current["project_id"], timestamp(current["expires_at"])) != (
                    snapshot["organization_id"], snapshot["project_id"], timestamp(snapshot["expires_at"])
                ):
                    raise PolicyError("grant_identity_changed", "The same grant ID cannot change its target or expiration")
            self._save(db, "funding", snapshot)
        return snapshot

    def _supersede_unresolved(self, db, snapshot, previous_window):
        """A newer user-confirmed prepaid balance already reflects whatever an unresolved synchronous submission from
        before it cost. Close those holds so they stop reducing the new balance: cost unknown, recorded as a 0
        placeholder with the reason. Jobs that may still be running, that have a retrievable response ID, or that are
        Batch jobs stay held. A charge that posts later is still counted through the organization-wide cost delta
        since the new observation's baseline. Nothing is resent, and closed jobs keep blocking duplicate submissions."""
        observed = timestamp(snapshot["verified_at"])
        now = datetime.now(timezone.utc)
        closed = []
        for row in db.execute("SELECT * FROM jobs WHERE actual_microusd IS NULL AND async_job=0").fetchall():
            job = self._job(row)
            if job["status"] != "uncertain" and job["status"] not in ACTIVE_SYNC_STATES:
                continue
            if isinstance(job["api_id"], str) and job["api_id"].startswith("resp_"):
                continue  # resume can retrieve the real outcome and cost
            if self._stored_request_identities(job) is None:
                continue  # without a task identity a closed row could not keep blocking a retry; leave it for review
            try:
                horizon = self._sync_horizon((job["metadata"] or {}).get("pricing_request") or job["request_meta"] or {})
            except PolicyError:
                continue
            # Only a request whose whole bounded window (all retries) ended, plus a grace period for billing to post,
            # before the balance was observed: the observed balance then reflects whatever it cost, and the helper has
            # long stopped working on it.
            if timestamp(job["updated_at"]) + horizon + SUPERSEDE_GRACE > observed:
                continue
            metadata = {**(job["metadata"] or {}), "superseded_by_balance": {
                "funding_window_id": funding_identity(snapshot), "previous_funding_window_id": previous_window,
                "balance_verified_at": snapshot["verified_at"], "closed_at": now.isoformat(), "prior_status": job["status"],
                "released_reservation_microusd": job["reservation_microusd"],
                "actual_cost": "unknown; 0 is an accounting placeholder, not provider-confirmed usage"}}
            db.execute("UPDATE jobs SET status='failed',updated_at=?,actual_microusd=0,metadata=? WHERE job_id=?",
                       (now.isoformat(), _json(metadata), job["job_id"]))
            closed.append(job["job_id"])
        return closed

    @staticmethod
    def _all_spent(db):
        return db.execute("SELECT COALESCE(SUM(actual_microusd),0) FROM jobs").fetchone()[0]

    @staticmethod
    def _spent_before(db, when):
        return sum(row["actual_microusd"] for row in db.execute("SELECT actual_microusd,updated_at FROM jobs WHERE actual_microusd IS NOT NULL")
                   if timestamp(row["updated_at"]) <= when)

    def _prepaid_totals(self, db, funding):
        baseline = self._setting(db, "funding_window:" + funding_identity(funding))
        if not baseline:
            raise PolicyError("account_baseline_unverified", "The prepaid observation has no durable local spending baseline")
        pending = db.execute("SELECT COALESCE(SUM(reservation_microusd),0) FROM jobs WHERE actual_microusd IS NULL").fetchone()[0]
        return {"spent_microusd": max(0, self._all_spent(db) - baseline["local_spent_baseline"]),
                "reserved_microusd": pending}

    def _prepaid_cost_position(self, db, funding, now, *, allow_stale_costs=False):
        totals = self._prepaid_totals(db, funding)
        evidence = self._setting(db, "account_costs")
        if not evidence or evidence.get("funding_window_id") != funding_identity(funding):
            raise PolicyError("account_costs_unverified", "Refresh supported account costs before each new billable job")
        snapshot = evidence["snapshot"]
        account = self._validate_account_costs(snapshot, funding, now, allow_stale_costs=allow_stale_costs)
        baseline = funding["account_cost_baseline"]
        # An API observation after the balance could include intervening spending.
        # Count the full queried window when the observations cannot be aligned.
        baseline_cost = decimal_amount(baseline["cost_total_usd"]) if account_cost_basis(funding) == "verified_observation_delta" else 0
        api_delta = usd_to_microusd(account - baseline_cost)
        return totals, evidence, snapshot, max(totals["spent_microusd"], api_delta)

    @staticmethod
    def _weekly_usd_floor(value):
        return int((decimal_amount(value) * 1_000_000).to_integral_value(rounding=ROUND_FLOOR))

    @staticmethod
    def _weekly_window(anchor, now):
        anchor_value = anchor if isinstance(anchor, DateTime) else timestamp(anchor, "weekly budget activation")
        if anchor_value.tzinfo is None or now.tzinfo is None:
            raise PolicyError("weekly_budget_state_invalid", "Weekly budget timestamps must include an explicit timezone")
        anchor_local = anchor_value.astimezone(WEEKLY_BUDGET_TIMEZONE)
        now_local = now.astimezone(WEEKLY_BUDGET_TIMEZONE)
        elapsed = now_local - anchor_local
        if elapsed < timedelta(0):
            raise PolicyError("weekly_clock_rollback", "Local time is earlier than weekly-budget activation; correct the clock before submitting")
        index = elapsed // timedelta(days=WEEKLY_BUDGET_DAYS)
        start = anchor_local + timedelta(days=WEEKLY_BUDGET_DAYS * index)
        return index, start, start + timedelta(days=WEEKLY_BUDGET_DAYS)

    @staticmethod
    def _weekly_windows_until(expiry, start):
        delta = expiry.astimezone(WEEKLY_BUDGET_TIMEZONE) - start
        if delta <= timedelta(0):
            return 0
        micros = ((delta.days * 86400 + delta.seconds) * 1_000_000) + delta.microseconds
        week_micros = WEEKLY_BUDGET_DAYS * 86400 * 1_000_000
        return (micros + week_micros - 1) // week_micros

    def _weekly_grant_schedule(self, db, funding, now, window_start, *, allow_stale_costs=False):
        totals, _evidence, _snapshot, consumed = self._prepaid_cost_position(db, funding, now, allow_stale_costs=allow_stale_costs)
        committed = consumed + totals["reserved_microusd"]
        allocation = min(self._weekly_usd_floor(funding["allocation_usd"]),
                         sum(self._weekly_usd_floor(grant["balance_usd"]) for grant in funding["grants"]))
        priority = {"promotional": 0, "unknown": 1, "purchased": 2}
        grants = sorted(funding["grants"], key=lambda grant: (
            priority[grant["funding_type"]], grant_expiry(grant), grant["grant_id"]))
        contributions = []
        cap = 0
        for grant in grants:
            balance = min(self._weekly_usd_floor(grant["balance_usd"]), allocation)
            allocation -= balance
            charged = min(balance, committed)
            committed -= charged
            remaining = balance - charged
            expiry = grant_expiry(grant)
            windows = self._weekly_windows_until(expiry, window_start)
            weekly = remaining // windows if windows else 0
            if windows:
                cap += weekly
            contributions.append({
                "expires_at": expiry.isoformat(),
                "windows_remaining": windows,
                "remaining_microusd_estimate": remaining if windows else 0,
                "weekly_contribution_microusd": weekly,
            })
        return cap, contributions

    @staticmethod
    def _weekly_window_usage(db, window_start, reset_at):
        start_utc = window_start.astimezone(timezone.utc).isoformat()
        reset_utc = reset_at.astimezone(timezone.utc).isoformat()
        row = db.execute(
            "SELECT COALESCE(SUM(CASE WHEN actual_microusd IS NOT NULL THEN actual_microusd ELSE 0 END),0), "
            "COALESCE(SUM(CASE WHEN actual_microusd IS NULL THEN reservation_microusd ELSE 0 END),0) "
            "FROM jobs WHERE created_at>=? AND created_at<?", (start_utc, reset_utc)).fetchone()
        return row[0], row[1]

    def _weekly_budget_candidate(self, db, funding, now, *, allow_stale_costs=False):
        if funding.get("funding_policy") != "existing_prepaid_only":
            return None, 0, False
        stored = self._setting(db, WEEKLY_BUDGET_STATE_KEY)
        if stored is None:
            anchor = now.astimezone(WEEKLY_BUDGET_TIMEZONE)
            activation_pending = True
        else:
            if (not isinstance(stored, dict) or stored.get("schema_version") != WEEKLY_BUDGET_SCHEMA
                    or isinstance(stored.get("schema_version"), bool)
                    or not isinstance(stored.get("window_index"), int) or isinstance(stored.get("window_index"), bool)
                    or stored["window_index"] < 0
                    or not isinstance(stored.get("weekly_limit_microusd"), int)
                    or isinstance(stored.get("weekly_limit_microusd"), bool)
                    or stored["weekly_limit_microusd"] < 0):
                raise PolicyError("weekly_budget_state_invalid", "The saved weekly budget is malformed; preserve the ledger and inspect it before submitting")
            if (not isinstance(stored.get("grant_contributions"), list)
                    or not isinstance(stored.get("budget_basis_funding_window_id"), str)
                    or not stored["budget_basis_funding_window_id"]):
                raise PolicyError("weekly_budget_state_invalid", "The saved weekly grant breakdown is malformed; preserve the ledger and inspect it before submitting")
            for contribution in stored["grant_contributions"]:
                if (not isinstance(contribution, dict)
                        or not isinstance(contribution.get("expires_at"), str)
                        or not isinstance(contribution.get("windows_remaining"), int)
                        or isinstance(contribution.get("windows_remaining"), bool)
                        or contribution["windows_remaining"] < 0
                        or not isinstance(contribution.get("remaining_microusd_estimate"), int)
                        or isinstance(contribution.get("remaining_microusd_estimate"), bool)
                        or contribution["remaining_microusd_estimate"] < 0
                        or not isinstance(contribution.get("weekly_contribution_microusd"), int)
                        or isinstance(contribution.get("weekly_contribution_microusd"), bool)
                        or contribution["weekly_contribution_microusd"] < 0):
                    raise PolicyError("weekly_budget_state_invalid", "The saved weekly grant breakdown is malformed; preserve the ledger and inspect it before submitting")
                timestamp(contribution["expires_at"], "weekly grant expiration")
            anchor = timestamp(stored.get("activated_at"), "weekly budget activation").astimezone(WEEKLY_BUDGET_TIMEZONE)
            previous_admission = stored.get("last_admitted_at")
            if previous_admission is not None and now < timestamp(previous_admission, "last weekly admission"):
                raise PolicyError("weekly_clock_rollback", "Local time is earlier than the last admitted weekly-budget request; correct the clock before submitting")
            activation_pending = False
        index, start, reset = self._weekly_window(anchor, now)
        if stored is not None and stored["window_index"] > index:
            raise PolicyError("weekly_budget_state_invalid", "The saved weekly window is ahead of current local time; preserve the ledger and inspect it before submitting")
        if stored is not None and stored["window_index"] == index:
            state = dict(stored)
            if (timestamp(state.get("window_start"), "weekly window start") != start.astimezone(timezone.utc)
                    or timestamp(state.get("reset_at"), "weekly reset") != reset.astimezone(timezone.utc)):
                raise PolicyError("weekly_budget_state_invalid", "The saved weekly window does not match its activation anchor")
        else:
            cap, contributions = self._weekly_grant_schedule(db, funding, now, start, allow_stale_costs=allow_stale_costs)
            state = {
                "schema_version": WEEKLY_BUDGET_SCHEMA,
                "activated_at": anchor.isoformat(),
                "window_index": index,
                "window_start": start.isoformat(),
                "reset_at": reset.isoformat(),
                "weekly_limit_microusd": cap,
                "grant_contributions": contributions,
                "budget_basis_funding_window_id": funding_identity(funding),
            }
        spent, held = self._weekly_window_usage(db, start, reset)
        current = spent + held
        return state, current, activation_pending

    def _weekly_budget_status(self, db, funding, now, *, allow_stale_costs=False):
        if funding.get("funding_policy") != "existing_prepaid_only":
            return None
        try:
            state, current, activation_pending = self._weekly_budget_candidate(db, funding, now, allow_stale_costs=allow_stale_costs)
            global_available = self._prepaid_available(db, funding, now, allow_stale_costs=allow_stale_costs)
            weekly_remaining = state["weekly_limit_microusd"] - current
            available = max(0, min(weekly_remaining, global_available))
            start = timestamp(state["window_start"], "weekly window start")
            reset = timestamp(state["reset_at"], "weekly reset")
            window_spent, window_held = self._weekly_window_usage(db, start, reset)
            all_held = db.execute(
                "SELECT COALESCE(SUM(reservation_microusd),0) FROM jobs WHERE actual_microusd IS NULL"
            ).fetchone()[0]
            return {
                "status": "activation_pending" if activation_pending else ("exhausted" if weekly_remaining <= 0 else "active"),
                "timezone": "America/Chicago",
                "activation_pending": activation_pending,
                "window_is_provisional": activation_pending,
                "activated_at": None if activation_pending else state["activated_at"],
                "provisional_anchor_at": state["activated_at"] if activation_pending else None,
                "window_index": state["window_index"],
                "window_start": state["window_start"],
                "reset_at": state["reset_at"],
                "weekly_limit_usd": str(Decimal(state["weekly_limit_microusd"]) / 1_000_000),
                "spent_or_reserved_usd": str(Decimal(current) / 1_000_000),
                "window_spent_usd": str(Decimal(window_spent) / 1_000_000),
                "window_held_reservations_usd": str(Decimal(window_held) / 1_000_000),
                "all_unresolved_reservations_usd": str(Decimal(all_held) / 1_000_000),
                "pre_window_reservations_are_in_grant_estimates": True,
                "weekly_remaining_usd": str(Decimal(max(0, weekly_remaining)) / 1_000_000),
                "available_for_new_requests_usd": str(Decimal(available) / 1_000_000),
                "weekly_exhausted": weekly_remaining <= 0,
                "grant_estimates": [{
                    "expires_at": row["expires_at"],
                    "windows_remaining": self._weekly_windows_until(timestamp(row["expires_at"]), now.astimezone(WEEKLY_BUDGET_TIMEZONE)),
                    "remaining_at_window_start_usd_estimate": str(Decimal(row["remaining_microusd_estimate"]) / 1_000_000),
                    "weekly_contribution_usd": str(Decimal(row["weekly_contribution_microusd"]) / 1_000_000),
                } for row in state["grant_contributions"]],
                "grant_balances_are_estimates": True,
            }
        except PolicyError as exc:
            return {"status": "unverified", "error_code": exc.code, "grant_balances_are_estimates": True}

    @staticmethod
    def _manual_limit_verification(funding, now, *, require_current_month=True):
        manual = funding.get("limit_verification")
        if not isinstance(manual, dict) or manual.get("source") != "user_confirmation":
            raise PolicyError("hard_limit_unverified", "Confirm the enforced organization and project caps in Platform before admission")
        verified = timestamp(manual.get("verified_at"), "limit_verification verified_at")
        month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        if verified > now or require_current_month and verified < month:
            raise PolicyError("hard_limit_verification_stale", "Manual cap evidence cannot be future-dated; unavailable API controls require current-month confirmation")
        if funding.get("platform_hard_limit_enforced") is not True:
            raise PolicyError("hard_limit_unverified", "Manual cap evidence must confirm actual hard-limit enforcement")
        return manual

    def _effective_limit(self, scope, snapshot, funding, now):
        """Keep API runtime facts separate from independently verified UI controls."""
        limit = snapshot.get(scope + "_spend_limit")
        if isinstance(limit, dict) and limit.get("availability") == "unavailable":
            if limit.get("http_status") != 404 or limit.get("source") != "official_admin_api":
                raise PolicyError("hard_limit_unverified", "Only a confirmed unavailable API endpoint permits manual cap evidence")
            self._manual_limit_verification(funding, now)
            amount = decimal_amount(funding.get(scope + "_limit_usd"), scope + " confirmed hard limit")
            source = "user_confirmation"
        else:
            if (not isinstance(limit, dict) or limit.get("availability") not in {None, "available"}
                    or limit.get("source", "official_admin_api") != "official_admin_api"
                    or limit.get("enforcement") not in {"enforcing", "inactive"} or limit.get("currency") != "USD"
                    or limit.get("interval") != "month"):
                raise PolicyError("hard_limit_unverified", f"The {scope} monthly hard-limit configuration is unverified")
            amount = decimal_amount(limit.get("threshold_usd"), scope + " hard limit")
            if limit["enforcement"] == "enforcing":
                source = "official_admin_api"
            else:
                # The screenshot verifies the configured control, which need not
                # change when its spend counter resets. A fresh matching API
                # threshold keeps that configuration evidence bound across cycles.
                manual = self._manual_limit_verification(funding, now, require_current_month=False)
                evidence = manual.get("ui_evidence")
                if manual.get("api_status_interpretation") != "configuration_verified_separately" or not isinstance(evidence, dict):
                    raise PolicyError("hard_limit_ui_evidence_missing", "API inactive status requires separately verified configured-control evidence")
                # The confirmation workflow verifies actual image hashes and
                # containment once. Admission validates the durable receipt and
                # exact threshold binding, not an invented meaning of inactive.
                for name in ("organization", "project"):
                    image = evidence.get(name)
                    if (not isinstance(image, dict) or not isinstance(image.get("path"), str) or not image["path"].strip()
                            or not isinstance(image.get("sha256"), str) or not re.fullmatch(r"[a-fA-F0-9]{64}", image["sha256"])):
                        raise PolicyError("hard_limit_ui_evidence_missing", "Retain hash-bound organization and project configured-control screenshots")
                if amount != decimal_amount(funding.get(scope + "_limit_usd"), scope + " confirmed hard limit"):
                    raise PolicyError("hard_limit_ui_mismatch", "API inactive threshold differs from the separately verified configured cap")
                source = "user_screenshot_verified_with_api_inactive"
        if not amount:
            raise PolicyError("hard_limit_unverified", f"The {scope} monthly hard limit must be positive")
        return amount, source

    def _validate_account_costs(self, snapshot, funding, now, *, allow_stale_costs=False):
        if not isinstance(snapshot, dict) or snapshot.get("source") != "official_admin_api" or snapshot.get("status") != "observed":
            raise PolicyError("account_costs_unverified", "Refresh supported organization Costs and enforced limits before a new submission")
        for key in ("organization_id", "project_id"):
            if snapshot.get(key) != funding[key]:
                raise PolicyError("account_cost_target_mismatch", "Account-cost evidence targets a different account")
        observed = timestamp(snapshot.get("observed_at"), "account observed_at")
        end = timestamp(snapshot.get("window_end"), "account window_end")
        start = timestamp(snapshot.get("window_start"), "account window_start")
        baseline = funding["account_cost_baseline"]
        if start != timestamp(baseline["window_start"]) or end < timestamp(baseline["observed_at"]) or end > observed:
            raise PolicyError("account_cost_window_mismatch", "Account-cost evidence does not extend the verified baseline window")
        if observed > now or ((now - end).total_seconds() > account_cost_max_age(self.policy) and not allow_stale_costs):
            raise PolicyError("account_costs_stale", "Refresh account costs immediately before submitting new work")
        amount = decimal_amount(snapshot.get("cost_total_usd"), "account cost_total_usd")
        if amount < decimal_amount(baseline["cost_total_usd"]):
            raise PolicyError("account_costs_decreased", "Costs fell below the verified baseline; reconcile adjustments with a new balance observation")
        month = timestamp(snapshot.get("month_start"), "account month_start")
        if month != now.replace(day=1, hour=0, minute=0, second=0, microsecond=0):
            raise PolicyError("platform_limit_stale", "Account-cost evidence must cover the current UTC monthly limit cycle")
        for scope in ("organization", "project"):
            if not uses_local_prepaid_budget(self.policy):
                self._effective_limit(scope, snapshot, funding, now)
            decimal_amount(snapshot.get(scope + "_spend_usd"), scope + " monthly spend")
        return amount

    def update_account_costs(self, snapshot):
        """Persist supported fresh readbacks; never activate or renew prepaid funding."""
        with self._db(True) as db:
            funding = self._setting(db, "funding", {})
            if funding.get("funding_policy") != "existing_prepaid_only":
                raise PolicyError("funding_policy_unverified", "Record the existing-prepaid observation before updating admission costs")
            now = datetime.now(timezone.utc)
            amount = self._validate_account_costs(snapshot, funding, now)
            old = self._setting(db, "account_costs")
            month = timestamp(snapshot["month_start"])
            monthly_local_baseline = self._spent_before(db, month)
            if old and old.get("funding_window_id") == funding_identity(funding):
                prior = old["snapshot"]
                if timestamp(snapshot["window_end"]) < timestamp(prior["window_end"]) or amount < decimal_amount(prior["cost_total_usd"]):
                    raise PolicyError("account_costs_regressed", "Account-cost refresh cannot discard already-observed spending")
                prior_month = timestamp(prior["month_start"])
                if month < prior_month:
                    raise PolicyError("account_costs_regressed", "Monthly account evidence cannot move to an older cycle")
                if month == prior_month and any(decimal_amount(snapshot[scope + "_spend_usd"]) < decimal_amount(prior[scope + "_spend_usd"])
                                               for scope in ("organization", "project")):
                    raise PolicyError("account_costs_regressed", "Monthly spend readbacks decreased; reconcile adjustments before admitting new work")
                if month == prior_month:
                    monthly_local_baseline = old.get("monthly_local_baseline", monthly_local_baseline)
            reset = month.replace(year=month.year + 1, month=1) if month.month == 12 else month.replace(month=month.month + 1)
            self._save(db, "account_costs", {"funding_window_id": funding_identity(funding), "snapshot": snapshot,
                "monthly_local_baseline": monthly_local_baseline,
                "monthly_cycle": {"month_start": month.isoformat(), "reset_at": reset.isoformat(),
                                  "source": "fresh_supported_account_read"}})
        return snapshot

    def _effective_cycle_reset(self, db, funding, now):
        evidence = self._setting(db, "account_costs")
        if not evidence or evidence.get("funding_window_id") != funding_identity(funding):
            raise PolicyError("account_costs_unverified", "Refresh supported account costs for the current monthly cycle")
        self._validate_account_costs(evidence["snapshot"], funding, now)
        if uses_local_prepaid_budget(self.policy):
            return funding_expiry(funding)
        month = timestamp(evidence["snapshot"]["month_start"])
        reset = month.replace(year=month.year + 1, month=1) if month.month == 12 else month.replace(month=month.month + 1)
        original_reset = timestamp(funding["platform_limit_reset_at"])
        return min(original_reset, reset) if original_reset > now else reset

    def validate_ready_funding(self, now=None):
        """Fresh cycle metadata can renew a spend counter, never credit funding."""
        now = now or datetime.now(timezone.utc)
        with self._db() as db:
            funding = self._setting(db, "funding", {})
            validate_funding(funding, self.policy, now, allow_platform_stale=True)
            if funding.get("funding_policy") != "existing_prepaid_only":
                return timestamp(funding["platform_limit_reset_at"])
            return self._effective_cycle_reset(db, funding, now)

    def _prepaid_available(self, db, funding, now, *, allow_stale_costs=False):
        totals, evidence, snapshot, consumed = self._prepaid_cost_position(db, funding, now, allow_stale_costs=allow_stale_costs)
        baseline = funding["account_cost_baseline"]
        margin = 1 - decimal_amount(self.policy.get("allocation_margin", "0.05"))
        available = usd_to_microusd(decimal_amount(funding["allocation_usd"]) * margin) - consumed - totals["reserved_microusd"]
        if uses_local_prepaid_budget(self.policy):
            return available
        # API billing can lag. Cover locally known consumption not yet visible in
        # monthly account totals, without subtracting the same API delta twice.
        for scope in ("organization", "project"):
            cap = min(decimal_amount(funding[scope + "_limit_usd"]),
                      self._effective_limit(scope, snapshot, funding, now)[0])
            funding_month = timestamp(funding["verified_at"]).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
            current_month = timestamp(snapshot["month_start"])
            if current_month == funding_month:
                baseline_spend = decimal_amount(funding[scope + "_spend_usd"])
                local_new = totals["spent_microusd"]
            else:
                baseline_spend = decimal_amount(0)
                monthly_base = evidence.get("monthly_local_baseline", self._spent_before(db, current_month))
                local_new = max(0, self._all_spent(db) - monthly_base)
            spent = max(baseline_spend, decimal_amount(snapshot[scope + "_spend_usd"]))
            visible_since_baseline = usd_to_microusd(max(0, decimal_amount(snapshot[scope + "_spend_usd"]) - baseline_spend))
            unseen_local = max(0, local_new - visible_since_baseline)
            available = min(available, usd_to_microusd(max(0, cap - spent)) - unseen_local - totals["reserved_microusd"])
        return available

    def set_enabled(self, enabled: bool):
        if not isinstance(enabled, bool):
            raise PolicyError("invalid_enabled", "enabled must be a boolean")
        with self._db(True) as db:
            if enabled:
                funding = self._setting(db, "funding", {})
                validate_funding(funding, self.policy, allow_platform_stale=True)
                if funding.get("funding_policy") == "existing_prepaid_only":
                    self._effective_cycle_reset(db, funding, datetime.now(timezone.utc))
            self._save(db, "enabled", enabled)

    @staticmethod
    def _job(row):
        if row is None:
            raise PolicyError("job_not_found", "No recorded job has that local identifier")
        result = dict(row)
        for field in ("request_meta", "usage", "metadata"):
            result[field] = json.loads(result[field]) if result[field] else None
        result["async_job"] = bool(result["async_job"])
        result.pop("external_request_id_sha256", None)
        return result

    def get_job(self, job_id):
        with self._db() as db:
            return self._job(db.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone())

    def lookup_external_request(self, external_request_id):
        key = external_request_id_sha256(external_request_id)
        with self._db() as db:
            row = db.execute("SELECT * FROM jobs WHERE external_request_id_sha256=?", (key,)).fetchone()
            return self._job(row) if row else None

    def require_external_request_match(self, job, identity_requests):
        candidates = self._request_identities(identity_requests)
        existing = self._stored_request_identities(job)
        if existing is None or existing != candidates:
            raise PolicyError("external_request_conflict", "This external request ID is already bound to a different or unverifiable request")
        return job

    def pending(self):
        with self._db() as db:
            return [self._job(row) for row in db.execute("SELECT * FROM jobs WHERE actual_microusd IS NULL ORDER BY created_at")]

    @staticmethod
    def _totals(db, grant_id):
        # An uncertain old submission can still consume a later grant; retain its reservation.
        row = db.execute("SELECT COALESCE(SUM(CASE WHEN grant_id=? THEN actual_microusd ELSE 0 END),0), COALESCE(SUM(CASE WHEN actual_microusd IS NULL THEN reservation_microusd ELSE 0 END),0) FROM jobs", (grant_id,)).fetchone()
        return {"spent_microusd": row[0], "reserved_microusd": row[1]}

    def spending_mode(self):
        mode = self.policy.get('spending_mode', 'weekly')
        if mode not in ('weekly', 'prepaid-available'):
            raise PolicyError('spending_mode_invalid', 'Spending mode must be weekly or prepaid-available')
        return mode

    def sync_job_limit(self):
        limit = self.policy.get('max_sync_jobs', 1)
        if type(limit) is not int or not 1 <= limit <= 8:
            raise PolicyError('sync_capacity_invalid', 'max_sync_jobs must be an operator-configured integer from 1 through 8')
        return limit

    def weekly_budget_display(self):
        """Weekly budget for display (Agent Commons paces the prepaid grant by it). A stale Costs read is tolerated
        here only; admission keeps the freshness check, since every submission refreshes Costs first."""
        with self._db() as db:
            funding = self._setting(db, "funding", {})
            now = datetime.now(timezone.utc)
            weekly = self._weekly_budget_status(db, funding, now)
            if weekly and weekly.get("error_code") == "account_costs_stale":
                # Only this display call tolerates stale Costs; admission paths never pass the flag.
                weekly = self._weekly_budget_status(db, funding, now, allow_stale_costs=True)
                if weekly and weekly.get("status") != "unverified":
                    weekly["display_from_stale_costs"] = True
            return weekly

    def status(self):
        with self._db() as db:
            funding = self._setting(db, "funding", {})
            now = datetime.now(timezone.utc)
            totals = self._prepaid_totals(db, funding) if funding.get("funding_policy") == "existing_prepaid_only" else self._totals(db, funding.get("grant_id", ""))
            activation = self._activation_total(db)
            limits = {}
            account = self._setting(db, "account_costs")
            if funding.get("funding_policy") == "existing_prepaid_only" and account:
                for scope in ("organization", "project"):
                    try:
                        if uses_local_prepaid_budget(self.policy):
                            limits[scope] = {"source": "local_prepaid_budget", "platform_cap_required": False}
                        else:
                            amount, source = self._effective_limit(scope, account["snapshot"], funding, now)
                            limits[scope] = {"threshold_usd": str(amount), "source": source}
                    except PolicyError as exc:
                        limits[scope] = {"source": "unverified", "error_code": exc.code}
            mode = self.spending_mode()
            if mode == 'prepaid-available' and funding.get('funding_policy') != 'existing_prepaid_only':
                raise PolicyError('funding_policy_invalid', 'Prepaid-available mode requires existing prepaid funding')
            weekly = self._weekly_budget_status(db, funding, now)
            spending = {}
            if 'spending_mode' in self.policy:
                try:
                    spending = {'spending_mode': mode,
                                'prepaid_available_usd': str(Decimal(max(0, self._prepaid_available(db, funding, now))) / 1_000_000)}
                except PolicyError:
                    # Unavailable evidence is not a verified zero balance. Preserve
                    # legacy diagnostics and omit the paired optional observation.
                    pass
            return {"enabled": self._setting(db, "enabled", False), "funding": funding,
                    "sync_concurrency_limit": self.sync_job_limit(), **spending,
                    "funding_window_id": funding.get("funding_window_id"), **totals,
                    "account_cost_basis": account_cost_basis(funding) if funding.get("funding_policy") == "existing_prepaid_only" else "legacy_promotional_only",
                    "activation_consumed_microusd": activation,
                    "effective_limits": limits,
                    "monthly_cycle": account.get("monthly_cycle") if account else None,
                    "weekly_budget": weekly,
                    "pending_jobs": [self._job(row) for row in db.execute("SELECT * FROM jobs WHERE actual_microusd IS NULL ORDER BY created_at")]}

    @staticmethod
    def _activation_total(db):
        return sum((row["actual_microusd"] if row["actual_microusd"] is not None else row["reservation_microusd"])
                   for row in db.execute("SELECT request_meta,actual_microusd,reservation_microusd FROM jobs")
                   if json.loads(row["request_meta"]).get("activation") is True)

    def _local_timeout(self, request):
        value = request.get("local_timeout_seconds", self.policy.get("request_timeout_seconds", 30))
        if isinstance(value, bool):
            raise PolicyError("invalid_execution_bounds", "Local request timeout must be a whole number from 1 to 900 seconds")
        try:
            timeout = decimal_amount(value, "local_timeout_seconds")
        except PolicyError:
            raise PolicyError("invalid_execution_bounds", "Local request timeout must be a whole number from 1 to 900 seconds") from None
        if timeout != timeout.to_integral_value() or not 1 <= timeout <= 900:
            raise PolicyError("invalid_execution_bounds", "Local request timeout must be a whole number from 1 to 900 seconds")
        return timeout

    def _sync_horizon(self, request):
        timeout = self._local_timeout(request)
        retry_elapsed = decimal_amount(self.policy.get("retry_elapsed_seconds", 60), "retry_elapsed_seconds")
        retries = self.policy.get("max_transient_retries", 2)
        if isinstance(retries, bool) or not isinstance(retries, int) or retries < 0:
            raise PolicyError("invalid_execution_bounds", "Configure a nonnegative integer retry limit")
        # Match the service's bounded retry policy while covering time spent in every attempt.
        seconds = timeout * (min(2, retries) + 1) + min(60, retry_elapsed)
        if request.get("allow_standard_fallback") and self.policy.get("standard_fallback") and request.get("tier") == "flex":
            seconds *= 2
        try:
            return timedelta(seconds=float(seconds))
        except (OverflowError, ValueError):
            raise PolicyError("invalid_execution_bounds", "Execution bounds exceed supported datetime limits") from None

    def execution_horizon(self, request, *, async_job=False):
        if not async_job:
            return self._sync_horizon(request)
        timeout = self._local_timeout(request)
        try:
            # Upload and create precede the provider's 24-hour completion window.
            return timedelta(hours=24, seconds=float(timeout * 2))
        except (OverflowError, ValueError):
            raise PolicyError("invalid_execution_bounds", "Execution bounds exceed supported datetime limits") from None

    @staticmethod
    def _stored_request_identities(job):
        """Read current fingerprints or conservatively derive a legacy intent key."""
        try:
            stored_meta = job["request_meta"]
            meta = stored_meta if isinstance(stored_meta, dict) else json.loads(stored_meta)
        except (KeyError, TypeError, ValueError):
            return None
        if not isinstance(meta, dict):
            return None
        version = meta.get("request_identity_version")
        if version is not None:
            if type(version) is not int or version != REQUEST_IDENTITY_VERSION:
                return None
            identities = meta.get("request_identities")
            if not isinstance(identities, list) or not identities or len(identities) > 1000:
                return None
            if any(not isinstance(item, dict) or not _valid_sha256(item.get("intent_sha256"))
                   or not _valid_sha256(item.get("payload_sha256")) for item in identities):
                return None
            return identities

        # Legacy rows never stored provider input. Their purpose text can identify
        # a different task, but cannot prove that an altered-purpose payload differs.
        purposes = []
        purpose = meta.get("purpose")
        if purpose is not None:
            purposes.append(purpose)
        if job["async_job"]:
            try:
                details = json.loads(job["metadata"] or "{}")
            except (KeyError, TypeError, ValueError):
                return None
            items = details.get("items") if isinstance(details, dict) else None
            if not isinstance(items, dict) or not items or len(items) > 1000:
                return None
            purposes = [item.get("purpose") if isinstance(item, dict) else None for item in items.values()]
        if not purposes:
            return None
        legacy = [{"intent_sha256": _intent_hash(value), "payload_sha256": None} for value in purposes]
        if any(item["intent_sha256"] is None for item in legacy):
            return None
        return legacy

    @staticmethod
    def _request_identities(requests):
        if not isinstance(requests, (list, tuple)) or not requests or len(requests) > 1000:
            raise PolicyError("request_identity_unavailable", "A bounded request set is required for replay protection")
        identities = [_request_identity(request) if isinstance(request, dict) else None for request in requests]
        if any(identity is None for identity in identities):
            raise PolicyError("request_identity_unavailable", "Request purpose and payload must support replay protection")
        return identities

    @staticmethod
    def _identities_overlap(left, right):
        for field in ("intent_sha256", "payload_sha256"):
            left_values = {item.get(field) for item in left if item.get(field)}
            if any(item.get(field) in left_values for item in right if item.get(field)):
                return True
        return False

    def _check_reservation(self, db, request, amount_microusd, *, async_job=False, identity_requests=None,
                           now=None):
        if isinstance(amount_microusd, bool) or not isinstance(amount_microusd, int) or amount_microusd <= 0:
            raise PolicyError("invalid_reservation", "Reservation must be positive integer micro-USD")
        now = now or datetime.now(timezone.utc)
        if not self._setting(db, "enabled", False):
            raise PolicyError("execution_disabled", "New API submissions are disabled")
        funding = self._setting(db, "funding", {})
        validate_funding(funding, self.policy, now, allow_platform_stale=True)
        mode = self.spending_mode()
        if mode == 'prepaid-available' and funding.get('funding_policy') != 'existing_prepaid_only':
            raise PolicyError('funding_policy_invalid', 'Prepaid-available mode requires existing prepaid funding')
        # Funding must cover the entire bounded workflow, not just admission time.
        required_deadline = now + self.execution_horizon(request, async_job=async_job)
        deadline = timestamp(request["deadline"], "deadline") if "deadline" in request else required_deadline
        if deadline < required_deadline:
            raise PolicyError("deadline_too_short", "Job deadline does not cover its bounded execution and retry window")
        if deadline > funding_expiry(funding):
            raise PolicyError("grant_deadline_exceeded", "Grant expires before this job's deadline")
        platform_reset = self._effective_cycle_reset(db, funding, now) if funding.get("funding_policy") == "existing_prepaid_only" else timestamp(funding["platform_limit_reset_at"])
        if deadline > platform_reset:
            raise PolicyError("platform_deadline_exceeded", "Refresh platform limit evidence for the job's full completion window")

        outstanding = db.execute("SELECT async_job,status,request_meta,metadata FROM jobs WHERE actual_microusd IS NULL").fetchall()
        if not async_job and sum(not row["async_job"] and row["status"] in ACTIVE_SYNC_STATES for row in outstanding) >= self.sync_job_limit():
            raise PolicyError("sync_slot_busy", "The local synchronous inference safety capacity is occupied; collect an active job before submitting another")
        # Holds closed without a known outcome (superseded by a newer balance, or written off) never free their task for
        # a retry: the submission may have run.
        closed_unknown = db.execute("SELECT async_job,status,request_meta,metadata FROM jobs WHERE actual_microusd IS NOT NULL AND "
                                    "json_valid(metadata) AND (json_extract(metadata,'$.superseded_by_balance') IS NOT NULL OR "
                                    "json_extract(metadata,'$.write_off') IS NOT NULL)").fetchall()
        candidates = self._request_identities(identity_requests if identity_requests is not None else [request])
        for row in [*outstanding, *closed_unknown]:
            previous = self._stored_request_identities(row)
            if previous is None:
                raise PolicyError("duplicate_scope_unresolved", "An unresolved API submission has no reliable task identity; reconcile or classify it before new submissions")
            if self._identities_overlap(candidates, previous):
                raise PolicyError("duplicate_request", "This task or provider-bound input already has an unresolved API submission; reconcile it before retrying")

        weekly_state = None
        if funding.get("funding_policy") == "existing_prepaid_only":
            available = self._prepaid_available(db, funding, now)
            weekly_state, weekly_usage, _activation_pending = self._weekly_budget_candidate(db, funding, now)
            weekly_remaining = weekly_state["weekly_limit_microusd"] - weekly_usage
            if self.spending_mode() == 'weekly':
                if amount_microusd > weekly_remaining:
                    raise PolicyError("weekly_budget_exhausted", "Reservation exceeds the remaining weekly prepaid allowance; new API inference may be admitted at the recorded weekly reset")
                available = min(available, weekly_remaining)
        else:
            totals = self._totals(db, funding["grant_id"])
            allocation = usd_to_microusd(decimal_amount(funding["allocation_usd"]) * (1 - decimal_amount(self.policy.get("allocation_margin", "0.05"))))
            available = allocation - totals["spent_microusd"] - totals["reserved_microusd"]
        if amount_microusd > available:
            raise PolicyError("allocation_exhausted", "Reservation does not fit the allocation after spending, pending work, and margin")
        if request.get("activation") is True and amount_microusd + self._activation_total(db) > usd_to_microusd(self.policy.get("activation_max_usd", "1")):
            raise PolicyError("activation_budget_exhausted", "Activation reservations and settled spending exceed the aggregate activation allowance")
        meta = {key: request[key] for key in ("capability", "purpose", "model", "tier", "deadline", "activation", "local_timeout_seconds") if key in request}
        meta["request_identity_version"] = REQUEST_IDENTITY_VERSION
        meta["request_identities"] = candidates
        return {"funding": funding, "deadline": deadline, "available_microusd": available, "request_meta": meta,
                "checked_at": now, "weekly_budget_state": weekly_state}

    def check_reservation(self, request, amount_microusd: int, *, async_job=False, identity_requests=None):
        """Read-only admission check; reserve() repeats it atomically before dispatch."""
        with self._db() as db:
            admission = self._check_reservation(db, request, amount_microusd, async_job=async_job,
                                                identity_requests=identity_requests)
            return {"status": "eligible", "request_count": len(admission["request_meta"]["request_identities"])}

    def reserve(self, request, amount_microusd: int, *, async_job=False, job_id=None, identity_requests=None):
        job_id = job_id or str(uuid4())
        with self._db(True) as db:
            admission = self._check_reservation(db, request, amount_microusd, async_job=async_job,
                                                identity_requests=identity_requests)
            created_at = admission["checked_at"].isoformat()
            try:
                weekly = admission.get("weekly_budget_state")
                if weekly is not None:
                    weekly["last_admitted_at"] = created_at
                    self._save(db, WEEKLY_BUDGET_STATE_KEY, weekly)
                db.execute("INSERT INTO jobs(job_id,created_at,updated_at,grant_id,status,async_job,reservation_microusd,request_meta) VALUES (?,?,?,?,?,?,?,?)",
                           (job_id, created_at, created_at, funding_identity(admission["funding"]), "reserved", int(async_job), amount_microusd,
                            _json(admission["request_meta"])))
            except sqlite3.IntegrityError:
                raise PolicyError("duplicate_job", "Job ID already exists; resume the existing job instead") from None
        return self.get_job(job_id)

    def reserve_external_request(self, request, amount_microusd: int, *, async_job=False,
                                 identity_requests=None):
        """Atomically reuse a matching operation or persist its first reservation."""
        if "external_request_id" not in request:
            raise PolicyError("external_request_id_required", "A stable external_request_id is required for correlated admission")
        external_hash = external_request_id_sha256(request["external_request_id"])
        identities = self._request_identities(identity_requests if identity_requests is not None else [request])
        job_id = str(uuid4())
        with self._db(True) as db:
            existing = db.execute("SELECT * FROM jobs WHERE external_request_id_sha256=?", (external_hash,)).fetchone()
            if existing is not None:
                job = self._job(existing)
                self.require_external_request_match(job, identity_requests if identity_requests is not None else [request])
                return job, True
            admission = self._check_reservation(db, request, amount_microusd, async_job=async_job,
                                                identity_requests=identity_requests)
            created_at = admission["checked_at"].isoformat()
            weekly = admission.get("weekly_budget_state")
            if weekly is not None:
                weekly["last_admitted_at"] = created_at
                self._save(db, WEEKLY_BUDGET_STATE_KEY, weekly)
            db.execute("INSERT INTO jobs(job_id,created_at,updated_at,grant_id,status,async_job,reservation_microusd,request_meta,external_request_id_sha256) "
                       "VALUES (?,?,?,?,?,?,?,?,?)",
                       (job_id, created_at, created_at, funding_identity(admission["funding"]), "reserved",
                        int(async_job), amount_microusd, _json(admission["request_meta"]), external_hash))
        return self.get_job(job_id), False

    def update_job(self, job_id, status, *, api_id=None, usage=None, actual_microusd=None, artifact=None, metadata=None):
        if status not in STATES:
            raise PolicyError("invalid_job_state", "Unknown local job state")
        if actual_microusd is not None and (isinstance(actual_microusd, bool) or not isinstance(actual_microusd, int) or actual_microusd < 0 or status not in TERMINAL):
            raise PolicyError("invalid_settlement", "Only a terminal job with verified nonnegative integer cost can release a reservation")
        with self._db(True) as db:
            job = self._job(db.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone())
            if job["actual_microusd"] is not None and (status != job["status"] or actual_microusd != job["actual_microusd"]):
                raise PolicyError("job_already_settled", "A settled job cannot be changed or resubmitted")
            merged = {**(job["metadata"] or {}), **(metadata or {})}
            db.execute("UPDATE jobs SET status=?,updated_at=?,api_id=?,usage=?,actual_microusd=?,artifact=?,metadata=? WHERE job_id=?",
                       (status, datetime.now(timezone.utc).isoformat(), api_id or job["api_id"], _json(usage) if usage is not None else _json(job["usage"]),
                        actual_microusd if actual_microusd is not None else job["actual_microusd"], artifact or job["artifact"], _json(merged), job_id))
        return self.get_job(job_id)
