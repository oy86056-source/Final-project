import { createInterface } from 'node:readline/promises';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRuntime, PROJECT_ROOT } from '../index.js';
import { redact } from '../security/redaction.js';
import { publicConfig } from '../core/config.js';

const FLAG_VALUES = new Set(['--cwd', '--root', '--approval', '--state-dir', '--spec', '--title', '--goal', '--port', '--provider', '--limit', '--args-json', '--prompt', '--message', '--model', '--base-url', '--command']);
const BOOLEAN_FLAGS = new Set(['--json', '--yes', '--all', '--dry-run']);

export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token.startsWith('--')) {
      const [name, inline] = token.split('=', 2);
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name.replace(/^--/, '')] = inline === undefined ? true : ['1', 'true', 'yes'].includes(String(inline).toLowerCase());
      } else if (FLAG_VALUES.has(name)) {
        const value = inline !== undefined ? inline : argv[++index];
        if (value === undefined) throw new Error(`missing value for ${name}`);
        flags[name.replace(/^--/, '')] = value;
      } else {
        flags[name.replace(/^--/, '')] = inline === undefined ? true : inline;
      }
    } else {
      positionals.push(token);
    }
  }
  return { flags, positionals };
}

function approvalPrompt() {
  return async (request) => {
    if (!process.stdin.isTTY) return false;
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await rl.question(`Approve ${request.action} (${request.risk})? ${request.reason} [y/N] `);
      return /^(y|yes)$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  };
}

function buildRuntime(flags = {}) {
  const cwd = resolve(flags.cwd || PROJECT_ROOT);
  const root = resolve(flags.root || cwd);
  const overrides = {};
  if (flags['state-dir']) overrides.runtime = { stateDir: resolve(flags['state-dir']) };
  if (flags.approval) overrides.security = { approvalMode: flags.approval };
  return createRuntime({
    cwd,
    root,
    config: overrides,
    approvalPrompt: approvalPrompt()
  });
}

function output(value, flags = {}) {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (typeof value === 'string') {
    process.stdout.write(`${value}\n`);
    return;
  }
  if (value && typeof value === 'object' && typeof value.text === 'string') {
    process.stdout.write(`${value.text}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function humanStatus(status) {
  const lines = [
    `OpenRuntimeAgent ${status.version}`,
    `root: ${status.root}`,
    `repo: ${status.repo.files} files, languages: ${Object.keys(status.repo.languages).join(', ') || 'unknown'}`,
    `tools: ${status.tools.length}, agents: ${status.agents.length}, providers: ${status.providers.length}, adapters: ${status.adapters.total ?? 0}`,
    `tasks: ${status.tasks.length}, pending approvals: ${status.approvals.length}, events: ${status.state.events}`,
    '',
    'Recent tasks:'
  ];
  if (!status.tasks.length) lines.push('  (none)');
  for (const task of status.tasks.slice(0, 10)) lines.push(`  ${task.id}  ${task.status.padEnd(12)}  ${task.title}`);
  return lines.join('\n');
}

function humanTaskResult(result) {
  const lines = [
    `task ${result.taskId}: ${result.status} (${result.durationMs}ms)`,
    result.summary,
    ''
  ];
  for (const step of result.steps) {
    lines.push(`${step.ok ? 'PASS' : 'FAIL'}  ${step.tool.padEnd(18)} ${step.title}`);
  }
  if (result.verification) lines.push('', `verification: ${result.verification.command} -> ${result.verification.ok ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}

function configSet(flags, keyPath, rawValue) {
  const cwd = resolve(flags.cwd || PROJECT_ROOT);
  const allowed = new Set([
    'runtime.stateDir',
    'runtime.defaultTimeoutMs',
    'runtime.maxConcurrentAgents',
    'runtime.checkpointEvery',
    'security.approvalMode',
    'security.allowNetwork',
    'security.requireApproval',
    'agents.useModel'
  ]);
  if (!allowed.has(keyPath)) throw new Error(`config key is not mutable via CLI: ${keyPath}`);
  let value = rawValue;
  if (['true', 'false'].includes(String(value).toLowerCase())) value = String(value).toLowerCase() === 'true';
  else if (/^-?\d+$/.test(String(value))) value = Number(value);
  else if (String(value).startsWith('[')) value = JSON.parse(value);
  const [section, name] = keyPath.split('.');
  const configPath = resolve(cwd, '.ora', 'config.json');
  mkdirSync(dirname(configPath), { recursive: true });
  const existing = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  existing[section] = { ...(existing[section] || {}), [name]: value };
  writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  return { key: keyPath, value, configPath };
}

async function main() {
  const { flags, positionals } = parseArgs();
  const [command, subcommand, ...rest] = positionals;
  if (!command || command === 'help' || flags.help) {
    output({
      usage: 'ora <command> [options]',
      commands: [
        'init', 'status', 'scan', 'task create|run|list|show|resume|cancel',
        'agents list', 'tools list|invoke <name> --args-json <json>',
        'providers list|check|route', 'adapters list|discover|check|report',
        'approvals list|approve <id>|deny <id>', 'config show|set <key> <value>',
        'events', 'smoke', 'ui', 'help'
      ],
      globalFlags: ['--cwd', '--root', '--json', '--approval <auto|manual|deny>', '--yes', '--state-dir', '--spec', '--goal', '--title']
    }, flags);
    return;
  }

  if (command === 'init') {
    const cwd = resolve(flags.cwd || PROJECT_ROOT);
    const configPath = resolve(cwd, '.ora', 'config.json');
    mkdirSync(dirname(configPath), { recursive: true });
    if (!existsSync(configPath)) writeFileSync(configPath, `${JSON.stringify({ runtime: {}, security: {}, agents: {} }, null, 2)}\n`, 'utf8');
    const runtime = buildRuntime(flags);
    output({ ok: true, configPath, stateDir: runtime.config.runtime.stateDir, tools: runtime.tools.size }, flags);
    return;
  }

  if (command === 'config' && subcommand === 'set') {
    output(configSet(flags, rest[0], rest[1]), flags);
    return;
  }

  if (command === 'smoke') {
    const { runSmoke } = await import('../scripts/smoke.js');
    const result = await runSmoke({ cwd: resolve(flags.cwd || PROJECT_ROOT), json: flags.json });
    output(result, flags);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === 'ui') {
    const { startDashboard } = await import('../ui/server.js');
    const runtime = buildRuntime(flags);
    const server = await startDashboard({ runtime, port: Number(flags.port) || 4173 });
    output({ ok: true, url: server.url, endpoints: ['/api/status', '/api/tasks', '/api/events'] }, flags);
    return;
  }

  const runtime = buildRuntime(flags);

  if (command === 'status') {
    output(flags.json ? await runtime.status() : humanStatus(await runtime.status()), flags);
    return;
  }

  if (command === 'scan') {
    const manifest = await runtime.repo.scan();
    const summary = {
      root: manifest.root,
      fileCount: manifest.files.length,
      languages: manifest.languages,
      frameworks: manifest.frameworks,
      packageManagers: manifest.packageManagers,
      entryPoints: manifest.entryPoints,
      scripts: manifest.scripts,
      dependencies: Object.keys(manifest.dependencies).slice(0, 40),
      git: manifest.git,
      warnings: manifest.warnings
    };
    output(summary, flags);
    return;
  }

  if (command === 'agents') {
    output(runtime.agents.list(), flags);
    return;
  }

  if (command === 'tools') {
    if (subcommand === 'invoke') {
      const name = rest[0];
      const args = flags['args-json'] ? JSON.parse(flags['args-json']) : {};
      const previousMode = runtime.approvalGate.mode;
      if (flags.yes) runtime.approvalGate.mode = 'auto';
      const result = await runtime.tools.invoke(name, args, {});
      runtime.approvalGate.mode = previousMode;
      output(result, flags);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    output(runtime.tools.list(), flags);
    return;
  }

  if (command === 'providers') {
    if (subcommand === 'check') {
      output(await runtime.providers.checkAll(), flags);
      return;
    }
    if (subcommand === 'route') {
      const result = await runtime.providers.route({
        task: flags.prompt || flags.message || '',
        messages: [{ role: 'user', content: flags.prompt || flags.message || 'Reply with OK' }],
        prefer: flags.provider ? [flags.provider] : [],
        maxAttempts: 2
      });
      output(result, flags);
      return;
    }
    if (subcommand === 'register') {
      const spec = flags['args-json'] ? JSON.parse(flags['args-json']) : {};
      if (!spec.id || !spec.baseURL) throw new Error('--args-json must include id and baseURL');
      output(runtime.providers.register({ ...spec, apiKeyEnv: spec.apiKeyEnv }), flags);
      return;
    }
    output(runtime.providers.list(), flags);
    return;
  }

  if (command === 'adapters') {
    if (subcommand === 'discover') {
      output(await runtime.adapters.discover(), flags);
      return;
    }
    if (subcommand === 'check') {
      output(rest[0] ? await runtime.adapters.validate(rest[0]) : await runtime.adapterRegistry.validateAll(), flags);
      return;
    }
    if (subcommand === 'execute') {
      const previousMode = runtime.approvalGate.mode;
      if (flags.yes) runtime.approvalGate.mode = 'auto';
      const result = await runtime.tools.invoke('adapter.execute', {
        id: rest[0],
        args: flags['args-json'] ? JSON.parse(flags['args-json']) : [],
        input: flags.message || ''
      }, {});
      runtime.approvalGate.mode = previousMode;
      output(result, flags);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    output(await runtime.adapters.report(), flags);
    return;
  }

  if (command === 'approvals') {
    if (subcommand === 'approve') {
      output(runtime.approvalGate.approve(rest[0]), flags);
      return;
    }
    if (subcommand === 'deny') {
      output(runtime.approvalGate.deny(rest[0]), flags);
      return;
    }
    output(runtime.approvalGate.pending(), flags);
    return;
  }

  if (command === 'config') {
    output(flags.json ? publicConfig(runtime.config) : JSON.stringify(publicConfig(runtime.config), null, 2), flags);
    return;
  }

  if (command === 'events') {
    output(runtime.events.history({ type: subcommand || rest[0], limit: Number(flags.limit) || 100 }), flags);
    return;
  }

  if (command === 'task') {
    if (subcommand === 'create') {
      let spec = null;
      if (flags.spec) spec = JSON.parse(readFileSync(resolve(flags.spec), 'utf8'));
      const task = runtime.tasks.create({
        title: flags.title || '',
        goal: flags.goal || rest.join(' ') || '',
        root: runtime.config.runtime.cwd,
        input: spec ? { spec } : {}
      });
      output(task, flags);
      return;
    }
    if (subcommand === 'list') {
      output(runtime.tasks.list({ status: rest[0], limit: Number(flags.limit) || 100 }), flags);
      return;
    }
    if (subcommand === 'show') {
      output(runtime.tasks.snapshot(rest[0]), flags);
      return;
    }
    if (subcommand === 'cancel') {
      output(runtime.tasks.cancel(rest[0]), { json: false });
      return;
    }
    if (subcommand === 'run' || subcommand === 'resume') {
      let spec = null;
      if (flags.spec) spec = JSON.parse(readFileSync(resolve(flags.spec), 'utf8'));
      const result = subcommand === 'resume'
        ? await runtime.resumeTask(rest[0], { autoApprove: flags.yes || flags.approval === 'auto', spec: spec || undefined })
        : await runtime.runTask({
            taskId: rest[0],
            goal: flags.goal || '',
            title: flags.title || '',
            spec,
            autoApprove: flags.yes || flags.approval === 'auto'
          });
      output(flags.json ? result : humanTaskResult(result), flags);
      if (!result.success) process.exitCode = 1;
      return;
    }
  }

  throw new Error(`unknown command: ${command}${subcommand ? ` ${subcommand}` : ''}`);
}

export async function mainWithErrorHandling(argv = process.argv.slice(2)) {
  try {
    await main(argv);
  } catch (error) {
    const message = redact(error?.message || String(error));
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) await mainWithErrorHandling();

export { buildRuntime, humanStatus, humanTaskResult };
