import test from 'node:test';
import assert from 'node:assert/strict';
import { runRealE2E } from '../../scripts/real-e2e.js';

// One disposable fixture, one runtime run: this file deliberately calls runRealE2E once.
test('real task: the runtime repairs a real bug and verifies it with the fixture suite', async () => {
  const report = await runRealE2E({ json: true });

  assert.equal(
    report.ok,
    true,
    `E2E report failed checks: ${JSON.stringify(report.checks.filter((check) => !check.passed))}`
  );
  assert.ok(
    report.mode === 'live-llm' || report.mode === 'offline-deterministic',
    `unexpected mode: ${report.mode}`
  );

  const passedCheck = (name) => {
    const check = report.checks.find((item) => item.name === name);
    assert.ok(check, `missing check: ${name}`);
    assert.equal(check.passed, true, `${name}: ${check.detail}`);
  };

  passedCheck('bug was corrected in the actual file');
  passedCheck('a verification failure was detected');
  passedCheck('deterministic repair found a verified fix');
  passedCheck('final verification passed');
  assert.equal(report.verification?.ok, true, JSON.stringify(report.verification));

  passedCheck('provider probe result is reported honestly');
  assert.equal(typeof report.providerProbe?.ok, 'boolean', JSON.stringify(report.providerProbe));
  assert.equal(
    report.mode,
    report.providerProbe.ok ? 'live-llm' : 'offline-deterministic',
    'mode must honestly reflect the provider probe result'
  );
});
