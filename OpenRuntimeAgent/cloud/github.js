const DEFAULT_API = 'https://api.github.com';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createGitHubClient({
  token,
  repository = process.env.GITHUB_REPOSITORY || '',
  apiUrl = process.env.GITHUB_API_URL || DEFAULT_API,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!token) throw new Error('GITHUB_TOKEN is required');
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error(`Invalid GITHUB_REPOSITORY: ${repository}`);
  const [owner, repo] = repository.split('/');
  const base = `${apiUrl.replace(/\/$/, '')}/repos/${owner}/${repo}`;

  async function request(path, options = {}) {
    const {
      method = 'GET',
      body = null,
      headers = {},
      retries = 3,
      accept = 'application/vnd.github+json'
    } = options;
    const url = path.startsWith('http') ? path : `${base}${path.startsWith('/') ? path : `/${path}`}`;
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            accept,
            authorization: `Bearer ${token}`,
            'x-github-api-version': '2022-11-28',
            ...(body === null ? {} : { 'content-type': 'application/json' }),
            ...headers
          },
          body: body === null ? undefined : JSON.stringify(body)
        });
      } catch (error) {
        lastError = error;
        if (attempt === retries) break;
        await sleep(250 * 2 ** attempt);
        continue;
      }
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
      if (response.ok) return { ok: true, status: response.status, data: payload, headers: response.headers };
      const retryable = response.status === 409 || response.status === 422 || response.status >= 500;
      lastError = new Error(`GitHub ${method} ${path} failed (${response.status}): ${typeof payload === 'string' ? payload.slice(0, 300) : JSON.stringify(payload)?.slice(0, 300)}`);
      lastError.status = response.status;
      if (!retryable || attempt === retries) throw lastError;
      await sleep(300 * 2 ** attempt);
    }
    throw lastError;
  }

  async function getRef(branch) {
    try {
      const result = await request(`/git/ref/heads/${encodeURIComponent(branch)}`);
      return result.data.object.sha;
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  function decodeContent(data) {
    if (!data || typeof data.content !== 'string') return '';
    const clean = data.content.replace(/\s/g, '');
    if (data.encoding === 'base64') return Buffer.from(clean, 'base64').toString('utf8');
    return data.content;
  }

  async function getFile(path, ref) {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    try {
      const result = await request(`/contents/${path.split('/').map(encodeURIComponent).join('/')}${query}`);
      return { path, sha: result.data.sha, content: decodeContent(result.data), exists: true };
    } catch (error) {
      if (error.status === 404) return { path, sha: null, content: '', exists: false };
      throw error;
    }
  }

  async function listDirectory(path, ref) {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    try {
      const result = await request(`/contents/${path.split('/').map(encodeURIComponent).join('/')}${query}`);
      return Array.isArray(result.data) ? result.data : [];
    } catch (error) {
      if (error.status === 404) return [];
      throw error;
    }
  }

  async function getJson(path, ref) {
    const file = await getFile(path, ref);
    if (!file.exists) return null;
    try { return JSON.parse(file.content); } catch { return null; }
  }

  async function putFile(path, content, { branch = 'main', message = 'update', retries = 3 } = {}) {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    let sha = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const existing = await getFile(path, branch);
      sha = existing.exists ? existing.sha : null;
      try {
        const result = await request(`/contents/${encodedPath}`, {
          method: 'PUT',
          body: {
            message,
            content: Buffer.from(String(content), 'utf8').toString('base64'),
            branch,
            ...(sha ? { sha } : {})
          },
          retries: 0
        });
        return result.data;
      } catch (error) {
        if (attempt === retries) throw error;
        await sleep(400 * 2 ** attempt);
      }
    }
    return null;
  }

  async function deleteFile(path, { branch = 'main', message = 'delete' } = {}) {
    const existing = await getFile(path, branch);
    if (!existing.exists) return false;
    const result = await request(`/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'DELETE',
      body: { message, branch, sha: existing.sha }
    });
    return Boolean(result.data);
  }

  async function ensureBranch(branch, fromBranch = 'main') {
    const existing = await getRef(branch);
    if (existing) return { created: false, sha: existing };
    const source = await getRef(fromBranch);
    if (!source) throw new Error(`Source branch not found: ${fromBranch}`);
    const result = await request('/git/refs', {
      method: 'POST',
      body: { ref: `refs/heads/${branch}`, sha: source }
    });
    return { created: true, sha: result.data.object.sha };
  }

  async function createOrphanBranch(branch, files = {}, message = 'initialize branch') {
    const existing = await getRef(branch);
    if (existing) return { created: false, sha: existing };
    const tree = await request('/git/trees', {
      method: 'POST',
      body: {
        base_tree: null,
        tree: Object.entries(files).map(([path, content]) => ({
          path,
          type: 'blob',
          mode: '100644',
          content: String(content)
        }))
      }
    });
    const commit = await request('/git/commits', {
      method: 'POST',
      body: { message, tree: tree.data.sha, parents: [] }
    });
    const ref = await request('/git/refs', {
      method: 'POST',
      body: { ref: `refs/heads/${branch}`, sha: commit.data.sha }
    });
    return { created: true, sha: ref.data.object.sha };
  }

  async function dispatch(eventType, clientPayload = {}) {
    const result = await request('/dispatches', {
      method: 'POST',
      body: { event_type: eventType, client_payload: clientPayload }
    });
    return result.ok;
  }

  async function dispatchWorkflow(workflow, ref, inputs = {}) {
    const result = await request(`/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
      method: 'POST',
      body: { ref, inputs }
    });
    return result.ok;
  }

  async function listRuns({ workflow, status = 'all', perPage = 100 } = {}) {
    const path = workflow
      ? `/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=${perPage}`
      : `/actions/runs?per_page=${perPage}`;
    const result = await request(path);
    const runs = result.data.workflow_runs || [];
    return status === 'all' ? runs : runs.filter((run) => run.status === status);
  }

  async function getRun(runId) {
    const result = await request(`/actions/runs/${encodeURIComponent(String(runId))}`);
    return result.data;
  }

  async function cancelRun(runId) {
    const result = await request(`/actions/runs/${encodeURIComponent(String(runId))}/cancel`, { method: 'POST' });
    return result.ok;
  }

  async function enablePages(branch = 'gh-pages') {
    const result = await request('/pages', {
      method: 'PUT',
      body: { build_type: 'legacy', source: { branch, path: '/' } }
    });
    return result.data;
  }

  async function getPages() {
    try {
      const result = await request('/pages');
      return result.data;
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  return {
    owner,
    repo,
    repository,
    base,
    request,
    getRef,
    getFile,
    getJson,
    listDirectory,
    putFile,
    deleteFile,
    ensureBranch,
    createOrphanBranch,
    dispatch,
    dispatchWorkflow,
    listRuns,
    getRun,
    cancelRun,
    enablePages,
    getPages
  };
}
