"""Command line: every command prints one JSON object. Exit 0 success, 2 blocked or refused, 1 local error."""
import argparse
import getpass
import hashlib
import json
import os
import re
import sys
import tempfile
import time
import warnings
from datetime import timedelta
from pathlib import Path

from . import api, dpapi, inventory
from .dpapi import HelperError
from .ledger import DEFAULT_POLICY, Ledger, micro, now_utc, usd

ROOT = Path(__file__).resolve().parents[1]
# AI Studio issues authorization keys by default. Keep restricted standard keys usable too.
KEY_SHAPE = re.compile(r"(?:AIza[0-9A-Za-z_-]{35}|AQ\.[!-~]+)")


def load_policy(state):
    """Defaults in code; an optional local policy.json (ignored by Git) may override them."""
    override = state / "policy.json"
    return {**DEFAULT_POLICY, **(json.loads(override.read_text(encoding="utf-8")) if override.is_file() else {})}


class Helper:
    def __init__(self, state_dir=None, policy=None, registry=None, opener=None):
        # One ledger per install: the CLI offers no state-dir switch, so budgets and duplicate checks are shared.
        self.state = Path(state_dir) if state_dir else ROOT / ".local"
        if state_dir is None and (not self.state.is_dir() or self.state.is_symlink() or self.state.is_junction()):
            raise HelperError("storage_not_initialized", "Run Enter-ApiKey.ps1 to initialize private Gemini storage")
        self.policy = policy if policy is not None else load_policy(self.state)
        self.inventory_path = self.state / "model-catalog.json"
        self.registry = registry if registry is not None else self.read_registry()
        self.ledger = Ledger(self.state / "usage.sqlite3", self.policy)
        self.opener = opener

    # ---- key -----------------------------------------------------------------------------------------------
    @property
    def key_file(self):
        return self.state / "secrets" / "gemini-key.bin"

    def save_key(self, key):
        if not KEY_SHAPE.fullmatch(key or ""):
            raise HelperError("key_shape", "Enter a Gemini authorization key or a restricted standard API key; nothing was saved")
        self.key_file.parent.mkdir(parents=True, exist_ok=True)
        if self.key_file.parent.is_symlink() or self.key_file.parent.is_junction():
            raise HelperError("storage_redirected", "Gemini credential storage must be a regular local directory")
        clear = key.encode("ascii")
        protected = dpapi.protect(clear)
        if dpapi.unprotect(protected) != clear:
            raise HelperError("dpapi_failed", "Gemini credential encryption could not be verified")
        with tempfile.NamedTemporaryFile(dir=self.key_file.parent, delete=False) as staged:
            staged_path = Path(staged.name)
            try:
                staged.write(protected)
            except OSError:
                staged.close()
                staged_path.unlink(missing_ok=True)
                raise
        try:
            os.replace(staged_path, self.key_file)
        finally:
            staged_path.unlink(missing_ok=True)
        return {"status": "saved", "credential_present": True,
                "next_action": "Record the credit balance again (refresh-funding): a new key needs a new balance observation"}

    def key(self):
        if not self.key_file.is_file():
            raise HelperError("credential_missing", "Run Enter-ApiKey.ps1 to store the Gemini API key")
        return dpapi.unprotect(self.key_file.read_bytes()).decode("ascii")

    @staticmethod
    def fingerprint(key):
        """A short, non-reversible tag that ties a balance observation to the key in use."""
        return hashlib.sha256(("agent-commons-gemini:" + key).encode()).hexdigest()[:16]

    def _kw(self):
        return {"opener": self.opener} if self.opener else {}

    def read_registry(self):
        source = self.inventory_path if self.inventory_path.is_file() else ROOT / "registry.json"
        try:
            registry = json.loads(source.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return registry if isinstance(registry, dict) and isinstance(registry.get("models"), dict) else {}

    def _result_path(self, job_id):
        name = hashlib.sha256(job_id.encode()).hexdigest() + ".json"
        return self.state / "results" / name

    def lookup(self, job_id):
        job = self.ledger.job(job_id)
        result = None
        if job["status"] == "completed":
            try:
                result = json.loads(self._result_path(job_id).read_text(encoding="utf-8"))
            except (OSError, ValueError):
                # Accounting and manual reconciliation remain available for older rows and damaged result files.
                pass
        return {"status": "recorded", "job": job, "result": result}

    def sync_models(self):
        key = self.key()
        fingerprint = self.fingerprint(key)
        observed_at = now_utc().isoformat()
        visible = api.list_models(key, **self._kw())
        catalog = inventory.build_catalog(
            inventory.fetch_doc("models", **self._kw()), inventory.fetch_doc("pricing", **self._kw()),
            visible, observed_at)
        with self.ledger.catalog_update():
            if self.fingerprint(self.key()) != fingerprint:
                raise HelperError("credential_changed", "The Gemini key changed during model discovery")
            if self.inventory_path.is_file():
                current = self.read_registry()
                if current.get("key_fingerprint") == fingerprint and current.get("observed_at", "") >= observed_at:
                    return {name: value for name, value in current.items() if name != "key_fingerprint"}
            inventory.publish_catalog(self.inventory_path, {**catalog, "key_fingerprint": fingerprint})
        return catalog

    # ---- views ---------------------------------------------------------------------------------------------
    def status(self):
        present = self.key_file.is_file()
        fingerprint = self.fingerprint(self.key()) if present else None
        blockers = self.ledger.blockers(fingerprint)
        if not present:
            blockers.append("credential_missing")
        if self.registry.get("key_fingerprint", fingerprint) != fingerprint:
            blockers.append("model_catalog_credential_changed")
        if not self.registry.get("models"):
            blockers.append("registry_empty")
        jobs = self.ledger.open_jobs()
        return {"status": "ready" if not blockers else "blocked", "blockers": blockers,
                "enabled": self.ledger.enabled(), "credential_present": present,
                "credits": self.ledger.credits(), "policy": self.policy,
                "registry": {"verified_at": self.registry.get("verified_at"), "models": sorted(self.registry.get("models", {}))},
                "open_jobs": len(jobs),
                "unsettled_jobs": [{"status": j["status"], "created_at": j["created_at"]} for j in jobs]}

    def refresh_funding(self, snapshot):
        self.ledger.refresh_funding(snapshot, self.fingerprint(self.key()))
        return self.status()

    # ---- invoke --------------------------------------------------------------------------------------------
    def invoke(self, request):
        for field in ("job_id", "model", "prompt", "max_cost_usd", "purpose", "deliverable"):
            if not isinstance(request.get(field), str) or not request[field].strip():
                raise HelperError("invalid_input", f"{field} is required")
        entry = self.registry.get("models", {}).get(request["model"])
        if not entry:
            replacement = self.registry.get("superseded", {}).get(request["model"])
            if replacement:
                raise HelperError("model_superseded", f"Use {replacement}")
            raise HelperError("model_unregistered", "The model is absent from the current priced Gemini catalog")
        max_tokens = int(request.get("max_output_tokens", 8192))
        thinking = int(request.get("thinking_budget", self.policy["thinking_reserve_tokens"]))
        if not 1 <= max_tokens <= 65536 or not 0 <= thinking <= 65536:
            raise HelperError("invalid_input", "max_output_tokens must be 1-65536 and thinking_budget 0-65536")
        if max_tokens > entry.get("output_token_limit", 65536):
            raise HelperError("invalid_input", "max_output_tokens exceeds this Gemini model's output limit")
        micro(request["max_cost_usd"], "max_cost_usd")
        key = self.key()
        fingerprint = self.fingerprint(key)
        if self.registry.get("key_fingerprint", fingerprint) != fingerprint:
            raise HelperError("model_catalog_credential_changed", "Refresh model discovery for the current Gemini key")
        minimum_reservation = api.reservation_microusd(entry, now_utc(), 0, max_tokens + thinking, self.policy["reservation_margin"])
        self.ledger.preflight(request, minimum_reservation, fingerprint)
        deadline = None
        if "timeout_ms" in request:
            timeout_ms = request["timeout_ms"]
            if type(timeout_ms) is not int or timeout_ms < 60_000:
                raise HelperError("invalid_input", "timeout_ms must allow at least 60 seconds")
            deadline = time.monotonic() + timeout_ms / 1_000 - 10
        count_timeout = min(60, max(1, deadline - time.monotonic() - 1)) if deadline is not None else 60
        input_tokens = api.count_tokens(key, request["model"], request["prompt"], request.get("system"),
                                        timeout=count_timeout, **self._kw())
        if "input_token_limit" in entry and input_tokens > entry["input_token_limit"]:
            raise HelperError("invalid_input", "The prompt exceeds this Gemini model's input limit")
        timeout = int(self.policy["request_timeout_seconds"])
        if deadline is not None:
            timeout = min(timeout, deadline - time.monotonic())
            if timeout < 1:
                raise HelperError("job_time_exhausted", "The time budget ran out during token counting; nothing was generated")
        reservation = api.reservation_microusd(entry, now_utc(), input_tokens, max_tokens + thinking, self.policy["reservation_margin"])
        self.ledger.reserve(request, reservation, fingerprint)
        try:
            reply = api.generate(key, request["model"], request["prompt"], system=request.get("system"), max_output_tokens=max_tokens,
                                 thinking_budget=thinking, timeout=timeout, **self._kw())
        except api.Uncertain as exc:
            self.ledger.mark_uncertain(request["job_id"], str(exc))
            return {"status": "uncertain", "job_id": request["job_id"], "error_code": str(exc),
                    "next_action": "The request may have been processed; its reservation stays held until settle-uncertain"}
        except HelperError as exc:
            self.ledger.settle(request["job_id"], "failed", 0, error=exc.code)
            raise
        except BaseException:
            self.ledger.mark_uncertain(request["job_id"], "local_interrupted")
            raise
        cost = api.actual_microusd(entry, now_utc(), reply["usage"])
        result = {"status": "completed", "job_id": request["job_id"], "model": reply["model_version"] or request["model"], "text": reply["text"],
                  "usage": reply["usage"], "finish_reason": reply["finish_reason"], "cost_usd": usd(cost)}
        if cost > reservation:
            result["warning"] = "overrun: the charge exceeded the reservation; new requests are paused until clear-overrun"
        destination = self._result_path(request["job_id"])
        try:
            destination.parent.mkdir(exist_ok=True)
            destination.write_text(json.dumps(result, ensure_ascii=True), encoding="utf-8")
        finally:
            # Record the provider's known cost even if the result file could not be written.
            self.ledger.settle(request["job_id"], "completed", cost, usage=reply["usage"])
        return result


def _print(result):
    print(json.dumps(result, ensure_ascii=True))
    return 2 if result.get("status") in ("blocked", "refused", "uncertain") else 0


def _read_key():
    print("Paste the Gemini API key (input is hidden). Never paste it in chat.", file=sys.stderr)
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        try:
            return getpass.getpass("Gemini API key: ").strip()
        except getpass.GetPassWarning:
            raise HelperError("hidden_input_unavailable", "This console cannot hide input; run Enter-ApiKey.ps1 in a normal terminal") from None


def main(argv=None, helper=None):
    parser = argparse.ArgumentParser(description="Gemini API on prepaid Google Cloud credit, for Agent Commons")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("status", "credits", "enable", "disable", "set-key", "models", "sync-models", "clear-overrun"):
        sub.add_parser(name)
    sub.add_parser("refresh-funding").add_argument("--snapshot", required=True)
    sub.add_parser("invoke").add_argument("--request", required=True)
    sub.add_parser("lookup").add_argument("--job-id", required=True)
    settle = sub.add_parser("settle-uncertain")
    settle.add_argument("--job-id", required=True)
    settle.add_argument("--actual-usd", required=True)
    settle.add_argument("--evidence", required=True)
    args = parser.parse_args(argv)
    try:
        helper = helper or Helper()
        if args.command == "status":
            return _print(helper.status())
        if args.command == "credits":
            return _print(helper.ledger.credits())
        if args.command in ("enable", "disable"):
            helper.ledger.set_enabled(args.command == "enable")
            return _print(helper.status())
        if args.command == "set-key":
            return _print(helper.save_key(_read_key()))
        if args.command == "models":
            return _print({"status": "observed", "models": api.list_models(helper.key(), **helper._kw())})
        if args.command == "sync-models":
            return _print(helper.sync_models())
        if args.command == "clear-overrun":
            helper.ledger.clear_overrun()
            return _print(helper.status())
        if args.command == "refresh-funding":
            return _print(helper.refresh_funding(json.loads(Path(args.snapshot).read_text(encoding="utf-8-sig"))))
        if args.command == "invoke":
            return _print(helper.invoke(json.loads(Path(args.request).read_text(encoding="utf-8-sig"))))
        if args.command == "lookup":
            return _print(helper.lookup(args.job_id))
        if args.command == "settle-uncertain":
            stuck_after = timedelta(seconds=2 * int(helper.policy["request_timeout_seconds"]))
            helper.ledger.settle_manual(args.job_id, micro(args.actual_usd, "actual_usd", up=True), args.evidence, stuck_after)
            return _print({"status": "settled", "job": helper.ledger.job(args.job_id)})
    except HelperError as exc:
        return _print({"status": "blocked", "error_code": exc.code, "next_action": str(exc)})
    except (OSError, ValueError, KeyError, TypeError) as exc:
        # Never echo input text: it may hold a prompt or key material.
        print(json.dumps({"status": "error", "error_code": "local_input_or_state_error", "kind": type(exc).__name__}))
        return 1
    return 1
