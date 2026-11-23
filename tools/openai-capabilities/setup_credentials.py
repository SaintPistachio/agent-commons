"""Local terminal-only credential entry. No key command-line arguments."""
from __future__ import annotations

import argparse
import getpass
import hmac
import json
import os
from pathlib import Path
import re
import sys
import warnings

from openai_capabilities.credentials import credential_path, verify_private_storage
from openai_capabilities.policy import PolicyError

ROOT = Path(__file__).resolve().parents[2]


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, _message):
        # argparse's default diagnostic echoes unrecognized argument values.
        # Never echo a key accidentally supplied on the command line.
        print(json.dumps({"status": "blocked", "code": "invalid_arguments", "message": "Use --kind admin or --kind project; enter keys only at the hidden prompt."}))
        raise SystemExit(2)


def save_new_credential(policy, root, key, *, admin=False, acl_checker=None):
    """Create once under verified permissions; never overwrite or back up keys."""
    path = credential_path(policy, root, admin=admin)
    prefix = "sk-admin-" if admin else "sk-proj-"
    if not isinstance(key, str) or not re.fullmatch(re.escape(prefix) + r"[A-Za-z0-9_-]+", key):
        raise PolicyError("credential_invalid", "Entered credential does not match the selected role")
    verify_private_storage(root, acl_checker=acl_checker)
    if path.exists():
        raise PolicyError("credential_exists", "The designated file already exists; replacement requires a separate explicit workflow")
    created = False
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
        created = True
        with os.fdopen(descriptor, "wb") as stream:
            # The empty file inherits only the private root's allowlisted ACL.
            # Verify before any credential bytes are written.
            verify_private_storage(root, credential_file=path, acl_checker=acl_checker)
            name = "OPENAI_ADMIN_KEY" if admin else "OPENAI_API_KEY"
            stream.write((name + "=" + key + "\n").encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        verify_private_storage(root, credential_file=path, acl_checker=acl_checker)
    except PolicyError:
        if created:
            path.unlink(missing_ok=True)
        raise
    except OSError:
        if created:
            path.unlink(missing_ok=True)
        raise PolicyError("credential_write_failed", "Credential could not be saved to protected local storage") from None
    return {"status": "saved", "path": str(path), "env_name": "OPENAI_ADMIN_KEY" if admin else "OPENAI_API_KEY", "role": "admin" if admin else "project"}


def main(argv=None):
    parser = SafeArgumentParser(description="Enter a role-specific key using a local hidden terminal prompt.")
    parser.add_argument("--kind", choices=("admin", "project"), required=True)
    args = parser.parse_args(argv)
    try:
        if not sys.stdin.isatty() or not sys.stderr.isatty():
            raise PolicyError("interactive_terminal_required", "Run this command in your local interactive terminal; redirected or chat input is refused")
        policy = json.loads((Path(__file__).resolve().parent / "policy.json").read_text(encoding="utf-8-sig"))
        admin = args.kind == "admin"
        path = credential_path(policy, ROOT, admin=admin)
        verify_private_storage(ROOT)
        if path.exists():
            raise PolicyError("credential_exists", "The designated credential file already exists; it will not be overwritten")
        answer = input(f"Save the new {args.kind} credential only to {path}? Type yes to continue: ").strip()
        if answer.lower() != "yes":
            print(json.dumps({"status": "cancelled"}))
            return 1
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            try:
                key = getpass.getpass(f"{args.kind.capitalize()} key (hidden): ")
                confirmation = getpass.getpass("Enter the same key again (hidden): ")
            except getpass.GetPassWarning:
                raise PolicyError("hidden_input_unavailable", "Secure hidden terminal input is unavailable; no credential was saved") from None
        if not hmac.compare_digest(key, confirmation):
            raise PolicyError("credential_mismatch", "The hidden entries did not match; no credential was saved")
        result = save_new_credential(policy, ROOT, key, admin=admin)
        key = confirmation = ""
        print(json.dumps(result))
        return 0
    except PolicyError as exc:
        print(json.dumps({"status": "blocked", "code": exc.code, "message": str(exc)}))
        return 1
    except (EOFError, KeyboardInterrupt):
        print(json.dumps({"status": "cancelled"}))
        return 1
    except (OSError, UnicodeError, ValueError):
        print(json.dumps({"status": "blocked", "code": "credential_setup_failed", "message": "Credential setup could not complete safely; inspect local configuration and permissions."}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
