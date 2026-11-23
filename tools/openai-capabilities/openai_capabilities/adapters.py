"""Bounded official-SDK operations. No environment credential or URL discovery."""
from __future__ import annotations

import copy
import json
import logging
import math
import os
import queue
import re
import threading
import time
from typing import Any
from .execution_context import execution_context

API_BASE = "https://api.openai.com/v1"
ENDPOINTS = {"embeddings": "/v1/embeddings", "responses": "/v1/responses"}
MODELS = {"embeddings": {"text-embedding-3-small"}, "decisions": {"gpt-6-luna"},
          "responses": {"gpt-6-luna", "gpt-6.1-sol"}}
_REGISTRY_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "registry.json")


def _registered_responses_models():
    """Responses models with a verified registry entry (pricing and limits). policy.validate_request checks the
    model, tier and prices against the same registry, so adding a verified entry is all a new model needs."""
    try:
        with open(_REGISTRY_FILE, encoding="utf-8") as handle:
            models = json.load(handle)["models"]
    except (OSError, ValueError, KeyError, TypeError):
        return set()
    return {name for name, entry in models.items()
            if isinstance(entry, dict) and isinstance(entry.get("capabilities"), dict) and "responses" in entry["capabilities"]}


class AdapterError(Exception):
    """Allowlisted error metadata; never contains SDK exception text or payloads."""
    def __init__(self, code, message, *, retryable=False, uncertain=False,
                 api_id=None, input_file_id=None, http_status=None,
                 failure_class=None, exception_type=None, provider_request_id=None,
                 transport_cause_type=None):
        super().__init__(message)
        self.code, self.retryable, self.uncertain = code, retryable, uncertain
        self.api_id, self.input_file_id = api_id, input_file_id
        self.http_status = http_status if type(http_status) is int and 100 <= http_status <= 599 else None
        self.failure_class = failure_class if failure_class in {
            "provider_transport", "provider_http", "provider_error", "local_deadline", "local_result_missing"
        } else None
        self.exception_type = exception_type if exception_type in {
            "APITimeoutError", "APIConnectionError", "ReadTimeout", "ConnectTimeout", "WriteTimeout",
            "PoolTimeout", "NetworkError", "HTTPStatusError", "APIStatusError", "APIError", "BadRequestError",
            "AuthenticationError", "PermissionDeniedError", "NotFoundError", "ConflictError",
            "UnprocessableEntityError", "RateLimitError", "InternalServerError", "ServerError"
        } else None
        self.provider_request_id = (provider_request_id if isinstance(provider_request_id, str)
                                    and len(provider_request_id) <= 180
                                    and provider_request_id.startswith("req_")
                                    and all(ch.isalnum() or ch in "_-" for ch in provider_request_id[4:])
                                    else None)
        self.transport_cause_type = transport_cause_type if transport_cause_type in {
            "ConnectError", "ConnectTimeout", "ReadError", "ReadTimeout", "WriteError", "WriteTimeout",
            "PoolTimeout", "NetworkError", "ProxyError", "RemoteProtocolError", "LocalProtocolError",
            "ProtocolError", "PermissionError", "ConnectionRefusedError", "ConnectionResetError",
            "TimeoutError", "gaierror", "SSLError", "OSError"
        } else None


def _bad(message):
    raise AdapterError("invalid_payload", message)


def _fields(value, allowed, required=()):
    if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
        _bad("Unsupported or missing request fields; inspect the capability guide.")


def _text(value, *, empty=False):
    if not isinstance(value, str) or (not empty and not value.strip()):
        _bad("Expected a nonempty text value.")


def _cache(value, capability):
    _fields(value, {"mode", "ttl"})
    if value.get("mode", "explicit") not in {"explicit", "implicit"}:
        _bad("Unsupported cache mode.")
    ttls = {"30m"} if capability == "decisions" else {"30m", "12h"}
    if value.get("ttl", "30m") not in ttls:
        _bad("Unsupported cache lifetime for this endpoint.")


_TOOL_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _validate_tools(tools):
    if not isinstance(tools, list) or not 1 <= len(tools) <= 64:
        _bad("Function tools require 1 to 64 tool definitions.")
    names = set()
    for tool in tools:
        if not isinstance(tool, dict):
            _bad("Each tool definition must be an object.")
        if tool.get("type") != "function":
            _bad("Media, files, tools, and references require a separately priced adapter.")
        _fields(tool, {"type", "name", "description", "parameters", "strict"}, {"type", "name", "parameters", "strict"})
        name = tool["name"]
        if not isinstance(name, str) or _TOOL_NAME.fullmatch(name) is None or name in names:
            _bad("Function tool names must be unique bounded identifiers.")
        names.add(name)
        if "description" in tool:
            if not isinstance(tool["description"], str) or len(tool["description"]) > 8192:
                _bad("Function tool description must be a bounded string.")
        if tool["strict"] is not True:
            _bad("Function tools require strict=true.")
        params = tool["parameters"]
        if not isinstance(params, dict) or params.get("type") != "object":
            _bad("Function tool parameters must be a strict object schema.")
        _check_schema(params)
    return names


def _validate_tool_choice(choice, tool_names):
    if isinstance(choice, str):
        if choice not in {"auto", "none", "required"}:
            _bad("Unsupported tool_choice mode.")
        return
    if isinstance(choice, dict):
        _fields(choice, {"type", "name"}, {"type", "name"})
        if choice["type"] != "function" or not isinstance(choice["name"], str) or choice["name"] not in tool_names:
            _bad("Named tool_choice must select a declared function tool.")
        return
    _bad("Unsupported tool_choice specification.")


def _input(value, capability, tool_names=None):
    if isinstance(value, str):
        _text(value)
        return
    if not isinstance(value, list) or not value or len(value) > 1000:
        _bad("Input must be text or at most 1000 text/JSON messages.")
    breakpoints = 0
    call_ids, output_call_ids = set(), set()
    for message in value:
        if not isinstance(message, dict):
            _bad("Invalid input item.")
        item_type = message.get("type")
        if item_type in {"function_call", "function_call_output"}:
            if capability != "responses" or not tool_names:
                _bad("Function call items require declared function tools.")
            if item_type == "function_call":
                _fields(message, {"type", "call_id", "name", "arguments"}, {"type", "call_id", "name", "arguments"})
                call_id = message["call_id"]
                if not isinstance(call_id, str) or not call_id.strip() or len(call_id) > 128 or call_id in call_ids:
                    _bad("Function call items require unique bounded call_id strings.")
                if not isinstance(message["name"], str) or message["name"] not in tool_names:
                    _bad("Function call items must reference a declared tool.")
                if not isinstance(message["arguments"], str) or len(message["arguments"].encode("utf-8")) > 65536:
                    _bad("Function call arguments must be strings within 64 KiB.")
                call_ids.add(call_id)
            else:
                _fields(message, {"type", "call_id", "output"}, {"type", "call_id", "output"})
                call_id = message["call_id"]
                if not isinstance(call_id, str) or call_id not in call_ids or call_id in output_call_ids:
                    _bad("Function call output must match one earlier function_call item.")
                if not isinstance(message["output"], str) or len(message["output"].encode("utf-8")) > 262144:
                    _bad("Function call output must be a string within 256 KiB.")
                output_call_ids.add(call_id)
            continue
        _fields(message, {"role", "content", "type"}, {"role", "content"})
        if message["role"] not in {"user", "developer", "system", "assistant"} or message.get("type", "message") != "message":
            _bad("Only text conversation messages are supported.")
        content = message["content"]
        if isinstance(content, str):
            _text(content, empty=True)
            continue
        if not isinstance(content, list) or not content:
            _bad("Message content must be text or supported content parts.")
        for part in content:
            if not isinstance(part, dict):
                _bad("Invalid content part.")
            kind = part.get("type")
            if kind in {"input_text", "output_text"}:
                if kind == "output_text" and message["role"] != "assistant":
                    _bad("Output text is allowed only in assistant messages.")
                _fields(part, {"type", "text", "prompt_cache_breakpoint"}, {"type", "text"})
                _text(part["text"], empty=True)
                if "prompt_cache_breakpoint" in part:
                    bp = part["prompt_cache_breakpoint"]
                    _fields(bp, {"mode", "ttl"} if capability == "responses" else {"mode"}, {"mode"})
                    if bp["mode"] != "explicit" or bp.get("ttl", "30m") not in {"30m", "12h"}:
                        _bad("Invalid cache breakpoint.")
                    breakpoints += 1
            elif kind == "input_json" and capability == "decisions" and message["role"] == "user":
                _fields(part, {"type", "data"}, {"type", "data"})
                if not isinstance(part["data"], (dict, list)):
                    _bad("Decisions JSON evidence must be an object or array.")
                try:
                    encoded = json.dumps(part["data"], allow_nan=False).encode("utf-8")
                except (ValueError, TypeError, RecursionError):
                    _bad("Invalid JSON evidence.")
                if len(encoded) > 262144:
                    _bad("JSON evidence exceeds the supported size.")
            else:
                _bad("Media, files, tools, and references require a separately priced adapter.")
    if breakpoints > 4:
        _bad("At most four cache breakpoints are supported.")


def _questions(questions):
    if not isinstance(questions, list) or not 1 <= len(questions) <= 400:
        _bad("Decisions requires 1 to 400 questions.")
    names = set()
    for q in questions:
        _fields(q, {"type", "name", "instructions", "choices", "levels"}, {"type", "name", "instructions"})
        _text(q["name"])
        _text(q["instructions"])
        if q["name"] in names:
            _bad("Question names must be unique.")
        names.add(q["name"])
        kind = q["type"]
        if kind == "predicate":
            if "choices" in q or "levels" in q:
                _bad("Predicates do not take choices or levels.")
        elif kind == "choice":
            choices = q.get("choices")
            if "levels" in q or not isinstance(choices, list) or not 2 <= len(choices) <= 255:
                _bad("Choice questions require 2 to 255 choices.")
            values = set()
            for choice in choices:
                _fields(choice, {"value", "description"}, {"value"})
                if type(choice["value"]) not in (str, bool):
                    _bad("Choice values must be strings or booleans.")
                typed_value = (type(choice["value"]), choice["value"])
                if typed_value in values:
                    _bad("Choice values must be unique.")
                values.add(typed_value)
                if "description" in choice:
                    _text(choice["description"], empty=True)
        elif kind == "score":
            levels = q.get("levels")
            if "choices" in q or not isinstance(levels, list) or not 2 <= len(levels) <= 10:
                _bad("Score questions require 2 to 10 ordered levels.")
            for level in levels:
                _fields(level, {"label", "description"}, {"label", "description"})
                _text(level["label"])
                _text(level["description"])
        else:
            _bad("Supported question types are predicate, choice, and score.")


def _check_schema(schema, depth=0):
    """Small explicit JSON Schema subset, rejected rather than silently ignored."""
    if depth > 32 or not isinstance(schema, dict):
        _bad("Structured schema is invalid or too deeply nested.")
    allowed = {"type", "properties", "required", "additionalProperties", "items", "enum", "anyOf", "description", "title"}
    if set(schema) - allowed:
        _bad("This helper supports basic typed JSON schemas, enum, and anyOf; unsupported constraints require an adapter extension.")
    if "anyOf" in schema:
        if not isinstance(schema["anyOf"], list) or not schema["anyOf"]:
            _bad("Schema anyOf must be a nonempty array.")
        for sub in schema["anyOf"]:
            _check_schema(sub, depth + 1)
    kind = schema.get("type")
    kinds = kind if isinstance(kind, list) else [kind]
    if any(k not in {"object", "array", "string", "integer", "number", "boolean", "null", None} for k in kinds):
        _bad("Unsupported schema type.")
    if kind is None and "anyOf" not in schema and "enum" not in schema:
        _bad("Each schema node must establish a type, enum, or anyOf.")
    if "properties" in schema:
        if not isinstance(schema["properties"], dict):
            _bad("Schema properties must be an object.")
        for sub in schema["properties"].values():
            _check_schema(sub, depth + 1)
    if "required" in schema and (not isinstance(schema["required"], list) or any(not isinstance(k, str) for k in schema["required"])):
        _bad("Schema required must list field names.")
    if "additionalProperties" in schema and type(schema["additionalProperties"]) is not bool:
        _bad("Schema additionalProperties must be boolean.")
    if "items" in schema:
        _check_schema(schema["items"], depth + 1)
    if "object" in kinds:
        if not isinstance(schema.get("properties"), dict) or schema.get("additionalProperties") is not False:
            _bad("Strict object schemas require properties and additionalProperties=false.")
        if set(schema.get("required", [])) != set(schema["properties"]):
            _bad("Strict object schemas must require every declared property; use a nullable type for optional values.")
    if "array" in kinds and "items" not in schema:
        _bad("Array schemas require an items schema.")
    if "enum" in schema and (not isinstance(schema["enum"], list) or not schema["enum"]):
        _bad("Schema enum must be nonempty.")


def _matches_schema(value, schema):
    if "anyOf" in schema and not any(_matches_schema(value, sub) for sub in schema["anyOf"]):
        return False
    if "enum" in schema and not any(type(value) is type(v) and value == v for v in schema["enum"]):
        return False
    kind = schema.get("type")
    if isinstance(kind, list):
        return any(_matches_schema(value, {**schema, "type": one}) for one in kind)
    checks = {"object": lambda: isinstance(value, dict), "array": lambda: isinstance(value, list),
              "string": lambda: isinstance(value, str), "integer": lambda: type(value) is int,
              "number": lambda: _number(value), "boolean": lambda: type(value) is bool, "null": lambda: value is None}
    if kind is not None and not checks[kind]():
        return False
    if isinstance(value, dict):
        props = schema.get("properties", {})
        if set(schema.get("required", [])) - set(value):
            return False
        if schema.get("additionalProperties") is False and set(value) - set(props):
            return False
        return all(_matches_schema(v, props[k]) for k, v in value.items() if k in props)
    if isinstance(value, list) and "items" in schema:
        return all(_matches_schema(v, schema["items"]) for v in value)
    return True


def validate_payload(request):
    """Pure validation before admission or network activity; returns SDK body."""
    cap, model, tier = request.get("capability"), request.get("model"), request.get("tier", "default")
    allowed = MODELS.get(cap, set()) | (_registered_responses_models() if cap == "responses" else set())
    if cap not in MODELS or model not in allowed:
        _bad("Unsupported endpoint/model combination.")
    if tier not in ({"default", "batch"} if cap == "embeddings" else {"default"} if cap == "decisions" else {"default", "flex", "batch"}):
        _bad("Unsupported processing tier for this endpoint.")
    payload = copy.deepcopy(request.get("payload"))
    fields = {"embeddings": {"input", "dimensions"},
              "decisions": {"input", "questions", "prompt_cache_options", "prompt_cache_key"},
              "responses": {"input", "instructions", "max_output_tokens", "reasoning", "text", "prompt_cache_options", "prompt_cache_key",
                            "tools", "tool_choice", "parallel_tool_calls"}}
    _fields(payload, fields[cap], {"input"})
    if cap == "embeddings":
        inputs = payload["input"]
        if isinstance(inputs, str):
            inputs = [inputs]
        if not isinstance(inputs, list) or not 1 <= len(inputs) <= 2048 or any(not isinstance(i, str) or not i.strip() for i in inputs):
            _bad("Embeddings requires 1 to 2048 nonempty text inputs.")
        if "dimensions" in payload and (type(payload["dimensions"]) is not int or not 1 <= payload["dimensions"] <= 1536):
            _bad("Embedding dimensions must be between 1 and 1536.")
        payload["encoding_format"] = "float"
    else:
        tool_names = None
        if cap == "responses":
            if "tools" in payload:
                if "text" in payload:
                    _bad("Structured output cannot be combined with function tools.")
                tool_names = _validate_tools(payload["tools"])
            if "tool_choice" in payload:
                if not tool_names:
                    _bad("tool_choice requires declared function tools.")
                _validate_tool_choice(payload["tool_choice"], tool_names)
            if "parallel_tool_calls" in payload:
                if not tool_names:
                    _bad("parallel_tool_calls requires declared function tools.")
                if type(payload["parallel_tool_calls"]) is not bool:
                    _bad("parallel_tool_calls must be a boolean.")
        _input(payload["input"], cap, tool_names)
        if "prompt_cache_options" in payload:
            _cache(payload["prompt_cache_options"], cap)
        else:
            # Avoid speculative writes for one-off application calls.
            payload["prompt_cache_options"] = {"mode": "explicit", "ttl": "30m"}
        if "prompt_cache_key" in payload:
            _text(payload["prompt_cache_key"])
        if cap == "decisions":
            _questions(payload.get("questions"))
        else:
            limit = payload.get("max_output_tokens")
            if type(limit) is not int or not 1 <= limit <= 128000:
                _bad("Responses requires max_output_tokens between 1 and 128000.")
            if "instructions" in payload:
                _text(payload["instructions"], empty=True)
            if "reasoning" in payload:
                _fields(payload["reasoning"], {"effort"}, {"effort"})
                efforts = {"low", "medium", "high", "xhigh", "max"} | ({"none"} if model == "gpt-6-luna" else set())
                if payload["reasoning"]["effort"] not in efforts:
                    _bad("Unsupported reasoning effort for this model.")
            if "text" in payload:
                _fields(payload["text"], {"format"}, {"format"})
                fmt = payload["text"]["format"]
                _fields(fmt, {"type", "name", "schema", "strict"}, {"type", "name", "schema", "strict"})
                if fmt["type"] != "json_schema" or fmt["strict"] is not True or not isinstance(fmt["schema"], dict):
                    _bad("Structured output requires a strict JSON schema.")
                _text(fmt["name"])
                if fmt["schema"].get("type") != "object":
                    _bad("Structured output requires an object at the schema root.")
                _check_schema(fmt["schema"])
            payload["store"] = False
            if tier != "batch":
                payload["service_tier"] = tier
    return {"model": model, **payload}


def _dict(value):
    return value.model_dump(mode="json") if hasattr(value, "model_dump") else dict(value)


def _safe_error(exc):
    code = getattr(exc, "code", None)
    if not code and isinstance(getattr(exc, "body", None), dict):
        body = exc.body
        code = body.get("code") or (body.get("error", {}).get("code") if isinstance(body.get("error"), dict) else None)
    known = {"credit_balance_exhausted", "project_spend_limit_exceeded", "organization_spend_limit_exceeded",
             "organization_usage_limit_exceeded", "rate_limit_exceeded", "resource_unavailable", "invalid_api_key",
             "invalid_request_error", "permission_denied", "insufficient_quota", "not_found"}
    status = getattr(exc, "status_code", None)
    if type(status) is not int or not 100 <= status <= 599:
        status = None
    exception_type = exc.__class__.__name__
    transport_types = {"APITimeoutError", "APIConnectionError", "ReadTimeout", "ConnectTimeout"}
    transport_cause_type = None
    cause = getattr(exc, "__cause__", None) or getattr(exc, "__context__", None)
    for _ in range(4):
        if cause is None:
            break
        candidate = cause.__class__.__name__
        if candidate in {"ConnectError", "ConnectTimeout", "ReadError", "ReadTimeout", "WriteError", "WriteTimeout",
                "PoolTimeout", "NetworkError", "ProxyError", "RemoteProtocolError", "LocalProtocolError",
                "ProtocolError", "PermissionError", "ConnectionRefusedError", "ConnectionResetError",
                "TimeoutError", "gaierror", "SSLError", "OSError"}:
            transport_cause_type = candidate
        cause = getattr(cause, "__cause__", None) or getattr(cause, "__context__", None)
    uncertain = exception_type in transport_types
    # A gateway/server error does not establish that inference never ran. Only
    # explicit capacity/throttling rejections are automatically repeatable.
    uncertain = uncertain or bool(status and status >= 500)
    if uncertain:
        code = "execution_uncertain"
    elif code not in known:
        code = {401: "authentication_failed", 403: "permission_denied", 404: "not_found", 400: "invalid_request_error", 429: "unclassified_rate_error"}.get(status, "server_error" if status and status >= 500 else "sdk_error")
    return AdapterError(code, "API operation failed; use the classified code and recorded identifiers.",
                        retryable=not uncertain and code in {"rate_limit_exceeded", "resource_unavailable"},
                        uncertain=uncertain, http_status=status,
                        failure_class=("provider_transport" if exception_type in transport_types else
                                       "provider_http" if status is not None else "provider_error"),
                        exception_type=exception_type, provider_request_id=getattr(exc, "request_id", None),
                        transport_cause_type=transport_cause_type)


def bounded_call(operation, timeout_seconds, *args, **kwargs):
    """Bound caller wall time, without claiming to cancel remote execution.

    SDK socket timeouts bound individual phases, not a slowly streaming complete
    operation. A daemon worker lets the dedicated helper process exit after its
    local deadline. A late result is deliberately not treated as a safe retry.
    """
    if type(timeout_seconds) not in (int, float) or not math.isfinite(timeout_seconds) or not 0 < timeout_seconds <= 900:
        raise AdapterError("timeout_configuration_invalid", "Operation deadline must be positive and at most 900 seconds.")
    deadline = time.monotonic() + timeout_seconds
    result = queue.SimpleQueue()

    def run():
        try:
            value = operation(*args, **kwargs)
            result.put((True, value, time.monotonic()))
        except BaseException as exc:
            # Catch even thread-local process-control exceptions so an upstream
            # traceback cannot leak request data through threading.excepthook.
            result.put((False, exc, time.monotonic()))

    worker = threading.Thread(target=run, name="openai-bounded-operation", daemon=True)
    worker.start()
    worker.join(max(0, deadline - time.monotonic()))
    if worker.is_alive():
        raise AdapterError("execution_uncertain", "Local operation deadline elapsed; remote execution may continue. Inspect the recorded outcome before retrying.", uncertain=True, failure_class="local_deadline")
    success, value, finished = result.get_nowait()
    if finished > deadline:
        raise AdapterError("execution_uncertain", "Local operation deadline elapsed; remote execution may have completed. Inspect the recorded outcome before retrying.", uncertain=True, failure_class="local_deadline")
    if success:
        return value
    if isinstance(value, AdapterError):
        raise value
    if isinstance(value, Exception):
        raise _safe_error(value) from None
    raise AdapterError("execution_uncertain", "The operation ended without a usable SDK result; inspect its outcome before retrying.", uncertain=True, failure_class="local_result_missing")


def _number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _decision_valid(body, questions):
    answers = body.get("answers")
    if not isinstance(answers, list) or len(answers) != len(questions):
        return False
    by_name = {a.get("name"): a for a in answers if isinstance(a, dict)}
    if len(by_name) != len(questions):
        return False
    for question in questions:
        a = by_name.get(question["name"], {})
        if a.get("type") == "refusal":
            continue
        if a.get("type") != question["type"]:
            return False
        if a["type"] == "predicate":
            if not _number(a.get("probability")) or not 0 <= a["probability"] <= 1:
                return False
        else:
            probs = a.get("probabilities")
            options = [c["value"] for c in question["choices"]] if a["type"] == "choice" else list(range(len(question["levels"])))
            typed_options = {(type(o), o) for o in options}
            if not isinstance(probs, list) or len(probs) != len(options):
                return False
            values = []
            for p in probs:
                if not isinstance(p, dict) or not _number(p.get("probability")) or not 0 <= p["probability"] <= 1:
                    return False
                if type(p.get("value")) not in (str, bool, int):
                    return False
                values.append((type(p.get("value")), p.get("value")))
            if set(values) != typed_options or not math.isclose(sum(p["probability"] for p in probs), 1, abs_tol=.001):
                return False
            if not _number(a.get("confidence")) or not 0 <= a["confidence"] <= 1:
                return False
            if a["type"] == "choice" and (type(a.get("choice")), a.get("choice")) not in typed_options:
                return False
            if a["type"] == "score":
                score = a.get("score")
                expected = sum(p["value"] * p["probability"] for p in probs)
                if not _number(score) or not math.isclose(score, expected, abs_tol=.001):
                    return False
    return True


def reported_configuration(body):
    """Response observations only; absent/invalid values never use the request."""
    model = body.get("model")
    if not isinstance(model, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}", model) is None:
        model = None
    reasoning = body.get("reasoning")
    effort = reasoning.get("effort") if isinstance(reasoning, dict) else None
    if effort not in ("none", "minimal", "low", "medium", "high", "xhigh", "max"):
        effort = None
    return {"reported_model": model, "selected_effort": effort}


def normalize_result(request, body):
    cap = request["capability"]
    result = {"status": "completed", "api_id": body.get("id"), "usage": body.get("usage"),
              "service_tier": body.get("service_tier"), "output": None}
    if cap == "responses":
        result.update(reported_configuration(body))
    if cap == "embeddings":
        rows = body.get("data", [])
        if "validation_input_count" in request:
            expected_count = request["validation_input_count"]
        else:
            inputs = request["payload"]["input"]
            expected_count = 1 if isinstance(inputs, str) else len(inputs)
        if type(expected_count) is not int or not 1 <= expected_count <= 2048:
            result["status"] = "invalid_result"
            return result
        valid = isinstance(rows, list) and len(rows) == expected_count
        valid = valid and all(isinstance(r, dict) and type(r.get("index")) is int and isinstance(r.get("embedding"), list)
                              and bool(r["embedding"]) and all(_number(v) for v in r["embedding"]) for r in rows)
        valid = valid and {r["index"] for r in rows} == set(range(expected_count))
        if valid:
            dims = request["payload"].get("dimensions", 1536)
            valid = all(len(r["embedding"]) == dims for r in rows)
        result["status"] = "completed" if valid else "invalid_result"
        result["output"] = [r["embedding"] for r in sorted(rows, key=lambda r: r["index"])] if valid else None
    elif cap == "decisions":
        valid = _decision_valid(body, request["payload"]["questions"])
        result["status"] = "invalid_result" if not valid else "refused" if any(a.get("type") == "refusal" for a in body["answers"]) else "completed"
        result["output"] = body.get("answers") if valid else None
    else:
        result["status"] = body.get("status", "invalid_result")
        output = body.get("output", [])
        if not isinstance(output, list):
            result["status"], result["output"] = "invalid_result", None
            return result
        refusals = [part for item in output if isinstance(item, dict) and isinstance(item.get("content"), list)
                    for part in item["content"] if isinstance(part, dict) and part.get("type") == "refusal"]
        texts = [part["text"] for item in output if isinstance(item, dict) and isinstance(item.get("content"), list)
                 for part in item["content"] if isinstance(part, dict) and part.get("type") == "output_text" and isinstance(part.get("text"), str)]
        has_tools = bool(request.get("payload", {}).get("tools")) or bool(request.get("function_tools"))
        if refusals:
            result["status"], result["output"] = "refused", refusals
        elif result["status"] == "completed":
            if has_tools:
                calls = []
                for item in output:
                    if isinstance(item, dict) and item.get("type") == "function_call":
                        call_id, name, arguments = item.get("call_id"), item.get("name"), item.get("arguments")
                        if not isinstance(call_id, str) or not call_id or not isinstance(name, str) or not name or not isinstance(arguments, str):
                            result["status"], result["output"] = "invalid_result", None
                            return result
                        calls.append({"call_id": call_id, "name": name, "arguments": arguments})
                result["output"] = {"text": "".join(texts), "function_calls": calls}
            else:
                result["output"] = "".join(texts)
                if "text" in request["payload"]:
                    try:
                        result["output"] = json.loads(result["output"])
                        if not _matches_schema(result["output"], request["payload"]["text"]["format"]["schema"]):
                            result["status"], result["output"] = "invalid_result", None
                    except (ValueError, TypeError):
                        result["status"], result["output"] = "invalid_result", None
        else:
            result["output"] = {"text": "".join(texts), "incomplete_details": body.get("incomplete_details")}
    return result


class SDKAdapter:
    def __init__(self, key, organization, project, *, client=None, timeout_seconds=900):
        if not isinstance(key, str) or not key or not organization or not project:
            raise AdapterError("credential_configuration_missing", "A designated project key, organization, and project are required.")
        if type(timeout_seconds) not in (int, float) or not math.isfinite(timeout_seconds) or not 0 < timeout_seconds <= 900:
            raise AdapterError("timeout_configuration_invalid", "Operation deadline must be positive and at most 900 seconds.")
        self.timeout_seconds = timeout_seconds
        self.execution_context = None  # Injected clients never supply production provenance.
        if client is not None:
            self.client = client
            return
        if os.environ.get("OPENAI_CUSTOM_HEADERS"):
            raise AdapterError("ambient_headers_forbidden", "Remove ambient OpenAI custom headers from the helper process; project routing must be explicit.")
        try:
            # The helper runs in its own process; do not allow ambient SDK debug
            # logging to copy private requests or credentials into normal output.
            for logger in ("openai", "httpx2", "httpcore2"):
                sink = logging.getLogger(logger)
                sink.handlers = [logging.NullHandler()]
                sink.propagate = False
                sink.disabled = True
            from openai import OpenAI
            import httpx2
        except ImportError:
            raise AdapterError("sdk_missing", "Install the pinned official SDK in the helper environment.") from None
        self.client = OpenAI(api_key=key, organization=organization, project=project,
                             admin_api_key="", base_url=API_BASE, max_retries=0,
                             timeout=timeout_seconds,
                             http_client=httpx2.Client(trust_env=False, follow_redirects=False, timeout=timeout_seconds))
        self.execution_context = execution_context(organization, project, api_base=API_BASE)

    def close(self):
        self.client.close()

    def _perform(self, operation, *args, **kwargs):
        return bounded_call(operation, self.timeout_seconds, *args, **kwargs)

    def call(self, request):
        body = validate_payload(request)
        if request.get("tier") == "batch":
            _bad("Use batch-submit for Batch processing.")
        resource = getattr(self.client, request["capability"])
        raw = self._perform(resource.create, **body)
        result = normalize_result(request, _dict(raw))
        result["api_id"] = result["api_id"] or getattr(raw, "_request_id", None)
        return result

    def batch_submit(self, requests, local_job_id, checkpoint=None):
        if not requests or len(requests) > 1000:
            _bad("Batch requires 1 to 1000 items in this helper.")
        bodies = [validate_payload(r) for r in requests]
        caps = {r["capability"] for r in requests}
        if len(caps) != 1 or next(iter(caps)) not in ENDPOINTS or len({r["model"] for r in requests}) != 1 or any(r.get("tier") != "batch" for r in requests):
            _bad("Batch items must share one supported endpoint, model, and Batch tier.")
        ids = [r.get("custom_id", f"item-{i+1}") for i, r in enumerate(requests)]
        if any(not isinstance(i, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", i) for i in ids) or len(set(ids)) != len(ids):
            _bad("Batch custom_id values must be unique bounded identifiers.")
        endpoint = ENDPOINTS[next(iter(caps))]
        encoded = "\n".join(json.dumps({"custom_id": custom_id, "method": "POST", "url": endpoint, "body": body}, allow_nan=False) for custom_id, body in zip(ids, bodies)).encode("utf-8")
        if len(encoded) > 20_000_000:
            _bad("Batch payload exceeds this helper's 20 MB bound.")
        uploaded = _dict(self._perform(self.client.files.create, file=("batch.jsonl", encoded, "application/jsonl"), purpose="batch"))
        file_id = uploaded["id"]
        if checkpoint:
            checkpoint({"input_file_id": file_id, "item_ids": ids})
        try:
            batch = _dict(self._perform(self.client.batches.create, input_file_id=file_id, endpoint=endpoint,
                                       completion_window="24h", metadata={"local_job_id": local_job_id}))
        except AdapterError as exc:
            exc.input_file_id = file_id
            raise
        return {"status": batch["status"], "api_id": batch["id"], "input_file_id": file_id, "item_ids": ids}

    def batch_status(self, api_id):
        if not isinstance(api_id, str) or not re.fullmatch(r"batch[_-][A-Za-z0-9_-]{1,160}", api_id):
            _bad("Invalid Batch identifier.")
        batch = _dict(self._perform(self.client.batches.retrieve, api_id))
        return {"status": batch["status"], "api_id": batch["id"], "input_file_id": batch.get("input_file_id"),
                "output_file_id": batch.get("output_file_id"), "error_file_id": batch.get("error_file_id"),
                "request_counts": batch.get("request_counts")}

    def retrieve_response(self, api_id):
        """Inspect an existing response only; store=false may make it unavailable."""
        if not isinstance(api_id, str) or not re.fullmatch(r"resp_[A-Za-z0-9_-]{1,160}", api_id):
            _bad("Only recorded Responses identifiers can be retrieved.")
        return _dict(self._perform(self.client.responses.retrieve, api_id))

    def batch_reconcile(self, local_job_id, input_file_id=None, *, max_pages=10):
        """Find a lost create response by both durable identifiers, never resubmit."""
        if not isinstance(local_job_id, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", local_job_id):
            _bad("Invalid local job identifier.")
        if not isinstance(input_file_id, str) or not re.fullmatch(r"file[_-][A-Za-z0-9_-]{1,160}", input_file_id):
            raise AdapterError("reconciliation_identifiers_missing", "The durable input file identifier is required to reconcile Batch submission.", uncertain=True)
        if type(max_pages) is not int or not 1 <= max_pages <= 10:
            _bad("Batch reconciliation is bounded to 1 to 10 pages.")
        matches, after = {}, None
        for _ in range(max_pages):
            kwargs = {"limit": 100}
            if after:
                kwargs["after"] = after
            page = _dict(self._perform(self.client.batches.list, **kwargs))
            rows = page.get("data")
            if not isinstance(rows, list) or len(rows) > 100:
                raise AdapterError("invalid_batch_listing", "Batch listing was malformed; submission remains uncertain.", uncertain=True)
            for row in rows:
                if not isinstance(row, dict):
                    raise AdapterError("invalid_batch_listing", "Batch listing was malformed; submission remains uncertain.", uncertain=True)
                meta = row.get("metadata") or {}
                if isinstance(meta, dict) and meta.get("local_job_id") == local_job_id and row.get("input_file_id") == input_file_id:
                    ident = row.get("id")
                    if not isinstance(ident, str) or not re.fullmatch(r"batch[_-][A-Za-z0-9_-]{1,160}", ident):
                        raise AdapterError("invalid_batch_listing", "Batch listing returned an invalid identifier.", uncertain=True)
                    matches[ident] = row
            if len(matches) > 1:
                raise AdapterError("ambiguous_batch_submission", "Multiple batches match the durable submission; inspect the account before proceeding.", uncertain=True, input_file_id=input_file_id)
            if page.get("has_more") is False:
                if len(matches) != 1:
                    raise AdapterError("batch_submission_not_found", "No batch matches both durable identifiers; do not resubmit until the remote outcome is established.", uncertain=True, input_file_id=input_file_id)
                batch = next(iter(matches.values()))
                return {"status": batch["status"], "api_id": batch["id"], "input_file_id": input_file_id}
            if page.get("has_more") is not True or not rows or not isinstance(rows[-1].get("id"), str) or rows[-1]["id"] == after:
                raise AdapterError("invalid_batch_listing", "Batch pagination did not establish a complete listing.", uncertain=True)
            after = rows[-1]["id"]
        raise AdapterError("batch_reconciliation_incomplete", "Batch search reached its page bound; inspect the account without resubmitting.", uncertain=True, input_file_id=input_file_id)

    def batch_results(self, api_id):
        batch = self.batch_status(api_id)
        result = {**batch, "successful": {}, "failed": {}}
        if batch["status"] not in {"completed", "cancelled", "expired", "failed"}:
            return result
        seen = set()
        for field in ("output_file_id", "error_file_id"):
            if not batch.get(field):
                continue
            content = self._perform(self.client.files.content, batch[field])
            try:
                text = content.text
                if len(text.encode("utf-8")) > 100_000_000:
                    raise ValueError()
                lines = [json.loads(line) for line in text.splitlines() if line.strip()]
                for line in lines:
                    custom_id = line["custom_id"]
                    if not isinstance(custom_id, str) or custom_id in seen:
                        raise ValueError()
                    seen.add(custom_id)
                    response = line.get("response") or {}
                    if not line.get("error") and response.get("status_code") == 200 and isinstance(response.get("body"), dict):
                        result["successful"][custom_id] = response["body"]
                    else:
                        # Do not echo remote error text; it can contain submitted private input.
                        result["failed"][custom_id] = {"code": "batch_item_failed", "status_code": response.get("status_code")}
            except (ValueError, TypeError, KeyError):
                raise AdapterError("invalid_batch_results", "Batch results are malformed or repeat an item identifier.", api_id=api_id) from None
        return result

    def batch_cancel(self, api_id):
        if not isinstance(api_id, str) or not re.fullmatch(r"batch[_-][A-Za-z0-9_-]{1,160}", api_id):
            _bad("Invalid Batch identifier.")
        batch = _dict(self._perform(self.client.batches.cancel, api_id))
        return {"status": batch["status"], "api_id": batch["id"]}
