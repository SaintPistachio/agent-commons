"""Public, project-visible Gemini models eligible for text jobs and their Standard rates."""
import json
import os
import re
import tempfile
import urllib.request
from datetime import date, datetime, timedelta

from .api import default_opener
from .dpapi import HelperError

DOCS_ROOT = "https://aistudio.google.com/docs"
GENERAL_ID = re.compile(r"gemini-(\d+(?:\.\d+)*)-(flash-lite|[a-z]+)")
SPECIAL_LINES = {"audio", "embedding", "image", "live", "robotics", "transcribe", "tts"}
DOC_HEADING = re.compile(r'^## .+?\s+{% id="([^"]+)" %}\s*$', re.M)
PUBLIC_MODELS = re.compile(r'^\s*\* `(gemini-[^ `]+)`\s*$', re.M)
PRICE = r"\$([0-9]+(?:\.[0-9]{1,6})?)"
DAY = r"[A-Za-z]+ \d{1,2}, \d{4}"
# The Standard table can include a parenthesized list of input modalities.
FLAT_PRICE = re.compile(PRICE + r"(?: \([a-zA-Z /]+\))?")
DATED_PRICE = re.compile(PRICE + rf" through ({DAY})\.\s+" + PRICE + rf" starting ({DAY})\.")


def sections(markdown):
    headings = list(DOC_HEADING.finditer(markdown))
    return {heading[1]: markdown[heading.end(): headings[i + 1].start() if i + 1 < len(headings) else len(markdown)]
            for i, heading in enumerate(headings)}


def model_line(model):
    match = GENERAL_ID.fullmatch(model)
    if not match or match[2] in SPECIAL_LINES:
        return None
    return match[2], tuple(map(int, match[1].split(".")))


def public_models(markdown):
    found = set()
    for heading, section in sections(markdown).items():
        if re.fullmatch(r"all-gemini-\d+-models", heading):
            found.update(model for model in PUBLIC_MODELS.findall(section) if model_line(model))
    if not found:
        raise HelperError("invalid_public_catalog", "Google's public text model catalog could not be read")
    return found


def price_schedule(value):
    flat = FLAT_PRICE.fullmatch(value)
    if flat:
        return {date.min.isoformat(): flat[1]}
    dated = DATED_PRICE.fullmatch(value)
    if not dated:
        raise ValueError("Unsupported pricing format")
    first_end = datetime.strptime(dated[2], "%B %d, %Y").date()
    second_start = datetime.strptime(dated[4], "%B %d, %Y").date()
    if first_end + timedelta(days=1) != second_start:
        raise ValueError("Non-contiguous pricing schedule")
    return {date.min.isoformat(): dated[1], second_start.isoformat(): dated[3]}


def standard_prices(section):
    standard = re.search(r'{% tab title="Standard" %}\s*{% table %}(.*?){% /table %}', section, re.S)
    if not standard or "Paid Tier, per 1M tokens in USD" not in standard[1]:
        raise ValueError("Missing Standard USD table")
    prices = {}
    for row in re.split(r"(?m)^\s*---\s*$", standard[1]):
        fields = re.split(r"(?m)^\s*\* ", row.strip("\n"))[1:]
        if len(fields) != 3:
            continue
        label = fields[0].strip()
        key = {"Input price": "input", "Output price (including thinking tokens)": "output"}.get(label)
        if key:
            if key in prices:
                raise ValueError("Ambiguous Standard USD price")
            prices[key] = price_schedule(fields[2].strip())
    if set(prices) != {"input", "output"} or prices["input"].keys() != prices["output"].keys():
        raise ValueError("Unmatched input and output prices")
    # Charge cached input at the full input rate in the local ledger. Cache discounts need no price assumption.
    rows = [{"from": start, "input": prices["input"][start], "output": prices["output"][start]} for start in prices["input"]]
    if any(float(row[key]) <= 0 for row in rows for key in ("input", "output")):
        raise ValueError("Non-positive Standard USD rate")
    return rows


def build_catalog(models_doc, pricing_doc, visible, observed_at):
    documented = public_models(models_doc)
    price_sections = sections(pricing_doc)
    candidates = {entry["name"]: entry for entry in visible if entry.get("name") in documented
                  and {"generateContent", "countTokens"}.issubset(entry.get("methods") or [])}
    if not candidates:
        raise HelperError("empty_project_catalog", "The project model list and public text catalog have no common entries")
    latest = {}
    for model in candidates:
        line, version = model_line(model)
        if line not in latest or version > latest[line][0]:
            latest[line] = (version, model)
    models, unavailable, superseded = {}, {}, {}
    for model, entry in sorted(candidates.items()):
        _, newest = latest[model_line(model)[0]]
        if model != newest:
            superseded[model] = newest
            continue
        try:
            rows = standard_prices(price_sections[model])
            input_limit, output_limit = entry.get("input_token_limit"), entry.get("output_token_limit")
            if any(type(limit) is not int or limit <= 0 for limit in (input_limit, output_limit)):
                raise ValueError("Missing token limits")
        except (KeyError, ValueError):
            unavailable[model] = "Current Standard USD text pricing or output limit could not be verified"
            continue
        models[model] = {"prices": rows, "input_token_limit": input_limit, "output_token_limit": output_limit}
    if not models:
        raise HelperError("unpriced_project_catalog", "No current Gemini model has verified Standard USD rates and token limits")
    return {"status": "observed", "observed_at": observed_at, "models": models,
            "superseded": superseded, "unavailable": unavailable}


def fetch_doc(name, opener=default_opener):
    request = urllib.request.Request(f"{DOCS_ROOT}/{name}.md", headers={"Accept": "text/markdown"})
    try:
        with opener(request, timeout=25) as response:
            return response.read().decode("utf-8")
    except (OSError, ValueError) as exc:
        raise HelperError("model_doc_unavailable", f"Could not read Google's {name} documentation") from exc


def publish_catalog(path, catalog):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False, mode="w", encoding="utf-8") as stream:
            temporary = stream.name
            json.dump(catalog, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            os.unlink(temporary)
