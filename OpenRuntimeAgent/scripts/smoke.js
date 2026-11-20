import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PROJECT_ROOT, createRuntime, redact } from '../index.js';

const ADD_SOURCE = `export function add(a, b) {\n  return a + b;\n}\n`;
const ADD_TEST = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.js';\n\ntest('adds numbers', () => {\n  assert.equal(add(2, 3), 5);\n});\n`;
const MULTIPLY_SOURCE = `export function multiply(a, b) {\n  let result = 0;\n  for (let i = 0; i < b; i += 1) result += a;\n  return result;\n}\n`;
const MULTIPLY_TEST = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { multiply } from '../src/multiply.js';\n\ntest('multiplies numbers', () => {\n  assert.equal(multiply(3, 4), 12);\n});\n`;

export async function runSmoke({ cwd = PROJECT_ROOT, json = false } = {}) {
  const base = resolve(cwd, '.ora-state-smoke');
  const fixture = join(base, 'fixture');
  const stateDir = join(base, 'state');
  mkdirSync(join(fixture, 'src'), { recursive: true });
  mkdirSync(join(fixture, 'tests'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(fixture, 'package.json'), `${JSON.stringify({ name: 'ora-smoke-fixture', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`);
  writeFileSync(join(fixture, 'README.md'), '# Smoke fixture\n\nA generated project used by OpenRuntimeAgent end-to-end verification.\n');
  writeFileSync(join(fixture, 'src', 'add.js'), ADD_SOURCE);
  writeFileSync(join(fixture, 'tests', 'add.test.js'), ADD_TEST);
  const spec = {
    files: [
      { path: 'src/multiply.js', content: MULTIPLY_SOURCE, reason: 'implement requested multiplication utility' },
      { path: 'tests/multiply.test.js', content: MULTIPLY_TEST, reason: 'add regression test' }
    ],
    verification: { command: 'node --test', reason: 'run fixture test suite' }
  };

  const runtime = createRuntime({
    cwd,
    root: fixture,
    config: {
      runtime: { stateDir, checkpointEvery: 1 },
      security: { approvalMode: 'auto' }
    }
  });
  const scan = await runtime.repo.scan();
  const task = await runtime.runTask({
    goal: 'implement multiply utility and verify with tests',
    title: 'end-to-end smoke',
    spec
  });

  const checks = [];
  const check = (name, passed, detail = '') => checks.push({ name, passed: passed === true, detail });
  check('repository scan discovered fixture files', scan.files.length >= 4, `files=${scan.files.length}`);
  check('task completed without failed steps', task.success && task.status === 'completed', task.summary);
  check('generated source file exists', existsSync(join(fixture, 'src', 'multiply.js')));
  check('generated test file exists', existsSync(join(fixture, 'tests', 'multiply.test.js')));
  check('generated code is correct', readFileSync(join(fixture, 'src', 'multiply.js'), 'utf8').includes('multiply'));
  check('verification step ran', task.verification !== null && task.verification.command === 'node --test');
  check('verification passed', task.verification?.ok === true);
  check('checkpoints persisted', task.checkpoints.length > 0, `count=${task.checkpoints.length}`);
  check('state file persisted', existsSync(join(stateDir, 'state.json')));
  check('structured events recorded', runtime.events.history().some((event) => event.type === 'tool:end'));
  const secret = `sk-${'a'.repeat(32)}`;
  check('redaction removes secret material', !redact(`token=${secret}`).includes(secret));

  const report = {
    ok: checks.every((item) => item.passed),
    fixture,
    taskId: task.taskId,
    summary: task.summary,
    steps: task.steps.map((step) => ({ tool: step.tool, ok: step.ok, title: step.title })),
    verification: task.verification,
    checks
  };
  if (json) return report;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('smoke.js');
if (invokedDirectly) {
  const result = await runSmoke({ json: true });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
