import contextlib
from synthetic_keys import synthetic_key, synthetic_env_prefix
import getpass
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import warnings

from openai_capabilities.credentials import SECRET_RELATIVE, credential_path, load_credential, verify_private_storage
from openai_capabilities.policy import PolicyError
import setup_credentials


class CredentialTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.secret = self.root / SECRET_RELATIVE
        self.secret.mkdir(parents=True)
        self.policy = {"credential_env_file": str(SECRET_RELATIVE / "project.env"),
                       "admin_credential_env_file": str(SECRET_RELATIVE / "admin.env"),
                       "credential_env_name": "OPENAI_API_KEY"}
        self.allow = Mock(return_value=True)

    def test_project_admin_separation_and_no_ambient_fallback(self):
        project = self.secret / "project.env"
        project.write_text(((synthetic_env_prefix('OPENAI_API_KEY')) + synthetic_key('proj-syntheticProjectCanary') + '\n'), encoding="utf-8")
        admin = self.secret / "admin.env"
        admin.write_text(((synthetic_env_prefix('OPENAI_ADMIN_KEY')) + synthetic_key('admin-syntheticAdminCanary') + '\n'), encoding="utf-8")
        with patch.dict(os.environ, {"OPENAI_API_KEY": (synthetic_key('proj-ambientCanary')), "OPENAI_ADMIN_KEY": (synthetic_key('admin-ambientCanary'))}):
            self.assertEqual(load_credential(self.policy, self.root, acl_checker=self.allow), (synthetic_key('proj-syntheticProjectCanary')))
            self.assertEqual(load_credential(self.policy, self.root, admin=True, acl_checker=self.allow), (synthetic_key('admin-syntheticAdminCanary')))
            project.unlink()
            with self.assertRaises(PolicyError) as caught:
                load_credential(self.policy, self.root, acl_checker=self.allow)
            self.assertEqual(caught.exception.code, "credential_missing")
        self.assertTrue(all(isinstance(call.args[0], Path) for call in self.allow.call_args_list))

    def test_rejects_wrong_roles_mixed_files_and_oversized_files(self):
        project = self.secret / "project.env"
        for content in (((synthetic_env_prefix('OPENAI_API_KEY')) + synthetic_key('admin-wrongRoleCanary') + '\n'),
                        ((synthetic_env_prefix('OPENAI_API_KEY')) + synthetic_key('proj-a') + ('\n' + synthetic_env_prefix('OPENAI_ADMIN_KEY')) + synthetic_key('admin-b') + '\n'),
                        ((synthetic_env_prefix('OPENAI_API_KEY')) + synthetic_key('proj-a') + ('\n' + synthetic_env_prefix('OPENAI_API_KEY')) + synthetic_key('proj-b') + '\n'),
                        ((synthetic_env_prefix('OPENAI_API_KEY') + "'") + synthetic_key('proj-unbalanced') + '\n'), "X" * 65537):
            project.write_text(content, encoding="utf-8")
            with self.subTest(size=len(content)), self.assertRaises(PolicyError) as caught:
                load_credential(self.policy, self.root, acl_checker=self.allow)
            self.assertEqual(caught.exception.code, "credential_invalid")
            self.assertNotIn("Canary", str(caught.exception))

    def test_rejects_unprotected_or_unverifiable_permissions_before_reading_key(self):
        project = self.secret / "project.env"
        project.write_text(((synthetic_env_prefix('OPENAI_API_KEY')) + synthetic_key('proj-syntheticCanary')), encoding="utf-8")
        for checker in (Mock(return_value=False), Mock(side_effect=PermissionError("private-canary"))):
            with self.assertRaises(PolicyError) as caught:
                load_credential(self.policy, self.root, acl_checker=checker)
            self.assertEqual(caught.exception.code, "private_storage_permissions")
            self.assertNotIn("private-canary", str(caught.exception))

    def test_rejects_outside_paths_and_legacy_broad_location(self):
        for value in (".env.local", "../project.env", str(self.root / "project.env")):
            with self.subTest(value=value), self.assertRaises(PolicyError):
                credential_path({**self.policy, "credential_env_file": value}, self.root)

    def test_rejects_reparse_points_before_permissions_or_secret_read(self):
        path = self.secret / "project.env"
        original = Path.lstat
        def fake_lstat(target, *args, **kwargs):
            result = original(target, *args, **kwargs)
            if target == self.secret:
                return type("ReparseStat", (), {"st_mode": result.st_mode, "st_file_attributes": 0x400})()
            return result
        with patch.object(Path, "lstat", fake_lstat), self.assertRaises(PolicyError) as caught:
            credential_path(self.policy, self.root)
        self.assertEqual(caught.exception.code, "credential_path_invalid")

    def test_new_only_write_checks_permissions_while_file_is_empty(self):
        path = self.secret / "admin.env"
        checks = []
        def checker(target, directory):
            if not directory:
                checks.append(target.stat().st_size)
            return True
        result = setup_credentials.save_new_credential(self.policy, self.root, (synthetic_key('admin-syntheticCanary')), admin=True, acl_checker=checker)
        self.assertEqual(result["env_name"], "OPENAI_ADMIN_KEY")
        self.assertEqual(checks[0], 0)
        self.assertGreater(checks[-1], 0)
        self.assertEqual(load_credential(self.policy, self.root, admin=True, acl_checker=self.allow), (synthetic_key('admin-syntheticCanary')))
        with self.assertRaises(PolicyError) as caught:
            setup_credentials.save_new_credential(self.policy, self.root, (synthetic_key('admin-replacementCanary')), admin=True, acl_checker=self.allow)
        self.assertEqual(caught.exception.code, "credential_exists")
        self.assertNotIn("syntheticCanary", str(result))
        self.assertEqual(len(list(self.secret.iterdir())), 1)

    def test_permission_failure_during_new_write_removes_empty_file(self):
        path = self.secret / "project.env"
        def checker(target, directory):
            return directory
        with self.assertRaises(PolicyError):
            setup_credentials.save_new_credential(self.policy, self.root, (synthetic_key('proj-syntheticCanary')), acl_checker=checker)
        self.assertFalse(path.exists())

    def test_noninteractive_input_and_key_arguments_are_refused_without_echo(self):
        with patch.object(setup_credentials.sys, "stdin", Mock(isatty=Mock(return_value=False))), patch.object(setup_credentials.getpass, "getpass") as hidden, contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(setup_credentials.main(["--kind", "admin"]), 1)
            self.assertIn("interactive_terminal_required", output.getvalue())
            hidden.assert_not_called()
        with contextlib.redirect_stdout(io.StringIO()) as output, self.assertRaises(SystemExit):
            setup_credentials.main(["--kind", "admin", "--key", (synthetic_key('admin-secretCanary'))])
        self.assertNotIn("secretCanary", output.getvalue())

    def test_hidden_input_never_falls_back_to_echoing(self):
        def warning(*args, **kwargs):
            warnings.warn("hidden input unavailable", getpass.GetPassWarning)
        (self.root / "policy.json").write_text("{}", encoding="utf-8")
        with patch.object(setup_credentials.sys, "stdin", Mock(isatty=Mock(return_value=True))), patch.object(setup_credentials.sys, "stderr", Mock(isatty=Mock(return_value=True))), patch.object(setup_credentials.json, "loads", return_value=self.policy), patch.object(setup_credentials, "ROOT", self.root), patch.object(setup_credentials, "__file__", str(self.root / "setup_credentials.py")), patch.object(setup_credentials, "verify_private_storage"), patch("builtins.input", return_value="yes"), patch.object(setup_credentials.getpass, "getpass", side_effect=warning), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(setup_credentials.main(["--kind", "admin"]), 1)
            self.assertIn("hidden_input_unavailable", output.getvalue())
        self.assertFalse((self.secret / "admin.env").exists())


if __name__ == "__main__":
    unittest.main()
