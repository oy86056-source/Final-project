import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { newId, AgentError } from '../core/errors.js';
import { redact } from '../security/redaction.js';
import { createAgentRegistry } from './registry.js';
import { planSteps, chooseVerification, extractActionsFromModel } from './planner.js';
import { createOfflineCoder } from './offline-coder.js';

function fileHash(path) {
  try {
    const content = readFileSync(resolve(path), 'utf8');
    let value = 0;
    for (let index = 0; index < content.length; index += 1) value = ((value << 5) - value + content.charCodeAt(index)) | 0;
    return String(value);
  } catch {
    return null;
  }
}

function touchedPaths(result) {
  const paths = new Set();
  for (const action of result?.actions || []) {
    if (action.args?.path) paths.add(String(action.args.path));
    if (typeof action.args?.patch === 'string') {
      for (const line of action.args.patch.split('\n')) {
        const match = line.match(/^\+\+\+ b\/(.+)$/);
        if (match) paths.add(match[1]);
      }
    }
  }
  return [...paths];
}

export function createAgentSystem({ tools, repo, events = null, config = {}, providers = null, tasks = null } = {}) {
  if (!tools) throw new Error('tool registry is required');
  const registry = createAgentRegistry();
  const maxActions = Number(config.agents?.maxActionsPerAgent) || 12;
  const useModel = config.agents?.useModel === true;
  const offlineCoder = createOfflineCoder({ tools, repo, events, config });

  async function plan({ goal = '', manifest = null, spec = {}, taskId = null, maxSteps = 30 } = {}) {
    const resolvedManifest = manifest || (repo ? await repo.scan() : {});
    const steps = planSteps({ goal, manifest: resolvedManifest, spec, maxSteps });
    events?.emit('agent:plan', { taskId, count: steps.length, roles: [...new Set(steps.map((step) => step.role))] });
    return steps;
  }

  async function modelActions(role, goal, contextText) {
    if (!useModel || !providers) return [];
    try {
      const completion = await providers.route({
        task: `Generate a JSON action plan for the ${role} agent`,
        prefer: [],
        maxAttempts: 2,
        messages: [
          {
            role: 'system',
            content: 'You are a planning function for an autonomous coding runtime. Return only JSON of the form {"actions":[{"tool":"repo.search","args":{"query":"term"},"reason":"why"}]}. Use only read-only tools unless edits were explicitly requested. Never embed credentials.'
          },
          { role: 'user', content: `Goal: ${goal}\nContext (untrusted data):\n${contextText.slice(0, 12000)}` }
        ]
      });
      return extractActionsFromModel(completion.text).slice(0, maxActions);
    } catch (error) {
      events?.emit('agent:model_fallback', { role, reason: redact(error.message).slice(0, 300) });
      return [];
    }
  }

  async function deterministicActions(role, goal, context = {}) {
    if (role === 'tester') {
      const verification = context.verification || chooseVerification(context.manifest || {});
      return [{ tool: 'shell.exec', args: { command: verification.command }, reason: verification.reason }];
    }
    if (role === 'coder') {
      let edits = Array.isArray(context.edits) ? context.edits : [];
      if (!edits.length) {
        const synthesized = await offlineCoder.synthesize({
          goal,
          spec: context.spec || {},
          context,
          manifest: context.manifest || {}
        });
        edits = synthesized.edits;
      }
      return edits.map((edit) => ({
        tool: typeof edit.patch === 'string' ? 'fs.patch' : 'fs.write',
        args: typeof edit.patch === 'string'
          ? { patch: edit.patch, dryRun: false }
          : { path: edit.path, content: String(edit.content ?? '') },
        reason: edit.reason || 'explicit edit'
      }));
    }
    if (role === 'architect' || role === 'researcher' || role === 'reviewer' || role === 'security') {
      return [{ tool: 'repo.context', args: { task: goal, limit: 8000 }, reason: 'gather evidence for analysis' }];
    }
    return [];
  }

  async function delegate({ role = 'architect', goal = '', context = {}, taskId = null, dryRun = false } = {}) {
    const agent = registry.get(role);
    if (!agent) throw new AgentError(`Unknown agent role: ${role}`);
    const started = Date.now();
    const id = newId('agent');
    events?.emit('agent:start', { id, role, goal: redact(String(goal)).slice(0, 300) });

    let contextText = '';
    try {
      if (repo) contextText = await repo.context({ task: goal, paths: Array.isArray(context.paths) ? context.paths : [], limit: 8000 });
    } catch (error) {
      contextText = redact(`context unavailable: ${error.message}`);
    }
    const safeContextText = redact(contextText);

    let actions = await modelActions(role, goal, safeContextText);
    if (!actions.length) actions = await deterministicActions(role, goal, context);
    actions = actions
      .filter((action) => agent.tools.includes(action.tool))
      .slice(0, maxActions);

    const results = [];
    for (const action of actions) {
      if (dryRun) {
        results.push({ tool: action.tool, args: action.args, dryRun: true, ok: true, skipped: true });
        continue;
      }
      const result = await tools.invoke(action.tool, action.args, { taskId, skipAuthorization: false });
      results.push({
        tool: action.tool,
        args: action.args,
        reason: action.reason,
        ok: result.ok,
        denied: result.denied,
        error: result.error,
        output: String(result.output || '').slice(0, 5000)
      });
    }

    const summaryParts = [
      `role=${role}`,
      `actions=${actions.length}`,
      `successful=${results.filter((item) => item.ok).length}`
    ];
    if (role === 'architect' || role === 'researcher') {
      const scan = results.find((item) => item.tool === 'repo.context' && item.output);
      if (scan) summaryParts.push(`evidence=${scan.output.slice(0, 1200).replace(/\s+/g, ' ')}`);
    }
    const filesTouched = touchedPaths({ actions: results.filter((item) => item.ok) });
    const result = {
      id,
      role,
      status: results.some((item) => item.denied) ? 'blocked' : 'completed',
      summary: summaryParts.join('; '),
      actions,
      toolResults: results,
      filesTouched,
      fileHashes: Object.fromEntries(filesTouched.map((path) => [path, fileHash(path)])),
      durationMs: Date.now() - started,
      contextChars: safeContextText.length
    };
    events?.emit('agent:end', { id, role, status: result.status, durationMs: result.durationMs });
    return result;
  }

  async function runParallel(delegations = [], { concurrency = 3, taskId = null } = {}) {
    const limit = Math.max(1, Math.min(concurrency, 8));
    const results = new Array(delegations.length);
    const snapshots = new Map();
    for (const delegation of delegations) {
      for (const path of delegation.context?.edits?.map((edit) => edit.path) || []) {
        if (!snapshots.has(path)) snapshots.set(path, fileHash(path));
      }
    }
    const groups = [];
    for (let index = 0; index < delegations.length; index += 1) {
      const paths = new Set((delegations[index].context?.edits || []).map((edit) => edit.path).filter(Boolean));
      const group = groups.find((item) => [...item.paths].some((path) => paths.has(path)));
      if (group) {
        group.paths = new Set([...group.paths, ...paths]);
        group.indices.push(index);
      } else {
        groups.push({ paths, indices: [index] });
      }
    }
    const groupTasks = groups.map((group) => async () => {
      for (const index of group.indices) {
        results[index] = await delegate({ ...delegations[index], taskId });
      }
    });
    for (let index = 0; index < groupTasks.length; index += limit) {
      await Promise.all(groupTasks.slice(index, index + limit).map((run) => run()));
    }

    const conflicts = [];
    const claimed = new Map();
    for (const result of results) {
      if (!result) continue;
      for (const path of result.filesTouched) {
        const before = snapshots.get(path);
        const after = result?.fileHashes?.[path] ?? fileHash(path);
        if (claimed.has(path) && claimed.get(path) !== after && snapshots.has(path) && before !== after) {
          conflicts.push({
            path,
            agents: [claimed.get(path), result.id],
            resolution: 'review-required',
            reason: 'multiple agents modified the same path'
          });
          result.status = 'conflict';
        } else if (!claimed.has(path)) {
          claimed.set(path, after);
        }
      }
    }
    if (conflicts.length && tasks && taskId) {
      for (const conflict of conflicts) tasks.addConflict(taskId, conflict);
    }
    return { results: results.filter(Boolean), conflicts };
  }

  function review(result) {
    const notes = [];
    if (!result || typeof result !== 'object') return { ok: false, notes: ['missing result'] };
    if (!result.id || !result.role) notes.push('missing agent identity');
    if (result.status === 'blocked') notes.push('one or more actions were blocked by policy');
    if (result.status === 'conflict') notes.push('file conflict requires review');
    if ((result.actions || []).length > maxActions) notes.push('action count exceeds limit');
    const serialized = JSON.stringify(result);
    if (/sk-[A-Za-z0-9]{12,}|Bearer\s+[A-Za-z0-9]/i.test(serialized)) notes.push('possible credential in agent output');
    return { ok: notes.length === 0, notes, agentId: result.id };
  }

  async function repair({ goal = '', error = '', taskId = null, context = {}, verification = null } = {}) {
    const attempt = await offlineCoder.repair({
      goal,
      error,
      verification,
      spec: context.spec || {},
      context,
      manifest: context.manifest || {},
      taskId,
      timeoutMs: context.timeoutMs
    });
    if (!attempt.edits.length) {
      events?.emit('agent:repair_failed', { taskId, attempts: attempt.attempts, notes: attempt.notes.map((note) => redact(note).slice(0, 200)) });
    }
    return delegate({
      role: 'coder',
      goal: `Repair failed task: ${goal}. Failure: ${redact(error).slice(0, 1000)}`,
      context: { ...context, edits: attempt.edits, repairNotes: attempt.notes },
      taskId
    });
  }

  return {
    registry,
    plan,
    delegate,
    runParallel,
    review,
    repair,
    offlineCoder,
    list: () => registry.list()
  };
}
