import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactObject } from '../security/redaction.js';
import { newId } from './errors.js';

const VERSION = 1;
const MAX_CHECKPOINTS = 20;
const MAX_EVENT_LOG_BYTES = 2 * 1024 * 1024;

function emptyState() {
  return {
    version: VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    counters: {},
    tasks: {},
    sessions: {},
    approvals: {}
  };
}

function atomicWrite(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

export function createStateStore({ dir, events = null, redact = true } = {}) {
  if (!dir) throw new Error('state dir is required');
  const stateDir = resolve(dir);
  const checkpointsDir = join(stateDir, 'checkpoints');
  const statePath = join(stateDir, 'state.json');
  const eventsPath = join(stateDir, 'events.jsonl');
  mkdirSync(checkpointsDir, { recursive: true });
  let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : emptyState();
  if (state.version !== VERSION) state = { ...emptyState(), ...state, version: VERSION };

  function save() {
    state.updatedAt = new Date().toISOString();
    atomicWrite(statePath, state);
    return state;
  }

  return {
    dir: stateDir,
    statePath,
    eventsPath,

    load() {
      return state;
    },

    save,

    update(mutator) {
      const result = mutator(state);
      save();
      return result === undefined ? state : result;
    },

    get(key, fallback = null) {
      return state[key] === undefined ? fallback : state[key];
    },

    set(key, value) {
      state[key] = value;
      save();
      return value;
    },

    async appendEvent(event) {
      const value = redact ? redactObject(event) : event;
      try {
        if (existsSync(eventsPath) && statSync(eventsPath).size > MAX_EVENT_LOG_BYTES) {
          renameSync(eventsPath, join(stateDir, 'events.1.jsonl'));
        }
      } catch {}
      appendFileSync(eventsPath, `${JSON.stringify(value)}\n`, 'utf8');
    },

    readEvents({ limit = 200 } = {}) {
      if (!existsSync(eventsPath)) return [];
      const lines = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-limit).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { type: 'corrupt', raw: '[unreadable]' };
        }
      });
    },

    checkpoint(name, data = null) {
      const id = newId('ckpt');
      const record = {
        id,
        name: String(name || 'checkpoint'),
        ts: new Date().toISOString(),
        state: data === null ? JSON.parse(JSON.stringify(state)) : data
      };
      atomicWrite(join(checkpointsDir, `${id}.json`), record);
      const files = readdirSync(checkpointsDir).filter((name) => name.endsWith('.json')).sort();
      for (const file of files.slice(0, Math.max(0, files.length - MAX_CHECKPOINTS))) {
        try { unlinkSync(join(checkpointsDir, file)); } catch {}
      }
      return { id, name: record.name, ts: record.ts };
    },

    listCheckpoints() {
      if (!existsSync(checkpointsDir)) return [];
      return readdirSync(checkpointsDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => {
          try {
            const record = JSON.parse(readFileSync(join(checkpointsDir, name), 'utf8'));
            return { id: record.id, name: record.name, ts: record.ts };
          } catch {
            return { id: name, name: 'unreadable', ts: null };
          }
        });
    },

    restore(id) {
      if (!/^ckpt-[a-z0-9-]+$/.test(String(id))) throw new Error(`Invalid checkpoint id: ${String(id).slice(0, 60)}`);
      const path = join(checkpointsDir, `${id}.json`);
      if (!existsSync(path)) throw new Error(`Checkpoint not found: ${id}`);
      const record = JSON.parse(readFileSync(path, 'utf8'));
      state = { ...record.state, version: VERSION };
      save();
      return state;
    },

    removeCheckpoint(id) {
      const path = join(checkpointsDir, `${String(id)}.json`);
      if (!existsSync(path)) return false;
      unlinkSync(path);
      return true;
    },

    reset() {
      state = emptyState();
      save();
      return state;
    }
  };
}
