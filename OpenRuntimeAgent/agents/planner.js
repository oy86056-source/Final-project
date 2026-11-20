function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter((token) => token.length > 2);
}

function includesAny(goal, words) {
  const tokens = new Set(tokenize(goal));
  return words.some((word) => tokens.has(word));
}

export function chooseVerification(manifest = {}, { prefer = [] } = {}) {
  const scripts = manifest.scripts || {};
  const files = new Set((manifest.files || []).map((file) => (file.path || file).split('/')[0]));
  const preferred = prefer.find((name) => scripts[name]) || ['test', 'check', 'verify', 'build', 'lint'].find((name) => scripts[name]);
  if (preferred) return { command: `npm run ${preferred}`, reason: `package.json script: ${preferred}` };
  if (files.has('package.json')) return { command: 'npm test -- --runInBand', reason: 'npm package detected' };
  if (files.has('pyproject.toml') || files.has('requirements.txt')) {
    return { command: 'python3 -m pytest -q', reason: 'Python project detected' };
  }
  if (files.has('Cargo.toml')) return { command: 'cargo test', reason: 'Rust project detected' };
  if (files.has('go.mod')) return { command: 'go test ./...', reason: 'Go project detected' };
  if (files.has('Makefile')) return { command: 'make test', reason: 'Makefile detected' };
  if (includesAny(JSON.stringify(files), ['test', 'tests']))   return { command: 'node --test', reason: 'test directory detected' };
  return { command: 'node --version', reason: 'no project test runner detected; using runtime availability check' };
}

export function planSteps({ goal = '', manifest = {}, spec = {}, maxSteps = 30, includeContext = true } = {}) {
  const steps = [];
  const add = (step) => {
    if (steps.length < maxSteps) steps.push(step);
  };

  add({
    title: 'Scan repository structure',
    tool: 'repo.scan',
    args: {},
    role: 'architect',
    reason: 'Establish ground truth about the repository before editing'
  });

  if (includeContext) {
    add({
      title: 'Assemble task-focused context',
      tool: 'repo.context',
      args: { task: goal, limit: 12000 },
      role: 'researcher',
      reason: 'Collect relevant files and configuration for the task'
    });
  }

  const edits = Array.isArray(spec.files) ? spec.files : [];
  for (const edit of edits) {
    if (!edit || typeof edit.path !== 'string') continue;
    if (typeof edit.patch === 'string') {
      add({
        title: `Apply patch to ${edit.path}`,
        tool: 'fs.patch',
        args: { patch: edit.patch, dryRun: false },
        role: 'coder',
        reason: edit.reason || 'Requested file patch'
      });
    } else {
      add({
        title: `Write ${edit.path}`,
        tool: 'fs.write',
        args: { path: edit.path, content: String(edit.content ?? '') },
        role: 'coder',
        reason: edit.reason || 'Requested file creation'
      });
    }
  }

  if (Array.isArray(spec.commands)) {
    for (const command of spec.commands) {
      const value = typeof command === 'string' ? command : command?.command;
      if (typeof value !== 'string' || !value.trim()) continue;
      add({
        title: `Run command: ${value.slice(0, 80)}`,
        tool: 'shell.exec',
        args: { command: value },
        role: command?.role || 'coder',
        reason: command?.reason || 'Requested command'
      });
    }
  }

  if (!edits.length && includesAny(goal, ['implement', 'create', 'add', 'write', 'generate', 'fix', 'refactor'])) {
    add({
      title: 'Delegate implementation analysis',
      tool: 'agent.delegate',
      args: {
        role: 'coder',
        goal,
        context: { edits: [], requirement: goal }
      },
      role: 'coder',
      reason: 'No explicit file specification was supplied; request a concrete implementation proposal'
    });
  }

  if (includesAny(goal, ['analy', 'inspect', 'explore', 'understand', 'research']) || !edits.length) {
    add({
      title: 'Delegate architecture analysis',
      tool: 'agent.delegate',
      args: { role: 'architect', goal, context: { requirement: goal } },
      role: 'architect',
      reason: 'Produce an evidence-based analysis of the repository'
    });
  }

  if (includesAny(goal, ['test', 'tests', 'verify', 'verification', 'check', 'checks', 'build', 'lint', 'validate', 'validat']) || edits.length > 0) {
    const verification = spec.verification || chooseVerification(manifest);
    add({
      title: `Verify: ${verification.command}`,
      tool: 'shell.exec',
      args: { command: verification.command },
      role: 'tester',
      reason: verification.reason || 'Verification step'
    });
  }

  add({
    title: 'Review working tree changes',
    tool: 'git.diff',
    args: {},
    role: 'reviewer',
    reason: 'Collect a final diff for review'
  });

  return steps.slice(0, maxSteps);
}

export function extractActionsFromModel(text = '') {
  const match = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  const payload = match ? match[1] : String(text);
  try {
    const parsed = JSON.parse(payload.trim());
    const actions = Array.isArray(parsed) ? parsed : parsed.actions;
    if (!Array.isArray(actions)) return [];
    return actions
      .filter((action) => action && typeof action.tool === 'string' && action.args && typeof action.args === 'object')
      .map((action) => ({ tool: action.tool, args: action.args, reason: action.reason || '' }));
  } catch {
    return [];
  }
}
