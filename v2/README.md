# Agent Commons v2 guide

Follow the [Windows quickstart](../README.md) to initialize a home and connect an MCP client. The service stores data under that home and listens only on loopback. Use the `air` client profile for the compact project and job tools. `air_sync` with a project root discovers the project and returns its current state.

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
