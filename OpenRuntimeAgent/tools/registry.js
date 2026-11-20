import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolError, TimeoutError, errorRecord } from '../core/errors.js';
import { redact, redactObject } from '../security/redaction.js';
import { publicConfig } from '../core/config.js';

const MAX_OUTPUT = 200000;

function patchTargets(patchService, args = {}) {
  const text = String(args.patch || '');
  const paths = new Set();
  try {
    const files = typeof patchService?.parseUnifiedDiff === 'function' ? patchService.parseUnifiedDiff(text) : [];
    for (const file of files || []) {
      if (file?.oldPath) paths.add(file.oldPath);
      if (file?.newPath) paths.add(file.newPath);
    }
  } catch {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^(?:---|\+\+\+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const raw = match[1].split('\t')[0].trim();
    if (!raw || raw === '/dev/null') continue;
    paths.add(raw.replace(/^(?:a|b)\//, ''));
  }
  return [...paths];
}

export function createToolRegistry({ permissions, events = null, repo, shell, patch, adapters, providers, config, env = process.env } = {}) {
  const tools = new Map();
  let services = {};

  function register(tool) {
    if (!tool || typeof tool.name !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(tool.name)) {
      throw new ToolError('tool name is required and must match /^[a-z0-9._-]+$/i');
    }
    if (typeof tool.handler !== 'function') throw new ToolError(`tool ${tool.name} needs a handler`);
    const record = {
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema || {},
      risk: tool.risk || 'low',
      readOnly: tool.readOnly !== false,
      handler: tool.handler
    };
    tools.set(record.name, record);
    events?.emit('tool:registered', { name: record.name, risk: record.risk });
    return { name: record.name, description: record.description, risk: record.risk };
  }

  function list() {
    return [...tools.values()]
      .map(({ name, description, inputSchema, risk, readOnly }) => ({ name, description, inputSchema, risk, readOnly }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function get(name) {
    return tools.get(String(name));
  }

  async function invoke(name, args = {}, ctx = {}) {
    const tool = tools.get(String(name));
    if (!tool) throw new ToolError(`Unknown tool: ${name}`);
    const safeArgs = redactObject(args || {});
    const decision = ctx.skipAuthorization
      ? { approved: true, risk: tool.risk, reason: 'internal call' }
      : await permissions.authorize({
          tool: tool.name,
          path: args?.path ?? args?.cwd,
          command: args?.command,
          network: args?.network === true,
          external: tool.name === 'adapter.execute' || tool.name === 'model.complete'
        });
    if (!decision.approved) {
      const result = {
        ok: false,
        denied: true,
        tool: tool.name,
        error: redact(decision.reason || 'not approved'),
        risk: decision.risk,
        approvalId: decision.approvalId || null,
        output: '',
        durationMs: 0,
        invocationId: randomUUID()
      };
      events?.emit('tool:denied', { name: tool.name, reason: result.error, risk: decision.risk });
      return result;
    }

    const invocationId = randomUUID();
    const started = Date.now();
    const timeoutMs = Math.max(100, Number(ctx.timeoutMs) || 60000);
    events?.emit('tool:start', { invocationId, name: tool.name, args: redact(JSON.stringify(safeArgs).slice(0, 2000)) });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new TimeoutError(`tool ${tool.name} timed out`)), timeoutMs);
    timer.unref?.();
    if (ctx.signal) ctx.signal.addEventListener('abort', () => controller.abort(ctx.signal.reason), { once: true });

    let output;
    let error = null;
    try {
      output = await Promise.race([
        Promise.resolve(tool.handler(args || {}, { ...ctx, signal: controller.signal, services })),
        new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason || new TimeoutError('aborted')), { once: true });
        })
      ]);
    } catch (caught) {
      error = errorRecord(caught);
      error.message = redact(error.message);
    } finally {
      clearTimeout(timer);
    }

    let text = '';
    let data = null;
    if (output && typeof output === 'object' && typeof output.output === 'string') {
      text = output.output;
      data = output.data ?? output;
    } else if (typeof output === 'string') {
      text = output;
    } else {
      data = output ?? null;
      try {
        text = JSON.stringify(output ?? null);
      } catch {
        text = '[unserializable]';
      }
    }
    if (text.length > MAX_OUTPUT) text = `${text.slice(0, MAX_OUTPUT)}\n[TRUNCATED]`;
    const durationMs = Date.now() - started;
    const explicitOk = output && typeof output === 'object' && 'ok' in output
      ? output.ok === true
      : output && typeof output === 'object' && 'exitCode' in output
        ? output.exitCode === 0
        : true;
    const result = {
      ok: error === null && explicitOk,
      denied: false,
      tool: tool.name,
      output: redact(text),
      data: data === null ? null : redactObject(data, { env }),
      error,
      risk: decision.risk,
      approvalId: decision.approvalId || null,
      durationMs,
      invocationId
    };
    events?.emit('tool:end', {
      invocationId,
      name: tool.name,
      ok: result.ok,
      durationMs,
      outputBytes: result.output.length,
      error: result.error ? result.error.message : null
    });
    return result;
  }

  function bind(nextServices = {}) {
    services = { ...services, ...nextServices };
  }

  function registerBuiltins() {
    register({
      name: 'fs.read',
      description: 'Read a UTF-8 file inside the allowed roots',
      inputSchema: { path: 'string' },
      risk: 'low',
      readOnly: true,
      handler: async ({ path }) => ({ output: await repo.readFile(path) })
    });

    register({
      name: 'fs.list',
      description: 'List a directory inside the allowed roots',
      inputSchema: { path: 'string' },
      risk: 'low',
      readOnly: true,
      handler: async ({ path = '.' } = {}) => {
        const absolute = permissions.confined(path);
        if (!absolute.allowed) throw new ToolError(absolute.reason);
        const entries = await readdir(absolute.path, { withFileTypes: true });
        return { output: entries.map((entry) => `${entry.isDirectory() ? 'd' : 'f'} ${entry.name}`).sort().join('\n') };
      }
    });

    register({
      name: 'fs.write',
      description: 'Create or overwrite a file with backup and atomic write',
      inputSchema: { path: 'string', content: 'string' },
      risk: 'medium',
      readOnly: false,
      handler: ({ path, content }) => {
        const change = patch.writeFile(path, content);
        return { output: JSON.stringify(change), data: change };
      }
    });

    register({
      name: 'fs.patch',
      description: 'Apply a unified diff patch',
      inputSchema: { patch: 'string', dryRun: 'boolean' },
      risk: 'medium',
      readOnly: false,
      handler: (args) => {
        for (const path of patchTargets(patch, args)) {
          const check = permissions.confined(path);
          if (!check.allowed) throw new ToolError(`patch target not allowed: ${check.reason}`);
        }
        return patch.applyPatch(args);
      }
    });

    register({
      name: 'shell.exec',
      description: 'Execute a shell command with safeguards',
      inputSchema: { command: 'string', cwd: 'string' },
      risk: 'high',
      readOnly: false,
      handler: (args, ctx) => shell.exec(args.command, { cwd: args.cwd, signal: ctx.signal, skipAuthorization: true })
    });

    register({
      name: 'git.status',
      description: 'Show git status in the repository',
      inputSchema: {},
      risk: 'low',
      readOnly: true,
      handler: () => shell.exec('git status --short', { skipAuthorization: true })
    });

    register({
      name: 'git.diff',
      description: 'Show current git diff',
      inputSchema: {},
      risk: 'low',
      readOnly: true,
      handler: async () => {
        const result = await shell.exec('git diff --no-ext-diff --unified=3', { skipAuthorization: true });
        if (result.ok) return result;
        const stderr = String(result.stderr || '');
        if (/not a git repository/i.test(stderr) || result.exitCode === 129) {
          return {
            ok: true,
            output: 'Not a git repository; working tree diff unavailable.',
            data: { ...result, skipped: true, reason: 'not-a-git-repository' }
          };
        }
        return result;
      }
    });

    register({
      name: 'repo.scan',
      description: 'Scan and summarize repository structure',
      inputSchema: {},
      risk: 'low',
      readOnly: true,
      handler: async () => {
        const manifest = await repo.scan();
        return {
          data: manifest,
          output: JSON.stringify({
            root: manifest.root,
            fileCount: manifest.files.length,
            languages: manifest.languages,
            frameworks: manifest.frameworks,
            packageManagers: manifest.packageManagers,
            entryPoints: manifest.entryPoints,
            scripts: manifest.scripts,
            git: manifest.git,
            warnings: manifest.warnings
          })
        };
      }
    });

    register({
      name: 'repo.search',
      description: 'Search repository text with a literal query',
      inputSchema: { query: 'string', limit: 'number' },
      risk: 'low',
      readOnly: true,
      handler: async ({ query, limit = 20 }) => ({ output: JSON.stringify(await repo.search(query, { limit })) })
    });

    register({
      name: 'repo.context',
      description: 'Assemble task-focused repository context',
      inputSchema: { task: 'string', paths: 'array', limit: 'number' },
      risk: 'low',
      readOnly: true,
      handler: async ({ task = '', paths = [], limit }) => ({
        output: await repo.context({ task, paths, limit: limit || (config?.repo?.contextLimit || 24000) })
      })
    });

    register({
      name: 'agent.delegate',
      description: 'Delegate a subtask to a specialist agent',
      inputSchema: { role: 'string', goal: 'string', context: 'object' },
      risk: 'medium',
      readOnly: false,
      handler: async (args) => {
        const system = services.agents;
        if (!system) throw new ToolError('agent system is not available');
        const result = await system.delegate(args);
        return {
          ok: result?.status === 'completed' && !(result?.toolResults || []).some((item) => item?.denied),
          output: JSON.stringify(result)
        };
      }
    });

    register({
      name: 'model.complete',
      description: 'Route a prompt to an available model provider',
      inputSchema: { prompt: 'string', messages: 'array', provider: 'string' },
      risk: 'medium',
      readOnly: false,
      handler: async ({ prompt = '', messages, provider, prefer = [] } = {}) => {
        if (!providers) throw new ToolError('provider registry is not available');
        const payload = messages || [{ role: 'user', content: prompt }];
        const completion = provider
          ? await providers.complete(provider, { messages: payload })
          : await providers.route({ messages: payload, prefer, task: prompt || JSON.stringify(payload).slice(0, 200) });
        return { output: completion.text, data: completion };
      }
    });

    register({
      name: 'adapter.execute',
      description: 'Execute a validated integration adapter',
      inputSchema: { id: 'string', args: 'array' },
      risk: 'high',
      readOnly: false,
      handler: async ({ id, args: adapterArgs = [], input = '', cwd }) => {
        const lifecycle = services.adapters;
        const executor = lifecycle || adapters;
        if (!executor) throw new ToolError('adapter registry is not available');
        return { output: JSON.stringify(await executor.execute(id, { args: adapterArgs, input, cwd })) };
      }
    });

    register({
      name: 'config.show',
      description: 'Show the safe runtime configuration',
      inputSchema: {},
      risk: 'low',
      readOnly: true,
      handler: () => ({ output: JSON.stringify(publicConfig(config)) })
    });

    register({
      name: 'approvals.list',
      description: 'List pending approval requests',
      inputSchema: {},
      risk: 'low',
      readOnly: true,
      handler: () => ({ output: JSON.stringify(services.approvalGate?.pending() || []) })
    });
  }

  return {
    register,
    registerBuiltins,
    list,
    get,
    invoke,
    bind,
    get size() {
      return tools.size;
    }
  };
}
