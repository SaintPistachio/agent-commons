"""Small JSON command interface. No billable work at import or discovery time."""
import argparse
import json
from pathlib import Path

from .adapters import AdapterError
from .policy import PolicyError
from .service import PACKAGE_ROOT, Service, _scrub, read_json


class SafeParser(argparse.ArgumentParser):
    def error(self, _message):
        self.exit(2, '{"status":"blocked","error_code":"invalid_arguments","next_action":"Inspect --help; credentials are never accepted as command arguments"}\n')


def main(argv=None):
    parser = SafeParser(description="Selective existing-prepaid OpenAI API capabilities")
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument("--policy", type=Path, default=PACKAGE_ROOT / "policy.json")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("status", "disable", "enable", "credits", "refresh-costs"):
        sub.add_parser(name)
    sub.add_parser("lookup", help="Read a recorded external operation without submitting or retrieving provider data").add_argument(
        "--external-request-id", required=True)
    for name in ("dry-run", "invoke", "batch-submit"):
        operation = sub.add_parser(name)
        operation.add_argument("--request", type=Path, required=True)
        if name in ("dry-run", "invoke"):
            operation.add_argument("--local-deadline-utc", help="Frozen host execution cutoff; does not change funding admission")
        operation.add_argument("--activation", action="store_true", help="Charge this job against the aggregate $1 activation allowance")
    sub.add_parser("refresh-funding").add_argument("--snapshot", type=Path, required=True)
    billing = sub.add_parser("billing-evidence", help="Parse selected local invoices/receipts without ledger access or funding changes")
    billing.add_argument("--document", type=Path, action="append", required=True)
    billing.add_argument("--pdftotext", type=Path, required=True)
    billing.add_argument("--extractor-sha256", required=True)
    for name in ("resume", "batch-status", "batch-results", "batch-cancel"):
        sub.add_parser(name).add_argument("job_id")
    setup = sub.add_parser("configure-limits", help="Explicit setup only; preview by default")
    setup.add_argument("--snapshot", type=Path, required=True)
    setup.add_argument("--apply", action="store_true")
    setup.add_argument("--expected-plan-sha256")
    confirm = sub.add_parser("confirm-limits", help="Record explicitly user-confirmed enforced settings without API writes")
    confirm.add_argument("--snapshot", type=Path, required=True)
    confirm.add_argument("--expected-plan-sha256", required=True)
    confirm.add_argument("--organization-limit-usd", required=True)
    confirm.add_argument("--project-limit-usd", required=True)
    confirm.add_argument("--enforced", action="store_true")
    confirm.add_argument("--ui-evidence", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "billing-evidence":
            import sys
            from .openai_helper_billing_evidence import import_documents, digest, bounded_file
            from . import openai_helper_billing_text as billing_text
            result = import_documents(args.document, (args.state_dir or PACKAGE_ROOT / ".local") / "billing-evidence",
                args.pdftotext, args.extractor_sha256, billing_text.parse_billing_text,
                digest(bounded_file(Path(billing_text.__file__).absolute(), 1024 * 1024)),
                progress=lambda event: print(json.dumps(event), file=sys.stderr, flush=True))
            print(json.dumps(result, ensure_ascii=True, allow_nan=False))
            return 0
        service = Service(args.state_dir, policy=read_json(args.policy))
        match args.command:
            case "status": result = service.status()
            case "lookup": result = service.lookup_external_request(args.external_request_id)
            case "lookup": result = service.lookup_external_request(args.external_request_id)
            case "disable":
                service.ledger.set_enabled(False)
                result = {"status": "disabled", "enabled": False, "pending_jobs": service.ledger.pending(),
                          "next_action": "Recorded jobs remain available through resume"}
            case "enable": result = service.enable()
            case "credits": result = service.credits()
            case "refresh-costs": result = service.refresh_costs()
            case "refresh-funding":
                service.ledger.refresh_funding(read_json(args.snapshot))
                result = service.status()
            case "configure-limits":
                result = service.configure_limits(read_json(args.snapshot), apply=args.apply, expected_sha256=args.expected_plan_sha256)
            case "confirm-limits":
                result = service.confirm_limits(read_json(args.snapshot), args.expected_plan_sha256,
                    args.organization_limit_usd, args.project_limit_usd, enforced=args.enforced,
                    ui_evidence=read_json(args.ui_evidence) if args.ui_evidence else None)
            case "dry-run" | "invoke" | "batch-submit":
                request = read_json(args.request)
                if args.activation:
                    if args.command == "batch-submit":
                        for item in request["requests"]:
                            item["request"]["activation"] = True
                    else:
                        request["activation"] = True
                result = {"dry-run": service.dry_run, "invoke": service.invoke, "batch-submit": service.batch_submit}[args.command](request, **({"local_deadline_utc": args.local_deadline_utc} if getattr(args, "local_deadline_utc", None) is not None else {}))
            case _: result = service.resume(args.job_id, args.command)
        # Keep JSON machine-readable on Windows consoles whose active code page
        # cannot encode arbitrary provider output. Escaping non-ASCII here must
        # never turn a completed submission into a local CLI failure.
        print(json.dumps(_scrub(result), ensure_ascii=True, allow_nan=False))
        return 2 if result.get("status") in {"blocked", "uncertain", "failed", "partial", "refused", "invalid_result", "incomplete"} else 0
    except (PolicyError, AdapterError) as exc:
        result = {"status": "blocked", "error_code": exc.code, "next_action": str(exc)}
        if isinstance(exc, PolicyError) and exc.diagnostics:
            result["diagnostics"] = exc.diagnostics
        print(json.dumps(result))
        return 2
    except (OSError, ValueError, KeyError, TypeError):
        # Do not serialize arbitrary exception text: it may contain private input.
        print(json.dumps({"status": "blocked", "error_code": "local_input_or_state_error",
                          "next_action": "Check the requested JSON file, supported schema, and local state access"}))
        return 2
