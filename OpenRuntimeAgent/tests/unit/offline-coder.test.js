import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateEdits, inferPathsFromError, createOfflineCoder } from '../../agents/offline-coder.js';

const TARGET = 'src/calculator.js';

function stubTools() {
  return {
    async invoke() {
      return { ok: true, output: '', data: null, error: null };
    }
  };
}

test('candidateEdits proposes flipping the subtraction to addition', () => {
  const source = 'export function add(a,b){ return a - b; }';
  const candidates = candidateEdits(source, TARGET);
  const fix = candidates.find((candidate) => candidate.content === 'export function add(a,b){ return a + b; }');

  assert.ok(fix, `expected the '-' to '+' edit, got ${JSON.stringify(candidates.map((item) => item.content))}`);
  assert.equal(fix.path, TARGET);
  assert.match(fix.reason, /'-'.*'\+'/);
});

test('candidateEdits leaves operators inside string literals and // comments alone', () => {
  const source = [
    'export function add(a, b) {',
    "  const note = 'a - b'; // a - b must stay a - b",
    '  return a - b;',
    '}'
  ].join('\n');
  const candidates = candidateEdits(source, TARGET);

  assert.ok(candidates.length > 0, 'expected at least one real operator candidate');
  assert.ok(
    candidates.some((candidate) => candidate.content.includes('return a + b;')),
    `expected the real subtraction to be fixed, got ${JSON.stringify(candidates.map((item) => item.content))}`
  );
  for (const candidate of candidates) {
    assert.ok(candidate.content.includes("'a - b';"), `string literal changed: ${candidate.content}`);
    assert.ok(candidate.content.includes('// a - b must stay a - b'), `comment changed: ${candidate.content}`);
    assert.ok(!candidate.content.includes("'a + b'"), `string literal operator changed: ${candidate.content}`);
    assert.ok(!candidate.content.includes('// a + b'), `comment operator changed: ${candidate.content}`);
  }
});

test('inferPathsFromError extracts a js path from an assertion error', () => {
  const error = [
    'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '5 !== 1',
    '    at tests/calculator.test.js:5:10',
    '    at node_modules/some-lib/index.js:1:1'
  ].join('\n');

  const paths = inferPathsFromError(error);
  assert.ok(paths.some((path) => path.endsWith('tests/calculator.test.js')), JSON.stringify(paths));
  assert.ok(!paths.some((path) => path.includes('node_modules')), JSON.stringify(paths));
});

test('synthesize returns an explicit spec edit unchanged', async () => {
  const coder = createOfflineCoder({ tools: stubTools(), repo: {}, events: null, config: {} });
  const edit = { path: 'src/explicit.js', content: 'export const answer = 42;\n', reason: 'as specified' };

  const result = await coder.synthesize({ goal: 'add the explicit file', spec: { edits: [edit] } });

  assert.equal(result.edits.length, 1);
  assert.deepEqual(result.edits[0], edit);
});

test('synthesize derives a two-argument function from spec.expectations', async () => {
  const coder = createOfflineCoder({ tools: stubTools(), repo: {}, events: null, config: {} });

  const result = await coder.synthesize({
    goal: 'implement add',
    spec: {
      expectations: [
        { function: 'add', args: [2, 3], expected: 5 },
        { function: 'add', args: [-1, 1], expected: 0 }
      ]
    }
  });

  assert.equal(result.edits.length, 1);
  assert.equal(result.edits[0].path, 'src/add.js');
  assert.match(result.edits[0].content, /export function add\(a, b\)/);
  assert.match(result.edits[0].content, /return a \+ b;/);
});

test('repair reverts a failed candidate, keeps the verified fix and reports one edit', async () => {
  const original = [
    'export const enabled = 1 < 2;',
    'export function add(a, b) {',
    '  return a - b;',
    '}'
  ].join('\n').concat('\n');
  const badCandidate = original.replace('1 < 2', '1 > 2');
  const fixed = original.replace('return a - b;', 'return a + b;');
  const files = new Map([[TARGET, original]]);
  const writes = [];
  const execs = [];
  const ok = (output, data = null) => ({ ok: true, output, data, error: null });
  const failed = (message) => ({ ok: false, output: '', data: null, error: { message } });

  const tools = {
    async invoke(name, args) {
      if (name === 'fs.read') {
        return files.has(args.path) ? ok(files.get(args.path)) : failed('file not found');
      }
      if (name === 'fs.write') {
        writes.push({ path: args.path, content: args.content });
        files.set(args.path, args.content);
        return ok(JSON.stringify({ path: args.path }), { path: args.path });
      }
      if (name === 'shell.exec') {
        execs.push({ command: args.command, content: files.get(TARGET) });
        return execs.length === 1
          ? failed('AssertionError: expected 5 but got -1')
          : ok('1 passing', { exitCode: 0 });
      }
      throw new Error(`unexpected tool: ${name}`);
    }
  };
  const coder = createOfflineCoder({ tools, repo: {}, events: null, config: {} });

  const result = await coder.repair({
    goal: 'fix add',
    verification: { command: 'npm test' },
    spec: { repairTargets: [TARGET] },
    taskId: 'unit-repair'
  });

  assert.equal(result.edits.length, 1, JSON.stringify(result.notes));
  assert.equal(result.edits[0].content, fixed);
  assert.equal(files.get(TARGET), fixed, 'the verified fixed file must be left in place');
  assert.equal(result.verification?.ok, true);
  assert.equal(execs.length, 2, JSON.stringify(execs));
  assert.equal(execs[0].content, badCandidate, 'first verification must run against the first candidate');
  assert.equal(execs[1].content, fixed, 'second verification must run against the fixed candidate');
  assert.deepEqual(writes.map((write) => write.content), [badCandidate, original, fixed]);
  assert.equal(writes[1].content, original, 'the failed candidate must be reverted before the next attempt');
});
