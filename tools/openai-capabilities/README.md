# OpenAI API helper

The optional helper owns admission, usage accounting, and reconciliation for paid OpenAI API jobs. The [v2 setup guide](../../v2/README.md#set-up-the-optional-openai-api-helper) shows how to install its hash-pinned dependencies. Store credentials, policy, funding records, and the local ledger outside the tracked source tree. Installing dependencies leaves paid submissions disabled.

The `examples/` directory contains synthetic request templates for Responses, Decisions, embeddings, and Batch. Inspect a request and use the helper's `dry-run` command before any authorized `invoke`. Cost ceilings in the examples limit what the request can spend.

`demo_embedding_index.py` reads a completed synthetic embedding artifact and builds a small local similarity index. It makes zero API calls.

```powershell
python tools/openai-capabilities/demo_embedding_index.py --embedding-artifact C:/ExampleWorkspace/example-vectors.json --output C:/ExampleWorkspace/example-index.json
```
