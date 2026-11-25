"""Catalog metadata and evidence-backed routing. No network or inference side effects."""
import copy
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
from urllib.parse import urlsplit

EFFORTS = ("low", "medium", "high", "xhigh", "max")
TASKS = ("transform", "explain", "coding", "complex", "review", "followup")
GROUPS = ("Gemini Models", "Claude and GPT models", "Gemini 4 Argon")
TTL_SECONDS = 3600
OFFICIAL_DOMAINS = ("antigravity.google", "deepmind.google", "ai.google.dev", "blog.google", "anthropic.com", "openai.com")


class RegistryError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _fail(code, message):
    raise RegistryError(code, message)


def _hash(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def _utc(value=None):
    if value is None:
        return datetime.now(timezone.utc)
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ValueError("A timezone-aware UTC timestamp is required.")
    return value.astimezone(timezone.utc)


def parse_catalog(text):
    models, variants, unsupported, seen = {}, {}, [], set()
    for line in text.splitlines():
        if not line.strip():
            continue
        row = re.fullmatch(r"([a-z0-9][a-z0-9.-]+)\s+([^\x00-\x1f\x7f]+)", line.strip())
        if not row or row[1] in seen or "-" not in row[1]:
            _fail("MODELS_UNKNOWN", "Model catalog has malformed or duplicate rows.")
        model, display = row.groups()
        seen.add(model)
        family, sep, effort = model.rpartition("-")
        if not sep or not family or effort not in EFFORTS:
            unsupported.append({"id": model, "reason": "Unsupported or missing effort suffix."})
            continue
        models[model] = display
        variants[model] = {"family": family, "effort": effort}
    if not seen:
        _fail("MODELS_UNKNOWN", "The available model catalog is empty.")
    return {"models": models, "variants": variants, "unsupported": unsupported,
            "fingerprint": _hash({"models": models, "unsupported": sorted(unsupported, key=lambda row: row["id"])})}


def refresh_catalog(cache_path, cli_sha, fetch_text, read_json, write_json, now=None, force=False, observation=None):
    if observation is not None and not force:
        key = ('catalog', str(Path(cache_path)), cli_sha)
        snapshot = observation.memo(key,
            lambda: refresh_catalog(cache_path, cli_sha, fetch_text, read_json, write_json, now=now))
        # An operation may wait for a long-running generation. Pure reuse cannot
        # extend the catalog's existing freshness contract or hide clock rollback.
        age = (_utc(now) - _utc(snapshot['fetched_at'])).total_seconds()
        if 0 <= age < TTL_SECONDS:
            return snapshot
        observation.forget(key)
        return refresh_catalog(cache_path, cli_sha, fetch_text, read_json, write_json, now=now)
    current = _utc(now)
    cache_path = Path(cache_path)
    old = read_json(cache_path) if cache_path.is_file() else None
    if isinstance(old, dict) and old.get("schema_version") == 1 and not force:
        try:
            age = (current - _utc(old["fetched_at"])).total_seconds()
            valid = (old.get("cli_sha256") == cli_sha and 0 <= age < TTL_SECONDS
                     and isinstance(old.get("models"), dict) and isinstance(old.get("variants"), dict)
                     and isinstance(old.get("unsupported"), list))
            if valid:
                # Reparse cached metadata rather than trusting an unverified shape.
                parsed = parse_catalog("\n".join(f"{k} {v}" for k, v in old["models"].items()) + "\n" +
                                       "\n".join(f"{r['id']} unsupported" for r in old["unsupported"]))
                if parsed["fingerprint"] == old.get("fingerprint") and parsed["variants"] == old["variants"]:
                    return old
        except (ValueError, KeyError, TypeError, RegistryError):
            pass
    parsed = parse_catalog(fetch_text())
    previous = set(old.get("models", {})) if isinstance(old, dict) else set()
    snapshot = {"schema_version": 1, "cli_sha256": cli_sha,
                "fetched_at": current.isoformat().replace("+00:00", "Z"), **parsed,
                "changes": {"added": sorted(set(parsed["models"]) - previous),
                            "removed": sorted(previous - set(parsed["models"]))}}
    write_json(cache_path, snapshot)
    return snapshot


def validate_proposal(profile):
    """Validate Codex-authored capability evidence; this does not assert test success."""
    if not isinstance(profile, dict):
        _fail("CAPABILITY_EVIDENCE_INVALID", "A model capability profile must be an object.")
    profile = copy.deepcopy(profile)
    model = profile.get("model", "")
    if not isinstance(model, str):
        _fail("CAPABILITY_EVIDENCE_INVALID", "Model identifier must be text.")
    family, sep, effort = model.rpartition("-")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]+", model) or not sep or effort not in EFFORTS:
        _fail("CAPABILITY_EVIDENCE_INVALID", "Profile requires an exact supported model/effort identifier.")
    if profile.get("family") != family or profile.get("effort") != effort:
        _fail("CAPABILITY_EVIDENCE_INVALID", "Model family and effort must match its exact identifier.")
    tasks = profile.get("tasks")
    preferences = profile.get("task_preferences")
    if (not isinstance(tasks, list) or not tasks or any(not isinstance(task, str) for task in tasks) or len(set(tasks)) != len(tasks)
            or any(task not in TASKS for task in tasks) or not isinstance(preferences, dict)
            or set(preferences) != set(tasks)
            or any(type(rank) is not int or rank < 0 for rank in preferences.values())):
        _fail("CAPABILITY_EVIDENCE_INVALID", "Profile requires explicit task classes and nonnegative preference ranks.")
    if profile.get("group") not in GROUPS:
        _fail("CAPABILITY_EVIDENCE_INVALID", "Included-plan quota group must be verified.")
    limits = profile.get("quota_limits")
    if (not isinstance(limits, list) or not limits or any(not isinstance(row, dict) or
            set(row) != {"group", "limit"} or not all(isinstance(v, str) and v.strip() for v in row.values()) for row in limits)):
        _fail("CAPABILITY_EVIDENCE_INVALID", "Explicit quota limit row keys are required.")
    keys = [(row["group"], row["limit"]) for row in limits]
    if profile["group"] == "Gemini 4 Argon":
        base = {("Gemini 4 Argon", "Gemini 4 Argon Weekly Limit")}
    else:
        base = {(profile["group"], name) for name in ("Weekly Limit Remaining", "Five Hour Limit Remaining")}
    if len(set(keys)) != len(keys) or not base.issubset(keys):
        _fail("CAPABILITY_EVIDENCE_INVALID", "Quota mapping must include the group's required limits without duplicates.")
    evidence = profile.get("evidence")
    if (not isinstance(evidence, dict) or evidence.get("quota_mapping_verified") is not True
            or not isinstance(evidence.get("reason"), str) or not evidence["reason"].strip()
            or not isinstance(evidence.get("limitations"), list) or not evidence["limitations"]
            or any(not isinstance(s, str) or not s.strip() for s in evidence["limitations"])
            or evidence.get("task_classes") != tasks):
        _fail("CAPABILITY_EVIDENCE_INVALID", "Reason, limitations, task evidence and verified quota mapping are required.")
    sources = evidence.get("sources")
    if not isinstance(sources, list) or not sources:
        _fail("CAPABILITY_EVIDENCE_INVALID", "Official capability sources and retrieval dates are required.")
    for source in sources:
        try:
            if not isinstance(source, dict):
                raise ValueError("Invalid source")
            url = urlsplit(source["url"])
            host = url.hostname or ""
            date = datetime.strptime(source["retrieved_at"], "%Y-%m-%d").date()
            valid = (url.scheme == "https" and url.username is None and url.password is None
                     and url.port in (None, 443) and any(host == domain or host.endswith("." + domain) for domain in OFFICIAL_DOMAINS)
                     and date <= datetime.now(timezone.utc).date())
        except (ValueError, KeyError, TypeError):
            valid = False
        if not valid:
            _fail("CAPABILITY_EVIDENCE_INVALID", "Source must have an official HTTPS URL and valid nonfuture retrieval date.")
    return profile


def load_registry(seed_path, state_path, read_json, observation=None, identity_key=None):
    if observation is not None:
        return observation.memo(('registry', str(Path(seed_path)), str(state_path), identity_key),
            lambda: load_registry(seed_path, state_path, read_json))
    seed = read_json(Path(seed_path))
    if not isinstance(seed, dict) or seed.get("schema_version") != 1 or not isinstance(seed.get("profiles"), list):
        _fail("REGISTRY_INVALID", "Routing seed has an unsupported schema.")
    profiles = {}
    for entry in seed["profiles"]:
        profile = validate_proposal(entry)
        if profile.get("state") != "seeded" or profile["model"] in profiles:
            _fail("REGISTRY_INVALID", "Routing seed has invalid state or duplicate profiles.")
        profiles[profile["model"]] = profile
    if state_path is not None and Path(state_path).is_file():
        state = read_json(Path(state_path))
        if not isinstance(state, dict) or state.get("schema_version") != 1 or not isinstance(state.get("profiles"), list):
            _fail("REGISTRY_INVALID", "Routing state has an unsupported schema.")
        seen = set()
        for entry in state["profiles"]:
            profile = validate_proposal(entry)
            validation = profile.get("validation", {})
            if (profile.get("state") != "validated" or validation.get("status") != "passed"
                    or not isinstance(validation.get("identity_hash"), str) or not validation["identity_hash"]
                    or not isinstance(validation.get("suite_version"), str) or not validation["suite_version"]
                    or profile["model"] in seen):
                _fail("REGISTRY_INVALID", "Promoted profile lacks passed, identity-bound evaluation evidence.")
            seen.add(profile["model"])
            profiles[profile["model"]] = profile
    return {"schema_version": 1, "profiles": list(profiles.values())}


def _profiles(registry):
    return {p["model"]: p for p in registry["profiles"] if p.get("state") in ("seeded", "validated")}


def profile_headroom(profile, quota, registry):
    known = {(r["group"], r["limit"]) for p in registry["profiles"] for r in p["quota_limits"]}
    rows = {}
    for row in quota:
        key = (row.get("group"), row.get("limit"))
        amount = row.get("remaining_percent")
        if (key not in known or key in rows or type(amount) not in (int, float)
                or not math.isfinite(amount) or not 0 <= amount <= 100):
            _fail("QUOTA_UNKNOWN", "Unknown, duplicate or invalid quota caps block automatic selection.")
        rows[key] = amount
    required = {(r["group"], r["limit"]) for r in profile["quota_limits"]}
    if not required.issubset(rows):
        # A window the CLI no longer reports (Gemini 4 Argon, Nov 2026) closes only the profiles that need it.
        _fail("QUOTA_LIMIT_MISSING", "An applicable verified quota limit is missing.")
    return min(rows[key] for key in required)


def _effort_reason(reason, source):
    if reason is not None:
        if (not isinstance(reason, str) or not reason.strip() or len(reason) > 240
                or any(ord(char) < 32 or ord(char) == 127 for char in reason)):
            _fail("MODEL_UNAVAILABLE", "Effort reason must be one nonempty line of at most 240 characters.")
        return reason.strip()
    return {
        "explicit_assignment": "Caller selected this effort for the assignment from validated task options.",
        "explicit_model": "Caller selected this exact model and effort from validated task options.",
        "previous_assignment": "Retained the previous effort for a narrow continuation.",
        "compatibility_default": "Effort omitted; retained the preferred available validated task assignment.",
    }[source]


def assignment_options(models, quota, registry):
    """Advertised exact task/effort eligibility; no inference or family-wide assumptions."""
    families = {}
    for profile in sorted(_profiles(registry).values(), key=lambda p: p["model"]):
        if profile["model"] not in models or profile["family"].startswith("gpt-oss"):
            continue
        try:
            capacity, blocker = profile_headroom(profile, quota, registry), None
        except RegistryError as exc:
            if exc.code != "QUOTA_LIMIT_MISSING":
                raise
            capacity, blocker = 0, "quota_limit_missing"
        tasks = families.setdefault(profile["family"], {})
        for task in profile["tasks"]:
            tasks.setdefault(task, []).append({
                "model": profile["model"], "effort": profile["effort"],
                "group": profile["group"], "headroom_percent": capacity,
                "available": capacity > 0, **({"blocker": blocker} if blocker else {}),
            })
    return [{"family": family, "tasks": tasks} for family, tasks in sorted(families.items())]


def select(task, models, quota, registry, override=None, effort=None, previous=None,
           family=None, effort_reason=None):
    if (task not in TASKS or (effort is not None and effort not in EFFORTS)
            or (family is not None and (not isinstance(family, str)
                or not re.fullmatch(r"[a-z0-9][a-z0-9.-]+", family)))):
        _fail("MODEL_UNAVAILABLE", "Unsupported task, family or effort.")
    profiles = _profiles(registry)
    source = "explicit_assignment" if effort is not None else "compatibility_default"
    if task == "followup":
        if not previous or previous not in models or previous not in profiles:
            _fail("PREVIOUS_MODEL_REQUIRED", "Follow-up requires the previous available validated model.")
        old = profiles[previous]
        if family is not None and family != old["family"]:
            _fail("MODEL_UNAVAILABLE", "Follow-up family must match the previous assignment.")
        family = old["family"]
        effort = effort or old["effort"]
        if source == "compatibility_default":
            source = "previous_assignment"
    if override:
        if (override not in models or override not in profiles
                or (effort is not None and profiles[override]["effort"] != effort)
                or (family is not None and profiles[override]["family"] != family)
                or task not in profiles[override]["tasks"]):
            _fail("MODEL_UNAVAILABLE", "Requested model/effort is not advertised and validated for this task and family.")
        candidates = [profiles[override]]
        source = "explicit_model"
    else:
        candidates = [p for p in profiles.values() if task in p["tasks"]
                      and (effort is None or p["effort"] == effort)
                      and (family is None or p["family"] == family)
                      and not p["family"].startswith("gpt-oss")]
    reason = _effort_reason(effort_reason, source)
    eligible, errors = [], []
    for p in candidates:
        if p["model"] in models:
            try:
                capacity = profile_headroom(p, quota, registry)
                if capacity > 0:
                    eligible.append((capacity, -p["task_preferences"][task], p))
            except RegistryError as exc:
                if exc.code != "QUOTA_LIMIT_MISSING":
                    errors.append(exc)
    if not eligible:
        if errors:
            raise errors[0]
        _fail("NO_ELIGIBLE_MODEL", "No sufficiently capable advertised model has the requested validated effort and verified remaining quota.")
    # Preference evidence and quota select only among suitable exact pairs. Effort
    # ordering and version numbers are deliberately absent from this comparison.
    capacity, _, chosen = max(eligible, key=lambda entry: (entry[0], entry[1], entry[2]["model"]))
    return {"model": chosen["model"], "family": chosen["family"], "task": task,
            "effort": chosen["effort"], "group": chosen["group"], "headroom_percent": capacity,
            "effort_choice_source": source, "effort_reason": reason}


def select_probe(group, purpose, models, quota, registry):
    """Choose a small suitable accepted model without permanent provider model IDs."""
    if group not in GROUPS:
        _fail("MODEL_UNAVAILABLE", "Unknown probe quota group.")
    if group == "Gemini 4 Argon":
        # Acceptance checks the synthetic response itself, not a routed task class.
        eligible, errors = [], []
        for profile in _profiles(registry).values():
            model = profile["model"]
            if profile["group"] != group or model not in models or profile["family"].startswith("gpt-oss"):
                continue
            try:
                capacity = profile_headroom(profile, quota, registry)
            except RegistryError as exc:
                if exc.code != "QUOTA_LIMIT_MISSING":
                    errors.append(exc)
                continue
            if capacity > 0:
                eligible.append((capacity, model, profile))
        if eligible:
            capacity, model, chosen = max(eligible, key=lambda entry: (entry[0], entry[1]))
            source = "compatibility_default"
            return {"model": model, "family": chosen["family"], "task": chosen["tasks"][0],
                    "effort": chosen["effort"], "group": group, "headroom_percent": capacity,
                    "effort_choice_source": source, "effort_reason": _effort_reason(None, source)}
        if errors:
            raise errors[0]
        _fail("NO_ELIGIBLE_MODEL", "No validated model is available for the required probe quota group.")
    task_order = ("explain", "transform", "coding", "review", "complex") if purpose in ("control", "tool_denial") else ("transform", "explain", "coding", "review", "complex")
    subset = {**registry, "profiles": [p for p in registry["profiles"] if p["group"] == group]}
    # Retain all quota mappings while limiting eligible models to the requested group.
    group_models = {k: v for k, v in models.items() if any(p["model"] == k for p in subset["profiles"])}
    errors = []
    for task in task_order:
        try:
            return select(task, group_models, quota, registry)
        except RegistryError as exc:
            errors.append(exc)
    if any(exc.code == "QUOTA_UNKNOWN" for exc in errors):
        raise next(exc for exc in errors if exc.code == "QUOTA_UNKNOWN")
    _fail("NO_ELIGIBLE_MODEL", "No validated model is available for the required probe quota group.")


def pending_candidates(snapshot, registry):
    assigned = _profiles(registry)
    return [{"model": model, **variant, "status": "capability_assessment_required"}
            for model, variant in sorted(snapshot["variants"].items())
            if model not in assigned and not variant["family"].startswith("gpt-oss")]
