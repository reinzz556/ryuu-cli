import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalManager } from '../../src/agent/approvals.js';

function makeManager(overrides = {}) {
  return new ApprovalManager({ policy: 'ask', interactive: false, confirm: null, ...overrides });
}

test('read-only tools are auto-approved without any flag', async () => {
  const manager = makeManager();
  const decision = await manager.request({ tool: 'read_file', risk: 'read' });
  assert.equal(decision.approved, true);
  assert.equal(decision.reason, 'read-only tool');
});

test('--auto-approve (autoApproveAll) approves command execution without prompting', async () => {
  let prompted = 0;
  const manager = makeManager({
    interactive: true,
    confirm: async () => {
      prompted += 1;
      return false;
    },
    autoApproveAll: true,
  });
  const decision = await manager.request({
    tool: 'run_command',
    risk: 'exec',
    args: { argv: ['npm', 'test'] },
    critical: true,
  });
  assert.equal(decision.approved, true);
  assert.match(decision.reason, /--auto-approve/);
  assert.equal(prompted, 0, 'autoApproveAll must not prompt, even for critical exec actions');
});

test('--auto-approve approves writes and destructive actions too', async () => {
  const manager = makeManager({ autoApproveAll: true });
  const write = await manager.request({ tool: 'write_file', risk: 'write' });
  const destructive = await manager.request({ tool: 'delete_file', risk: 'destructive', critical: true });
  assert.equal(write.approved, true);
  assert.equal(destructive.approved, true);
  assert.equal(manager.stats.denied, 0);
});

test('--auto-approve cannot override the read-only policy', async () => {
  const manager = makeManager({ policy: 'read-only', autoApproveAll: true });
  const decision = await manager.request({ tool: 'run_command', risk: 'exec' });
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /read-only/);
});

test('--auto-approve beats --yes and the auto policy', async () => {
  const manager = makeManager({ policy: 'ask', autoApproveWrites: true, autoApproveAll: true });
  const exec = await manager.request({ tool: 'run_command', risk: 'exec' });
  assert.equal(exec.approved, true, 'exec must be covered by autoApproveAll even though --yes only covers writes');
  assert.match(exec.reason, /--auto-approve/);
});

test('without --auto-approve, exec is still denied in non-interactive mode', async () => {
  const manager = makeManager({ autoApproveWrites: true });
  const decision = await manager.request({ tool: 'run_command', risk: 'exec' });
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /no prompt is available/);
});
