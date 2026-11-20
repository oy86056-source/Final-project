import { newId } from './errors.js';

export function createContextManager({ state, events = null, maxMessages = 300 } = {}) {
  if (!state) throw new Error('state store is required');

  function sessions() {
    return state.load().sessions;
  }

  function requireSession(taskId) {
    const session = sessions()[String(taskId)];
    if (!session) throw new Error(`Context not found: ${taskId}`);
    return session;
  }

  return {
    create(taskId, system = '') {
      const session = {
        id: String(taskId),
        system: String(system || ''),
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      state.update((current) => {
        current.sessions[session.id] = session;
      });
      events?.emit('context:created', { taskId: session.id });
      return session;
    },

    ensure(taskId, system = '') {
      return sessions()[String(taskId)] || this.create(taskId, system);
    },

    add(taskId, role, content, meta = {}) {
      const session = this.ensure(taskId);
      const message = {
        id: newId('msg'),
        role: String(role || 'user'),
        content: String(content ?? ''),
        meta,
        ts: new Date().toISOString()
      };
      session.messages.push(message);
      if (session.messages.length > maxMessages) session.messages.splice(0, session.messages.length - maxMessages);
      session.updatedAt = message.ts;
      state.save();
      events?.emit('context:message', { taskId: session.id, role: message.role, size: message.content.length });
      return message;
    },

    get(taskId) {
      return requireSession(taskId);
    },

    messages(taskId, { limit = 50 } = {}) {
      return requireSession(taskId).messages.slice(-limit);
    },

    buildPrompt(taskId, { maxChars = 24000, includeSystem = true } = {}) {
      const session = requireSession(taskId);
      const parts = [];
      if (includeSystem && session.system) parts.push(session.system);
      for (const message of session.messages.slice().reverse()) {
        const block = `${message.role.toUpperCase()}: ${message.content}`;
        if (parts.reduce((sum, part) => sum + part.length, 0) + block.length > maxChars) break;
        parts.unshift(block);
      }
      return parts.join('\n\n');
    },

    clear(taskId) {
      const session = requireSession(taskId);
      session.messages = [];
      state.save();
      return session;
    }
  };
}
