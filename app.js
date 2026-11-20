(() => {
  'use strict';

  const REPO = 'oy86056-source/Final-project';
  const API = 'https://api.github.com';
  const STATE_BRANCH = 'ora-state';
  const QUEUE_BRANCH = 'ora-queue';
  const ALLOWED_COMMANDS = new Set([
    'node --version', 'npm --version', 'node --test', 'npm test', 'npm run check',
    'npm run build', 'npm run lint', 'git status --short',
    'git diff --no-ext-diff --unified=3', 'pwd', 'ls -la'
  ]);
  const ALLOWED_COMMAND_RE = /^node --check [A-Za-z0-9_./-]{1,160}$/;
  const TOKEN_KEY = 'ora-cloud-token';

  const state = {
    token: sessionStorage.getItem(TOKEN_KEY) || '',
    tasks: [],
    local: {},
    current: null,
    currentData: null,
    filter: 'all',
    connected: false,
    polling: null
  };

  const el = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const short = (value, max = 110) => {
    const text = String(value ?? '');
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };
  const time = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  };
  const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

  function toBase64(text) {
    const bytes = new TextEncoder().encode(String(text));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function fromBase64(value) {
    const binary = atob(String(value || '').replace(/\s/g, ''));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  async function api(path, options = {}) {
    const { method = 'GET', body = null } = options;
    const response = await fetch(`${API}/repos/${REPO}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${state.token}`,
        'x-github-api-version': '2022-11-28',
        ...(body === null ? {} : { 'content-type': 'application/json' })
      },
      body: body === null ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) {
      const error = new Error(data?.message || `GitHub request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function getContent(path, ref) {
    try {
      const data = await api(`/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
      return { content: fromBase64(data.content), sha: data.sha };
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async function putContent(path, content, branch, message) {
    const existing = await getContent(path, branch);
    const body = { message, content: toBase64(content), branch };
    if (existing?.sha) body.sha = existing.sha;
    return api(`/contents/${encodePath(path)}`, { method: 'PUT', body });
  }

  function newTaskId() {
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    return `task-${suffix.replace(/[^a-z0-9-]/g, '')}`;
  }

  function setError(id, message) {
    el(id).textContent = message ? String(message) : '';
  }

  function setConnected(connected, message = '') {
    state.connected = connected;
    el('connectionDot').classList.toggle('online', connected);
    el('connectionDot').title = connected ? 'connected to GitHub' : 'disconnected';
    el('submitCard').hidden = !connected;
    el('historyCard').hidden = !connected;
    if (connected) el('detailCard').hidden = false;
    setError('authError', message);
    if (connected) {
      el('authCard').querySelector('.card-head h2').textContent = 'Connected';
      refreshAll();
      startPolling();
    }
  }

  async function connect() {
    const token = el('tokenInput').value.trim();
    if (!token) return setError('authError', 'Enter a fine-grained GitHub token.');
    try {
      state.token = token;
      sessionStorage.setItem(TOKEN_KEY, token);
      await api('/user');
      await loadTasks();
      setConnected(true);
    } catch (error) {
      state.token = '';
      sessionStorage.removeItem(TOKEN_KEY);
      setConnected(false, `Connection failed: ${error.message}`);
    }
  }

  function disconnect() {
    state.token = '';
    sessionStorage.removeItem(TOKEN_KEY);
    stopPolling();
    state.tasks = [];
    state.local = {};
    el('detailCard').hidden = true;
    setConnected(false);
  }

  function validateSpec(text) {
    if (!text.trim()) return {};
    let spec;
    try { spec = JSON.parse(text); } catch (error) { throw new Error(`Spec JSON is invalid: ${error.message}`); }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('Spec must be a JSON object.');
    if (spec.files !== undefined) {
      if (!Array.isArray(spec.files) || spec.files.length > 20) throw new Error('spec.files must contain at most 20 entries.');
      for (const file of spec.files) {
        const path = String(file?.path || '');
        if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,160}$/.test(path) || path.includes('..') || path.startsWith('/')) {
          throw new Error(`Unsafe file path: ${path.slice(0, 80)}`);
        }
        const size = String(file.content ?? file.patch ?? '').length;
        if (size > 20000) throw new Error(`File ${path} exceeds 20000 characters.`);
      }
    }
    const commandOf = (entry) => String(typeof entry === 'string' ? entry : entry?.command || '').trim();
    const allowed = (command) => ALLOWED_COMMANDS.has(command) || ALLOWED_COMMAND_RE.test(command);
    if (spec.commands !== undefined) {
      if (!Array.isArray(spec.commands) || spec.commands.length > 5) throw new Error('spec.commands must contain at most 5 entries.');
      for (const command of spec.commands.map(commandOf)) if (!allowed(command)) throw new Error(`Command not allowed: ${command.slice(0, 80)}`);
    }
    if (spec.verification !== undefined && !allowed(commandOf(spec.verification))) {
      throw new Error(`Verification command not allowed: ${commandOf(spec.verification).slice(0, 80)}`);
    }
    return spec;
  }

  async function submitTask() {
    setError('submitError', '');
    el('submitStatus').textContent = 'Submitting…';
    el('submitBtn').disabled = true;
    try {
      const goal = el('goalInput').value.trim();
      if (goal.length < 3) throw new Error('Enter a goal of at least 3 characters.');
      const spec = validateSpec(el('specInput').value);
      const id = newTaskId();
      const request = {
        id,
        title: goal.slice(0, 80),
        goal,
        spec,
        requestedBy: 'mobile-dashboard',
        createdAt: new Date().toISOString()
      };
      await putContent(`requests/${id}.json`, `${JSON.stringify(request, null, 2)}\n`, QUEUE_BRANCH, `ora: submit ${id}`);
      await api('/dispatches', {
        method: 'POST',
        body: {
          event_type: 'ora-task',
          ref: 'main',
          client_payload: { task_id: id, request_path: `requests/${id}.json` }
        }
      });
      state.local[id] = {
        id, title: request.title, goal, status: 'queued', createdAt: request.createdAt,
        mode: 'offline-deterministic', progress: { step: 0, total: 0, label: 'queued — waiting for worker' }
      };
      el('goalInput').value = '';
      el('submitStatus').textContent = `Submitted ${id}`;
      await loadTasks();
      showTask(id);
    } catch (error) {
      setError('submitError', error.message);
      el('submitStatus').textContent = '';
    } finally {
      el('submitBtn').disabled = false;
    }
  }

  async function loadTasks() {
    const content = await getContent('tasks/index.json', STATE_BRANCH);
    const index = content ? JSON.parse(content.content) : { tasks: [] };
    const remote = Array.isArray(index.tasks) ? index.tasks : [];
    const merged = [...remote];
    for (const [id, local] of Object.entries(state.local)) {
      if (!merged.some((task) => task.id === id)) merged.push(local);
      else Object.assign(merged.find((task) => task.id === id), local, merged.find((task) => task.id === id));
    }
    state.tasks = merged.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 100);
    renderList();
  }

  function renderList() {
    const list = el('taskList');
    const tasks = state.tasks.filter((task) => state.filter === 'all' || task.status === state.filter);
    if (!tasks.length) {
      list.innerHTML = '<p class="muted">No tasks yet. Submit one above.</p>';
      return;
    }
    list.innerHTML = tasks.map((task) => `
      <button class="task-item ${state.current === task.id ? 'selected' : ''}" data-task="${esc(task.id)}">
        <div class="task-top"><span class="task-goal">${esc(short(task.goal || task.title, 90))}</span><span class="pill ${esc(task.status)}">${esc(task.status)}</span></div>
        <div class="task-top"><span class="task-id">${esc(task.id)}</span><span class="muted">${esc(time(task.createdAt))}</span></div>
      </button>`).join('');
    list.querySelectorAll('[data-task]').forEach((button) => {
      button.addEventListener('click', () => showTask(button.dataset.task));
    });
  }

  async function showTask(id) {
    state.current = id;
    state.currentData = null;
    el('detailCard').hidden = false;
    el('detailTitle').textContent = `Task ${id}`;
    setError('detailError', '');
    renderList();
    await pollTask(true);
  }

  async function pollTask(force = false) {
    if (!state.current || !state.connected) return;
    try {
      const content = await getContent(`tasks/${state.current}.json`, STATE_BRANCH);
      if (!content) {
        el('progressText').textContent = state.local[state.current]?.progress?.label || 'waiting for worker…';
        return;
      }
      const task = JSON.parse(content.content);
      if (!force && state.currentData && JSON.stringify(state.currentData) === JSON.stringify(task)) return;
      state.currentData = task;
      if (task.status && !['running', 'queued'].includes(task.status)) delete state.local[task.id];
      renderDetail(task);
      await loadTasks();
    } catch (error) {
      setError('detailError', error.message);
    }
  }

  function renderDetail(task) {
    el('detailTitle').textContent = task.title || task.goal || task.id;
    const progress = task.progress || {};
    const total = Number(progress.total) || 0;
    const step = Number(progress.step) || 0;
    el('progressBar').style.width = total ? `${Math.min(100, Math.round((step / total) * 100))}%` : '0%';
    el('progressText').textContent = progress.label || `${step}/${total}`;
    el('detailMeta').innerHTML = [
      ['Status', task.status], ['Mode', task.mode || 'offline-deterministic'],
      ['Started', time(task.startedAt)], ['Finished', time(task.finishedAt)],
      ['Worker', task.worker?.provider || '—'], ['Run', task.worker?.runId || '—']
    ].map(([label, value]) => `<div class="meta"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('');
    el('cancelBtn').disabled = !['running', 'queued'].includes(task.status);

    el('stepsView').innerHTML = (task.steps || []).length
      ? task.steps.map((item) => `<div class="step ${item.ok ? 'ok' : 'fail'}"><div class="step-title"><span>${esc(short(item.title, 100))}</span><span class="pill ${item.ok ? 'completed' : 'failed'}">${item.ok ? 'pass' : item.denied ? 'denied' : 'fail'}</span></div>${item.error ? `<div class="muted">${esc(short(item.error, 240))}</div>` : ''}${item.output ? `<pre class="output">${esc(short(item.output, 1200))}</pre>` : ''}</div>`).join('')
      : '<p class="muted">No steps recorded yet.</p>';

    el('eventsView').textContent = (task.events || []).slice(-120).map((event) => `${event.ts || ''}  ${event.type || ''}${event.tool ? `  ${event.tool}` : ''}${event.message ? `  ${event.message}` : ''}`).join('\n') || 'No events yet.';

    el('filesView').innerHTML = (task.changedFiles || []).length
      ? task.changedFiles.map((file) => `<div class="file"><strong>${esc(file.path)}</strong> <span class="pill">${esc(file.action)}</span><pre class="output">${esc(short(file.after || file.before || '', 1500))}</pre></div>`).join('')
      : '<p class="muted">No files changed.</p>';

    el('verificationView').textContent = task.verification
      ? `${task.verification.command}\nexit: ${task.verification.exitCode}\n${task.verification.ok ? 'PASS' : 'FAIL'}\n\n${task.verification.output || ''}`
      : 'No verification step recorded.';

    el('resultView').textContent = [
      `status: ${task.status || '—'}`,
      `summary: ${task.result?.summary || '—'}`,
      task.error?.message ? `error: ${task.error.message}` : '',
      `duration: ${task.result?.durationMs ?? '—'} ms`,
      task.internalTaskId ? `ora task: ${task.internalTaskId}` : ''
    ].filter(Boolean).join('\n');
  }

  async function cancelTask() {
    if (!state.current || !state.currentData) return;
    const id = state.current;
    el('cancelBtn').disabled = true;
    try {
      await putContent(`requests/${id}.cancel`, 'cancel\n', QUEUE_BRANCH, `ora: cancel ${id}`);
      const runId = state.currentData.worker?.runId;
      if (runId) {
        try { await api(`/actions/runs/${encodeURIComponent(String(runId))}/cancel`, { method: 'POST' }); } catch {}
      }
      state.local[id] = { ...(state.local[id] || {}), id, status: 'cancelled', createdAt: state.currentData.createdAt };
      state.currentData = { ...state.currentData, status: 'cancelled' };
      renderDetail(state.currentData);
      await loadTasks();
    } catch (error) {
      setError('detailError', `Cancellation failed: ${error.message}`);
      el('cancelBtn').disabled = false;
    }
  }

  function startPolling() {
    stopPolling();
    state.polling = setInterval(async () => {
      if (document.hidden) return;
      try { await loadTasks(); await pollTask(); } catch {}
    }, 6000);
  }

  function stopPolling() {
    if (state.polling) clearInterval(state.polling);
    state.polling = null;
  }

  function refreshAll() {
    loadTasks().then(() => state.current && pollTask()).catch((error) => setError('detailError', error.message));
  }

  el('connectBtn').addEventListener('click', connect);
  el('tokenInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') connect(); });
  el('submitBtn').addEventListener('click', submitTask);
  el('refreshBtn').addEventListener('click', () => refreshAll());
  el('reloadBtn').addEventListener('click', () => refreshAll());
  el('cancelBtn').addEventListener('click', cancelTask);
  el('closeDetail').addEventListener('click', () => { el('detailCard').hidden = true; state.current = null; });
  document.querySelectorAll('.filter').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.filter').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      state.filter = button.dataset.filter;
      renderList();
    });
  });

  if (state.token) {
    api('/user').then(() => { setConnected(true); }).catch(() => disconnect());
  }
})();
