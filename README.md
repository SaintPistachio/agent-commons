# Agent Commons

Agent Commons is a local service that lets Claude, Codex, and Antigravity share project state through the Model Context Protocol (MCP). It keeps tasks, decisions, checkpoints, messages, and artifacts in a local SQLite database. The optional OpenAI API helper can run delegated jobs.

## Quickstart on Windows

Install Node.js 24.18.0 or a newer Node.js 24 release, PowerShell 7, and Git. Clone this repository and open PowerShell from the checkout as the Windows user who will run the service. Use a different port if 4727 is already in use.

Choose a new directory under your private local application-data folder. Initialization creates it with access limited to your Windows account and LocalSystem. For an existing installation, see the [upgrade instructions](v2/README.md#security-defaults-and-upgrades).

```powershell
$acPort = 4727
$acHome = Join-Path $env:LOCALAPPDATA 'AgentCommons-data'
$acProject = 'C:\Projects\SampleProject'
npm.cmd ci
New-Item -ItemType Directory -Path $acProject -Force | Out-Null
node v2/src/cli.ts init --home $acHome --port $acPort
node v2/src/cli.ts project-create --home $acHome --name Sample --root $acProject
node v2/src/cli.ts add-client --home $acHome --port $acPort --name sample-client --profile air
node v2/src/cli.ts serve --home $acHome --port $acPort
```

The service listens on `127.0.0.1`. To verify that the client can reach the sample project, run the following from a second PowerShell window in the checkout. Use the same paths as above.

```powershell
$acHome = Join-Path $env:LOCALAPPDATA 'AgentCommons-data'
$acConnection = Join-Path $acHome 'connections\sample-client.json'
node v2/src/cli.ts air-sync --connection $acConnection --root 'C:\Projects\SampleProject'
```

The reply should identify the `Sample` project. For an MCP client, configure the stdio command `node` with the absolute path to `v2/src/mcp.ts`, then `--connection` and the absolute path to the client connection file. Create a separate client connection for each app. Keep connection files private because they contain bearer tokens.

To stop the service, press Ctrl+C in the server window.

## Provider setup

The quickstart works without provider credentials for local MCP collaboration. Claude, Codex, and Antigravity can connect as MCP clients, while local delegated worker routes stay disabled by default (`release` fail-closed policy) until the local operator explicitly enables them with `node v2/src/cli.ts worker-policy --home <home> --allow-local-cli` (and restarts the service if it is already running) when their CLIs are installed and verified under your user account. To enable paid delegated jobs, configure the OpenAI API helper and point `AGENT_COMMONS_OPENAI_HELPER_ROOT` at its installation before starting Agent Commons. Each paid job requires explicit spend authorization and a cost ceiling.

## Approved checks for patch jobs

Shared patch edit jobs require a local Linux Docker engine reachable from Windows. Configure named checks for the project in `patch-checks.json` in the private data directory. Each check uses a locally available image pinned by digest and an operator-selected command. See the [v2 guide](v2/README.md) for the configuration format and job options.

## Verify the checkout

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd test
```
