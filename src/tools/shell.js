import { defineTool } from './registry.js';
import { ToolError } from '../utils/errors.js';

/** Read-only binaries that are reasonable to run during debugging. */
const SAFE_BINARIES = new Set(['git', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'python', 'python3', 'pytest', 'go', 'cargo', 'rustc', 'tsc', 'eslint', 'vitest', 'jest', 'mocha', 'ls', 'cat', 'grep', 'rg', 'find', 'head', 'tail', 'wc', 'diff']);

const CRITICAL_BINARIES = new Set(['sudo', 'su', 'doas', 'pkexec', 'mkfs', 'mkfs.ext4', 'dd', 'shutdown', 'reboot', 'halt', 'poweroff', 'fdisk', 'parted']);

/**
 * Static, best-effort command assessment. This is a UX signal for the approval
 * prompt, not a security boundary: any approval-gated command can still be
 * dangerous, and shell execution is explicitly not a sandbox.
 */
export function assessCommand(argv) {
  const reasons = [];
  let level = 'normal';
  const command = argv[0] || '';
  const rest = argv.slice(1);
  const base = command.split('/').pop();

  if (CRITICAL_BINARIES.has(base)) {
    level = 'critical';
    reasons.push(`privileged/destructive binary: ${base}`);
  }
  if (/^(rm|unlink|rmdir)$/.test(base)) {
    const recursive = rest.some((arg) => /^-[a-zA-Z]*[rR]/.test(arg));
    const targets = rest.filter((arg) => !arg.startsWith('-'));
    if (recursive && targets.some((target) => target === '/' || target === '~' || target === '..' || /^\/(\*|$)/.test(target))) {
      level = 'critical';
      reasons.push('recursive delete of a root/home/parent path');
    } else {
      if (level === 'normal') level = 'high';
      reasons.push('file deletion');
    }
  }
  if (base === 'git' && rest.some((arg) => ['push', 'reset', 'clean', 'checkout'].includes(arg))) {
    const force = rest.some((arg) => ['--force', '-f', '--hard', '-fd', '-df'].includes(arg));
    if (force) {
      level = 'critical';
      reasons.push('destructive git operation with force/hard flags');
    } else {
      if (level === 'normal') level = 'high';
      reasons.push('git operation that can modify history or working tree');
    }
  }
  if (base === 'npm' && ['publish', 'unpublish'].includes(rest[0])) {
    level = 'critical';
    reasons.push('publishes packages to a registry');
  }
  if (['npx', 'bunx'].includes(base) || (base === 'npm' && rest[0] === 'exec')) {
    if (level === 'normal') level = 'high';
    reasons.push('downloads and executes a remote package');
  }
  if ((base === 'npm' || base === 'pnpm' || base === 'yarn') && ['install', 'add', 'i'].includes(rest[0])) {
    if (level === 'normal') level = 'high';
    reasons.push('dependency installation (network + scripts)');
  }
  if (['chmod', 'chown', 'chgrp'].includes(base)) {
    if (level === 'normal') level = 'high';
    reasons.push('permission/ownership change');
  }
  if (base === 'kill' || base === 'pkill' || base === 'killall') {
    if (level === 'normal') level = 'high';
    reasons.push('signals other processes');
  }
  if (base.startsWith('curl') || base === 'wget') {
    if (level === 'normal') level = 'high';
    reasons.push('network download');
  }
  if (!SAFE_BINARIES.has(base) && level === 'normal') {
    reasons.push('non-standard binary (review carefully)');
  }
  return { level, reasons };
}

export function assessShellString(command) {
  const reasons = [];
  let level = 'high';
  const text = String(command || '');
  if (/\bsudo\b|\bsu\s/.test(text)) {
    level = 'critical';
    reasons.push('privilege escalation');
  }
  if (/\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+)?\/(\s|$|\*)/.test(text) || /\brm\s+-rf\s+~/.test(text)) {
    level = 'critical';
    reasons.push('recursive delete at filesystem root or home');
  }
  if (/\|\s*(ba)?sh\b|\|\s*python/.test(text)) {
    level = 'critical';
    reasons.push('pipes a remote/untrusted payload into an interpreter');
  }
  if (/mkfs|\bdd\s+.*of=\/dev|>\s*\/dev\/sd/.test(text)) {
    level = 'critical';
    reasons.push('writes directly to block devices');
  }
  if (level !== 'critical') reasons.push('raw shell syntax: pipes, redirects or chaining may run anything');
  return { level, reasons };
}

const outputLimit = (config) => Math.max(4000, Math.min(config.maxToolOutputBytes, 200000));

export function createShellTools({ workspace, config, processes, logger = null }) {
  return [
    defineTool({
      name: 'run_command',
      description:
        'Run a command in the workspace and wait for completion. Prefer argv (e.g. ["npm","test"]); shell:false is used. Raw shell syntax requires agent.allowShell=true in config.json and an explicit approval. Every execution is approval-gated. Shell execution is NOT a sandbox.',
      risk: 'exec',
      requiresApproval: true,
      schema: {
        type: 'object',
        properties: {
          argv: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 20000 },
            minItems: 1,
            maxItems: 200,
            description: 'Command and arguments, e.g. ["npm", "test"].',
          },
          shell_command: { type: 'string', minLength: 1, maxLength: 4000, description: 'Raw shell string (only when agent.allowShell=true).' },
          cwd: { type: 'string', minLength: 1, maxLength: 4096, description: 'Workspace-relative working directory.' },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000, description: 'Timeout (default 120000).' },
          description: { type: 'string', maxLength: 200, description: 'Why this command is needed.' },
        },
        additionalProperties: false,
      },
      assess: (args) => (args.shell_command ? assessShellString(args.shell_command) : assessCommand(args.argv || [])),
      preview: async (args) => {
        const display = args.shell_command ? `$ ${args.shell_command}\n(shell syntax)` : `$ ${(args.argv || []).join(' ')}`;
        const cwd = args.cwd || '.';
        const assessment = args.shell_command ? assessShellString(args.shell_command) : assessCommand(args.argv || []);
        const lines = [`${display}\ncwd: ${workspace.resolve(cwd).relPath}`, `risk: ${assessment.level}`];
        if (assessment.reasons.length > 0) lines.push(`notes:\n- ${assessment.reasons.join('\n- ')}`);
        lines.push('Shell execution is not a sandbox.');
        return lines.join('\n');
      },
      handler: async (args, ctx = {}) => {
        if (args.argv && args.shell_command) {
          throw new ToolError('Provide either argv or shell_command, not both.');
        }
        if (args.shell_command && !config.allowShell) {
          throw new ToolError(
            'Shell syntax is disabled. Pass an argv array instead, or ask the user to set agent.allowShell=true in config.json and approve the raw command.',
          );
        }
        if (!args.argv && !args.shell_command) throw new ToolError('Provide argv (preferred) or shell_command.');
        const assessment = args.shell_command ? assessShellString(args.shell_command) : assessCommand(args.argv);
        const record = processes.start({
          argv: args.argv,
          shellCommand: args.shell_command || null,
          cwd: args.cwd || '.',
          timeoutMs: args.timeout_ms ?? 120000,
          allowShell: config.allowShell,
          label: args.description || undefined,
        });
        const onAbort = () => {
          processes.stop(record.id, { graceMs: 1000 }).catch(() => {});
        };
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
        try {
          await record.done;
        } finally {
          ctx.signal?.removeEventListener('abort', onAbort);
        }
        const limit = outputLimit(config);
        const stdout = record.stdout.text;
        const stderr = record.stderr.text;
        logger?.info('command finished', {
          id: record.id,
          argv: record.argv,
          exitCode: record.exitCode,
          status: record.status,
          durationMs: record.durationMs,
        });
        return {
          process_id: record.id,
          argv: record.argv,
          cwd: record.cwd,
          status: record.status,
          exit_code: record.exitCode,
          signal: record.signal,
          duration_ms: record.durationMs,
          timed_out: record.timedOut,
          risk: assessment,
          stdout: stdout.length > limit ? `…[tail of output]…\n${stdout.slice(-limit)}` : stdout,
          stderr: stderr.length > limit ? `…[tail of output]…\n${stderr.slice(-limit)}` : stderr,
          truncated: record.truncated,
          ok: record.status === 'exited' && record.exitCode === 0,
        };
      },
    }),

    defineTool({
      name: 'start_process',
      description:
        'Start a long-running process (dev server, watcher) without blocking the agent. Returns a process id immediately. Use get_process_output to poll it and stop_process to stop it. Approval-gated.',
      risk: 'exec',
      requiresApproval: true,
      schema: {
        type: 'object',
        properties: {
          argv: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 20000 }, minItems: 1, maxItems: 200 },
          cwd: { type: 'string', minLength: 1, maxLength: 4096 },
          label: { type: 'string', maxLength: 120 },
          timeout_ms: { type: 'integer', minimum: 0, maximum: 3600000, description: '0 means no timeout (default 0 for background processes).' },
        },
        required: ['argv'],
        additionalProperties: false,
      },
      assess: (args) => assessCommand(args.argv),
      preview: async (args) => `Start background process: ${args.argv.join(' ')}\ncwd: ${workspace.resolve(args.cwd || '.').relPath}`,
      handler: async (args) => {
        const assessment = assessCommand(args.argv);
        const record = processes.start({
          argv: args.argv,
          cwd: args.cwd || '.',
          timeoutMs: args.timeout_ms ?? 0,
          label: args.label,
        });
        return {
          process_id: record.id,
          pid: record.pid,
          status: record.status,
          argv: record.argv,
          cwd: record.cwd,
          risk: assessment,
          note: 'Verify with get_process_output before assuming the service is ready.',
        };
      },
    }),

    defineTool({
      name: 'list_processes',
      description: 'List running and recently completed processes started in this session.',
      risk: 'read',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => ({ processes: processes.list() }),
    }),

    defineTool({
      name: 'get_process_output',
      description: 'Read captured stdout/stderr and status for a process started in this session.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          process_id: { type: 'string', minLength: 1, maxLength: 40 },
          stream: { type: 'string', enum: ['stdout', 'stderr', 'both'] },
          tail_bytes: { type: 'integer', minimum: 100, maximum: 200000 },
        },
        required: ['process_id'],
        additionalProperties: false,
      },
      handler: async (args) => processes.getOutput(args.process_id, {
        stream: args.stream ?? 'both',
        tailBytes: args.tail_bytes ?? outputLimit(config),
      }),
    }),

    defineTool({
      name: 'stop_process',
      description: 'Stop a running process with SIGTERM, escalating to SIGKILL after a grace period. Approval-gated.',
      risk: 'exec',
      requiresApproval: true,
      schema: {
        type: 'object',
        properties: {
          process_id: { type: 'string', minLength: 1, maxLength: 40 },
          grace_ms: { type: 'integer', minimum: 100, maximum: 10000 },
        },
        required: ['process_id'],
        additionalProperties: false,
      },
      assess: () => ({ level: 'high', reasons: ['terminates a running process started in this session'] }),
      preview: async (args) => `Stop process ${args.process_id}`,
      handler: async (args) => processes.stop(args.process_id, { graceMs: args.grace_ms ?? 3000 }),
    }),
  ];
}
