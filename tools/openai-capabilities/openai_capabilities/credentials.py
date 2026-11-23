"""Designated role-specific credentials in protected, ignored local storage."""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess

from .policy import PolicyError

SECRET_RELATIVE = Path("tools/openai-capabilities/.local/secrets")


def _reject_links(path: Path, boundary: Path):
    """Inspect lexical paths before resolve can hide a link or junction."""
    path, boundary = path.absolute(), boundary.absolute()
    if not path.is_relative_to(boundary):
        raise PolicyError("credential_path_invalid", "Credential path must remain inside the owning project")
    current = path
    while True:
        try:
            info = current.lstat()
        except FileNotFoundError:
            pass
        except OSError:
            raise PolicyError("credential_path_inaccessible", "Credential path could not be inspected safely") from None
        else:
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
                raise PolicyError("credential_path_invalid", "Credential paths cannot contain links or reparse points")
        if current == boundary:
            break
        current = current.parent


def credential_path(policy, root, *, admin=False):
    """Only the two designated roles/filenames are supported by this helper."""
    root = Path(root).absolute()
    expected = SECRET_RELATIVE / ("admin.env" if admin else "project.env")
    setting = "admin_credential_env_file" if admin else "credential_env_file"
    configured = Path(policy.get(setting, str(expected)))
    if configured.is_absolute() or configured != expected:
        raise PolicyError("credential_path_invalid", "Configure the designated role file inside the helper's protected secrets directory")
    path = root / configured
    _reject_links(path, root)
    return path


def verify_private_storage(root, *, credential_file=None, acl_checker=None):
    """Fail closed on Windows; the initializer owns the SID-based ACL contract.

    Tests may inject a pure ACL checker. Normal calls require the reviewed
    PowerShell initializer's read-only inspection of the entire private root.
    """
    root = Path(root).absolute()
    secret_root = root / SECRET_RELATIVE
    _reject_links(secret_root, root)
    if not secret_root.is_dir():
        raise PolicyError("private_storage_missing", "Initialize protected credential storage before saving or loading a key")
    paths = [(secret_root, True)]
    if credential_file is not None:
        credential_file = Path(credential_file).absolute()
        if credential_file.parent != secret_root:
            raise PolicyError("credential_path_invalid", "Credential file must be directly inside protected storage")
        _reject_links(credential_file, root)
        paths.append((credential_file, False))
    if acl_checker is not None:
        try:
            for path, directory in paths:
                if acl_checker(path, directory) is False:
                    raise PolicyError("private_storage_permissions", "Private credential permissions could not be verified")
        except PolicyError:
            raise
        except Exception:
            raise PolicyError("private_storage_permissions", "Private credential permissions could not be verified") from None
        return
    if os.name != "nt":
        raise PolicyError("private_storage_platform", "This installation requires verified Windows private-storage permissions")
    initializer = Path(__file__).resolve().parent.parent / "Initialize-PrivateStorage.ps1"
    if not initializer.is_file():
        raise PolicyError("private_storage_verifier_missing", "The private-storage permission verifier is missing")
    pwsh = shutil.which("pwsh")
    if not pwsh:
        raise PolicyError("private_storage_verifier_missing", "PowerShell 7 is required to verify private credential permissions")
    command = """
$ErrorActionPreference='Stop'
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& $env:CODEX_OPENAI_ACL_SCRIPT -WorkspaceRoot $env:CODEX_OPENAI_ACL_ROOT -ExpectedUserSid $sid -ExpectedSourceSha256 $env:CODEX_OPENAI_ACL_HASH
exit $LASTEXITCODE
"""
    env = os.environ.copy()
    env.update(CODEX_OPENAI_ACL_SCRIPT=str(initializer), CODEX_OPENAI_ACL_ROOT=str(root),
               CODEX_OPENAI_ACL_HASH=hashlib.sha256(initializer.read_bytes()).hexdigest())
    try:
        completed = subprocess.run([pwsh, "-NoProfile", "-NonInteractive", "-EncodedCommand",
                                    base64.b64encode(command.encode("utf-16-le")).decode("ascii")],
                                   env=env, capture_output=True, text=True, timeout=20, check=False)
        result = json.loads(completed.stdout.strip())
        if completed.returncode or result.get("status") != "dry_run":
            raise ValueError()
    except (OSError, ValueError, subprocess.SubprocessError):
        raise PolicyError("private_storage_permissions", "Protected credential permissions could not be verified as the normal Windows user") from None


def load_credential(policy, root, admin=False, *, acl_checker=None):
    """Read one designated credential; never inspect ambient key variables."""
    path = credential_path(policy, root, admin=admin)
    missing = "admin_credential_missing" if admin else "credential_missing"
    try:
        if not path.is_file():
            raise PolicyError(missing, "The designated credential has not been saved in protected local storage")
        if path.stat().st_size > 65536:
            raise PolicyError("credential_invalid", "Designated credential file is unexpectedly large")
        verify_private_storage(root, credential_file=path, acl_checker=acl_checker)
        text = path.read_text(encoding="utf-8-sig")
    except PolicyError:
        raise
    except (OSError, UnicodeError):
        raise PolicyError("credential_inaccessible", "The designated credential could not be read safely") from None
    name = "OPENAI_ADMIN_KEY" if admin else policy.get("credential_env_name", "OPENAI_API_KEY")
    if name != ("OPENAI_ADMIN_KEY" if admin else "OPENAI_API_KEY"):
        raise PolicyError("credential_configuration_invalid", "Credential roles use fixed environment entry names")
    # Single-entry files avoid mixed roles and ambiguous dotenv parsing. Comments
    # and blank lines are harmless, but no second variable is accepted.
    entries = [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    if len(entries) != 1:
        raise PolicyError("credential_invalid", "Expected exactly one role-specific credential entry")
    match = re.fullmatch(re.escape(name) + r"\s*=\s*(.*?)\s*", entries[0])
    if not match:
        raise PolicyError("credential_invalid", "Credential entry does not match the designated role")
    value = match.group(1)
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    prefix = "sk-admin-" if admin else "sk-proj-"
    if not re.fullmatch(re.escape(prefix) + r"[A-Za-z0-9_-]+", value):
        raise PolicyError("credential_invalid", "Credential format does not match the designated role")
    return value
