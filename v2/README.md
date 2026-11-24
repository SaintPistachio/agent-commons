# Agent Commons v2 guide

Follow the [Windows quickstart](../README.md) to initialize a home and connect an MCP client. The service stores data under that home and listens only on loopback. Use the `air` client profile for the compact project and job tools. `air_sync` with a project root discovers the project and returns its current state.

## Security defaults and upgrades

Local delegated worker routes (`claude`, `codex`, and `antigravity`), host-side native edits, and MCP job toolsets other than the built-in `project` set default to fail-closed (`release` safe mode) until explicitly enabled by the local operator via `<home>/worker-policy.json`. `<home>/worker-policy.json` has no HTTP or MCP write endpoint and is ACL-protected at the local OS user-account boundary by `Protect-AcTokenHome.ps1` (processes running under the same OS user account retain filesystem access under that account's ACL). When enabled, native CLI routes run under the local user account with stripped provider API keys, isolated per-job Git worktrees (hooks, external smudge/clean filters, and submodules disabled), operator-approved project roots, and `--tools Read,Grep,Glob` plus `--disallowedTools Bash Edit MultiEdit Write NotebookEdit` on Claude `advice` turns. An OpenAI API job requires explicit spend authorization and approval from the central helper, with edit mode using approved checks run in an isolated Linux Docker container.

The service loads `<home>/worker-policy.json` once at startup, so enabling, narrowing, or resetting (`--reset`) the policy takes effect after restarting the Agent Commons service (`cli.ts status` reads the policy on disk). Use the local operator CLI to manage this file:

```powershell
node v2/src/cli.ts worker-policy --home $acHome --allow-local-cli
node v2/src/cli.ts worker-policy --home $acHome --allow-local-cli --routes claude,codex --no-native-edit --no-toolsets
node v2/src/cli.ts worker-policy --home $acHome --reset
```

The operator registers new projects (`cli.ts project-create`). Existing projects keep their records and history. Before a migrated project can provide files or run jobs, use the local operator CLI to approve its physical directory:

```powershell
node v2/src/cli.ts project-approve-root --home $acHome --project p1 --root 'C:\Projects\SampleProject'
```

On Windows, run the service and client setup under the same standard Windows account.
Use a private data directory on a local fixed drive under a parent that other
standard users cannot replace. The CLI checks existing
permissions before creating or rotating a token or starting the service. If it
reports `AC_HOME_NOT_PRIVATE`, stop the existing service and review the exact
data directory. Run the repair as the intended service account. Reissue tokens
if another user previously had access, then restart the service and reconnect
the clients using their updated files.

```powershell
pwsh -NoProfile -File .\v2\scripts\automation\Protect-AcTokenHome.ps1 -DataRoot $acHome -Action Repair -WhatIf
pwsh -NoProfile -File .\v2\scripts\automation\Protect-AcTokenHome.ps1 -DataRoot $acHome -Action Repair
node v2/src/cli.ts rotate-client --home $acHome --all
```

Verify startup using `/health` and verify client authentication using `air-sync`.

## Configure a named check

For patch edit jobs, create `patch-checks.json` inside the private service home. Replace the example paths and digest with your project root, Docker CLI path, and a locally installed Linux image. The image must provide `/bin/sh`, `cp`, `xargs`, and `chmod`, as well as the check's dependencies. Keep the check's image pinned by digest.

```json
{
  "docker": "C:\\Tools\\Docker\\docker.exe",
  "projects": [
    {
      "root": "C:\\Projects\\Example",
      "checks": {
        "unit-tests": {
          "image": "example/check-image@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          "argv": ["node", "--test"],
          "timeout_seconds": 120,
          "protected_paths": ["package.json", "test"],
          "share_failure_output": false
        }
      }
    }
  ]
}
```

Submit a job with `mode=edit check=unit-tests` and a registered Git checkout root. The service pins the checkout's commit, applies candidate patches in a separate worktree, and saves a diff after the check passes. Review the diff before integrating it into your branch.

The check runs offline as a non-root user in a Linux container. It receives a read-only snapshot without Git metadata, links, or credential-like paths. The check runs on a writable temporary copy inside the container. Protect tests and input manifests with `protected_paths`. Enable `share_failure_output` only if the check's output can be shared with the selected provider.

## Quota observations

The service checks supported routes every 30 minutes and after jobs finish. It defers polling while a route is busy. Codex and Antigravity provide subscription-limit metadata, and the OpenAI helper reads its local credit record. A fresh, complete observation can clear a route cooldown when all required quota windows have room.

Claude polling runs automatically when Claude Code 2.1.273 or later is verified with a subscription login (and falls back to matching-account `cachedUsageUtilization` in `~/.claude.json` when available). The reader accepts only a structured local `/usage` result with zero model usage and cost. Unrecognized scoped windows make the observation partial, which prevents it from lifting a cooldown. The CLI's `status` output shows scheduled resets, advisory burn-rate pace and reset projections, and any refill that Agent Commons observed ahead of a scheduled reset. Run `node v2/src/cli.ts status-report` or `view` to inspect status and 7-day cycle history in read-only HTML.

## Memory, graph, and host tools

- `embed-status` / `embed-sync [--project P]`: inspect or index opt-in loopback semantic vectors (`<home>\embeddings.json`, `enabled: true`, loopback `base_url` only; schema 25) fused into `air_get` / `ctx=recall:...`.
- `graph-status [--project P]` / `graph-query --project P --query TEXT` / `graph-refresh --project P [--force]`: inspect, query, or locally refresh (`GRAPHIFY_BACKEND=none`) staleness-verified Graphify code relationships (`air_get handles="graph:<symbol>"` or `ctx=graph:<symbol>`).
- `audit-hosts [--app codex|claude|antigravity] [--json]`: read-only audit of host MCP configs (duplicates, missing executables, drifted `--connection`, tool-hub conflicts, and credential-marker checks).

## Model inventory

Run `node v2/src/cli.ts models --home DIR` to see the models and effort levels
Agent Commons has observed. Use `--route ROUTE` to filter the list and
`--refresh` to request a new observation. The `status` command reports
when the last successful observation was and flags refresh failures.

The service refreshes inventory at startup, daily, and when local provider
metadata changes. Antigravity refreshes its guarded catalog while the route
is idle. Claude Code publishes its account catalog during normal use.
OpenAI inventory combines public model documentation with the list available
to your configured project when its credential is present. The refresh uses
metadata requests without inference. An incomplete refresh preserves the last
complete list.

## Set up the optional OpenAI API helper

The helper in `tools/openai-capabilities` owns paid admission and usage accounting. Use its pinned Python dependencies and a separate, private runtime environment. Paid jobs require an explicit ceiling, a purpose, and a deliverable. Configure credentials and funding through the helper before enabling paid submissions. Use a separate project key and keep helper policies, funding evidence, credentials, and ledgers out of the checkout.

From the checkout, install the helper's pinned dependencies into its ignored virtual environment. The Windows lockfile uses Python 3.14 x64 wheels.

```powershell
python -m venv tools/openai-capabilities/.venv
$apiPython = Join-Path $PWD 'tools/openai-capabilities/.venv/Scripts/python.exe'
& $apiPython -m pip install --require-hashes --requirement tools/openai-capabilities/requirements.lock
& $apiPython tools/openai-capabilities/run.py --help
```

Use `policy.example.json` as a reference. A dependency install leaves paid execution disabled. Verify your own funding and access with the helper before opting in.

If the helper is installed outside this checkout, set `AGENT_COMMONS_OPENAI_HELPER_ROOT` to its installation directory before starting the service. That directory must contain `run.py` and `.venv\Scripts\python.exe` on Windows. An unclear provider outcome is held for reconciliation.

## Optional Windows maintenance

Use `Bootstrap-AgentCommonsV2.ps1` for a fresh installation or to restore a backup into a new home. Preview with `-WhatIf`. System startup and maintenance tasks are opt-in through `-RegisterTasks`. Run `Register-AcAutomation.ps1 -WhatIf` with an explicit `-Only` selection to preview individual setup steps.

Configure a dedicated `offDriveDestination` in the private home's `backup-config.json` before running `Backup-AcOffDrive.ps1` or `Test-AcRestore.ps1`. `Lock-AcData.ps1 -WhatIf` previews changes to the connection and backup directory permissions. For encrypted cloud backups, use `Set-AcBackupPassphrase.ps1` or `New-AcBackupRecoveryKey.ps1` to prepare the credential separately from the backup destination.

Run `Sync-AcTools.ps1` with an explicit `-Apps` selection to preview changes to those clients. Add `-Apply` only after reviewing the preview. Run `ac-report.mjs` with an explicit project and local connection to record an operator-approved summary. Keep raw diagnostics in the private service home.

The AIR-T benchmark uses only local data. Supply a synthetic SQLite fixture with project-level checkpoints and a new, empty, private scratch directory. The scratch directory will contain copies of the fixture database.
