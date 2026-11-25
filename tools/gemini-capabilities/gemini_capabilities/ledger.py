"""SQLite ledger: funding snapshots, reservations, settlement and admission for the Gemini credit helper.

All amounts are integer micro-USD. Admission and reservation commit together in one IMMEDIATE transaction.
Only promotional and already-purchased credit explicitly allocated in a funding snapshot is spendable.
"""
import json
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal, InvalidOperation

from .dpapi import HelperError

OPEN = ("submitting", "uncertain")
MONTH = timedelta(days=30)
DEFAULT_POLICY = {"allocation_margin": "0.05", "reservation_margin": "0.15", "monthly_target_usd": "10.00",
                  "max_job_usd": "2.00", "request_timeout_seconds": 600, "max_concurrent": 2,
                  "billing_lag_hours": 48, "funding_max_age_days": 35, "thinking_reserve_tokens": 24576}


def now_utc():
    return datetime.now(timezone.utc)


def iso(value):
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_time(value, field):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        raise HelperError("invalid_input", f"{field} must be an RFC 3339 time") from None
    if parsed.tzinfo is None:
        raise HelperError("invalid_input", f"{field} must include a time zone")
    return parsed.astimezone(timezone.utc)


def micro(value, field, *, up=False):
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise HelperError("invalid_input", f"{field} must be a decimal amount") from None
    if not amount.is_finite() or amount < 0:
        raise HelperError("invalid_input", f"{field} must be a non-negative amount")
    return int((amount * 1_000_000).to_integral_value(rounding=ROUND_CEILING if up else ROUND_FLOOR))


def usd(microusd):
    return str(Decimal(int(microusd)) / 1_000_000)


def validate_snapshot(snapshot, now):
    if not isinstance(snapshot, dict):
        raise HelperError("invalid_input", "The funding snapshot must be a JSON object")
    window = snapshot.get("funding_window_id")
    if not isinstance(window, str) or not window.strip() or len(window) > 128:
        raise HelperError("invalid_input", "funding_window_id must be a short non-empty string")
    if not isinstance(snapshot.get("source"), str) or not snapshot["source"].strip():
        raise HelperError("invalid_input", "source must say where the balances came from")
    verified = parse_time(snapshot.get("verified_at"), "verified_at")
    if verified > now + timedelta(minutes=1):
        raise HelperError("invalid_input", "verified_at cannot be in the future")
    grants = snapshot.get("grants")
    if not isinstance(grants, list) or not grants:
        raise HelperError("invalid_input", "grants must list at least one credit grant")
    total, seen = 0, set()
    for grant in grants:
        if not isinstance(grant, dict) or not isinstance(grant.get("grant_id"), str) or grant["grant_id"] in seen:
            raise HelperError("invalid_input", "each grant needs a unique grant_id")
        seen.add(grant["grant_id"])
        if grant.get("kind", "promotional") not in ("promotional", "prepaid"):
            raise HelperError("invalid_input", "each grant kind must be promotional or prepaid")
        total += micro(grant.get("balance_usd"), "balance_usd")
        try:
            date.fromisoformat(str(grant.get("expires_on")))
        except ValueError:
            raise HelperError("invalid_input", "expires_on must be YYYY-MM-DD") from None
    allocation = micro(snapshot.get("allocation_usd"), "allocation_usd")
    if allocation > total:
        raise HelperError("invalid_input", "allocation_usd cannot exceed the sum of grant balances")
    return verified


def expired_grants(funding, now):
    """A grant with a positive balance expires at the start of its expires_on UTC day."""
    out = []
    for grant in funding.get("grants", []):
        end = datetime.combine(date.fromisoformat(grant["expires_on"]), datetime.min.time(), timezone.utc)
        if micro(grant["balance_usd"], "balance_usd") > 0 and end <= now:
            out.append(grant["grant_id"])
    return out


class Ledger:
    def __init__(self, path, policy):
        self.path = path
        self.policy = policy
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._db(True) as db:
            db.execute("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            db.execute("""CREATE TABLE IF NOT EXISTS jobs(job_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                status TEXT NOT NULL, model TEXT NOT NULL, funding_window_id TEXT NOT NULL, reservation_microusd INTEGER NOT NULL,
                actual_microusd INTEGER, purpose TEXT NOT NULL, deliverable TEXT NOT NULL, usage TEXT, error TEXT, evidence TEXT)""")

    @contextmanager
    def _db(self, write=False):
        db = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield db
            db.execute("COMMIT")
        except BaseException:
            db.execute("ROLLBACK")
            raise
        finally:
            db.close()

    @staticmethod
    def _get(db, key, default=None):
        row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    @staticmethod
    def _put(db, key, value):
        db.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                   (key, json.dumps(value, sort_keys=True)))

    # ---- funding -------------------------------------------------------------------------------------------
    def refresh_funding(self, snapshot, key_fingerprint, now=None):
        now = now or now_utc()
        validate_snapshot(snapshot, now)
        snapshot = {**snapshot, "key_fingerprint": key_fingerprint}
        with self._db(True) as db:
            if self._get(db, "funding_window:" + snapshot["funding_window_id"]) is not None:
                raise HelperError("funding_window_reused", "Use a new funding_window_id for each balance observation")
            current = self._get(db, "funding")
            if current and parse_time(snapshot["verified_at"], "verified_at") <= parse_time(current["verified_at"], "verified_at"):
                raise HelperError("funding_not_newer", "The snapshot must be newer than the recorded one")
            self._put(db, "funding_window:" + snapshot["funding_window_id"], {"recorded_at": iso(now)})
            self._put(db, "funding", snapshot)
        return snapshot

    def funding(self):
        with self._db() as db:
            return self._get(db, "funding")

    def catalog_update(self):
        """Serialize the brief catalog publication with other helper processes."""
        return self._db(True)

    def set_enabled(self, enabled):
        with self._db(True) as db:
            self._put(db, "enabled", bool(enabled))

    # ---- positions -----------------------------------------------------------------------------------------
    def _position(self, db, funding, now):
        # Every charge from a request created after (observation - billing lag) counts against the observed balance,
        # whichever snapshot it was admitted under: Google's balance may not show recent charges yet, so overlap
        # is counted twice rather than not at all.
        lag = timedelta(hours=float(self.policy.get("billing_lag_hours", 48)))
        since = parse_time(funding["verified_at"], "verified_at") - lag if funding else now
        spent = db.execute("SELECT COALESCE(SUM(actual_microusd),0) FROM jobs WHERE created_at>=? AND actual_microusd IS NOT NULL",
                           (iso(since),)).fetchone()[0]
        reserved = db.execute(f"SELECT COALESCE(SUM(reservation_microusd),0) FROM jobs WHERE actual_microusd IS NULL AND status IN {OPEN}").fetchone()[0]
        allocation = micro(funding["allocation_usd"], "allocation_usd") if funding else 0
        margin = Decimal(str(self.policy.get("allocation_margin", "0.05")))
        spendable = max(0, int(allocation * (1 - margin)) - spent - reserved)
        # Rolling 30 days: settled charges and open reservations created in the last 30 days.
        target = micro(self.policy.get("monthly_target_usd", "10.00"), "monthly_target_usd")
        start = now - MONTH
        month_used = db.execute("SELECT COALESCE(SUM(COALESCE(actual_microusd, reservation_microusd)),0) FROM jobs WHERE created_at>=?",
                                (iso(start),)).fetchone()[0]
        # Weekly pace for display (Agent Commons spends down by it): a seventh of the 30-day target per calendar
        # week from Monday 00:00 UTC. Admission enforces the rolling 30-day budget, not this.
        week_start = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
        week_limit = target * 7 // 30
        week_used = db.execute("SELECT COALESCE(SUM(COALESCE(actual_microusd, reservation_microusd)),0) FROM jobs WHERE created_at>=?",
                               (iso(week_start),)).fetchone()[0]
        return {"spent": spent, "reserved": reserved, "allocation": allocation, "spendable": spendable,
                "month_start": start, "month_used": month_used, "month_available": max(0, target - month_used), "target": target,
                "week_start": week_start, "week_limit": week_limit, "week_used": week_used}

    def credits(self, now=None):
        now = now or now_utc()
        with self._db() as db:
            funding = self._get(db, "funding")
            position = self._position(db, funding, now)
        grants = []
        for grant in (funding or {}).get("grants", []):
            end = datetime.combine(date.fromisoformat(grant["expires_on"]), datetime.min.time(), timezone.utc)
            grants.append({**grant, "kind": grant.get("kind", "promotional"),
                           "days_to_expiration": round((end - now).total_seconds() / 86400, 2)})
        observed = sum(micro(g["balance_usd"], "balance_usd") for g in (funding or {}).get("grants", []))
        breakdown = {kind: usd(sum(micro(g["balance_usd"], "balance_usd") for g in grants if g["kind"] == kind))
                     for kind in ("promotional", "prepaid")}
        return {
            "status": "snapshot" if funding else "unfunded",
            "funding_window_id": (funding or {}).get("funding_window_id"),
            "grant_observed_at": (funding or {}).get("verified_at"),
            "grants": grants,
            "observed_balance_usd": usd(observed),
            "observed_credit_by_kind_usd": breakdown,
            "spent_since_snapshot_usd": usd(position["spent"]),
            "reserved_usd": usd(position["reserved"]),
            "estimated_remaining_usd": usd(max(0, observed - position["spent"])),
            "spendable_estimate_after_reservations_usd": usd(position["spendable"]),
            "monthly_budget": {
                "target_usd": usd(position["target"]), "rolling_window_start": iso(position["month_start"]),
                "spent_or_reserved_usd": usd(position["month_used"]),
                "available_for_new_requests_usd": usd(min(position["month_available"], position["spendable"])),
            },
            "weekly_budget": {
                "status": "active", "window_start": iso(position["week_start"]), "reset_at": iso(position["week_start"] + timedelta(days=7)),
                "weekly_limit_usd": usd(position["week_limit"]),
                "available_for_new_requests_usd": usd(max(0, min(position["week_limit"] - position["week_used"],
                                                                 position["month_available"], position["spendable"]))),
            } if funding else None,
            "account_cost_basis": "local_ledger_only",
            "note": "Balances are the user's last observation minus this helper's own spending; other use of the billing account is not seen.",
        }

    def _funding_blocker(self, funding, now, key_fingerprint):
        if not funding:
            return "funding_missing"
        if expired_grants(funding, now):
            return "grant_expired"
        if now - parse_time(funding["verified_at"], "verified_at") > timedelta(days=float(self.policy.get("funding_max_age_days", 35))):
            return "funding_stale"
        if key_fingerprint is not None and funding.get("key_fingerprint") != key_fingerprint:
            return "credential_changed"
        return None

    def blockers(self, key_fingerprint=None, now=None):
        now = now or now_utc()
        with self._db() as db:
            funding = self._get(db, "funding")
            enabled = self._get(db, "enabled", False)
            overrun = self._get(db, "overrun")
        out = [] if enabled else ["disabled"]
        if overrun:
            out.append("overrun")
        blocker = self._funding_blocker(funding, now, key_fingerprint)
        return out + ([blocker] if blocker else [])

    # ---- jobs ----------------------------------------------------------------------------------------------
    def _check_admission(self, db, request, reservation, key_fingerprint, now):
        if db.execute("SELECT 1 FROM jobs WHERE job_id=?", (request["job_id"],)).fetchone():
            raise HelperError("duplicate_request", "This job_id was already submitted; it is never replayed")
        if not self._get(db, "enabled", False):
            raise HelperError("disabled", "The helper is disabled")
        if self._get(db, "overrun"):
            raise HelperError("overrun", "A request cost more than it reserved; review it, then run clear-overrun")
        funding = self._get(db, "funding")
        blocker = self._funding_blocker(funding, now, key_fingerprint)
        if blocker:
            raise HelperError(blocker, {"funding_missing": "Record a funding snapshot first",
                                        "grant_expired": "A recorded credit grant expired; record the current balance first",
                                        "funding_stale": "The recorded balance is too old; record the current balance",
                                        "credential_changed": "The key changed since the balance was recorded; record the balance again"}[blocker])
        running = db.execute("SELECT COUNT(*) FROM jobs WHERE status='submitting'").fetchone()[0]
        if running >= int(self.policy.get("max_concurrent", 2)):
            raise HelperError("concurrency_limit", "Too many requests are in flight")
        cap = min(micro(request["max_cost_usd"], "max_cost_usd"), micro(self.policy.get("max_job_usd", "2.00"), "max_job_usd"))
        if reservation > cap:
            raise HelperError("job_cap_exceeded", f"Worst-case reservation ${usd(reservation)} exceeds the job ceiling ${usd(cap)}")
        position = self._position(db, funding, now)
        if reservation > position["spendable"]:
            raise HelperError("insufficient_funds", "The recorded credit allocation cannot cover this reservation")
        if reservation > position["month_available"]:
            raise HelperError("monthly_budget_exhausted", "This month's credit budget is used up")
        return funding

    def preflight(self, request, minimum_reservation, key_fingerprint):
        """Reject locally before the token count. Reserve checks again under the write lock."""
        with self._db() as db:
            self._check_admission(db, request, minimum_reservation, key_fingerprint, now_utc())

    def reserve(self, request, reservation, key_fingerprint, now=None):
        with self._db(True) as db:
            now = now or now_utc()  # read under the write lock, so admission cannot cross an expiry
            funding = self._check_admission(db, request, reservation, key_fingerprint, now)
            db.execute("""INSERT INTO jobs(job_id,created_at,updated_at,status,model,funding_window_id,reservation_microusd,purpose,deliverable)
                VALUES(?,?,?,?,?,?,?,?,?)""", (request["job_id"], iso(now), iso(now), "submitting", request["model"],
                                               funding["funding_window_id"], reservation, request["purpose"], request["deliverable"]))

    def settle(self, job_id, status, actual, usage=None, error=None, evidence=None, now=None):
        now = now or now_utc()
        with self._db(True) as db:
            row = db.execute("SELECT status, reservation_microusd FROM jobs WHERE job_id=?", (job_id,)).fetchone()
            if not row:
                raise HelperError("job_unknown", "No such job")
            if row["status"] != "submitting":
                raise HelperError("job_settled", "This job is already settled or uncertain")
            if actual > row["reservation_microusd"]:
                self._put(db, "overrun", {"job_id": job_id, "at": iso(now)})
            db.execute("UPDATE jobs SET status=?, actual_microusd=?, usage=?, error=?, evidence=COALESCE(?, evidence), updated_at=? WHERE job_id=?",
                       (status, actual, json.dumps(usage) if usage is not None else None, error, evidence, iso(now), job_id))

    def settle_manual(self, job_id, actual, evidence, stuck_after, now=None):
        """User-authorized settlement of an uncertain job, or of one left 'submitting' by a crash, with evidence."""
        if not isinstance(evidence, str) or len(evidence.strip()) < 8:
            raise HelperError("evidence_required", "Describe the billing evidence (at least a few words)")
        with self._db(True) as db:
            now = now or now_utc()
            row = db.execute("SELECT status, updated_at FROM jobs WHERE job_id=?", (job_id,)).fetchone()
            if not row:
                raise HelperError("job_unknown", "No such job")
            stuck = row["status"] == "submitting" and now - parse_time(row["updated_at"], "updated_at") > stuck_after
            if row["status"] != "uncertain" and not stuck:
                raise HelperError("not_uncertain", "Only an uncertain job, or one stuck submitting, can be settled by hand")
            db.execute("UPDATE jobs SET status='completed_manual', actual_microusd=?, evidence=?, updated_at=? WHERE job_id=?",
                       (actual, evidence.strip(), iso(now), job_id))

    def clear_overrun(self):
        with self._db(True) as db:
            db.execute("DELETE FROM settings WHERE key='overrun'")

    def mark_uncertain(self, job_id, error, now=None):
        now = now or now_utc()
        with self._db(True) as db:
            db.execute("UPDATE jobs SET status='uncertain', error=?, updated_at=? WHERE job_id=?", (error, iso(now), job_id))

    def job(self, job_id):
        with self._db() as db:
            row = db.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
        if not row:
            raise HelperError("job_unknown", "No such job")
        out = dict(row)
        reservation, actual = out.pop("reservation_microusd"), out.pop("actual_microusd")
        out["reservation_usd"] = usd(reservation)
        out["actual_usd"] = None if actual is None else usd(actual)
        out["usage"] = json.loads(out["usage"]) if out["usage"] else None
        return out

    def open_jobs(self):
        with self._db() as db:
            return [dict(r) for r in db.execute(f"SELECT job_id, status, reservation_microusd, created_at FROM jobs WHERE actual_microusd IS NULL AND status IN {OPEN}")]

    def enabled(self):
        with self._db() as db:
            return bool(self._get(db, "enabled", False))
