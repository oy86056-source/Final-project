import { newId, TaskError } from './errors.js';

export function createTaskManager({ state, events = null } = {}) {
  if (!state) throw new Error('state store is required');
  const emit = (type, data) => events?.emit(type, data);

  function requireTask(id) {
    const task = state.load().tasks[String(id)];
    if (!task) throw new TaskError(`Task not found: ${id}`);
    return task;
  }

  function mutate(id, mutator) {
    const task = requireTask(id);
    const result = mutator(task);
    task.updatedAt = new Date().toISOString();
    state.save();
    return result === undefined ? task : result;
  }

  return {
    create({ title = '', goal = '', root = process.cwd(), input = {}, createdBy = 'cli', metadata = {} } = {}) {
      if (!goal && !title) throw new TaskError('A title or goal is required');
      const id = newId('task');
      const task = {
        id,
        title: title || String(goal).slice(0, 80),
        goal,
        root,
        input,
        metadata,
        createdBy,
        status: 'created',
        steps: [],
        artifacts: [],
        checkpoints: [],
        conflicts: [],
        result: null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null
      };
      state.update((current) => {
        current.tasks[id] = task;
      });
      emit('task:created', { taskId: id, title: task.title });
      return task;
    },

    get(id) {
      return requireTask(id);
    },

    find(id) {
      return state.load().tasks[String(id)] || null;
    },

    list({ status, limit = 100 } = {}) {
      let tasks = Object.values(state.load().tasks);
      if (status) tasks = tasks.filter((task) => task.status === status);
      return tasks
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, limit)
        .map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          goal: String(task.goal).slice(0, 200),
          steps: task.steps.length,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt
        }));
    },

    update(id, patch) {
      return mutate(id, (task) => {
        for (const [key, value] of Object.entries(patch || {})) {
          if (['id', 'createdAt', 'steps', 'artifacts'].includes(key)) continue;
          task[key] = value;
        }
      });
    },

    transition(id, status, extra = {}) {
      return mutate(id, (task) => {
        task.status = status;
        if (status === 'running' && !task.startedAt) task.startedAt = new Date().toISOString();
        if (['completed', 'failed', 'cancelled'].includes(status)) task.finishedAt = new Date().toISOString();
        Object.assign(task, extra);
        emit('task:status', { taskId: id, status });
      });
    },

    start(id) {
      return this.transition(id, 'running');
    },

    complete(id, result = null) {
      return this.transition(id, 'completed', { result, error: null });
    },

    fail(id, error) {
      return this.transition(id, 'failed', {
        error: typeof error === 'string' ? error : error?.message || String(error),
        finishedAt: new Date().toISOString()
      });
    },

    cancel(id) {
      return this.transition(id, 'cancelled');
    },

    addStep(id, { title, tool = null, args = {}, role = null, status = 'pending' } = {}) {
      const step = {
        id: newId('step'),
        title: title || tool || 'step',
        tool,
        args,
        role,
        status,
        result: null,
        error: null,
        startedAt: null,
        completedAt: null
      };
      mutate(id, (task) => task.steps.push(step));
      emit('task:step:added', { taskId: id, stepId: step.id, title: step.title });
      return step;
    },

    startStep(id, stepId) {
      return mutate(id, (task) => {
        const step = task.steps.find((item) => item.id === stepId);
        if (!step) throw new TaskError(`Step not found: ${stepId}`);
        step.status = 'running';
        step.startedAt = new Date().toISOString();
        return step;
      });
    },

    completeStep(id, stepId, result) {
      return mutate(id, (task) => {
        const step = task.steps.find((item) => item.id === stepId);
        if (!step) throw new TaskError(`Step not found: ${stepId}`);
        step.status = 'completed';
        step.result = result;
        step.completedAt = new Date().toISOString();
        emit('task:step:completed', { taskId: id, stepId });
        return step;
      });
    },

    failStep(id, stepId, error) {
      return mutate(id, (task) => {
        const step = task.steps.find((item) => item.id === stepId);
        if (!step) throw new TaskError(`Step not found: ${stepId}`);
        step.status = 'failed';
        step.error = typeof error === 'string' ? error : error?.message || String(error);
        step.completedAt = new Date().toISOString();
        emit('task:step:failed', { taskId: id, stepId, error: step.error });
        return step;
      });
    },

    addArtifact(id, artifact) {
      return mutate(id, (task) => {
        task.artifacts.push({ ...artifact, at: new Date().toISOString() });
      });
    },

    addCheckpoint(id, checkpoint) {
      return mutate(id, (task) => task.checkpoints.push(checkpoint));
    },

    addConflict(id, conflict) {
      return mutate(id, (task) => task.conflicts.push({ ...conflict, at: new Date().toISOString() }));
    },

    snapshot(id) {
      return JSON.parse(JSON.stringify(requireTask(id)));
    }
  };
}
