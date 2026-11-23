import sys, tempfile, pathlib, json
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))
import standalone_control_contract as c
import antigravity as ag

ag.STATE_ROOT = pathlib.Path(tempfile.mkdtemp())  # keep test diagnostics out of real helper state
results = []

def check(name, fn, expect):
    try:
        out = fn(); got = "ok"
    except ValueError as e:
        got = e.args[0]
    except ag.HelperError as e:
        got = e.code
    results.append((name, got == expect, got))

rows = lambda *names, d="deny": [{"tool_name": n, "decision": d} for n in names]
A = c.ALIASED
check("1.5.1 names", lambda: c.verify_denials(A, rows("view_file", "write_to_file", "run_command", "invoke_subagent")), "ok")
check("1.5.12 names (real audit)", lambda: c.verify_denials(A, rows("read_file", "write_file", "run_command", "invoke_subagent")), "ok")
check("mixed vocab, repeats", lambda: c.verify_denials(A, rows("read_file", "view_file", "write_file", "run_command", "invoke_subagent", "run_command")), "ok")
check("unknown renamed tool", lambda: c.verify_denials(A, rows("open_file", "write_file", "run_command", "invoke_subagent")), "STANDALONE_CONTROL_UNKNOWN_AUDIT_NAME")
check("missing invoke_subagent", lambda: c.verify_denials(A, rows("read_file", "write_file", "run_command")), "STANDALONE_CONTROL_DENIAL_EVIDENCE_REQUIRED")
check("allow row", lambda: c.verify_denials(A, rows("read_file", "write_file", "run_command") + rows("invoke_subagent", d="allow")), "STANDALONE_CONTROL_DENIAL_EVIDENCE_REQUIRED")
check("extra field", lambda: c.verify_denials(A, [{"tool_name": "read_file", "decision": "deny", "x": 1}]), "STANDALONE_CONTROL_DENIAL_EVIDENCE_REQUIRED")
check("empty", lambda: c.verify_denials(A, []), "STANDALONE_CONTROL_DENIAL_EVIDENCE_REQUIRED")
check("legacy still strict on 1.5.12", lambda: c.verify_denials(c.LEGACY, rows("read_file", "write_file", "run_command", "invoke_subagent")), "STANDALONE_CONTROL_DENIAL_EVIDENCE_REQUIRED")
check("choose aliased", lambda: c.choose_profile(c.ALIASED_ID, "anyhash"), "ok")
e = c.verify_denials(A, rows("read_file", "write_file", "run_command", "invoke_subagent"))
results.append(("evidence reports configured names", e["denied_tool_names"] == sorted(c.CONFIGURED_TOOLS), e["denied_tool_names"]))

captured = {"conversation_id": "c1", "state": "ACTIVE", "step_index": 5, "step_type": "subagent", "tool_name": "invoke_subagent",
            "subagent_info": {"subagents": [{"type_name": "codex-guard-denied-child", "role": "Synthetic Denied Child", "initial_prompt": "Reply PONG"}]}}
def sub(step):
    obs = {}; ag.control_subagent_step(step, obs); return obs
check("captured 1.5.12 subagent step", lambda: sub(captured), "ok")
check("other child", lambda: sub({**captured, "subagent_info": {"subagents": [{"type_name": "evil"}]}}), "PROBE_FAILED")
check("two children", lambda: sub({**captured, "subagent_info": {"subagents": captured["subagent_info"]["subagents"] * 2}}), "PROBE_FAILED")
check("new output field", lambda: sub({**captured, "subagent_info": {"subagents": [{**captured["subagent_info"]["subagents"][0], "result": "PONG"}]}}), "PROBE_FAILED")
check("different prompt", lambda: sub({**captured, "subagent_info": {"subagents": [{"type_name": "codex-guard-denied-child", "initial_prompt": "do X"}]}}), "PROBE_FAILED")
check("subagent step without info", lambda: sub({**captured, "subagent_info": None}), "PROBE_FAILED")
terminal = {**captured, "state": "ERROR", "duration_seconds": 0.1, "subagent_info": {"subagents": []}}
def lifecycle(*steps):
    obs = {}
    for s in steps: ag.control_subagent_step(s, obs)
    return obs
check("real 1.5.12 lifecycle ACTIVE->ERROR", lambda: lifecycle(captured, terminal), "ok")
results.append(("lifecycle ends ERROR", lifecycle(captured, terminal) == {"5": ["ACTIVE", "ERROR"]}, lifecycle(captured, terminal)))
check("ERROR without request", lambda: lifecycle(terminal), "PROBE_FAILED")
check("empty list ending DONE", lambda: lifecycle(captured, {**terminal, "state": "DONE"}), "PROBE_FAILED")
check("terminal for another step", lambda: lifecycle(captured, {**terminal, "step_index": 9}), "PROBE_FAILED")
diag = list((ag.STATE_ROOT / "diagnostics").glob("probe-subagent-*.json"))
results.append(("diagnostics written", len(diag) >= 1, len(diag)))

# Preflight: the shared instructions file is allowed; other ambient files still block; no global agent file needed.
def preflight_with(files):
    profile = pathlib.Path(tempfile.mkdtemp())
    (profile / ".gemini/antigravity-cli").mkdir(parents=True)
    (profile / ".gemini/antigravity-cli/settings.json").write_text("{}", encoding="utf-8")
    for rel in files:
        (profile / rel).parent.mkdir(parents=True, exist_ok=True)
        (profile / rel).write_text("Use plain US English.\n", encoding="utf-8")
    saved = (ag.PROFILE, ag.SETTINGS, ag.CLI, ag.SHARED_INSTRUCTIONS)
    ag.PROFILE, ag.SETTINGS, ag.CLI = profile, profile / ".gemini/antigravity-cli/settings.json", pathlib.Path(sys.executable)
    ag.SHARED_INSTRUCTIONS = (profile / ".gemini/GEMINI.md",)
    try:
        return ag._read_preflight()
    finally:
        ag.PROFILE, ag.SETTINGS, ag.CLI, ag.SHARED_INSTRUCTIONS = saved
check("shared GEMINI.md allowed", lambda: preflight_with([".gemini/GEMINI.md"]), "ok")
check("no ambient files", lambda: preflight_with([]), "ok")
check("config AGENTS.md still blocks", lambda: preflight_with([".gemini/GEMINI.md", ".gemini/config/AGENTS.md"]), "AMBIENT_CUSTOMIZATIONS")
check("config rules still block", lambda: preflight_with([".gemini/config/rules/r.md"]), "AMBIENT_CUSTOMIZATIONS")
check("other global agent still blocks", lambda: preflight_with([".gemini/config/agents/other.md"]), "AMBIENT_CUSTOMIZATIONS")
results.append(("agent definition named for the job folder",
                ag.AGENT.read_text(encoding="utf-8").count("name: " + ag.AGENT_NAME + "\n") == 1, ag.AGENT_NAME))

for name, ok, got in results:
    print("PASS" if ok else "FAIL", name, "" if ok else got)
print("ALL PASS" if all(ok for _, ok, _ in results) else "FAILURES")
