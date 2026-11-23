# Agent Commons (AI-to-AI coordination)

- Applies only when Agent Commons tools are available; Agent Commons' own background workers ignore this section. If the service is unavailable, report that and fall back to durable Markdown/Git records rather than inventing shared ownership.
- Session start: call `air_sync(root="<working folder>")` once (skip only when a SessionStart hook already returned `@air1 sync` for the current workspace). Use AIR-T inside Agent Commons (`air_tx` write, `air_get` details, `air_wait` jobs, `art_put` large text), call `air_sync(include_spec: true)` if `@air1` opcodes are not in context, and always speak plain US English to the user.
- Consult an idle peer of another model family (`job route=auto intent=review proto=air ctx=...` or `ask to=<app> wake=auto`, then `air_wait`) when:
  1. the same test, build, or bug fails twice (before attempt 3; `hint=consult:` in `air_tx` or a failure-nudge hook when enabled flags this);
  2. changing a persistent schema, wire protocol, concurrency, security, or billing boundary;
  3. confidence in a root cause or design decision is below ~80%.
- Move non-trivial finished work to review (`tupd st=rev`; tasks with `rev_pol=cross` queue automatic cross-family review). Open a room (`ropen`/`rstep`, 2-3 rounds) only for an unresolved disagreement.
- Delegate bounded subtasks (`job mode=advice|edit`, default `route=auto`) when the `R` line shows an idle capable route; use AC jobs (not session-local native subagents) for durable background work. Preview route, model, effort, and cost with:
  `node --disable-warning=ExperimentalWarning v2/src/cli.ts route-plan --prompt "..."`
- When only waiting on already-running jobs remains, wait in one shell call instead of repeated `air_wait` calls (up to 9 min; exit 2 means still running; pass `AGENT_COMMONS_CONNECTION` or `--connection` with `claude-desktop.json`, `codex-desktop.json`, or `antigravity-desktop.json`):
  `node --disable-warning=ExperimentalWarning v2/src/cli.ts air-wait-until --handles j5[,j6] --connection C:/Projects/AgentCommons-data/connections/<app-desktop>.json`
- Submit an OpenAI API job only after the operator enables paid execution and authorizes the job ceiling. Include the purpose and deliverable.
- Record job outcomes: add commit trailer `AC-Accepted: jN`, `AC-Rejected: jN <reason>`, or `AC-Redone: jN by jM` when `.git/hooks/post-commit` is the AC outcome hook; otherwise (or without a commit) send `out j=jN v=accepted|rejected "reason"` directly.
