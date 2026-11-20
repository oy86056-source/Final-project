import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { redact } from '../security/redaction.js';

const SAFE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'NODE_ENV', 'TERM', 'CI'];
const DANGEROUS_ENV_KEYS = /^(BASH_ENV|ENV|LD_[A-Z0-9_]*|NODE_OPTIONS|PATH|SHELL|IFS|CDPATH|GLOBIGNORE|PROMPT_COMMAND|PYTHONPATH|PERL5LIB)$/i;

export function sanitizeEnv(extra = {}, env = process.env) {
  const result = {};
  for (const key of SAFE_ENV_KEYS) {
    if (env[key] !== undefined) result[key] = env[key];
  }
  for (const [key, value] of Object.entries(extra || {})) {
    if (DANGEROUS_ENV_KEYS.test(key) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value === undefined || value === null) continue;
    result[key] = String(value);
  }
  return result;
}

export function createShellExecutor({ events = null, defaultTimeoutMs = 60000, maxOutput = 200000, root = process.cwd(), env = process.env, permissions = null } = {}) {
  async function exec(command, { cwd = root, timeoutMs = defaultTimeoutMs, env: extraEnv = {}, signal = null, skipAuthorization = false } = {}) {
    const text = String(command || '');
    if (!text.trim()) throw new Error('empty command');
    if (text.length > 20000) throw new Error('command exceeds 20000 characters');
    if (text.includes('\0')) throw new Error('command contains NUL byte');

    if (!skipAuthorization && permissions) {
      const decision = await permissions.authorize({ tool: 'shell.exec', command: text, path: cwd });
      if (!decision.approved) {
        return {
          ok: false,
          exitCode: null,
          stdout: '',
          stderr: redact(decision.reason || 'command not approved'),
          durationMs: 0,
          truncated: false,
          denied: true,
          risk: decision.risk
        };
      }
    }

    const started = Date.now();
    const workdir = resolve(cwd);
    events?.emit('shell:start', { command: redact(text).slice(0, 500), cwd: workdir });
    const result = await new Promise((resolvePromise) => {
      let child;
      try {
        child = spawn('/bin/bash', ['-c', text], {
          cwd: workdir,
          env: sanitizeEnv(extraEnv, env),
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true
        });
      } catch (error) {
        resolvePromise({ ok: false, exitCode: null, stdout: '', stderr: error.message, killed: false });
        return;
      }

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      let abortReason = null;
      let killTimer = null;
      let settled = false;

      const append = (current, chunk) => {
        const available = maxOutput - current.length;
        if (available <= 0) {
          truncated = true;
          return current;
        }
        const slice = chunk.toString('utf8').slice(0, available);
        if (slice.length < chunk.length) truncated = true;
        return current + slice;
      };
      child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
      child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', onAbort);
        resolvePromise({ ...payload, stdout, stderr, truncated, timedOut });
      };

      const signalGroup = (name) => {
        try {
          process.kill(-child.pid, name);
        } catch {
          try { child.kill(name); } catch {}
        }
      };
      const terminate = (reason) => {
        abortReason = reason;
        signalGroup('SIGTERM');
        killTimer = setTimeout(() => signalGroup('SIGKILL'), 500);
        killTimer.unref?.();
        setTimeout(() => finish({ ok: false, exitCode: null, signal: reason, error: reason }), 2000).unref?.();
      };

      const onAbort = () => terminate('aborted');
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        terminate('timeout');
      }, Math.max(100, Number(timeoutMs) || defaultTimeoutMs));
      timer.unref?.();

      child.on('error', (error) => finish({ ok: false, exitCode: null, error: error.message }));
      child.on('close', (code, closeSignal) => {
        const ok = code === 0 && !timedOut && !abortReason;
        finish({
          ok,
          exitCode: code,
          signal: closeSignal || abortReason,
          error: ok ? null : (abortReason || (timedOut ? 'timeout' : `exit code ${code}`))
        });
      });
    });

    const durationMs = Date.now() - started;
    const safe = {
      ...result,
      ok: result.ok === true,
      stdout: redact(result.stdout || ''),
      stderr: redact(result.stderr || ''),
      durationMs,
      command: redact(text).slice(0, 500)
    };
    events?.emit('shell:end', {
      ok: safe.ok,
      exitCode: safe.exitCode,
      durationMs,
      stdoutBytes: safe.stdout.length,
      stderrBytes: safe.stderr.length
    });
    return safe;
  }

  return { exec, sanitizeEnv: (extra) => sanitizeEnv(extra, env) };
}
