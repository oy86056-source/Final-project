# Configuration

Configuration is local to the ORA root directory. No network service or secret store is required.

## File Location and Precedence

The config file is **`.ora/config.json` inside the ORA root** (the directory passed as `--cwd`, or the ORA root by default). `node bin/ora.js init` creates it with empty `runtime`, `security`, and `agents` sections if it does not already exist.

[`core/config.js`](../core/config.js) merges configuration in this order:

1. `DEFAULT_CONFIG`
2. The JSON file (`.ora/config.json`, or `ORA_CONFIG` if set)
3. `overrides` passed to `createRuntime` (the CLI sets `runtime.stateDir` from `--state-dir` and `security.approvalMode` from `--approval`)
4. `ORA_*` environment variables

After merging, a relative `runtime.stateDir` resolves against `cwd`, and `runtime.configPath` and `runtime.cwd` are added to the effective config. Invalid values throw `ConfigError`. Use `node bin/ora.js config show --json` to inspect the effective safe config.

## Defaults

| Section | Key | Default | Notes |
|---|---|---|---|
| `runtime` | `stateDir` | `.ora-state` | Resolved against `cwd`; contains `state.json`, `events.jsonl`, `checkpoints/`, `backups/` |
| `runtime` | `defaultTimeoutMs` | `60000` | Used for tool invocations and shell commands |
| `runtime` | `maxConcurrentAgents` | `3` | Exposed in config; `agents.runParallel` has its own `concurrency` option |
| `runtime` | `checkpointEvery` | `3` | Checkpoint every N planned steps |
| `runtime` | `maxSteps` | `30` | Plan length cap passed to `agents.plan` |
| `runtime` | `logLevel` | `info` | `debug` makes the event bus write events to stderr |
| `security` | `approvalMode` | `manual` | Must be `auto`, `manual`, or `deny` |
| `security` | `allowNetwork` | `false` | Network-capable shell commands still trigger approval when false |
| `security` | `requireApproval` | `["shell","write","network","external"]` | Categories that require an approval decision; `all` can also be included |
| `security` | `deniedPaths` | `".env"`, `".env.*"`, `"*.pem"`, `"*.key"`, `"*credentials*"`, `"*secret*"`, `".ssh/**"`, `".aws/**"`, `".freellmapi/.env"`, `".ora-state/**"` | Matched against paths relative to an allowed root |
| `repo` | `ignore` | `[]` | Extra ignore patterns for the scanner |
| `repo` | `maxFiles` | `20000` | Manifest cap |
| `repo` | `maxBytesPerFile` | `512000` | Files larger than this are skipped |
| `repo` | `contextLimit` | `24000` | Default limit for `repo.context` |
| `agents` | `useModel` | `false` | Enables model-generated actions in `delegate` only |
| `agents` | `maxActionsPerAgent` | `12` | Cap on actions per delegation |
| (root) | `providers` | `[]` | Provider specs registered at runtime construction |
| (root) | `adapters` | `[]` | Adapter definitions registered at runtime construction |

## Environment Variables

All `ORA_*` variables are read in [`core/config.js`](../core/config.js).

| Variable | Effect | Validation / coercion |
|---|---|---|
| `ORA_CONFIG` | Replaces the config file path | Resolved with `path.resolve`; file must contain a JSON object |
| `ORA_STATE_DIR` | Overrides `runtime.stateDir` | Used as-is; relative values resolve against `cwd` |
| `ORA_LOG_LEVEL` | Overrides `runtime.logLevel` | Any string; `debug` enables event logging to stderr |
| `ORA_MAX_CONCURRENT_AGENTS` | Overrides `runtime.maxConcurrentAgents` | Numeric, clamped to 1–16 |
| `ORA_DEFAULT_TIMEOUT_MS` | Overrides `runtime.defaultTimeoutMs` | Numeric, clamped to 100–600000 |
| `ORA_APPROVAL_MODE` | Overrides `security.approvalMode` | Final value must be `auto`, `manual`, or `deny` |
| `ORA_ALLOW_NETWORK` | Overrides `security.allowNetwork` | `1`, `true`, or `yes` (case-insensitive) means true |
| `ORA_USE_MODEL` | Overrides `agents.useModel` | `1`, `true`, or `yes` (case-insensitive) means true |
| `ORA_PROVIDERS_JSON` | Replaces `providers` with a JSON array | Invalid JSON throws `ConfigError` |

Example:

```bash
ORA_APPROVAL_MODE=deny ORA_USE_MODEL=1 ORA_STATE_DIR=.ora-state-dev \
  node bin/ora.js status --json
```

## Mutable CLI Config Keys

`node bin/ora.js config set <key> <value>` accepts only the allowlist implemented in [`bin/ora.js`](../bin/ora.js). Values are coerced: `true`/`false` become booleans, integer strings become numbers, and strings beginning with `[` are parsed as JSON. The command merges the key into `.ora/config.json` and prints `{ "key": ..., "value": ..., "configPath": ... }`.

| Key | Example value |
|---|---|
| `runtime.stateDir` | `.ora-state-dev` |
| `runtime.defaultTimeoutMs` | `30000` |
| `runtime.maxConcurrentAgents` | `4` |
| `runtime.checkpointEvery` | `1` |
| `security.approvalMode` | `auto` |
| `security.allowNetwork` | `false` |
| `security.requireApproval` | `["shell","write"]` |
| `agents.useModel` | `false` |

Any other key fails with `config key is not mutable via CLI: <key>`.

## Approval Mode Examples

```bash
# Auto-approve everything except risk=critical operations
node bin/ora.js config set security.approvalMode auto

# Ask an interactive operator (the default)
node bin/ora.js config set security.approvalMode manual

# Refuse every request that needs approval
node bin/ora.js config set security.approvalMode deny

# One-shot override; does not write the config file
node bin/ora.js task run --goal "analyze this repository" --approval auto
```

In `auto` mode, destructive commands are still denied because their risk is `critical`. In `manual` mode, a prompt is used only when the process has a TTY; otherwise the request is denied ([`bin/ora.js`](../bin/ora.js), [`security/permissions.js`](../security/permissions.js)).

## Custom Provider Spec

Add providers to `.ora/config.json`, pass them through `ORA_PROVIDERS_JSON`, or register one for the current process with `providers register`.

```json
{
  "providers": [
    {
      "id": "local-model",
      "name": "Local model",
      "kind": "openai-compatible",
      "baseURL": "http://127.0.0.1:8080/v1",
      "apiKeyEnv": "LOCAL_MODEL_API_KEY",
      "models": ["local/model"],
      "defaultModel": "local/model",
      "contextWindow": 32768,
      "maxOutput": 4096,
      "cost": 0,
      "speed": "fast",
      "capabilities": ["chat", "code", "json"]
    }
  ]
}
```

A spec requires `id` and an `http(s)` `baseURL`. `apiKeyEnv` names an environment variable whose value becomes the Bearer token. Optional metadata (`cost`, `speed`, `quality`, `capabilities`, `description`, `warning`, `latencyMs`) is used by the router ([`providers/registry.js`](../providers/registry.js), [`providers/router.js`](../providers/router.js)). Process-local registration:

```bash
node bin/ora.js providers register \
  --args-json '{"id":"local-model","baseURL":"http://127.0.0.1:8080/v1"}' \
  --json
node bin/ora.js providers check --json
```

## Custom Adapter Spec

Add adapter definitions to `.ora/config.json`; they are registered when the runtime is constructed.

```json
{
  "adapters": [
    {
      "id": "custom-linter",
      "name": "Custom linter",
      "kind": "cli",
      "command": "npx",
      "args": ["--no-install", "my-linter"],
      "versionArgs": ["--version"],
      "capabilities": ["lint"],
      "envAllowlist": ["MY_LINTER_CONFIG"],
      "timeoutMs": 30000,
      "enabled": true,
      "description": "Locally installed linter adapter"
    }
  ]
}
```

`id`, `command`, and `capabilities` are required. `envAllowlist` controls which environment variables reach the child process in addition to the base set (`PATH`, `HOME`, `LANG`, `LC_ALL`, `NODE_ENV`, `TERM`, `CI`). Definitions are registered in memory; no software is downloaded ([`adapters/registry.js`](../adapters/registry.js), [`adapters/lifecycle.js`](../adapters/lifecycle.js)).

## FreeLLMAPI Integration

FreeLLMAPI is registered by default unless `integrations.freellmapi` is `false` in `.ora/config.json`.

| Setting | Default | Source |
|---|---|---|
| Gateway base URL | `http://127.0.0.1:3001/v1` | `integrations.freellmapiBaseURL` |
| Configured key file | `/workspaces/Final-project/.freellmapi/.env` | `integrations.freellmapiEnvFile` (preserved as fallback) |
| Runtime-local key file | `<runtime.stateDir>/freellmapi.env` | Passed as runtime state env file |
| Key variable | `FREELLMAPI_API_KEY` | Environment, then configured key file, then runtime-local key file |
| Provider id / model | `freellmapi` / `auto` | Fixed in `registerFreeLLMAPI` |

The key is read by [`providers/registry.js`](../providers/registry.js) from `process.env.FREELLMAPI_API_KEY` first, then from a `KEY=value` line in the configured env file, then from the runtime-local env file. It is used as a Bearer token and is scrubbed from provider metadata, health results, error messages, and redacted event data; it is never logged in plain text.

FreeLLMAPI requires upstream provider keys configured in the gateway to actually generate text. Even when the gateway is reachable/authenticated and provider health succeeds, chat completion can be unavailable with `no_providers_configured` / HTTP 503; in that case runtime status reports LLM capabilities as `offline-deterministic` and real inference is not available.

If the gateway rejects requests with HTTP 401, the configured `FREELLMAPI_API_KEY` or gateway auth is invalid/unavailable. This is an external/gateway condition, not a runtime bug. Provide a valid key through the environment, configured env file, or runtime-local env file, point the integration at a reachable gateway, or disable it with `integrations.freellmapi: false`.

> Note: `config show` returns `publicConfig`, which lists providers and adapters from the config file only. Live-registered providers appear in `status`/`providers list`; adapter availability appears in `adapters discover` and `adapters report`.
