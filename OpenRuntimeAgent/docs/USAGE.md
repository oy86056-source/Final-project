# Usage

All commands below are run from the ORA root directory. Add `--json` to any reporting command to get machine-readable output. The CLI is one-shot: each invocation constructs a runtime, loads state from disk, and exits.

## 1. Analyze a Repository

Initialize configuration and inspect what the runtime sees:

```bash
node bin/ora.js init
node bin/ora.js status
node bin/ora.js scan --json
```

`init` prints `ok`, `configPath`, `stateDir`, and `tools`. `status` prints a human summary by default; with `--json` it returns `product`, `version`, `root`, `cwd`, `config`, `repo`, `tasks`, `agents`, `tools`, `providers`, `adapters`, `approvals`, and `state`. `scan --json` returns a manifest summary shaped like:

```json
{
  "root": "/workspaces/Final-project/OpenRuntimeAgent",
  "fileCount": 87,
  "languages": { "JavaScript": 42 },
  "frameworks": [],
  "packageManagers": [],
  "entryPoints": [{ "path": "bin/ora.js", "reason": "package.json bin" }],
  "scripts": { "test": "node --test" },
  "dependencies": [],
  "git": { "isRepo": true, "branch": "main", "dirty": true },
  "warnings": []
}
```

Search text and run an analysis task:

```bash
node bin/ora.js tools invoke repo.search \
  --args-json '{"query":"createRuntime","limit":2}' --json

node bin/ora.js task run \
  --goal "analyze this repository" \
  --title "repo-analysis" \
  --approval auto
```

Expected task output:

```text
task task-<id>: completed (<duration>ms)
Completed 4 steps with no failed tool executions

PASS  repo.scan          Scan repository structure
PASS  repo.context       Assemble task-focused context
PASS  agent.delegate     Delegate architecture analysis
PASS  git.diff           Review working tree changes
```

For this read-only goal, the deterministic planner adds no write or verification step.

## 2. Create and Run a Task with an Explicit File Spec

`--spec` takes a **path to a JSON file**, not inline JSON. Create `spec.json` in the ORA root:

```json
{
  "files": [
    {
      "path": "notes/example.md",
      "content": "# Example\n\nCreated by an ORA task spec.\n",
      "reason": "create a small reviewable artifact"
    }
  ],
  "verification": {
    "command": "npm run check",
    "reason": "confirm local JavaScript and JSON files parse"
  }
}
```

Create the task first, then run it by id:

```bash
node bin/ora.js task create \
  --title "spec-example" \
  --goal "create a note and verify the repository" \
  --spec spec.json --json

node bin/ora.js task run <task-id> --spec spec.json --approval auto
```

`task create --json` returns the task object with `id`, `title`, `goal`, `input: { "spec": ... }`, `status: "created"`, `steps: []`, and timestamps. `task run` returns:

```text
task task-<id>: completed (<duration>ms)
Completed 5 steps with no failed tool executions

PASS  repo.scan          Scan repository structure
PASS  repo.context       Assemble task-focused context
PASS  fs.write           Write notes/example.md
PASS  shell.exec         Verify: npm run check
PASS  git.diff           Review working tree changes

verification: npm run check -> PASS
```

With `--json`, the result contains `taskId`, `status`, `success`, `steps` (each with `id`, `title`, `tool`, `ok`, `denied`, `error`, `output`, `durationMs`), `verification` (`command`, `ok`, `exitCode`, `output`), `conflicts`, `checkpoints`, `summary`, `reviews`, `error`, and `durationMs`. Each `files` entry with a `patch` string becomes `fs.patch`; entries with `content` become `fs.write`. A `verification` entry becomes a `shell.exec` step with role `tester`.

To skip creating a task object first, run directly:

```bash
node bin/ora.js task run \
  --title "direct-spec" \
  --goal "create a note and verify the repository" \
  --spec spec.json \
  --approval auto
```

## 3. Run Tool Invocations Directly

List tools, then invoke one:

```bash
node bin/ora.js tools list --json

node bin/ora.js tools invoke fs.read \
  --args-json '{"path":"package.json"}' --json

node bin/ora.js tools invoke shell.exec \
  --args-json '{"command":"node --version"}' \
  --approval auto --json
```

A successful invocation returns this shape (values abbreviated):

```json
{
  "ok": true,
  "denied": false,
  "tool": "repo.search",
  "output": "[{\"path\":\"bin/ora.js\",\"line\":4,\"text\":\"...\"}]",
  "data": { "output": "..." },
  "error": null,
  "risk": "low",
  "approvalId": null,
  "durationMs": 410,
  "invocationId": "27b4bb3e-e2d7-440b-8c92-9daf0736ed8f"
}
```

A blocked invocation returns `ok: false`, `denied: true`, a redacted `error`, and a `risk` value. `--args-json` is parsed as JSON; malformed JSON fails before the tool runs.

## 4. Review Events and Checkpoints

Inspect a task snapshot:

```bash
node bin/ora.js task list --json
node bin/ora.js task show <task-id> --json
```

The snapshot includes `steps` with status/result/timestamps, `artifacts` (for example `repo-manifest` and `plan`), a `checkpoints` array of `{ id, name, ts }`, `conflicts`, and the stored `result`. Checkpoints are named `task:<task-id>:step:<n>` and written as JSON files under `<stateDir>/checkpoints/`. There is no CLI checkpoint-restore command; `state.restore(id)` is available through the library API.

Inspect events:

```bash
node bin/ora.js events --limit 20 --json
node bin/ora.js events --limit 100
```

Each event has `id`, `sequence`, `ts`, `type`, `level`, `message`, and `data`. Events are also appended to `<stateDir>/events.jsonl`, one redacted JSON object per line. Use `events <type> --json` to filter by type, for example `events task:finished --json`, or inspect `events.jsonl` directly.

Other useful diagnostics:

```bash
node bin/ora.js providers check --json
node bin/ora.js adapters discover --json
node bin/ora.js adapters check --json
node bin/ora.js config show --json
```

## 5. Resume a Task

```bash
node bin/ora.js task resume <task-id> --approval auto
```

`resumeTask` reuses the task's stored goal and spec and calls `runTask` again. It **re-plans and executes the full step sequence again**; it does not continue from the last completed step. The new steps and checkpoints are appended to the same task snapshot. Pass `--spec <path>` to override the stored spec for that run.

## 6. Approve or Deny an Operation

In `manual` mode, an approval request prints a prompt on a TTY:

```bash
node bin/ora.js tools invoke shell.exec \
  --args-json '{"command":"npm run check"}'
```

```text
Approve shell.exec (high)? within policy [y/N]
```

Only `y` or `yes` (case-insensitive) is accepted. Anything else denies the operation. With no TTY, the CLI prompt function returns `false` immediately, so the request is denied.

For a long-lived runtime process built with an approval prompt, pending requests can be inspected and resolved:

```bash
node bin/ora.js approvals list --json
node bin/ora.js approvals approve <approval-id>
node bin/ora.js approvals deny <approval-id>
```

Approval state is held in memory in the approval gate. In a one-shot CLI process, the prompt is resolved before the process exits; `approvals approve` and `deny` are useful only for pending requests in a still-running process. Decisions are not persisted.

To avoid prompts for non-critical work, use `--approval auto`, `--yes` on `task run`/`resume`, or `config set security.approvalMode auto`. `--yes` also works with `tools invoke` and `adapters execute`: the CLI temporarily switches the approval gate to `auto` for that invocation. Critical-risk operations are denied even in `auto` mode.

### Safety Notes

- Destructive command patterns require approval and are rated `critical`: `rm -rf`, `git push`, `git reset --hard`, `git clean -f`, `chmod`/`chown`, `npm publish`, `docker run|rm|system prune`, `shutdown`, `reboot`, `systemctl`, and `eval`/`exec` with quoted arguments ([`security/permissions.js`](../security/permissions.js)).
- Shell metacharacters (`|`, `>`, `&&`, `;`, `$(`, backtick) raise a command to at least `high` risk and require approval, even when the rest of the command looks harmless.
- Network-capable commands (`curl`, `wget`, `ssh`, `npm install`, `git clone`/`fetch`/`pull`/`push`, and others) require approval while `security.allowNetwork` is false.
- `fs.write`, `fs.patch`, and `shell.exec` are write-capable. File writes are confined to the repository root and back up existing content, but they still change files.
- Use `--root` or `--cwd` deliberately: the permission roots are derived from those values.

## 7. Use the Local Web Monitor

```bash
npm run ui
# equivalent: node bin/ora.js ui --port 4173
```

Expected output:

```json
{
  "ok": true,
  "url": "http://127.0.0.1:4173/",
  "endpoints": ["/api/status", "/api/tasks", "/api/events"]
}
```

Open `http://127.0.0.1:4173/` in a browser. The page shows status, tasks, and recent events and refreshes every 3 seconds. Endpoints:

| Endpoint | Returns |
|---|---|
| `/` or `/index.html` | The single HTML page |
| `/api/status` | `runtime.status()` |
| `/api/tasks` | `tasks.list({ limit: 200 })` |
| `/api/events` | `events.history({ limit: 200 })` |
| `/api/approvals` | `approvalGate.pending()` |

The dashboard is read-only: it has no POST or mutation endpoints. It serves its own runtime instance, loading state when the process starts; restart it to pick up state written by later CLI invocations. It binds only to `127.0.0.1` by default.
