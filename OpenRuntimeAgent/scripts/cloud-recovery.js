import { createGitHubClient } from '../cloud/github.js';
import { createCloudStore } from '../cloud/store.js';
import { REQUEST_PREFIX } from '../cloud/validate.js';

const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required');
  const github = createGitHubClient({ token });
  const store = createCloudStore({ github });
  const summaries = await store.listTasks();
  const results = { scanned: summaries.length, recovered: [], skipped: [], failed: [] };

  for (const summary of summaries) {
    if (!['running', 'queued'].includes(summary.status)) continue;
    const task = await store.getTask(summary.id);
    if (!task) continue;
    const attempts = Number(task.attempts || 0);
    const runId = task.worker?.runId;
    if (runId) {
      try {
        const run = await github.getRun(runId);
        if (ACTIVE.has(run.status)) {
          results.skipped.push({ id: task.id, reason: 'worker-active', runId });
          continue;
        }
      } catch (error) {
        results.failed.push({ id: task.id, reason: `run-check-failed: ${error.message.slice(0, 120)}` });
        continue;
      }
    }
    if (attempts >= 3) {
      await store.saveTask({
        ...task,
        status: 'interrupted',
        error: { message: 'Worker interrupted and automatic retry limit reached' },
        finishedAt: new Date().toISOString()
      });
      results.skipped.push({ id: task.id, reason: 'retry-limit' });
      continue;
    }
    if (await store.readCancelMarker(task.id)) {
      await store.saveTask({ ...task, status: 'cancelled', finishedAt: new Date().toISOString() });
      results.recovered.push({ id: task.id, action: 'cancelled' });
      continue;
    }
    const requestPath = task.requestPath || `${REQUEST_PREFIX}${task.id}.json`;
    const requestFile = await github.getFile(requestPath, store.queueBranch);
    if (!requestFile.exists) {
      await store.saveTask({
        ...task,
        status: 'interrupted',
        error: { message: 'Worker interrupted and task request is no longer available' },
        finishedAt: new Date().toISOString()
      });
      results.skipped.push({ id: task.id, reason: 'request-missing' });
      continue;
    }
    await store.saveTask({
      ...task,
      status: 'queued',
      attempts: attempts + 1,
      progress: { step: 0, total: 0, label: 'recovered — waiting for worker' },
      error: null,
      events: (task.events || []).concat([{
        ts: new Date().toISOString(),
        type: 'task:recovered',
        message: `Requeued after worker interruption (attempt ${attempts + 1})`
      }])
    });
    await github.dispatch('ora-task', {
      task_id: task.id,
      request_path: requestPath
    }, 'main');
    results.recovered.push({ id: task.id, action: 'requeued', attempt: attempts + 1 });
  }

  process.stdout.write(`${JSON.stringify(results)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
