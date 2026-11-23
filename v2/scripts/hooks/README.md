# Agent Commons hook scripts (Claude Code and Codex)

Shipped with each release under `AgentCommons-data\current\v2\scripts\hooks`, and **not installed**. Installing them
changes an app's own configuration, which needs the user's explicit go-ahead. Antigravity gets no hooks: its guarded
helper refuses to run while Antigravity has hooks, rules or skills configured, so it uses only its shared
`GEMINI.md` and the Agent Commons MCP plugin.

Both scripts are plain Node with no dependencies. They read the hook's JSON from stdin, talk to the service over
loopback HTTP with a connection file, and never block a session: with no connection, the service down, or any error,
they print nothing and exit 0. Agent Commons' own background workers never trigger them: Claude workers run with
`--strict-mcp-config` and Codex workers with `--ignore-user-config`.

| Script | Event | What it does |
| --- | --- | --- |
| `ac-session-start.mjs` | SessionStart | `air_sync` peek for the session's folder (`advance_cursor: false`, nothing marked read), given to the model as context |
| `ac-failure-nudge.mjs` | PostToolUse on the shell tool | counts consecutive failed commands per session; at the 2nd (and every 3rd after) prints one line naming idle peers of another model family |

Options: `--connection <file>` (or `AGENT_COMMONS_CONNECTION`), `--format plain|json` (`json` wraps the text as
`hookSpecificOutput.additionalContext`), `--timeout-ms 2000`, and for the nudge `--state-dir DIR` (per-session
counts in `ac-hook-fails-<session>.json`; use `a non-synchronized temporary directory`).

## Installing (only after the user approves)

Claude Code, in `~/.claude/settings.json` (merged into any existing `hooks`):

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "timeout": 5,
      "command": "node C:/Projects/AgentCommons-data/current/v2/scripts/hooks/ac-session-start.mjs --format json --connection C:/Projects/AgentCommons-data/connections/claude-desktop.json" }] }],
    "PostToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "timeout": 5,
      "command": "node C:/Projects/AgentCommons-data/current/v2/scripts/hooks/ac-failure-nudge.mjs --format json --state-dir C:/Temp/AgentCommons --connection C:/Projects/AgentCommons-data/connections/claude-desktop.json" }] }]
  }
}
```

Codex, in `~/.codex/hooks.json` (same layout as Claude Code; Codex asks to trust each new hook), with the Codex
connection file and the shell tool's matcher (`"^Bash$"` in the existing file). Before relying on the nudge, run one
failing command and check that the hook's input carries an exit code (`exit_code`, `exitCode`, `returncode` or
`code`, or `is_error`): without one the nudge does nothing, by design.
