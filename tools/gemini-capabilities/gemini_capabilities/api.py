"""Gemini API calls (generateContent, models.list), pricing and cost arithmetic. Standard library only."""
import json
import socket
import urllib.error
import urllib.request
from urllib.parse import urlencode
from datetime import datetime, timezone
from decimal import ROUND_CEILING, Decimal

from .dpapi import HelperError

BASE = "https://generativelanguage.googleapis.com/v1beta"


def prices_at(entry, at):
    """The price row in effect at `at` (rows carry an ISO `from` date, latest first wins)."""
    rows = sorted(entry.get("prices", []), key=lambda r: r["from"])
    chosen = None
    for row in rows:
        if datetime.fromisoformat(row["from"]).replace(tzinfo=timezone.utc) <= at:
            chosen = row
    if chosen is None:
        raise HelperError("price_unknown", "No verified price is in effect for this model")
    return chosen


def per_token(rate):
    return Decimal(str(rate)) / Decimal(1_000_000)


def reservation_microusd(entry, at, input_tokens, max_output_tokens, margin):
    """Worst case: the counted input tokens at the full input rate, every output and thinking token used, plus a
    margin. The highest listed price row from now on counts, so a scheduled price rise never under-reserves."""
    future = [r for r in entry.get("prices", []) if datetime.fromisoformat(r["from"]).replace(tzinfo=timezone.utc) >= at]
    rows = [prices_at(entry, at), *future]
    worst = max(per_token(r["input"]) * input_tokens + per_token(r["output"]) * max_output_tokens for r in rows)
    return int((worst * (1 + Decimal(str(margin))) * 1_000_000).to_integral_value(rounding=ROUND_CEILING))


def actual_microusd(entry, at, usage):
    row = prices_at(entry, at)
    prompt = int(usage.get("promptTokenCount") or 0)
    cached = int(usage.get("cachedContentTokenCount") or 0)
    output = int(usage.get("candidatesTokenCount") or 0) + int(usage.get("thoughtsTokenCount") or 0)
    cached_rate = row.get("cached_input", row["input"])
    cost = per_token(row["input"]) * max(0, prompt - cached) + per_token(cached_rate) * cached + per_token(row["output"]) * output
    return int((cost * 1_000_000).to_integral_value(rounding=ROUND_CEILING))


class Uncertain(Exception):
    """The request may have reached the provider; never retry it automatically."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """urllib copies headers, including the API key, onto redirects; the Gemini API never needs one."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, "redirect refused", headers, fp)


_OPENER = urllib.request.build_opener(_NoRedirect)


def default_opener(request, timeout):
    return _OPENER.open(request, timeout=timeout)


def _post(url, key, body, timeout, opener=default_opener):
    request = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                     headers={"x-goog-api-key": key, "content-type": "application/json"})
    return opener(request, timeout=timeout)


# Refusals that mean the request was not processed; anything else ambiguous stays uncertain.
REFUSED = {400, 401, 403, 404, 429}


def count_tokens(key, model, prompt, system=None, timeout=60, opener=default_opener):
    """Exact input tokens from the free countTokens method, so the reservation has a hard input bound."""
    body = {"contents": [{"role": "user", "parts": [{"text": prompt + ("\n" + system if system else "")}]}]}
    try:
        with _post(f"{BASE}/models/{model}:countTokens", key, body, timeout, opener) as response:
            total = json.loads(response.read().decode("utf-8")).get("totalTokens")
    except urllib.error.HTTPError as exc:
        raise HelperError(f"http_{exc.code}", "The Gemini API refused the token count") from None
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, json.JSONDecodeError):
        raise HelperError("count_tokens_failed", "Could not count tokens; nothing was submitted") from None
    if not isinstance(total, int) or total < 0:
        raise HelperError("count_tokens_failed", "The token count was not a number; nothing was submitted")
    return total


def generate(key, model, prompt, *, system=None, max_output_tokens, thinking_budget, timeout, opener=default_opener):
    body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"maxOutputTokens": max_output_tokens}}
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    # An explicit thinking budget bounds billable thinking; the reservation counts it on top of the output cap.
    body["generationConfig"]["thinkingConfig"] = {"thinkingBudget": thinking_budget}
    try:
        with _post(f"{BASE}/models/{model}:generateContent", key, body, timeout, opener) as response:
            reply = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code in REFUSED:
            raise HelperError(f"http_{exc.code}", "The Gemini API refused the request") from None
        raise Uncertain(f"http_{exc.code}") from None
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise Uncertain(type(exc).__name__) from None
    if not isinstance(reply.get("usageMetadata"), dict) or "promptTokenCount" not in reply["usageMetadata"]:
        raise Uncertain("usage_missing")
    candidates = reply.get("candidates") or []
    parts = (candidates[0].get("content") or {}).get("parts", []) if candidates else []
    text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
    return {"text": text, "usage": reply.get("usageMetadata") or {}, "model_version": reply.get("modelVersion"),
            "finish_reason": candidates[0].get("finishReason") if candidates else None}


def list_models(key, timeout=60, opener=default_opener):
    query = {"pageSize": 1000}
    models, seen = [], set()
    try:
        while True:
            request = urllib.request.Request(f"{BASE}/models?{urlencode(query)}", headers={"x-goog-api-key": key})
            with opener(request, timeout=timeout) as response:
                reply = json.loads(response.read().decode("utf-8"))
            page = reply.get("models", [])
            if not isinstance(page, list) or any(not isinstance(item, dict) for item in page):
                raise HelperError("model_list_invalid", "Gemini returned an invalid model list")
            models.extend(page)
            token = reply.get("nextPageToken")
            if not token:
                break
            if not isinstance(token, str) or token in seen:
                raise HelperError("model_list_invalid", "Gemini returned an invalid model list continuation")
            seen.add(token)
            query["pageToken"] = token
    except urllib.error.HTTPError as exc:
        raise HelperError(f"http_{exc.code}", "The Gemini API refused the model list request") from None
    except (OSError, ValueError):
        raise HelperError("model_list_failed", "Could not read the Gemini project model list") from None
    return [{"name": m.get("name", "").removeprefix("models/"), "methods": m.get("supportedGenerationMethods", []),
             "input_token_limit": m.get("inputTokenLimit"), "output_token_limit": m.get("outputTokenLimit")}
            for m in models]
