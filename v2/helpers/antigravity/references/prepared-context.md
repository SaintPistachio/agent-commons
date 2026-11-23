# Prepared context, results and capabilities

Read for document/data preparation, context reuse, structured output, full fetched research content, or the workspace interface. Preserve the main skill's data, quota, acceptance, no-replay and execution boundaries.

## Selected documents and reusable inputs

`-ContextBundlePath` accepts a UTF-8 JSON specification:

```json
{"files":[{"path":"C:/approved/project/sample.csv","name":"sample.csv"}],"requirements":"Selected requirements for this assignment."}
```

Use it with `Run` to prepare and include the selected contents, or with `-Action Prepare` to prepare without Google inference. Prepare returns `prepared_context_path`; give that path to later Runs with `-PreparedContextPath`. Do not supply both flags. Input hashes, extracted snapshots and manifest are checked before/after inference; additions, changed paths or content abort without replay. This is hash-verified immutability, not OS protection. Reuse only task-owned retained bundles whose inputs remain appropriate; disposable scratch must not become a durable evidence dependency.

Supported extraction: UTF-8 text/code with lines; CSV with quoted multiline rows and source-line references; DOCX body paragraphs/table text; XLSX sheet/row/cell values and formula text/cached values; PDF page text only when an existing `pdftotext` command is available. The helper installs no extractor or dependency. Each selected source and extracted document is bounded to 2MiB, at most100 documents and16MiB combined. Oversized inputs fail rather than silently truncate. Network/external archive relationships, macros and executable archive members are rejected. Secrets, restricted material and instruction files must be excluded.

Extraction limitations are explicit: DOCX pagination/layout unavailable and omitted header/footer/note/comment parts counted; XLSX charts/styles uninterpreted and formulas never executed; PDF OCR and visual interpretation not provided. Rendering/layout fidelity work remains with the appropriate Codex document tools. Source paths are not transmitted in the inline context; logical document names, references, hashes and selected content are.

## Structured output and patch proposals

`-OutputContractPath` selects exactly `{"kind":"findings"}`, `{"kind":"comparison"}`, `{"kind":"test-proposal"}` or `{"kind":"patch"}`. Nonpatch kinds request the native CLI JSON schema and validate the returned structured output, retaining the raw response. Their envelope is `{"kind":"...","items":[...]}`:

- findings items: nonempty `title`, `detail`, `evidence` strings;
- comparison items: nonempty `option`, `assessment`, `evidence` strings;
- test-proposal items: nonempty `name`, `steps`, `expected` strings.

Patch output is a raw unified diff. Validation checks safe relative paths and coherent hunk counts, rejects binary/path-traversal patches, and never applies or executes them. A valid format does not prove the proposed behavior or authorization. Codex reviews the actual target and applies/verifies any approved change. Invalid output returns `INVALID_OUTPUT`, preserves response/usage and is not automatically resubmitted.

Text-only contract assignments additionally use a verified parent-owned `PostInvocation` termination hook. This prevents the CLI's automatic no-tool continuation prompts from concatenating multiple answers. All model tools remain denied; the hook ends the selected invocation rather than authorizing a `finish` tool. It is never enabled for research or source-tool assignments. `-Action StructuredProbe` genuinely validates this behavior and writes separate identity-bound acceptance; missing or stale acceptance blocks text-only contract inference before prompt loading. The native schema flag alone is not treated as proof of valid output.

For offline checking, `-Action Validate -OutputContractPath <contract> -ResponsePath <selected response>` performs local validation without provider inference.

## Research content provenance

Use a research profile with `read_artifacts:true` only for sanitized public assignments. It permits the existing web tools plus exact fetched-content reads. A trusted native successful PostToolUse event binds allowed URL, conversation, workspace and step to the fixed current CLI content.md artifact layout; the native DONE stream independently crosschecks the output path and origin. The guard validates the content digest on each read. Unexpected metadata, different conversations, missing content, changed hashes and other local paths are denied. Evidence reports whether the model actually completed a read. Redirect/DNS/provider backend behavior remains outside this application guard.

## Broader workspace interface and blocked capabilities

An opt-in profile may describe `{"profile":"workspace","files":[],"allowed_domains":[],"integrations":[],"expected_result":"..."}`. It currently returns `WORKSPACE_CAPABILITY_UNAVAILABLE` before loading selected inputs or submitting a task; it does not silently downgrade the assignment. Native sandboxing exists on CLI1.4.3 but synthetic sibling-temp reads, including a fake .env file, succeeded. Therefore general execution, workspace editing and notebooks are not accepted.

Browser public/local operation remains blocked until a separate unsigned-in profile, origin restrictions and inherited child controls are proven. Arbitrary nested Google agents remain blocked. Headless stream JSON supports text blocks only, so visual inputs are unavailable rather than being converted into a false claim of visual inspection. Image generation lacks verified image-specific included quota/fallback coverage. MCP stays unconfigured until an exact connection/tool is explicitly selected and accepted; no accounts or plugins are installed automatically.

Treat blocked status as a capability limit, not permission to bypass the helper, request broader permissions, change credit settings, install software, or use host credentials. Quotas are shared; more useful assignments do not create more allowance. Codex retains authority over billing/permission controls, external effects, scheduling and final application.

## Native selected-image reads

Use `{"profile":"selected-images","files":[{"path":"C:/approved/figure.png","name":"figure.png"}]}` as ToolProfilePath. The helper makes exact hashed PNG copies and permits only view_file on those copies; no originals, discovery, commands, writes, browser, web, MCP or agents are allowed. Existing selected-context/privacy rules apply to image content.

Initial supported encoding: static noninterlaced eight-bit RGB/RGBA PNG with IHDR/IDAT/IEND only, at most20images,2MiB each/16MiB combined,4096pixels peraxis/fourmillionpixels total perimage. Other encodings/metadata chunks fail explicitly; no conversion/OCR is implied. The original files remain untouched. Source hashes and snapshot hashes are returned.

Run `-Action VisualProbe` only for explicit synthetic acceptance. It tests a randomized visual answer plus actual outside-read/write/command/agent denials and writes identity-bound `visual-acceptance.json`. Capabilities reports exact model/effort combinations genuinely accepted; normal image calls block before submission on an unaccepted selection. Missing/stale acceptance cannot enable image reads automatically.
