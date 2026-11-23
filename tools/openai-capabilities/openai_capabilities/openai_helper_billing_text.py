"""Pure, bounded parser for a deliberately narrow English billing-text layout.

This does not extract PDFs, bind accounts, establish payment authenticity, or
interpret subscription charges as API credits. The business key is a private
pseudonymous identifier, not an anonymity guarantee. Unsupported layouts fail
closed. All failures use fixed codes without echoing evidence.
"""

import hashlib
import re
import unicodedata
from datetime import date
from decimal import Decimal


_MAX_TEXT = 262144
_INVALID = "billing_text_invalid_input"
_MALFORMED = "billing_text_malformed"
_AMBIGUOUS = "billing_text_ambiguous"
_UNSUPPORTED = "billing_text_unsupported"

# An intentionally limited, explicit ISO currency allowlist. Symbols alone do
# not select an ISO currency, including the dollar sign.
_CODES = ("USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "JPY", "CNY", "INR")
_CODE = "(?:" + "|".join(_CODES) + ")"
_NUMBER = r"(?:0|[1-9][0-9]{0,11})\.[0-9]{2}"
_MONEY = rf"(?:{_CODE}\s+)?[$€£]?\s*{_NUMBER}(?:\s+{_CODE})?"
_MONEY_RE = re.compile(_MONEY)
_CODE_RE = re.compile(r"\b" + _CODE + r"\b")
_ITEM_RE = re.compile(
    rf"ChatGPT Pro Subscription \(per seat\) 1 ({_MONEY}) "
    rf"(?:0|[1-9][0-9]{{0,2}})(?:\.[0-9]{{1,4}})?% ({_MONEY})"
)
_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,127}")
_TABLE = "Description Qty Unit price Tax Amount"
_MONTHS = {}
for _number, (_short, _long) in enumerate((
    ("Jan", "January"), ("Feb", "February"), ("Mar", "March"),
    ("Apr", "April"), ("May", "May"), ("Jun", "June"),
    ("Jul", "July"), ("Aug", "August"), ("Sep", "September"),
    ("Oct", "October"), ("Nov", "November"), ("Dec", "December"),
), 1):
    _MONTHS[_short] = _number
    _MONTHS[_long] = _number
_MONTH = "(?:" + "|".join(sorted(_MONTHS, key=len, reverse=True)) + ")"
_DATE_RE = re.compile(rf"({_MONTH}) ([0-9]{{1,2}}), ([0-9]{{4}})")
_RANGE_RE = re.compile(
    rf"({_MONTH}) ([0-9]{{1,2}})(?:, ([0-9]{{4}}))? *[–-] *"
    rf"({_MONTH}) ([0-9]{{1,2}}), ([0-9]{{4}})"
)
_MONTH_START_RE = re.compile(rf"{_MONTH} [0-9]")


def _fail(code=_MALFORMED):
    raise ValueError(code)


def _put(values, key, value):
    if key in values and values[key] != value:
        _fail(_AMBIGUOUS)
    values[key] = value


def _calendar(year, month, day):
    try:
        return date(int(year), _MONTHS[month], int(day))
    except (ValueError, KeyError):
        _fail()


def _date(value):
    match = _DATE_RE.fullmatch(value)
    if not match:
        _fail()
    month, day, year = match.groups()
    return _calendar(year, month, day).isoformat()


def _cycle(value):
    match = _RANGE_RE.fullmatch(value)
    if not match:
        _fail()
    sm, sd, sy, em, ed, ey = match.groups()
    # A missing start year is inferred only from month rollover. Never turn a
    # reversed same-month range into an invented year-long subscription.
    if sy is None:
        sy = int(ey) - int(_MONTHS[sm] > _MONTHS[em])
    start = _calendar(sy, sm, sd)
    end = _calendar(ey, em, ed)
    if end <= start:
        _fail()
    return {
        "starts_on": start.isoformat(),
        "ends_on": end.isoformat(),
        "precision": "date_only",
        "timezone": "America/Chicago",
    }


def _money(value, currencies):
    if not _MONEY_RE.fullmatch(value):
        _fail()
    for code in _CODE_RE.findall(value):
        currencies.add(code)
    if len(currencies) > 1:
        _fail(_AMBIGUOUS)
    # The grammar admits only exact two-place decimals: no floats, grouping,
    # signs, exponents, or rounding. Symbols are deliberately not ISO evidence.
    value = _CODE_RE.sub("", value).strip()
    if value[:1] in ("$", "€", "£"):
        value = value[1:].strip()
    if not re.fullmatch(_NUMBER, value):
        _fail()
    return value


def _field(line, label):
    """Return a declared field, rejecting malformed label delimiters."""
    if not line.startswith(label):
        return None
    suffix = line[len(label):]
    if not suffix or suffix[0] not in " :":
        _fail()
    value = suffix.lstrip(" :")
    if not value:
        _fail()
    return value


def _footer(body, kind, fields, amounts, currencies):
    """Validate the known one-page footer without retaining payment identifiers."""
    if not body:
        return
    if kind == "invoice":
        if len(body) != 1:
            _fail(_UNSUPPORTED)
        footer = re.fullmatch(rf"({_ID_RE.pattern}) · ({_MONEY}) due ({_DATE_RE.pattern}) Page 1 of 1", body[0])
        if not footer or footer.group(1).upper() != fields["invoice_id"]:
            _fail(_UNSUPPORTED)
        if _money(footer.group(2), currencies) != amounts.get("Amount due"):
            _fail(_AMBIGUOUS)
        due = _date(footer.group(3))
        if fields.get("due_on") is not None and due != fields["due_on"]:
            _fail(_AMBIGUOUS)
        return
    if len(body) not in (4, 5) or body[0] != "Payment history" or body[1] != "Payment method Date Amount paid Receipt number" or body[-1] != "Page 1 of 1":
        _fail(_UNSUPPORTED)
    row = " ".join(body[2:-1])
    payment = re.fullmatch(rf".{{1,80}}? ({_DATE_RE.pattern}) ({_MONEY}) ([A-Za-z0-9-]+(?: [A-Za-z0-9-]+)?)", row)
    if not payment:
        _fail(_UNSUPPORTED)
    # _DATE_RE contains three capturing groups, so the full date is group1,
    # money group5 and the receipt reference group6.
    paid = _date(payment.group(1))
    if fields.get("paid_on") is not None and paid != fields["paid_on"]:
        _fail(_AMBIGUOUS)
    if _money(payment.group(5), currencies) != amounts.get("Amount paid"):
        _fail(_AMBIGUOUS)
    receipt = re.sub(r"(?<=-) +", "", payment.group(6)).upper()
    if receipt != fields["receipt_id"]:
        _fail(_AMBIGUOUS)


def parse_billing_text(text: str) -> dict:
    """Parse one supported Invoice/Receipt; never return private source fields.

    Supported money has two fractional digits, optional $, EUR/GBP symbols,
    and optional allowlisted ISO prefixes/suffixes. A single quantity-one
    subscription row is followed immediately by one date-only cycle. Only
    Subtotal, Tax, Total, and the kind-specific settlement row may follow it.
    Uninterpreted private header lines are discarded, never serialized.
    """
    if not isinstance(text, str) or not text or len(text) > _MAX_TEXT:
        _fail(_INVALID)
    for char in text:
        if unicodedata.category(char).startswith("C") and char not in "\t\n\r\f":
            _fail(_INVALID)
    raw_lines = text.replace("\r\n", "\n").replace("\r", "\n").replace("\f", "\n").split("\n")
    # In particular, do not search arbitrary text for an embedded heading.
    if raw_lines[0] not in ("Invoice", "Receipt"):
        _fail(_UNSUPPORTED)
    kind = raw_lines[0].lower()
    fields = {}
    currencies = set()
    issuer = False
    remaining = []
    for raw in raw_lines[1:]:
        line = " ".join(raw.split())
        if not line:
            continue
        if line in ("OpenAI", "OpenAI, LLC", "OpenAI OpCo, LLC",
                    "OpenAI, LLC Bill to", "OpenAI OpCo, LLC Bill to"):
            issuer = True
            continue
        handled = False
        for label, key in (("Invoice number", "invoice_id"),
                           ("Receipt number", "receipt_id")):
            value = _field(line, label)
            if value is not None:
                if not _ID_RE.fullmatch(value):
                    _fail()
                # IDs in this layout are ASCII and case-insensitive.
                _put(fields, key, value.upper())
                handled = True
                break
        if handled:
            continue
        for label, key in (("Date of issue", "issued_on"),
                           ("Date paid", "paid_on"),
                           ("Date due", "due_on")):
            value = _field(line, label)
            if value is not None:
                _put(fields, key, _date(value))
                handled = True
                break
        if handled:
            continue
        value = _field(line, "Currency")
        if value is not None:
            if value not in _CODES:
                _fail()
            currencies.add(value)
            if len(currencies) > 1:
                _fail(_AMBIGUOUS)
            continue
        if line.startswith("Date "):
            _fail(_UNSUPPORTED)
        remaining.append(line)

    if not issuer or "invoice_id" not in fields:
        _fail(_UNSUPPORTED)
    if kind == "receipt" and "receipt_id" not in fields:
        _fail()
    if kind == "invoice" and "receipt_id" in fields:
        _fail(_UNSUPPORTED)
    if remaining.count(_TABLE) != 1:
        _fail(_UNSUPPORTED)
    table_index = remaining.index(_TABLE)
    # Ignore private header fields, but never ignore apparent extra billing
    # content there. The parser is not a generic free-form invoice extractor.
    for line in remaining[:table_index]:
        if (any(word in line for word in (
                "Subscription", "Amount due", "Amount paid", "Subtotal",
                "Total", "Description", "Invoice", "Receipt"))
                or line.startswith("Tax ") or _MONTH_START_RE.match(line)):
            _fail(_UNSUPPORTED)
    body = remaining[table_index + 1:]
    if len(body) < 2:
        _fail()
    item = _ITEM_RE.fullmatch(body[0])
    if not item:
        _fail(_UNSUPPORTED)
    _money(item.group(1), currencies)
    subscription_amount = _money(item.group(2), currencies)
    cycle = _cycle(body[1])
    amounts = {}
    settlement = "Amount due" if kind == "invoice" else "Amount paid"
    tail = []
    for index, line in enumerate(body[2:], 2):
        if line == "Payment history" or re.match(rf"{_ID_RE.pattern} · ", line):
            tail = body[index:]
            break
        found = False
        tax = re.fullmatch(rf"Sales Tax - [A-Za-z .'-]{{1,80}} \((?:0|[1-9][0-9]{{0,2}})(?:\.[0-9]{{1,4}})?% on ({_MONEY})\) ({_MONEY})", line)
        if tax:
            if _money(tax.group(1), currencies) != subscription_amount:
                _fail(_AMBIGUOUS)
            _put(amounts, "Tax", _money(tax.group(2), currencies))
            continue
        for label in ("Subtotal", "Tax", "Total excluding tax", "Total", settlement):
            value = _field(line, label)
            if value is not None:
                _put(amounts, label, _money(value, currencies))
                found = True
                break
        if not found:
            # Includes extra items, extra cycles, alternative settlement rows,
            # arbitrary footers, and unsupported table continuations.
            _fail(_UNSUPPORTED)
    _footer(tail, kind, fields, amounts, currencies)
    billed_total = amounts.get(settlement)
    if billed_total is not None and "Total" in amounts:
        if amounts["Total"] != billed_total:
            _fail(_AMBIGUOUS)
    for label in ("Subtotal", "Total excluding tax"):
        if label in amounts and amounts[label] != subscription_amount:
            _fail(_AMBIGUOUS)
    pretax = amounts.get("Total excluding tax", amounts.get("Subtotal"))
    if pretax is not None and "Tax" in amounts and "Total" in amounts:
        if Decimal(pretax) + Decimal(amounts["Tax"]) != Decimal(amounts["Total"]):
            _fail(_AMBIGUOUS)
    currency = next(iter(currencies)) if currencies else None
    # Explicit ISO evidence cannot contradict a financial symbol elsewhere in
    # the table. Symbols by themselves still leave the currency unknown.
    symbols = {m.group(1) for line in body for m in re.finditer(r"([$€£])\s*[0-9]", line)}
    compatible = {"$": {"USD", "CAD", "AUD", "NZD"}, "€": {"EUR"}, "£": {"GBP"}}
    if currency is not None and any(currency not in compatible[s] for s in symbols):
        _fail(_AMBIGUOUS)
    return {
        "schema": "billing-text-evidence/1",
        "kind": kind,
        "business_key": hashlib.sha256(("openai:invoice:" + fields["invoice_id"]).encode("ascii")).hexdigest(),
        "plan": "chatgpt-pro",
        "cycle": cycle,
        "issued_on": fields.get("issued_on"),
        "paid_on": fields.get("paid_on"),
        "currency": currency,
        "subscription_amount": subscription_amount,
        "billed_total": billed_total,
        "grant_balance": None,
        "grant_issued": False,
        "admission_granted": False,
        "account_binding": "unverified",
    }
