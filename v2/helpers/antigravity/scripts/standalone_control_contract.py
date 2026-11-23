"""Closed, prospective contracts for the fixed standalone denial control.

This module performs no executable dispatch. Its only aliases are the closed,
reviewed hook-name table of the ALIASED profile, used for this fixed control.
"""
from dataclasses import dataclass
import hashlib
import json


LEGACY_ID = "standalone-fixed-four-deny-control/1"
REVIEWED_ID = "standalone-fixed-four-deny-control/2"
REVIEWED_CLI_SHA256 = (
    "a738ba5dd3fb14079180d0df70125c8b5b36c34afd0f8f1567774100f13ef138"
)
CONFIGURED_TOOLS = (
    "view_file", "write_to_file", "run_command", "invoke_subagent",
)
# Update-tolerant profile: the CLI's PreToolUse hook may report a configured tool under
# a different internal name (1.5.12 reports read_file / write_file while init still
# advertises view_file / write_to_file). Each name here was observed in a real guard audit
# and reviewed. A name outside this table fails closed with
# STANDALONE_CONTROL_UNKNOWN_AUDIT_NAME, and the probe diagnostic records the observed
# names, so a future rename needs one reviewed table entry, not a new binary pin.
ALIASED_ID = "standalone-fixed-four-deny-control/3"
KNOWN_AUDIT_NAMES = {
    "view_file": ("view_file", "read_file"),          # read_file: CLI 1.5.12
    "write_to_file": ("write_to_file", "write_file"),  # write_file: CLI 1.5.12
    "run_command": ("run_command",),
    "invoke_subagent": ("invoke_subagent",),
}


def canonical(value):
    return json.dumps(
        value, sort_keys=True, ensure_ascii=False, separators=(",", ":")
    )


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class _Profile:
    profile_id: str
    configured_to_audit: tuple
    required_cli_sha256: object

    @property
    def configured_names(self):
        return tuple(configured for configured, _ in self.configured_to_audit)

    @property
    def audit_names(self):
        return tuple(observed for _, observed in self.configured_to_audit)

    @property
    def mapping_sha256(self):
        return digest(dict(self.configured_to_audit))

    def document(self):
        return {
            "profile_id": self.profile_id,
            "required_cli_sha256": self.required_cli_sha256,
            "configured_to_audit": dict(self.configured_to_audit),
        }

    @property
    def profile_sha256(self):
        return digest(self.document())

    def binding(self):
        return {
            "control_profile_id": self.profile_id,
            "control_mapping_sha256": self.mapping_sha256,
            "control_profile_sha256": self.profile_sha256,
        }


LEGACY = _Profile(
    LEGACY_ID,
    tuple((name, name) for name in CONFIGURED_TOOLS),
    None,
)
REVIEWED = _Profile(
    REVIEWED_ID,
    (
        ("view_file", "read_file"),
        ("write_to_file", "write_file"),
        ("run_command", "run_command"),
        ("invoke_subagent", "invoke_subagent"),
    ),
    REVIEWED_CLI_SHA256,
)


@dataclass(frozen=True)
class _AliasedProfile:
    """Closed alias table; not bound to one CLI binary (see KNOWN_AUDIT_NAMES)."""
    profile_id: str
    aliases: tuple  # ((configured, (audit names...)), ...)

    @property
    def configured_names(self):
        return tuple(configured for configured, _ in self.aliases)

    @property
    def audit_names(self):
        return tuple(name for _, names in self.aliases for name in names)

    def aliases_for(self, configured):
        for name, names in self.aliases:
            if name == configured:
                return names
        raise ValueError("STANDALONE_CONTROL_UNKNOWN_PROFILE")

    def configured_for(self, audit_name):
        for configured, names in self.aliases:
            if audit_name in names:
                return configured
        return None

    @property
    def mapping_sha256(self):
        return digest({configured: list(names) for configured, names in self.aliases})

    def document(self):
        return {
            "profile_id": self.profile_id,
            "required_cli_sha256": None,
            "configured_to_audit_aliases": {c: list(n) for c, n in self.aliases},
        }

    @property
    def profile_sha256(self):
        return digest(self.document())

    def binding(self):
        return {
            "control_profile_id": self.profile_id,
            "control_mapping_sha256": self.mapping_sha256,
            "control_profile_sha256": self.profile_sha256,
        }


ALIASED = _AliasedProfile(
    ALIASED_ID,
    tuple((name, KNOWN_AUDIT_NAMES[name]) for name in CONFIGURED_TOOLS),
)


def choose_profile(profile_id, cli_sha256):
    """Select before execution. Never infer a profile from audit rows."""
    if type(profile_id) is not str:
        raise ValueError("STANDALONE_CONTROL_PROFILE_REQUIRED")
    if profile_id == LEGACY_ID:
        return LEGACY
    if profile_id == REVIEWED_ID:
        if type(cli_sha256) is not str or cli_sha256 != REVIEWED_CLI_SHA256:
            raise ValueError("STANDALONE_CONTROL_REVIEWED_BINARY_REQUIRED")
        return REVIEWED
    if profile_id == ALIASED_ID:
        return ALIASED
    raise ValueError("STANDALONE_CONTROL_UNKNOWN_PROFILE")


def _verify_aliased(rows):
    """Every row is a deny of a known reviewed name; each configured tool is denied at least once."""
    observed, covered = set(), set()
    for row in rows:
        if (
            type(row) is not dict
            or set(row) != {"tool_name", "decision"}
            or type(row["tool_name"]) is not str
            or type(row["decision"]) is not str
            or row["decision"] != "deny"
        ):
            raise ValueError("STANDALONE_CONTROL_DENIAL_EVIDENCE_REQUIRED")
        configured = ALIASED.configured_for(row["tool_name"])
        if configured is None:
            raise ValueError("STANDALONE_CONTROL_UNKNOWN_AUDIT_NAME")
        observed.add(row["tool_name"])
        covered.add(configured)
    if covered != set(ALIASED.configured_names):
        raise ValueError("STANDALONE_CONTROL_DENIAL_EVIDENCE_REQUIRED")
    return {
        "denied_tool_names": sorted(ALIASED.configured_names),
        "observed_denied_tool_names": sorted(observed),
        **ALIASED.binding(),
    }


def verify_denials(profile, rows):
    """Every row must deny; all four exact profile actions must be present.

    Repeated denials are permitted. Missing, extra, mixed-vocabulary, malformed,
    unknown and allow rows are rejected. The supplied profile must be one of
    this module's fixed objects.
    """
    if profile is not LEGACY and profile is not REVIEWED and profile is not ALIASED:
        raise ValueError("STANDALONE_CONTROL_UNKNOWN_PROFILE")
    if type(rows) is not list or not rows:
        raise ValueError("STANDALONE_CONTROL_DENIAL_EVIDENCE_REQUIRED")
    if profile is ALIASED:
        return _verify_aliased(rows)

    expected = set(profile.audit_names)
    observed = set()
    for row in rows:
        if (
            type(row) is not dict
            or set(row) != {"tool_name", "decision"}
            or type(row["tool_name"]) is not str
            or type(row["decision"]) is not str
            or row["decision"] != "deny"
            or row["tool_name"] not in expected
        ):
            raise ValueError("STANDALONE_CONTROL_DENIAL_EVIDENCE_REQUIRED")
        observed.add(row["tool_name"])
    if observed != expected:
        raise ValueError("STANDALONE_CONTROL_DENIAL_EVIDENCE_REQUIRED")

    return {
        "denied_tool_names": sorted(profile.configured_names),
        "observed_denied_tool_names": sorted(observed),
        **profile.binding(),
    }
