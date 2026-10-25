import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDoctor, runDoctor } from '../../src/services/doctor.js';
import { createTestWorkspace, ScriptedProvider, testConfig } from '../helpers.js';

test('doctor reports missing API key as blocking without printing secrets', async () => {
  const fixture = await createTestWorkspace();
  try {
    const config = testConfig(fixture.root, { apiKey: '' });
    const report = await runDoctor({ config, workspace: fixture.workspace });
    const configCheck = report.checks.find((check) => check.name === 'config');
    assert.equal(configCheck.status, 'fail');
    assert.equal(report.ok, false);
    const text = formatDoctor(report);
    assert.match(text, /\[FAIL\] config/);
    assert.match(text, /\[SKIP\] provider\.connectivity/);
    assert.ok(!text.includes('nvapi-'));
  } finally {
    await fixture.cleanup();
  }
});

test('offline doctor passes with a key and does not call the provider', async () => {
  const fixture = await createTestWorkspace();
  try {
    let called = false;
    const provider = { async ping() { called = true; return { ok: true }; } };
    const report = await runDoctor({ config: fixture.config, workspace: fixture.workspace, provider, live: false });
    assert.equal(report.ok, true);
    assert.equal(called, false);
    const connectivity = report.checks.find((check) => check.name === 'provider.connectivity');
    assert.equal(connectivity.status, 'skip');
    assert.match(connectivity.detail, /Offline check only/);
    assert.equal(report.checks.find((check) => check.name === 'workspace.write').status, 'pass');
  } finally {
    await fixture.cleanup();
  }
});

test('live doctor performs one probe and reports failure safely', async () => {
  const fixture = await createTestWorkspace();
  try {
    const okProvider = new ScriptedProvider([]);
    const okReport = await runDoctor({ config: fixture.config, workspace: fixture.workspace, provider: okProvider, live: true });
    assert.equal(okReport.checks.find((check) => check.name === 'provider.connectivity').status, 'pass');

    const badProvider = {
      async ping() {
        return { ok: false, error: { code: 'AUTH_INVALID', message: 'bad key nvapi-should-not-leak' } };
      },
    };
    const badReport = await runDoctor({ config: fixture.config, workspace: fixture.workspace, provider: badProvider, live: true });
    assert.equal(badReport.ok, false);
    assert.match(formatDoctor(badReport), /bad key \[REDACTED:nvidia-key\]/);
  } finally {
    await fixture.cleanup();
  }
});
