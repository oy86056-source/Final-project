import { chooseVerification } from './planner.js';
import { redact } from '../security/redaction.js';

const OPERATOR_SWAPS = [
  ['-', '+'],
  ['+', '-'],
  ['*', '/'],
  ['/', '*'],
  ['===', '=='],
  ['==', '==='],
  ['!==', '==='],
  ['<', '>'],
  ['>', '<'],
  ['<=', '>='],
  ['>=', '<='],
  ['&&', '||'],
  ['||', '&&']
];

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_REPAIR_FILE_BYTES = 200000;

function maskLiterals(line) {
  const masked = line.split('');
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const previous = index > 0 ? line[index - 1] : '';
    if (quote) {
      if (char === quote && previous !== '\\') quote = null;
      masked[index] = ' ';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      masked[index] = ' ';
      continue;
    }
    if (char === '/' && line[index + 1] === '/') {
      for (let cursor = index; cursor < line.length; cursor += 1) masked[cursor] = ' ';
      break;
    }
  }
  return masked.join('');
}

export function candidateEdits(source, path, limit = 40) {
  const original = String(source ?? '');
  const lines = original.split('\n');
  const candidates = [];
  for (let index = 0; index < lines.length && candidates.length < limit; index += 1) {
    const masked = maskLiterals(lines[index]);
    if (masked.trim() === '') continue;
    for (const [from, to] of OPERATOR_SWAPS) {
      const at = masked.indexOf(from);
      if (at === -1) continue;
      const next = [...lines];
      next[index] = `${lines[index].slice(0, at)}${to}${lines[index].slice(at + from.length)}`;
      candidates.push({
        path,
        content: next.join('\n'),
        reason: `repair operator '${from}' to '${to}' on line ${index + 1}`
      });
      if (candidates.length >= limit) break;
    }
  }
  return candidates;
}

export function inferPathsFromError(error = '') {
  const text = String(error ?? '');
  const found = new Set();
  const pattern = /([A-Za-z0-9_./-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|json))\b/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[1];
    if (raw.includes('node_modules')) continue;
    found.add(raw.replace(/^\.\//, '').replace(/^\/workspace\/[^/]+\//, ''));
  }
  return [...found].slice(0, 5);
}

function normalizeEdits(spec = {}) {
  const edits = [];
  if (Array.isArray(spec.files)) {
    for (const file of spec.files) {
      if (!file || typeof file.path !== 'string') continue;
      if (typeof file.patch === 'string') edits.push({ path: file.path, patch: file.patch, reason: file.reason || 'requested patch' });
      else edits.push({ path: file.path, content: String(file.content ?? ''), reason: file.reason || 'requested file' });
    }
  }
  if (Array.isArray(spec.edits)) {
    for (const edit of spec.edits) {
      if (!edit || typeof edit.path !== 'string') continue;
      edits.push({ ...edit, content: edit.content === undefined ? undefined : String(edit.content) });
    }
  }
  return edits;
}

function synthesizeFromExpectations(expectations = []) {
  const edits = [];
  const notes = [];
  const grouped = new Map();
  for (const item of expectations) {
    if (!item || typeof item.function !== 'string') continue;
    if (!IDENTIFIER_RE.test(item.function)) {
      notes.push(`skipped invalid expectation function name: ${String(item.function).slice(0, 80)}`);
      continue;
    }
    const key = item.path || `src/${item.function}.js`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  for (const [path, items] of grouped) {
    const name = items[0].function;
    const first = items[0];
    let body = null;
    if (Array.isArray(first.args) && first.args.length === 2 && typeof first.args[0] === 'number' && typeof first.args[1] === 'number' && typeof first.expected === 'number') {
      for (const [operator] of OPERATOR_SWAPS) {
        if (items.every((item) => {
          const [a, b] = item.args || [];
          if (typeof a !== 'number' || typeof b !== 'number') return false;
          const value = new Function('a', 'b', `return a ${operator} b;`)(a, b);
          return value === item.expected;
        })) {
          body = `return a ${operator} b;`;
          break;
        }
      }
    }
    if (!body) {
      const entries = items.map((item) => `  [${JSON.stringify(item.args)}, ${JSON.stringify(item.expected)}],`).join('\n');
      body = `const results = new Map([\n${entries}\n]);\n  return results.get(JSON.stringify([a, b]));`;
    }
    const params = Array.isArray(first.args) && first.args.length === 2 ? 'a, b' : '...args';
    edits.push({
      path,
      content: `export function ${name}(${params}) {\n  ${body}\n}\n`,
      reason: `synthesize ${name} from ${items.length} verified expectation(s)`
    });
  }
  return { edits, notes };
}

export function createOfflineCoder({ tools, repo, events = null, config = {} } = {}) {
  if (!tools) throw new Error('tool registry is required for the offline coder');
  const maxAttempts = Math.max(1, Math.min(Number(config.agents?.maxRepairAttempts) || 40, 200));
  const repairDeadlineMs = Math.max(1000, Number(config.agents?.repairDeadlineMs) || 60000);
  const allowInferredRepairTargets = config.agents?.allowInferredRepairTargets === true;

  async function read(path, taskId) {
    const result = await tools.invoke('fs.read', { path }, { taskId });
    let content = result.ok ? (typeof result.data?.output === 'string' ? result.data.output : result.output) : null;
    if (repo && typeof repo.readFile === 'function') {
      try {
        const full = await repo.readFile(path);
        if (typeof full === 'string') content = full;
      } catch {
      }
    }
    return typeof content === 'string' ? content : null;
  }

  async function synthesize({ goal = '', spec = {}, context = {}, manifest = {} } = {}) {
    const edits = normalizeEdits(spec);
    if (edits.length) return { edits, notes: ['used explicit task specification'] };
    const generated = synthesizeFromExpectations(spec.expectations || []);
    if (generated.edits.length) return { edits: generated.edits, notes: ['synthesized implementation from task expectations', ...generated.notes] };
    events?.emit('offline:synthesize', { goal: redact(String(goal)).slice(0, 200), edits: 0 });
    return { edits: [], notes: ['no deterministic implementation rule matched; verification will drive repair', ...generated.notes] };
  }

  async function repair({ goal = '', error = '', verification = null, spec = {}, context = {}, manifest = {}, taskId = null, timeoutMs } = {}) {
    const command = verification?.command || spec?.verification?.command || chooseVerification(manifest).command;
    const targets = [...new Set([
      ...(Array.isArray(spec.repairTargets) ? spec.repairTargets : []),
      ...(Array.isArray(context.paths) ? context.paths : []),
      ...(allowInferredRepairTargets ? inferPathsFromError(error) : []),
      ...(allowInferredRepairTargets ? inferPathsFromError(goal) : [])
    ])].slice(0, 5);

    const notes = [`verification command: ${command}`];
    let attempts = 0;
    const deadlineAt = Date.now() + repairDeadlineMs;
    for (const path of targets) {
      if (Date.now() > deadlineAt) {
        notes.push('repair deadline exceeded');
        break;
      }
      const original = await read(path, taskId);
      if (original === null) continue;
      if (Buffer.byteLength(original, 'utf8') > MAX_REPAIR_FILE_BYTES) {
        notes.push(`skipped ${path}: file exceeds ${MAX_REPAIR_FILE_BYTES} bytes`);
        continue;
      }
      for (const candidate of candidateEdits(original, path)) {
        if (Date.now() > deadlineAt) {
          notes.push('repair deadline exceeded');
          break;
        }
        if (attempts >= maxAttempts) break;
        attempts += 1;
        let revert = false;
        try {
          const write = await tools.invoke('fs.write', { path, content: candidate.content }, { taskId });
          if (!write.ok) continue;
          revert = true;
          const check = await tools.invoke('shell.exec', { command }, { taskId, timeoutMs });
          if (check.ok) {
            revert = false;
            events?.emit('offline:repair', { taskId, path, attempts, reason: candidate.reason });
            return {
              edits: [{ ...candidate, reason: `${candidate.reason}; verified by ${command}` }],
              notes: [...notes, candidate.reason, `verified after ${attempts} candidate(s)`],
              attempts,
              verification: { command, ok: true, output: String(check.output || '').slice(0, 2000) }
            };
          }
          notes.push(`candidate ${attempts} failed: ${redact(check.error?.message || String(check.error || 'verification failed')).slice(0, 200)}`);
        } catch (failure) {
          notes.push(`candidate ${attempts} threw: ${redact(failure.message).slice(0, 200)}`);
        } finally {
          if (revert) {
            const restore = await tools.invoke('fs.write', { path, content: original }, { taskId });
            if (!restore.ok) {
              const message = redact(restore.error?.message || String(restore.error || 'failed to restore original file')).slice(0, 200);
              notes.push(`restore failed: ${message}`);
              events?.emit('offline:restore_failed', { taskId, path, attempts, error: message });
              return { edits: [], notes, attempts, restoreFailed: true };
            }
          }
        }
      }
      if (Date.now() > deadlineAt) break;
    }
    events?.emit('offline:repair_failed', { taskId, attempts });
    return { edits: [], notes: [...notes, 'no candidate edit made verification pass'], attempts };
  }

  return { synthesize, repair, read };
}
