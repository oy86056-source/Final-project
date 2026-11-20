import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);

export function createDashboardHandler({ runtime }) {
  return async (request, response) => {
    const path = new URL(request.url || '/', 'http://localhost').pathname;
    const send = (status, body, type = 'application/json') => {
      response.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://api.github.com; img-src 'self' data:; object-src 'none'; base-uri 'self'",
        'x-content-type-options': 'nosniff'
      });
      response.end(body);
    };
    try {
      if (STATIC_FILES.has(path)) {
        const [name, type] = STATIC_FILES.get(path);
        return send(200, readFileSync(join(UI_DIR, name), 'utf8'), type);
      }
      if (path === '/api/status') return send(200, JSON.stringify(await runtime.status()));
      if (path === '/api/tasks') return send(200, JSON.stringify(runtime.tasks.list({ limit: 200 })));
      if (path === '/api/events') return send(200, JSON.stringify(runtime.events.history({ limit: 200 })));
      if (path === '/api/approvals') return send(200, JSON.stringify(runtime.approvalGate.pending()));
      return send(404, JSON.stringify({ error: 'not found' }));
    } catch {
      return send(500, JSON.stringify({ error: 'internal error' }));
    }
  };
}

export async function startDashboard({ runtime, port = 4173, hostname = '127.0.0.1' } = {}) {
  const server = createServer(createDashboardHandler({ runtime }));
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, resolvePromise);
  });
  const address = server.address();
  return {
    server,
    url: `http://${hostname}:${address.port}/`,
    async close() {
      await new Promise((resolvePromise) => server.close(resolvePromise));
    }
  };
}
