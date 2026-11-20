export const QUEUE_BRANCH = 'ora-queue';
export const STATE_BRANCH = 'ora-state';
export const TASK_WORKFLOW = 'ora-task.yml';
export const REQUEST_PREFIX = 'requests/';
export const STATE_PREFIX = 'tasks/';

export const ALLOWED_COMMANDS = new Set([
  'node --version',
  'npm --version',
  'node --test',
  'npm test',
  'npm run check',
  'npm run build',
  'npm run lint',
  'git status --short',
  'git diff --no-ext-diff --unified=3',
  'pwd',
  'ls -la'
]);

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,160}$/;

function fail(message) {
  const error = new Error(message);
  error.code = 'INVALID_TASK';
  throw error;
}

export function isAllowedCommand(command) {
  const value = String(command || '').trim();
  if (ALLOWED_COMMANDS.has(value)) return true;
  return /^node --check [A-Za-z0-9_./-]{1,160}$/.test(value);
}

export function validatePath(path) {
  const value = String(path || '');
  if (value.includes('..') || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    fail(`File path must stay inside the sandbox: ${value.slice(0, 80)}`);
  }
  if (!value || value.length > 200 || !SAFE_FILE.test(value)) fail(`Invalid file path: ${value.slice(0, 80)}`);
  return value;
}

export function validateRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Task request must be an object');
  const id = String(input.id || '');
  if (!/^task-[a-z0-9-]{6,80}$/.test(id)) fail('Invalid task id');
  const goal = String(input.goal || '').trim();
  if (goal.length < 3 || goal.length > 2000) fail('Goal must be between 3 and 2000 characters');

  const rawSpec = input.spec && typeof input.spec === 'object' && !Array.isArray(input.spec) ? input.spec : {};
  const spec = {};
  if (rawSpec.files !== undefined) {
    if (!Array.isArray(rawSpec.files) || rawSpec.files.length > 20) fail('spec.files must be an array with at most 20 entries');
    spec.files = rawSpec.files.map((entry) => {
      if (!entry || typeof entry !== 'object') fail('Each spec.files entry must be an object');
      const path = validatePath(entry.path);
      if (typeof entry.patch === 'string') {
        if (entry.patch.length > 20000) fail('Patch exceeds 20000 characters');
        return { path, patch: entry.patch, reason: String(entry.reason || '').slice(0, 200) };
      }
      const content = String(entry.content ?? '');
      if (content.length > 20000) fail('File content exceeds 20000 characters');
      return { path, content, reason: String(entry.reason || '').slice(0, 200) };
    });
  }
  if (rawSpec.commands !== undefined) {
    if (!Array.isArray(rawSpec.commands) || rawSpec.commands.length > 5) fail('spec.commands must be an array with at most 5 entries');
    spec.commands = rawSpec.commands.map((entry) => {
      const command = String(typeof entry === 'string' ? entry : entry?.command || '').trim();
      if (!isAllowedCommand(command)) fail(`Command is not in the cloud allowlist: ${command.slice(0, 80)}`);
      return typeof entry === 'string' ? command : { ...entry, command };
    });
  }
  if (rawSpec.verification !== undefined) {
    const command = String(rawSpec.verification?.command || '').trim();
    if (!isAllowedCommand(command)) fail(`Verification command is not in the cloud allowlist: ${command.slice(0, 80)}`);
    spec.verification = { command, reason: String(rawSpec.verification.reason || '').slice(0, 200) };
  }
  const maxSteps = Math.min(30, Math.max(1, Number.parseInt(input.maxSteps, 10) || 30));

  return {
    id,
    goal,
    title: String(input.title || goal.slice(0, 80)).slice(0, 120),
    spec,
    maxSteps,
    requestedBy: String(input.requestedBy || 'web').slice(0, 80),
    createdAt: String(input.createdAt || new Date().toISOString()).slice(0, 40),
    mode: 'offline-deterministic'
  };
}
