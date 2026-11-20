# Troubleshooting

Each section gives the failure mode, its cause in code, and a concrete fix.

## No Approval Handler in Non-TTY

**Symptoms**

- A tool result has `ok: false`, `denied: true`, and an error such as `no interactive approval handler configured` or `denied by operator`.
- No prompt appears when ORA runs in a script, CI job, or container.

**Cause**

[`security/permissions.js`](../security/permissions.js) sends every request that needs approval to the approval gate. In `manual` mode, the gate denies with `no interactive approval handler configured` when no prompt function was supplied. The CLI always supplies one, but [`bin/ora.js`](../bin/ora.js) makes that function return `false` immediately when `process.stdin.isTTY` is false; the recorded reason is then `denied by operator`.

**Fix**

- Run the command in an interactive terminal and answer `y` or `yes` at the prompt.
- For non-critical automation, pass `--approval auto`: `node bin/ora.js task run --goal "analyze this repository" --approval auto`. Auto mode still denies `critical` risk.
- For library use, pass an `approvalPrompt` function to `createRuntime`, or use the approval gate's `approve(id)` method from a long-lived process.
- If you intentionally want all approvals refused, use `--approval deny` or set `security.approvalMode` to `deny`; the denial is then expected behavior.

## Path Outside Allowed Roots

**Symptoms**

- `path outside allowed roots: <absolute path>` from permissions assessment.
- `path outside repository: <path>` from the patch engine.
- `Path must be relative to the repository root`, `Path traversal is not allowed`, or `Path escapes the repository root via symlink` from repo file reads.

**Cause**

The CLI constructs permissions with roots `[root, cwd]` and calls `confined()` before authorization ([`core/runtime.js`](../core/runtime.js), [`security/permissions.js`](../security/permissions.js)). The patch engine applies its own root check and refuses symlinks in the path chain or at the target ([`execution/patch.js`](../execution/patch.js)). Repository reads reject absolute paths, `..` segments, and symlinks resolving outside the root ([`repo-intelligence/scanner.js`](../repo-intelligence/scanner.js)). Default `deniedPaths` also blocks patterns such as `.env`, `*.pem`, `.ssh/**`, and `.ora-state/**`.

**Fix**

- Use paths relative to the repository root, for example `fs.read --args-json '{"path":"package.json"}'`.
- Set the intended root explicitly: `node bin/ora.js --root /path/to/repo ...` and, if config lookup should follow it, also pass `--cwd`.
- Replace symlink-based paths with real paths inside the root.
- If a denied pattern is the cause, check `node bin/ora.js config show --json` and change `security.deniedPaths` deliberately rather than bypassing confinement.

## Patch Context Mismatch

**Symptoms**

- `fs.patch` result has `ok: false`; `errors` contains `{ "path": "...", "error": "patch context mismatch at line N: expected \"...\", got \"...\"" }`.
- `applied` is `false`.

**Cause**

[`execution/patch.js`](../execution/patch.js) parses unified diffs and compares each `-` and context line against the current file exactly. There is no fuzzy matching or offset search. The diff must use `--- a/<path>` / `+++ b/<path>` headers and `@@ -old +new @@` hunks. `applyPatch` processes each file independently, so earlier files can be modified even when a later file fails; the operation is not atomic across files.

**Fix**

- Regenerate the diff from the current file contents. `generateUnifiedDiff` is exported from [`index.js`](../index.js) and is the exact generator used for change reports.
- For full-file replacements, use `fs.write` with `content` instead of a patch.
- Preflight with `fs.patch --args-json '{"patch":"...","dryRun":true}'`; the result includes `changes` and `errors` without writing files.
- Inspect `errors[].path` to find which file needs a fresh diff. Check `git diff` to see what was already applied before retrying.

## Provider Returns HTTP 401

**Symptoms**

- `node bin/ora.js providers check --json` reports `"ok": false` and an error like `HTTP 401: {"error":{"message":"Invalid API key","type":"authentication_error"}}`.
- Provider metadata includes `"warning": "no API key found"`.
- `providers route` or `model.complete` fails with `Routing failed for providers [...]: freellmapi: HTTP 401: ...`.

**Cause**

FreeLLMAPI is registered by default against `http://127.0.0.1:3001/v1`. [`providers/registry.js`](../providers/registry.js) reads `FREELLMAPI_API_KEY` from the environment, then from the configured env file (`integrations.freellmapiEnvFile`, default `/workspaces/Final-project/.freellmapi/.env`), then from the runtime-local env file (`<runtime.stateDir>/freellmapi.env`). With no valid key, the gateway rejects requests such as `GET /v1/models` with 401. The OpenAI-compatible client only retries 429 and 5xx responses ([`providers/openai-compatible.js`](../providers/openai-compatible.js)), so 401 fails immediately. This is an external/gateway condition, not a runtime bug.

**Fix**

- Set `FREELLMAPI_API_KEY`, or add `FREELLMAPI_API_KEY=...` to the configured env file or runtime-local env file (`<runtime.stateDir>/freellmapi.env`), then re-run `providers check`.
- Confirm the gateway is listening at the configured base URL; override it with `integrations.freellmapiBaseURL`.
- If you do not use the integration, set `"integrations": { "freellmapi": false }` in `.ora/config.json`.
- Register another provider with `providers register` or `ORA_PROVIDERS_JSON` and target it with `--provider` where supported.
- Offline planning, scanning, file edits, and local verification do not need a provider.

## Provider Healthy but Completion Unavailable (`no_providers_configured` / 503)

**Symptoms**

- Provider health checks may succeed, but chat completion fails with `no_providers_configured` and/or HTTP 503 from the gateway.
- Runtime status reports LLM capabilities in `offline-deterministic` mode.

**Cause**

FreeLLMAPI requires upstream provider keys configured in the gateway to actually generate text. Gateway reachability/authentication alone is not sufficient for completions.

**Fix**

- Configure upstream provider keys in the FreeLLMAPI gateway (external to OpenRuntimeAgent).
- Treat this as an external blocker: OpenRuntimeAgent does not claim real inference capability when completions are unavailable.
- Use offline/deterministic workflows until the gateway can complete requests successfully.

## Adapter Unavailable

**Symptoms**

- `adapters check <id>` returns `reason: "adapter not found"`, `adapter disabled`, or a spawn error.
- `adapters report` shows `available: false` for commands that exist on the system.
- `adapters execute <id>` throws `adapter not found: <id>`.

**Cause**

[`adapters/registry.js`](../adapters/registry.js) registers definitions but only sets `available` and `path` when `discover()` runs, searching the directories in `PATH`. A command that is not executable on `PATH` stays unavailable. Validation runs `<command> --version` (or `versionArgs`) and fails if the command exits non-zero or times out. [`adapters/lifecycle.js`](../adapters/lifecycle.js) caches validation results until configuration changes. Built-in definitions are `node`, `npm`, `git`, `opencode`, and `pi`.

**Fix**

- Run `node bin/ora.js adapters discover --json` before reading availability, then `node bin/ora.js adapters check <id> --json`.
- Make the executable available on `PATH` and confirm `<command> --version` succeeds in a shell.
- Add a custom definition to `config.adapters` with `id`, `command`, and `capabilities`; see [Configuration](CONFIGURATION.md).
- Remember that `adapters install` semantics are registration only: ORA never downloads or installs adapter software.

## Shell Metacharacters Require Approval

**Symptoms**

- A `shell.exec` invocation is denied with reason `shell metacharacters`.
- The reported risk is `high` even for a short command.

**Cause**

[`security/permissions.js`](../security/permissions.js) flags commands containing `|`, `>`, `&&`, `;`, `$(`, or a backtick when the tool is `shell.exec`. Commands run through `/bin/bash -c` ([`execution/shell.js`](../execution/shell.js)), so these characters can change behavior. Network-capable commands and destructive patterns add further reasons and can raise the risk to `critical`.

**Fix**

- Approve the request in an interactive terminal, or run the command with `--approval auto` if it is not `critical`.
- Split the command into separate tool invocations that do not need pipes or chaining.
- Quote arguments carefully in `--args-json`; the JSON string is parsed before the command is passed to the shell.
- If the command is also network-capable, review `security.allowNetwork` and the `NETWORK` patterns before auto-approving it.

## State File Corruption

**Symptoms**

- A CLI command exits with code 1 and prints a JSON parse error such as `Unexpected token ... in JSON at position ...`.
- Tasks disappear or `task show <id>` reports `Task not found: <id>`.

**Cause**

[`core/state.js`](../core/state.js) parses `<stateDir>/state.json` with `JSON.parse` at startup without a recovery fallback. A truncated, hand-edited, or partially written file therefore prevents the runtime from loading. Writes use a temporary file plus rename to reduce this risk, but external edits or disk failures can still corrupt the file. Events are stored separately in `events.jsonl`; a bad line there is tolerated and appears as `{ "type": "corrupt", "raw": "[unreadable]" }`. Checkpoints are separate files under `<stateDir>/checkpoints/`.

**Fix**

- Stop any process using the state directory, then inspect `<stateDir>/state.json` with a JSON validator.
- To recover a task, copy the `state` object from `<stateDir>/checkpoints/<checkpoint-id>.json` into `state.json` and keep `"version": 1`; checkpoint data is a task snapshot taken at that step.
- If no checkpoint is usable, move `state.json` aside and start fresh. This loses stored tasks, contexts, and approvals but preserves the rest of the repository.
- Do not point different running runtimes at the same state directory; there is no file locking.
