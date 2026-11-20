# OpenRuntimeAgent

> A zero-runtime-dependency, repo-aware coding runtime for Node.js. ORA scans a repository, builds a step plan, invokes tools through a permission gate, and records tasks, events, and checkpoints on local disk.

OpenRuntimeAgent (ORA) is an ESM project. The CLI in [`bin/ora.js`](bin/ora.js) is the primary interface. A library API is also exported from [`index.js`](index.js).

## Why This Exists

Coding agents are useful only when you can see what they did and stop them from doing the wrong thing. ORA keeps the loop explicit: scan the repository, produce a plan, run one tool per step, check permissions before each invocation, and persist the evidence. It runs without a package install step and without sending repository data to a model unless you opt in.

## Verified Capabilities

- **Repository intelligence**: scans files, languages, frameworks, package managers, entry points, scripts, dependencies, and git state; searches text and assembles task-focused context ([`repo-intelligence/scanner.js`](repo-intelligence/scanner.js)).
- **Deterministic planning**: a token-based planner turns a goal plus an optional JSON spec into tool steps; no model call is required ([`agents/planner.js`](agents/planner.js)).
- **Six specialist agents**: `architect`, `coder`, `tester`, `researcher`, `security`, and `reviewer`, each with an explicit tool allowlist ([`agents/registry.js`](agents/registry.js)).
- **Fifteen built-in tools**: file read/list/write/patch, shell execution, git status/diff, repo scan/search/context, agent delegation, model completion, adapter execution, config display, and approval listing ([`tools/registry.js`](tools/registry.js)).
- **Controlled execution**: shell commands run through `/bin/bash` with a sanitized environment, output caps, timeouts, and process-group termination ([`execution/shell.js`](execution/shell.js)). File changes use backups and atomic renames and accept unified diffs ([`execution/patch.js`](execution/patch.js)).
- **Permissions and redaction**: path confinement, risk classification, approval modes (`auto`, `manual`, `deny`), and redaction of secret-shaped values in events and tool output ([`security/permissions.js`](security/permissions.js), [`security/redaction.js`](security/redaction.js)).
- **Providers and adapters**: an OpenAI-compatible provider implementation with a scoring router, plus a validated CLI-adapter lifecycle with five built-in adapter definitions ([`providers/router.js`](providers/router.js), [`adapters/lifecycle.js`](adapters/lifecycle.js)).
- **Durable local state**: tasks, contexts, events, and checkpoints are written under a local state directory ([`core/state.js`](core/state.js)).
- **Local monitor**: a read-only web dashboard bound to `127.0.0.1:4173` ([`ui/server.js`](ui/server.js)).

## Requirements

- **Node.js >= 20.11**, as declared in [`package.json`](package.json). This project was verified on Node.js v24.21.0.
- **Zero runtime dependencies.** There is no `dependencies` field in [`package.json`](package.json); all imports resolve to Node.js built-ins or local modules.
- No account, API key, or network connection is required for planning, scanning, file edits, or local verification.

## Quick Start

Run these commands from the ORA root directory:

```bash
node bin/ora.js init
node bin/ora.js status
node bin/ora.js scan
node bin/ora.js task run --goal "analyze this repository" --approval auto
```

`init` creates `.ora/config.json` in the current directory if it does not exist. State is written to `.ora-state` under the current directory unless you override it. The final command prints a per-step `PASS`/`FAIL` report; add `--json` for the structured result.

Without `--approval auto`, an interactive terminal is required for steps that need approval. In a non-interactive shell, those steps are denied. See [Usage](docs/USAGE.md) and [Troubleshooting](docs/TROUBLESHOOTING.md).

## CLI Command Reference

Invoke as `node bin/ora.js <command> ...` (or `ora <command> ...` if the package bin is linked). Run `node bin/ora.js help --json` for the built-in summary.

| Command | Purpose | Key arguments and flags |
|---|---|---|
| `init` | Create `.ora/config.json` and report runtime paths | `--cwd`, `--state-dir`, `--approval`, `--json` |
| `status` | Report config, repo summary, tools, agents, providers, adapters, tasks, approvals, and state | `--json` |
| `scan` | Print the repository manifest summary | `--json` |
| `task create` | Create a task without running it | `--title`, `--goal`, `--spec`, positional goal words |
| `task run [id]` | Create or run a task from a goal and optional spec | `--goal`, `--title`, `--spec`, `--approval`, `--yes`, `--json` |
| `task resume <id>` | Re-run an existing task with its stored goal and spec | `--spec`, `--approval`, `--yes`, `--json` |
| `task list [status]` | List tasks, optionally filtered by status | `--limit`, `--json` |
| `task show <id>` | Print the full task snapshot, including steps and checkpoints | `--json` |
| `task cancel <id>` | Mark a task `cancelled` | (none) |
| `agents` | List specialist agents and their tool allowlists | `--json` |
| `tools list` | List registered tools with risk and read-only metadata | `--json` |
| `tools invoke <name>` | Invoke one tool | `--args-json '<json>'`, `--approval`, `--yes`, `--json` |
| `providers list` | List registered provider metadata | `--json` |
| `providers check` | Run each provider's `/models` health check | `--json` |
| `providers route` | Route a prompt through the provider router | `--prompt` / `--message`, `--provider`, `--json` |
| `providers register` | Register a provider spec for the current process | `--args-json '{"id":"...","baseURL":"..."}'` |
| `adapters list` | List adapter definitions and lifecycle state | `--json` |
| `adapters discover` | Check each adapter command against `PATH` | `--json` |
| `adapters check [id]` | Validate one adapter with its version command, or all adapters | `--json` |
| `adapters execute <id>` | Execute an adapter with argv and stdin through the approval gate | `--args-json '["arg"]'`, `--message`, `--yes`, `--json` |
| `adapters report` | Print adapter totals and per-adapter metadata | `--json` |
| `approvals list` | List in-memory pending approval requests | `--json` |
| `approvals approve <id>` / `deny <id>` | Resolve a pending request | `--json` |
| `config show` | Print safe configuration | `--json` |
| `config set <key> <value>` | Persist one allowlisted config key to `.ora/config.json` | see [Configuration](docs/CONFIGURATION.md) |
| `events [type]` | Print event history | `--limit`, `--json` |
| `smoke` | Run the generated end-to-end fixture | `--json` |
| `ui` | Start the local read-only dashboard | `--port` (default `4173`), `--json` |
| `help` | Print the built-in command and flag summary | `--json` |

Common flags:

| Flag | Meaning |
|---|---|
| `--cwd <path>` | Directory used for config lookup; defaults to the ORA root |
| `--root <path>` | Repository root; defaults to `--cwd` |
| `--state-dir <path>` | Override the state directory for this invocation |
| `--approval auto\|manual\|deny` | Override the approval mode for this invocation |
| `--yes` | Temporarily switches the approval gate to `auto` for `task run`/`resume`, `tools invoke`, and `adapters execute`; critical-risk operations remain denied |
| `--json` | Emit structured JSON instead of the human report |
| `--spec <path>` | Path to a JSON file containing a task spec; not inline JSON |
| `--title`, `--goal` | Task metadata |
| `--limit <n>` | Event or task history limit |
| `--args-json <json>` | Inline JSON object for tool/adapter arguments or provider registration |
| `--prompt`, `--message` | Prompt text for `providers route` or adapter stdin |
| `--port <n>` | Dashboard port |
| `--` | Treat remaining tokens as positional arguments |

The parser also accepts `--provider`, `--model`, `--base-url`, `--command`, `--all`, and `--dry-run`. They are parsed but are not consumed by the implemented commands listed above.

## Running a Task with an Explicit File Spec

`--spec` reads a JSON file. Save the following as `spec.json` in the ORA root:

```json
{
  "files": [
    {
      "path": "notes/example.md",
      "content": "# Example\n\nThis file was created by an ORA task spec.\n",
      "reason": "create a small, reviewable artifact"
    }
  ],
  "verification": {
    "command": "npm run check",
    "reason": "confirm all local JavaScript and JSON files parse"
  }
}
```

Then run:

```bash
node bin/ora.js task run \
  --title "spec-example" \
  --goal "create a note and verify the repository" \
  --spec spec.json \
  --approval auto
```

The planner turns `files` into `fs.write` (or `fs.patch` when an entry has a `patch` string) steps and `verification` into a `shell.exec` step with role `tester` ([`agents/planner.js`](agents/planner.js)). Expected human output shape:

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

Use `node bin/ora.js task show <task-id> --json` for the full structured record.

## Checks and Diagnostics

```bash
npm test          # node --test
npm run check     # node scripts/check.js
npm run smoke     # node scripts/smoke.js
npm run ui        # node bin/ora.js ui
```

- `npm test` runs Node's built-in test runner across `tests/unit`, `tests/integration`, `tests/security`, and `tests/e2e`; it currently reports `tests 51`, `pass 51`, `fail 0`.
- `npm run check` parses every `.json` file and runs `node --check` on every `.js` file, skipping `.git`, `node_modules`, and ORA state/testdir directories. It prints `{"ok":true,"checked":<n>,"failures":[]}` on success.
- `npm run smoke` generates a fixture under `.ora-state-smoke/fixture`, runs a spec-driven task with approval mode `auto`, and prints a report with `ok`, `taskId`, `steps`, `verification`, and `checks`. It does not modify ORA source files.
- `npm run ui` starts the read-only dashboard at **http://127.0.0.1:4173/**. It exposes `/`, `/api/status`, `/api/tasks`, `/api/events`, and `/api/approvals`. There are no write endpoints.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — layers, data flow, state, security boundaries, agents, adapters, providers
- [Configuration](docs/CONFIGURATION.md) — config file, environment variables, mutable keys, provider and adapter specs
- [Usage](docs/USAGE.md) — end-to-end workflows with expected output shapes
- [Troubleshooting](docs/TROUBLESHOOTING.md) — concrete failure modes and fixes
- [Limitations](docs/LIMITATIONS.md) — what ORA does not do today

## License

MIT (see [`package.json`](package.json)).
