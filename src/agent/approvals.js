/**
 * Approval policy:
 *  - read-only: deny every write/exec/destructive action
 *  - ask (default): ask for write, exec and destructive actions
 *  - auto: auto-approve writes, still ask for exec/destructive
 *
 * Session overrides (highest wins):
 *  - autoApproveAll (--auto-approve): auto-approve every non-read action,
 *    including exec and destructive ones. Intended for trusted, non-interactive
 *    automation; shell execution is still NOT a sandbox.
 *
 * Read-only tools never prompt. Approval is enforced in the agent loop before
 * tool execution, so a model cannot bypass it by calling a tool directly.
 */
export class ApprovalManager {
  constructor({ policy = 'ask', confirm = null, interactive = true, logger = null, autoApproveWrites = false, autoApproveAll = false } = {}) {
    if (!['ask', 'auto', 'read-only'].includes(policy)) throw new Error(`Unknown approval policy: ${policy}`);
    this.policy = policy;
    this.confirm = confirm;
    this.interactive = interactive;
    this.logger = logger;
    this.autoApproveWrites = autoApproveWrites;
    this.autoApproveAll = autoApproveAll;
    this.stats = { approved: 0, denied: 0, auto: 0 };
  }

  async request({ tool, risk, args = {}, preview = '', reasons = [], critical = false }) {
    if (risk === 'read') {
      this.stats.auto += 1;
      return { approved: true, reason: 'read-only tool' };
    }
    if (this.policy === 'read-only') {
      this.stats.denied += 1;
      this.logger?.warn('approval denied by read-only policy', { tool, risk });
      return { approved: false, reason: 'Approval policy is read-only; write and command actions are disabled.' };
    }
    if (this.autoApproveAll) {
      this.stats.approved += 1;
      this.logger?.info('auto-approved by --auto-approve', { tool, risk });
      return { approved: true, reason: 'auto-approved for this session (--auto-approve)' };
    }
    if (this.policy === 'auto' && risk === 'write') {
      this.stats.approved += 1;
      return { approved: true, reason: 'auto policy approves writes' };
    }
    if (this.autoApproveWrites && risk === 'write') {
      this.stats.approved += 1;
      return { approved: true, reason: 'writes auto-approved for this session (--yes)' };
    }

    if (!this.confirm) {
      this.stats.denied += 1;
      return {
        approved: false,
        reason: critical
          ? 'This action is marked critical and requires interactive approval; non-interactive mode denies it.'
          : 'Non-interactive session: approval required but no prompt is available.',
      };
    }

    let approved = false;
    try {
      approved = await this.confirm({ tool, risk, args, preview, reasons, critical });
    } catch (error) {
      this.logger?.warn('approval prompt failed', { tool, error: error.message });
      approved = false;
    }
    if (approved) this.stats.approved += 1;
    else this.stats.denied += 1;
    this.logger?.info('approval decision', { tool, risk, approved });
    return {
      approved: Boolean(approved),
      reason: approved ? 'approved by user' : 'denied by user',
    };
  }
}
