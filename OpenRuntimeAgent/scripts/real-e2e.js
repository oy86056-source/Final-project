import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRuntime, redact, PROJECT_ROOT } from '../index.js';

const BUGGY_SOURCE = `export function add(a, b) {\n  return a - b;\n}\n`;
const TEST_SOURCE = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/calculator.js';\n\ntest('add returns the sum of its arguments', () => {\n  assert.equal(add(2, 3), 5);\n  assert.equal(add(-1, 1), 0);\n});\n`;

export async function runRealE2E({ cwd = PROJECT_ROOT, json = false } = {}) {
  const base = resolve(cwd, '.ora-state-e2e');
  const fixture = join(base, 'fixture');
  const stateDir = join(base, 'state');
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(join(fixture, 'src'), { recursive: true });
  mkdirSync(join(fixture, 'tests'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(fixture, 'package.json'), `${JSON.stringify({ name: 'ora-real-e2e-fixture', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`);
  writeFileSync(join(fixture, 'README.md'), '# Real E2E fixture\n\nDisposable project used to verify OpenRuntimeAgent repairs a real bug.\n');
  writeFileSync(join(fixture, 'src', 'calculator.js'), BUGGY_SOURCE);
  writeFileSync(join(fixture, 'tests', 'calculator.test.js'), TEST_SOURCE);

  const runtime = createRuntime({
    cwd,
    root: fixture,
    config: {
      runtime: { stateDir, checkpointEvery: 1 },
      security: { approvalMode: 'auto' },
      agents: { useModel: false }
    }
  });

  let probe = { ok: false, error: 'not attempted' };
  try {
    const completion = await runtime.providers.complete('freellmapi', {
      messages: [{ role: 'user', content: 'Reply with the single word PONG.' }],
      maxTokens: 16
    });
    probe = { ok: true, text: String(completion.text || '').slice(0, 200), provider: completion.provider || 'freellmapi' };
  } catch (error) {
    probe = { ok: false, error: redact(String(error?.message || error)).slice(0, 500) };
  }

  const goal = 'Fix the bug in src/calculator.js so add(a, b) returns the sum of its arguments, then run the test suite until it passes.';
  const spec = {
    repairTargets: ['src/calculator.js'],
    verification: { command: 'npm test', reason: 'run fixture regression suite' }
  };
  const scan = await runtime.repo.scan();
  const task = await runtime.runTask({ goal, title: 'real end-to-end bug fix', spec });
  const finalSource = readFileSync(join(fixture, 'src', 'calculator.js'), 'utf8');
  const toolEvents = runtime.events.history().filter((event) => event.type === 'tool:end');
  const failedVerification = toolEvents.filter((event) => event.data?.name === 'shell.exec' && event.data?.ok === false);
  const repairEvents = runtime.events.history().filter((event) => event.type === 'offline:repair');

  const checks = [];
  const check = (name, passed, detail = '') => checks.push({ name, passed: passed === true, detail: String(detail).slice(0, 500) });
  check('fixture initially contained the real bug', BUGGY_SOURCE.includes('a - b'));
  check('repository scan discovered source and test files', scan.files.some((file) => file.path === 'src/calculator.js') && scan.files.some((file) => file.path === 'tests/calculator.test.js'), `files=${scan.files.length}`);
  check('runtime read the buggy source file', toolEvents.some((event) => event.data?.name === 'fs.read'));
  check('runtime wrote real file changes', toolEvents.some((event) => event.data?.name === 'fs.write' && event.data?.ok === true));
  check('bug was corrected in the actual file', finalSource.includes('a + b') && !finalSource.includes('a - b'), finalSource.trim());
  check('a verification failure was detected', failedVerification.length > 0, `failed_runs=${failedVerification.length}`);
  check('deterministic repair found a verified fix', repairEvents.length > 0, `repairs=${repairEvents.length}`);
  check('task completed successfully after repair', task.success && task.status === 'completed', task.summary);
  check('final verification passed', task.verification?.ok === true, task.verification?.output?.slice(0, 300));
  check('checkpoints were persisted', task.checkpoints.length > 0, `count=${task.checkpoints.length}`);
  check('state file was persisted', existsSync(join(stateDir, 'state.json')));
  check('provider probe result is reported honestly', typeof probe.ok === 'boolean', probe.error || probe.text);

  const report = {
    ok: checks.every((item) => item.passed),
    mode: probe.ok ? 'live-llm' : 'offline-deterministic',
    providerProbe: probe,
    fixture,
    stateDir,
    taskId: task.taskId,
    goal,
    summary: task.summary,
    steps: task.steps.map((step) => ({ tool: step.tool, role: step.role, ok: step.ok, title: step.title })),
    verification: task.verification,
    checks
  };
  if (!json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('real-e2e.js');
if (invokedDirectly) {
  const result = await runRealE2E({ json: true });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
