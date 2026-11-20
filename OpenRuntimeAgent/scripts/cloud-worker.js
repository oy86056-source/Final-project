import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../core/runtime.js';
import { createGitHubClient } from '../cloud/github.js';
import { createCloudStore } from '../cloud/store.js';
import { createSandbox, snapshotFiles, changedFiles } from '../cloud/workspace.js';
import { validateRequest } from '../cloud/validate.js';

function truncate(value, max = 4000) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}\n[TRUNCATED]` : text;
}

function summarizeEvent(event) {
  return {
    ts: event.ts || new Date().toISOString(),
    type: event.type || event.event || 'unknown',
    taskId: event.taskId || null,
    tool: event.name || event.tool || null,
    ok: typeof event.ok === 'boolean' ? event.ok : undefined,
    message: truncate(event.error || event.reason || event.summary || event.title || '', 500)
  };
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const requestId = process.env.ORA_TASK_ID;
  const requestPath = process.env.ORA_REQUEST_PATH || `requests/${requestId}.json`;
  if (!token) throw new Error('GITHUB_TOKEN is required');
  if (!requestId) throw new Error('ORA_TASK_ID is required');

  const github = createGitHubClient({ token });
  const store = createCloudStore({ github });
  await github.ensureBranch('ora-state', 'main');
  await github.ensureBranch('ora-queue', 'main');

  const { request, path } = await store.readRequest(requestId, requestPath);
  const task = validateRequest({ ...request, id: requestId });
  const controller = new AbortController();
  const events = [];
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'ora-cloud-'));
  const sandbox = createSandbox({ root: workspaceRoot, taskId: task.id });
  const before = snapshotFiles(sandbox.root);
  const stateDir = join(workspaceRoot, '.ora-state-worker');
  const runId = process.env.GITHUB_RUN_ID || null;
  const runUrl = runId
    ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${github.repository}/actions/runs/${runId}`
    : null;

  const baseState = {
    id: task.id,
    title: task.title,
    goal: task.goal,
    spec: task.spec,
    status: 'running',
    mode: 'offline-deterministic',
    llmConfigured: false,
    requestedBy: task.requestedBy,
    createdAt: task.createdAt,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    updatedAt: new Date().toISOString(),
    progress: { step: 0, total: 0, label: 'starting' },
    steps: [],
    events,
    changedFiles: [],
    result: null,
    error: null,
    verification: null,
    worker: { runId, runUrl, provider: 'github-actions', sandbox: 'isolated' },
    requestPath: path
  };

  let runtime;
  let finalState = baseState;
  try {
    runtime = createRuntime({
      cwd: sandbox.root,
      root: sandbox.root,
      config: {
        runtime: { stateDir, maxSteps: task.maxSteps, defaultTimeoutMs: 60000, checkpointEvery: 2 },
        security: { approvalMode: 'auto' },
        agents: { useModel: false },
        integrations: { freellmapi: false, opencode: false }
      },
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG || 'C.UTF-8', CI: 'true' }
    });
    runtime.events.on('*', (event) => {
      if (events.length < 400) events.push(summarizeEvent(event));
    });
    await store.saveTask(baseState);

    const result = await runtime.runTask({
      goal: task.goal,
      title: task.title,
      spec: Object.keys(task.spec).length ? task.spec : null,
      taskId: undefined,
      maxSteps: task.maxSteps,
      signal: controller.signal,
      onProgress: async ({ stepIndex, totalSteps, step }) => {
        finalState.progress = {
          step: stepIndex,
          total: totalSteps,
          label: `${step.title} (${step.ok ? 'ok' : step.denied ? 'denied' : 'failed'})`
        };
        finalState.steps = finalState.steps.concat([{
          id: step.id,
          title: step.title,
          tool: step.tool,
          ok: step.ok,
          denied: Boolean(step.denied),
          error: step.error ? truncate(step.error.message || step.error, 1000) : null,
          output: truncate(step.output, 4000)
        }]);
        await store.saveTask(finalState);
        if (await store.readCancelMarker(task.id)) controller.abort('cancelled by operator');
      }
    });

    const after = snapshotFiles(sandbox.root);
    finalState = {
      ...finalState,
      status: result.status,
      finishedAt: new Date().toISOString(),
      progress: { step: finalState.progress.step, total: finalState.progress.total, label: result.status },
      changedFiles: changedFiles(before, after),
      result: {
        summary: truncate(result.summary, 4000),
        success: result.success,
        durationMs: result.durationMs,
        checkpoints: result.checkpoints || [],
        conflicts: result.conflicts || [],
        reviews: result.reviews || []
      },
      verification: result.verification
        ? { ...result.verification, output: truncate(result.verification.output, 8000) }
        : null,
      error: result.error ? { message: truncate(result.error.message, 2000), stack: null } : null,
      internalTaskId: result.taskId
    };
  } catch (error) {
    finalState = {
      ...finalState,
      status: controller.signal.aborted ? 'cancelled' : 'failed',
      finishedAt: new Date().toISOString(),
      error: { message: truncate(error.message || error, 2000), stack: null },
      result: { summary: truncate(error.message || error, 2000), success: false, durationMs: 0 }
    };
  } finally {
    await store.saveTask(finalState);
    runtime?.shutdown?.();
    try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch {}
  }

  process.stdout.write(`${JSON.stringify({
    taskId: task.id,
    status: finalState.status,
    steps: finalState.steps.length,
    changedFiles: finalState.changedFiles.length,
    runId,
    mode: finalState.mode
  })}\n`);
  if (finalState.status === 'failed') process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
