import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { newId } from './errors.js';

export function createEventBus({ maxHistory = 2000, redact = (value) => value, logger = null } = {}) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);
  let history = [];
  let sequence = 0;

  function emit(type, data = {}, options = {}) {
    const { level = 'info', message = '' } = options || {};
    const event = {
      id: newId('evt'),
      sequence: ++sequence,
      ts: new Date().toISOString(),
      type: String(type),
      level,
      message,
      data: redact(data)
    };
    history.push(event);
    if (history.length > maxHistory) history = history.slice(history.length - maxHistory);
    emitter.emit('*', event);
    emitter.emit(event.type, event);
    if (logger) {
      try {
        logger(event);
      } catch {
        return event;
      }
    }
    return event;
  }

  return {
    emit,
    on: (type, handler) => {
      emitter.on(type, handler);
      return () => emitter.off(type, handler);
    },
    off: (type, handler) => emitter.off(type, handler),
    once: (type, handler) => emitter.once(type, handler),
    history({ type, limit = 100, since } = {}) {
      let items = history;
      if (type) items = items.filter((event) => event.type === type);
      if (since) items = items.filter((event) => event.ts >= since);
      return items.slice(-Math.max(0, Math.min(limit, maxHistory)));
    },
    clear() {
      history = [];
    },
    get size() {
      return history.length;
    },
    get sequence() {
      return sequence
    }
  };
}

export const eventId = () => randomUUID();
