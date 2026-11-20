import { STATE_BRANCH, QUEUE_BRANCH, STATE_PREFIX, REQUEST_PREFIX } from './validate.js';

export function createCloudStore({ github, stateBranch = STATE_BRANCH, queueBranch = QUEUE_BRANCH } = {}) {
  if (!github) throw new Error('github client is required');

  async function getTask(id) {
    if (!/^task-[a-z0-9-]{6,80}$/.test(String(id))) throw new Error(`Invalid task id: ${String(id).slice(0, 80)}`);
    return github.getJson(`${STATE_PREFIX}${id}.json`, stateBranch);
  }

  async function listTasks() {
    const index = await github.getJson(`${STATE_PREFIX}index.json`, stateBranch);
    return Array.isArray(index?.tasks) ? index.tasks : [];
  }

  async function saveTask(task) {
    const id = String(task?.id || '');
    if (!/^task-[a-z0-9-]{6,80}$/.test(id)) throw new Error(`Invalid task id: ${id}`);
    const record = { ...task, id, updatedAt: new Date().toISOString() };
    await github.putFile(`${STATE_PREFIX}${id}.json`, `${JSON.stringify(record, null, 2)}\n`, {
      branch: stateBranch,
      message: `ora: update ${id} (${record.status || 'unknown'})`
    });
    const tasks = await listTasks();
    const summary = {
      id,
      title: record.title || '',
      status: record.status || 'queued',
      goal: String(record.goal || '').slice(0, 200),
      createdAt: record.createdAt || record.updatedAt,
      updatedAt: record.updatedAt,
      finishedAt: record.finishedAt || null,
      mode: record.mode || 'offline-deterministic'
    };
    const next = [summary, ...tasks.filter((item) => item.id !== id)]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 100);
    await github.putFile(`${STATE_PREFIX}index.json`, `${JSON.stringify({ version: 1, tasks: next }, null, 2)}\n`, {
      branch: stateBranch,
      message: `ora: index ${id}`
    });
    return record;
  }

  async function listTaskIds() {
    const entries = await github.getJson('tasks', stateBranch);
    if (!Array.isArray(entries)) return [];
    return entries
      .filter((entry) => entry.type === 'file' && /^task-[a-z0-9-]{6,80}\.json$/.test(entry.name))
      .map((entry) => entry.name.replace(/\.json$/, ''));
  }

  async function readRequest(id, requestPath) {
    const path = requestPath || `${REQUEST_PREFIX}${id}.json`;
    if (!/^requests\/task-[a-z0-9-]{6,80}\.json$/.test(path)) throw new Error(`Invalid request path: ${path}`);
    const request = await github.getJson(path, queueBranch);
    if (!request) throw new Error(`Task request not found on ${queueBranch}: ${path}`);
    return { request, path };
  }

  async function readCancelMarker(id) {
    if (!/^task-[a-z0-9-]{6,80}$/.test(String(id))) return false;
    const marker = await github.getFile(`${REQUEST_PREFIX}${id}.cancel`, queueBranch);
    return marker.exists && /cancel/i.test(marker.content);
  }

  async function writeCancelMarker(id, cancelled = true) {
    if (cancelled) {
      await github.putFile(`${REQUEST_PREFIX}${id}.cancel`, 'cancel\n', {
        branch: queueBranch,
        message: `ora: cancel ${id}`
      });
    } else {
      await github.deleteFile(`${REQUEST_PREFIX}${id}.cancel`, {
        branch: queueBranch,
        message: `ora: clear cancel ${id}`
      });
    }
  }

  return { getTask, listTasks, listTaskIds, saveTask, readRequest, readCancelMarker, writeCancelMarker, stateBranch, queueBranch };
}
