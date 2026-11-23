# Agent Commons

Agent Commons is a local service that lets Claude, Codex, and Antigravity share project state through the Model Context Protocol (MCP). It keeps tasks, decisions, checkpoints, messages, and artifacts in a local SQLite database. The service can run delegated jobs through Claude, Codex, Antigravity, and an optional OpenAI API helper.

## Quickstart on Windows

Install Node.js 24.18.0 or a newer Node.js 24 release, PowerShell 7, and Git. Clone this repository and open PowerShell from the checkout. Choose a writable, non-synchronized data directory outside the checkout. Use a different port if 4727 is already in use.

```powershell
$acPort = 4727
$acHome = 'C:\Projects\AgentCommons-data'
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
node v2/src/cli.ts air-sync --connection 'C:\Projects\AgentCommons-data\connections\sample-client.json' --root 'C:\Projects\SampleProject'
```

The reply should identify the `Sample` project. For an MCP client, configure the stdio command `node` with the absolute path to `v2/src/mcp.ts`, then `--connection` and the absolute path to the client connection file. Create a separate client connection for each app. Keep connection files private because they contain bearer tokens.

To stop the service, press Ctrl+C in the server window.

## Provider setup

The quickstart works without provider credentials. To run delegated jobs, install and authenticate the CLI for the route you intend to use. Configure the route under the same Windows account that runs Agent Commons.

| Route | Requirement |
| --- | --- |
| `claude` | An authenticated Claude Code CLI. |
| `codex` | An authenticated Codex CLI. |
| `antigravity` | The supported Antigravity CLI and a passing probe from the bundled guarded helper. |
| `openai-api` | A separately configured OpenAI API helper with spending enabled by its operator. Point `AGENT_COMMONS_OPENAI_HELPER_ROOT` at the helper installation before starting Agent Commons. Each paid job needs an explicit cost ceiling. |

## Approved checks for patch jobs

Shared patch edit jobs require a local Linux Docker engine reachable from Windows. Configure named checks for the project in `patch-checks.json` in the private data directory. Each check uses a locally available image pinned by digest and an operator-selected command. See the [v2 guide](v2/README.md) for the configuration format and job options.

## Verify the checkout

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd test
```
