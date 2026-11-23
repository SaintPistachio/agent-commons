"""Private local evidence import, separate from funding admission and accounting.

Raw documents stay in this private store. The JSON result contains only bounded
parsed cycle evidence, digests and explicit uncertainty; it never grants funds.
Callers supply the already selected local extractor and its expected hash.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
from datetime import date
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import shutil
import stat
import tempfile
import time
import uuid
from itertools import islice


MAX_PDF = 20 * 1024 * 1024
MAX_TEXT = 262144
MAX_DOCUMENTS = 20
MAX_RECORDS = 1000


def fail(code):
    raise ValueError("billing_evidence_" + code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("ascii")


def local_path(value):
    p = Path(value)
    if not p.is_absolute() or str(p).startswith(("\\\\", "//")) or p == Path(p.anchor):
        fail("local_child_required")
    p = Path(os.path.abspath(p))
    for item in (p, *p.parents):
        if item.exists() or item.is_symlink():
            stat = item.lstat()
            if item.is_symlink() or getattr(stat, "st_file_attributes", 0) & 0x400:
                fail("link_refused")
    return p


def bounded_file(file, maximum):
    p = local_path(file)
    stat = p.lstat()
    if not p.is_file() or stat.st_nlink != 1 or stat.st_size > maximum:
        fail("file_refused")
    with p.open("rb") as stream:
        data = stream.read(maximum + 1)
    after = p.lstat()
    if len(data) > maximum or (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
        fail("source_changed")
    return data


def atomic_file(file, data):
    temp = file.with_name(file.name + "." + uuid.uuid4().hex + ".tmp")
    with os.fdopen(os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, file)


def private_storage(home, create=False, recursive=False):
    """Create only new private storage; refuse unsafe existing permissions."""
    local_path(home)
    if os.name == "nt":
        executable = shutil.which("pwsh")
        if not executable:
            fail("private_storage_unverified")
        verifier = Path(__file__).absolute().parent / "Verify-BillingEvidencePrivatePath.ps1"
        source_hash = digest(bounded_file(verifier, 65536))
        command = [executable, "-NoProfile", "-NonInteractive", "-File", str(verifier), "-Path", str(home), "-ExpectedSourceSha256", source_hash]
        if create:
            command.append("-Create")
        if recursive:
            command.append("-Recurse")
        environment = {k:v for k,v in os.environ.items() if k.upper() in {"SYSTEMROOT", "WINDIR", "TEMP", "TMP"}}
        checked = subprocess.run(command, executable=executable, env=environment, stdin=subprocess.DEVNULL,
            capture_output=True, text=True, timeout=30, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            result = json.loads(checked.stdout)
        except (ValueError, TypeError):
            fail("private_storage_unverified")
        if checked.returncode != 0 or result.get("status") != "private_verified":
            fail("private_storage_unverified")
        return
    if create:
        home.mkdir(mode=0o700)
    paths = [home]
    if recursive:
        for directory, children, files in os.walk(home, followlinks=False):
            paths.extend(Path(directory) / n for n in children + files)
            if len(paths) > 6000:
                fail("private_storage_unverified")
    for item in paths:
        local_path(item)
        info = item.lstat()
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            fail("private_storage_unverified")


@contextmanager
def evidence_lock(home, timeout=10):
    """Same OS-owned locking contract as helper cost refresh, separate namespace."""
    file = home / "import.lock"
    if file.exists():
        bounded_file(file, 4096)
    with os.fdopen(os.open(file, os.O_RDWR | os.O_CREAT | os.O_APPEND, 0o600), "a+b") as stream:
        if file.stat().st_size == 0:
            stream.write(b"\0")
            stream.flush()
        deadline = time.monotonic() + timeout
        while True:
            try:
                stream.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as error:
                if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    raise
                if time.monotonic() >= deadline:
                    fail("busy")
                time.sleep(min(.05, max(0, deadline - time.monotonic())))
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def extract_text(pdf, extractor, expected_hash, work):
    executable = local_path(extractor)
    if executable.name.lower() not in ("pdftotext", "pdftotext.exe") or not re.fullmatch(r"[a-f0-9]{64}", expected_hash):
        fail("extractor_required")
    if digest(bounded_file(executable, 128 * 1024 * 1024)) != expected_hash:
        fail("extractor_changed")
    # Provider credentials and native login environment are not extraction input.
    allowed = {"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL"}
    environment = {k: v for k, v in os.environ.items() if k.upper() in allowed}
    environment["AGENT_COMMONS_MANAGED_CHILD"] = "1"
    output, errors = work / "output.txt", work / "stderr.txt"
    with errors.open("xb") as stderr:
        child = subprocess.Popen([str(executable), "-layout", "-enc", "UTF-8", str(pdf), str(output)], executable=str(executable),
            cwd=work, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=stderr,
            env=environment, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        deadline = time.monotonic() + 20
        failure = None
        while child.poll() is None:
            if time.monotonic() >= deadline:
                failure = "extractor_timeout"
                break
            if errors.stat().st_size > 8192 or output.exists() and output.stat().st_size > MAX_TEXT:
                failure = "extractor_output_limit"
                break
            time.sleep(.05)
        if failure:
            child.kill()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                fail("extractor_termination_unverified")
            fail(failure)
        if child.returncode != 0 or errors.stat().st_size > 8192:
            fail("extractor_failed")
    return bounded_file(output, MAX_TEXT).decode("utf-8")


def _record(directory):
    raw = bounded_file(directory / "evidence.json", 65536)
    record = json.loads(raw, parse_constant=lambda _: fail("record_invalid"))
    if set(record) != {"schema", "artifact_sha256", "artifact_bytes", "imported_at", "extractor_sha256", "parser_sha256", "evidence", "record_sha256"}:
        fail("record_invalid")
    expected = record.pop("record_sha256")
    if record["schema"] != "helper-billing-evidence/1" or digest(canonical(record)) != expected or directory.name != record["artifact_sha256"]:
        fail("record_invalid")
    validate_evidence(record["evidence"])
    for key in ("parser_sha256", "extractor_sha256"):
        if not isinstance(record[key], str) or not re.fullmatch(r"[a-f0-9]{64}", record[key]):
            fail("record_invalid")
    stamp = datetime.fromisoformat(record["imported_at"])
    if stamp.tzinfo is None or stamp.utcoffset().total_seconds() != 0:
        fail("record_invalid")
    pdf = bounded_file(directory / "source.pdf", MAX_PDF)
    if len(pdf) != record["artifact_bytes"] or digest(pdf) != record["artifact_sha256"]:
        fail("artifact_changed")
    record["record_sha256"] = expected
    return record


def validate_evidence(value):
    expected = {"schema", "kind", "business_key", "plan", "cycle", "issued_on", "paid_on", "currency", "subscription_amount", "billed_total", "grant_balance", "grant_issued", "admission_granted", "account_binding"}
    if not isinstance(value, dict) or set(value) != expected or value["schema"] != "billing-text-evidence/1" or value["kind"] not in ("invoice", "receipt") or value["plan"] != "chatgpt-pro":
        fail("record_invalid")
    if not isinstance(value["business_key"], str) or not re.fullmatch(r"[a-f0-9]{64}", value["business_key"]) or value["grant_balance"] is not None or value["grant_issued"] is not False or value["admission_granted"] is not False or value["account_binding"] != "unverified":
        fail("record_invalid")
    cycle = value["cycle"]
    if not isinstance(cycle, dict) or set(cycle) != {"starts_on", "ends_on", "precision", "timezone"} or cycle["precision"] != "date_only" or cycle["timezone"] != "America/Chicago":
        fail("record_invalid")
    def day(raw):
        if not isinstance(raw, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
            fail("record_invalid")
        return date.fromisoformat(raw)
    if day(cycle["starts_on"]) >= day(cycle["ends_on"]):
        fail("record_invalid")
    for key in ("issued_on", "paid_on"):
        if value[key] is not None:
            day(value[key])
    if value["currency"] not in (None, "USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "JPY", "CNY", "INR"):
        fail("record_invalid")
    for key in ("subscription_amount", "billed_total"):
        if key == "billed_total" and value[key] is None:
            continue
        if not isinstance(value[key], str) or not re.fullmatch(r"(?:0|[1-9][0-9]{0,11})\.[0-9]{2}", value[key]):
            fail("record_invalid")


def summarize(records):
    """One invoice/receipt business identity, never duplicate funding or grant IDs."""
    groups = {}
    for record in records:
        evidence = record["evidence"]
        groups.setdefault(evidence["business_key"], []).append(record)
    cycles = []
    for key, members in sorted(groups.items()):
        evidence = [r["evidence"] for r in members]
        fields = ("plan", "cycle", "subscription_amount", "billed_total")
        claims = {k: {canonical(e[k]) for e in evidence if e[k] is not None} for k in fields}
        currencies = {e["currency"] for e in evidence if e["currency"] is not None}
        conflict = any(len(values) > 1 for values in claims.values()) or len(currencies) > 1
        selected = {k: next((e[k] for e in evidence if e[k] is not None), None) for k in fields}
        cycles.append({"business_key": key, "status": "conflicting_evidence" if conflict else "recorded_evidence",
            "artifacts": sorted(r["artifact_sha256"] for r in members),
            "cycle": None if conflict else selected["cycle"],
            "subscription_amount": None if conflict else selected["subscription_amount"],
            "billed_total": None if conflict else selected["billed_total"],
            "currency": next(iter(currencies)) if len(currencies) == 1 and not conflict else None,
            "currency_coverage": "partial" if any(e["currency"] is None for e in evidence) else "explicit",
            "payment_observed": any(e["kind"] == "receipt" and e["paid_on"] is not None for e in evidence),
            "observed_at": max(r["imported_at"] for r in members)})
    return {"schema": "helper-billing-cycle-projection/1", "status": "recorded", "cycles": cycles,
        "documents": len(records), "business_invoices": len(cycles), "grant_balance": None,
        "grant_issued": False, "expected_grant_issued": False, "account_binding": "unverified",
        "admission_granted": False, "ledger_opened": False, "inference_calls": 0,
        "acquisition": "explicit_local_documents", "live_balance_available": False}


def import_documents(documents, evidence_home, extractor, extractor_sha256, parse_text, parser_sha256, progress=None):
    if not isinstance(documents, list) or not 1 <= len(documents) <= MAX_DOCUMENTS or not re.fullmatch(r"[a-f0-9]{64}", parser_sha256):
        fail("input_invalid")
    home = local_path(evidence_home)
    home.parent.mkdir(parents=True, exist_ok=True)
    private_storage(home, create=not home.exists())
    records_home = local_path(home / "records")
    records_home.mkdir(mode=0o700, exist_ok=True)
    observed = datetime.now(timezone.utc).isoformat()
    imported, duplicate = 0, 0
    emit = progress or (lambda _event: None)
    emit({"event": "billing_evidence.started", "documents": len(documents), "inference_calls": 0})
    with evidence_lock(home):
        private_storage(home, recursive=True)
        if len(list(islice(records_home.iterdir(), MAX_RECORDS + 1))) > MAX_RECORDS:
            fail("record_limit")
        for index, name in enumerate(documents, 1):
            source = local_path(name)
            if source.suffix.lower() != ".pdf":
                fail("pdf_required")
            pdf = bounded_file(source, MAX_PDF)
            if not pdf.startswith(b"%PDF-"):
                fail("pdf_required")
            artifact = digest(pdf)
            emit({"event": "billing_evidence.document", "number": index, "total": len(documents), "artifact_sha256": artifact})
            directory = local_path(records_home / artifact)
            if (directory / "evidence.json").exists():
                _record(directory)
                duplicate += 1
                continue
            if not directory.exists() and len(list(islice(records_home.iterdir(), MAX_RECORDS))) >= MAX_RECORDS:
                fail("record_limit")
            # Scratch is an explicitly contained task-created child. Its raw
            # extraction output is removed; only the original private PDF remains.
            with tempfile.TemporaryDirectory(prefix="extract-", dir=home) as scratch:
                work = local_path(scratch)
                if work.parent != home:
                    fail("scratch_escape")
                selected = work / "source.pdf"
                selected.write_bytes(pdf)
                text = extract_text(selected, extractor, extractor_sha256, work)
                evidence = parse_text(text)
                validate_evidence(evidence)
            record = {"schema": "helper-billing-evidence/1", "artifact_sha256": artifact,
                "artifact_bytes": len(pdf), "imported_at": observed, "extractor_sha256": extractor_sha256,
                "parser_sha256": parser_sha256, "evidence": evidence}
            record["record_sha256"] = digest(canonical(record))
            directory.mkdir(mode=0o700, exist_ok=True)
            saved = directory / "source.pdf"
            if saved.exists():
                if bounded_file(saved, MAX_PDF) != pdf:
                    fail("artifact_changed")
            else:
                atomic_file(saved, pdf)
            atomic_file(directory / "evidence.json", canonical(record) + b"\n")
            imported += 1
        directories = list(islice(records_home.iterdir(), MAX_RECORDS + 1))
        if len(directories) > MAX_RECORDS:
            fail("record_limit")
        records = []
        for directory in sorted(directories):
            local_path(directory)
            if not directory.is_dir() or not re.fullmatch(r"[a-f0-9]{64}", directory.name):
                fail("record_invalid")
            if not (directory / "evidence.json").exists():
                fail("incomplete_import")
            records.append(_record(directory))
        result = summarize(records)
        result.update(imported_documents=imported, duplicate_documents=duplicate)
        emit({"event": "billing_evidence.completed", "imported": imported, "duplicates": duplicate, "conflicts": sum(c["status"] == "conflicting_evidence" for c in result["cycles"])})
        return result
