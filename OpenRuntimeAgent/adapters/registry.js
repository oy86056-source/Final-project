import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { redact } from '../security/redaction.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const BASE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'NODE_ENV', 'TERM', 'CI'];
const OUTPUT_LIMIT = 200000;
const VERSION_LIMIT = 200;
const CAPTURE_LIMIT = 4096;
const KILL_GRACE_MS = 1000;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkDefinition(def) {
  if (!isObject(def)) return 'definition must be an object';
  if (typeof def.id !== 'string' || !ID_PATTERN.test(def.id)) return 'invalid id';
  if (typeof def.command !== 'string' || def.command.trim() === '') return 'invalid command';
  if (!Array.isArray(def.capabilities)) return 'capabilities must be an array';
  if (def.capabilities.some((item) => typeof item !== 'string')) return 'invalid capabilities';
  if (def.args !== undefined && (!Array.isArray(def.args) || def.args.some((item) => typeof item !== 'string' || item.includes('\0')))) return 'invalid args';
  if (def.versionArgs !== undefined && (!Array.isArray(def.versionArgs) || def.versionArgs.some((item) => typeof item !== 'string' || item.includes('\0')))) return 'invalid versionArgs';
  if (def.envAllowlist !== undefined && (!Array.isArray(def.envAllowlist) || def.envAllowlist.some((item) => typeof item !== 'string' || item === '' || item.includes('\0') || item.includes('=')))) return 'invalid envAllowlist';
  if (def.timeoutMs !== undefined && (!Number.isFinite(def.timeoutMs) || def.timeoutMs <= 0)) return 'invalid timeoutMs';
  if (def.enabled !== undefined && typeof def.enabled !== 'boolean') return 'invalid enabled';
  return null;
}

function normalizeDefinition(def) {
  const internal = {
    id: def.id,
    name: def.name ?? def.id,
    kind: def.kind ?? 'cli',
    capabilities: [...def.capabilities],
    command: def.command,
    args: def.args === undefined ? [] : [...def.args],
    versionArgs: def.versionArgs === undefined ? ['--version'] : [...def.versionArgs],
    timeoutMs: def.timeoutMs ?? 30000,
    envAllowlist: def.envAllowlist === undefined ? [] : [...def.envAllowlist],
    description: def.description ?? '',
    enabled: def.enabled ?? true,
    source: def.source ?? 'builtin'
  };
  if (def.available !== undefined) internal.available = Boolean(def.available);
  if (def.path !== undefined) internal.path = def.path;
  return internal;
}

function publicMetadata(def) {
  const result = {
    id: def.id,
    name: def.name,
    kind: def.kind,
    capabilities: [...def.capabilities],
    command: def.command,
    args: [...def.args],
    versionArgs: [...def.versionArgs],
    timeoutMs: def.timeoutMs,
    envAllowlist: [...def.envAllowlist],
    description: def.description,
    enabled: def.enabled,
    source: def.source
  };
  if (def.available !== undefined) result.available = def.available;
  if (def.path !== undefined) result.path = def.path;
  return result;
}

function findCommand(command, directories) {
  if (typeof command !== 'string' || command === '') return null;
  const candidates = command.includes('/') || command.includes(path.sep)
    ? [command]
    : directories.map((directory) => path.join(directory, command));
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function appendCapped(current, chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  const remaining = OUTPUT_LIMIT - current.length;
  if (remaining <= 0) return { value: current, truncated: true };
  return { value: current + text.slice(0, remaining), truncated: text.length > remaining };
}

export function createAdapterRegistry({ logger = () => {}, env = process.env } = {}) {
  const definitions = new Map();
  const environment = isObject(env) ? env : {};

  function sortedDefinitions() {
    return [...definitions.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  function register(def) {
    const reason = checkDefinition(def);
    if (reason) throw new Error(reason);
    const internal = normalizeDefinition(def);
    definitions.set(internal.id, internal);
    logger('register', { id: internal.id });
    return publicMetadata(internal);
  }

  function list() {
    return sortedDefinitions().map(publicMetadata);
  }

  function get(id) {
    return definitions.get(id);
  }

  async function discover() {
    const directories = String(environment.PATH || '').split(path.delimiter).filter(Boolean);
    const results = [];
    for (const def of sortedDefinitions()) {
      const found = findCommand(def.command, directories);
      def.available = found !== null;
      def.path = found;
      results.push({
        id: def.id,
        name: def.name,
        command: def.command,
        available: def.available,
        path: found
      });
      logger('discover', { id: def.id, available: def.available });
    }
    return results;
  }

  async function validate(id) {
    const started = Date.now();
    const def = definitions.get(id);
    if (!def) return { id, ok: false, version: null, reason: 'adapter not found', durationMs: Date.now() - started };
    if (def.enabled === false) return { id, ok: false, version: null, reason: 'adapter disabled', durationMs: Date.now() - started };

    return await new Promise((resolve) => {
      let child;
      try {
        child = spawn(def.command, [...def.versionArgs], {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: buildEnv(def, {})
        });
      } catch (error) {
        resolve({ id, ok: false, version: null, reason: error.message, durationMs: Date.now() - started });
        return;
      }

      let captured = '';
      let errorReason = null;
      let timedOut = false;
      let settled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({ id, ok: false, version: null, reason: 'validation timed out', durationMs: Date.now() - started });
          }
        }
      }, def.timeoutMs);

      const collect = (chunk) => {
        if (captured.length >= CAPTURE_LIMIT) return;
        captured += chunk.toString('utf8').slice(0, CAPTURE_LIMIT - captured.length);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', (error) => {
        errorReason = error.message;
      });
      child.on('close', (code, signalName) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const line = captured.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean) || '';
        const version = line ? redact(line.slice(0, VERSION_LIMIT)) : null;
        const ok = !errorReason && !timedOut && code === 0;
        let reason = null;
        if (errorReason) reason = redact(errorReason);
        else if (timedOut) reason = 'validation timed out';
        else if (code !== 0) reason = `exited with code ${code}${signalName ? ` (${signalName})` : ''}`;
        def.validated = ok;
        def.version = version;
        resolve({ id, ok, version, reason, durationMs: Date.now() - started });
      });
    });
  }

  async function validateAll() {
    return await Promise.all(sortedDefinitions().map((def) => validate(def.id)));
  }

  function buildEnv(def, extraEnv) {
    const result = {};
    for (const key of BASE_ENV_KEYS) {
      if (typeof environment[key] === 'string') result[key] = environment[key];
    }
    for (const key of def.envAllowlist) {
      if (typeof environment[key] === 'string') result[key] = environment[key];
    }
    for (const [key, value] of Object.entries(extraEnv)) {
      if (key === '' || key.includes('\0') || key.includes('=') || /^(BASH_ENV|ENV|LD_[A-Z0-9_]*|NODE_OPTIONS|PATH|SHELL|IFS)$/i.test(key)) throw new Error('invalid env key');
      if (typeof value !== 'string') throw new Error('invalid env value');
      result[key] = value;
    }
    return result;
  }

  async function execute(id, options = {}) {
    const def = definitions.get(id);
    if (!def) throw new Error(`adapter not found: ${id}`);
    if (def.enabled === false) throw new Error(`adapter disabled: ${id}`);
    const opts = isObject(options) ? options : {};
    const args = opts.args === undefined ? [] : opts.args;
    const input = opts.input === undefined ? '' : opts.input;
    const cwd = opts.cwd === undefined ? process.cwd() : opts.cwd;
    const extraEnv = opts.env === undefined ? {} : opts.env;
    const signal = opts.signal;
    if (!Array.isArray(args) || args.some((item) => typeof item !== 'string' || item.includes('\0'))) throw new Error('invalid args');
    if (typeof input !== 'string') throw new Error('invalid input');
    if (typeof cwd !== 'string' || cwd.includes('\0')) throw new Error('invalid cwd');
    if (!isObject(extraEnv)) throw new Error('invalid env');
    const timeout = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : def.timeoutMs;
    const started = Date.now();
    const childEnv = buildEnv(def, extraEnv);

    if (signal && signal.aborted) {
      return { ok: false, id, exitCode: null, signal: 'ABORT', stdout: '', stderr: '', durationMs: Date.now() - started, truncated: false };
    }

    let child;
    try {
      child = spawn(def.command, [...def.args, ...args], {
        shell: false,
        cwd,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      return { ok: false, id, exitCode: null, signal: null, stdout: '', stderr: error.message, durationMs: Date.now() - started, truncated: false };
    }

    return await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let errorReason = null;
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let forceTimer = null;

      const onStdout = (chunk) => {
        const appended = appendCapped(stdout, chunk);
        stdout = appended.value;
        truncated = truncated || appended.truncated;
      };
      const onStderr = (chunk) => {
        const appended = appendCapped(stderr, chunk);
        stderr = appended.value;
        truncated = truncated || appended.truncated;
      };
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          resolve({ ok: false, id, exitCode: null, signal: null, stdout, stderr, durationMs: Date.now() - started, truncated });
          return;
        }
        forceTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            return;
          }
        }, KILL_GRACE_MS);
      }, timeout);
      const onAbort = () => {
        aborted = true;
        try {
          child.kill('SIGTERM');
        } catch {
          return;
        }
      };

      child.stdout.on('data', onStdout);
      child.stderr.on('data', onStderr);
      if (child.stdin) {
        child.stdin.on('error', () => {});
        if (input.length > 0) child.stdin.write(input, 'utf8');
        child.stdin.end();
      }
      child.on('error', (error) => {
        errorReason = error.message;
      });
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true });
      }
      child.on('close', (code, signalName) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
        let message = '';
        if (errorReason) message = errorReason;
        else if (timedOut) message = 'execution timed out';
        else if (aborted) message = 'execution aborted';
        let messageTruncated = false;
        let finalStderr = stderr;
        if (message && stderr.length < OUTPUT_LIMIT) {
          const combined = `${stderr}${stderr ? '\n' : ''}${message}`;
          messageTruncated = combined.length > OUTPUT_LIMIT;
          finalStderr = combined.slice(0, OUTPUT_LIMIT);
        }
        const ok = !errorReason && !timedOut && !aborted && code === 0;
        resolve({
          ok,
          id,
          exitCode: code,
          signal: signalName || (aborted ? 'ABORT' : null),
          stdout,
          stderr: finalStderr,
          durationMs: Date.now() - started,
          truncated: truncated || messageTruncated
        });
      });
    });
  }

  async function remove(id) {
    if (!definitions.has(id)) return { removed: false, id, reason: 'adapter not found' };
    definitions.delete(id);
    logger('remove', { id });
    return { removed: true, id };
  }

  return { register, list, get, discover, validate, validateAll, execute, remove };
}

export function registerBuiltins(registry, { env = process.env } = {}) {
  const environment = isObject(env) ? env : {};
  const builtins = [
    {
      id: 'node',
      name: 'Node.js',
      capabilities: ['runtime', 'javascript', 'test'],
      command: 'node',
      description: 'Node.js runtime'
    },
    {
      id: 'npm',
      name: 'npm',
      capabilities: ['package-manager', 'test', 'build'],
      command: 'npm',
      envAllowlist: ['npm_config_registry'],
      description: 'Node.js package manager'
    },
    {
      id: 'git',
      name: 'Git',
      capabilities: ['vcs', 'status', 'diff'],
      command: 'git',
      description: 'Version control system'
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      capabilities: ['model-run', 'agent-run', 'mcp'],
      command: 'opencode',
      description: 'OpenCode CLI agent'
    },
    {
      id: 'pi',
      name: 'Pi',
      capabilities: ['model-run', 'agent-run', 'skill'],
      command: 'pi',
      description: 'Pi CLI agent'
    }
  ];
  return builtins.map((definition) => {
    const allowlist = definition.envAllowlist === undefined
      ? []
      : definition.envAllowlist.filter((key) => Object.prototype.hasOwnProperty.call(environment, key));
    return registry.register({ ...definition, envAllowlist: allowlist, source: 'builtin' });
  });
}
