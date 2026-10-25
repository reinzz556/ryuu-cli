import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool } from './registry.js';
import { ToolError } from '../utils/errors.js';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 2 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15000;

async function runGit(args, { cwd, timeout = GIT_TIMEOUT_MS } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true, stdout, stderr, code: 0 };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ok: false, available: false, stdout: '', stderr: 'git is not installed or not on PATH', code: null };
    }
    if (error.killed) {
      return { ok: false, stdout: error.stdout || '', stderr: `git command timed out after ${timeout}ms`, code: null };
    }
    return {
      ok: false,
      stdout: error.stdout || '',
      stderr: error.stderr || error.message,
      code: typeof error.code === 'number' ? error.code : null,
    };
  }
}

function boundLines(text, maxLines) {
  const lines = String(text || '').split('\n');
  if (lines.length <= maxLines) return { text: lines.join('\n'), truncated: false };
  return { text: `${lines.slice(0, maxLines).join('\n')}\n…[diff truncated]`, truncated: true };
}

export function createGitTools({ workspace, logger = null }) {
  return [
    defineTool({
      name: 'inspect_git',
      description:
        'Read-only Git inspection: status, diff, log, show or branch. Never runs destructive git commands. Returns available=false when Git is not installed.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'diff', 'log', 'show', 'branch'] },
          path: { type: 'string', minLength: 1, maxLength: 4096, description: 'Optional workspace path to scope diff/status.' },
          staged: { type: 'boolean', description: 'Show staged diff (diff action only).' },
          max_lines: { type: 'integer', minimum: 20, maximum: 2000, description: 'Diff/log line cap (default 200).' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Log entry count (default 10).' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const maxLines = args.max_lines ?? 200;
        let relPath = null;
        if (args.path) relPath = workspace.resolve(args.path).relPath;
        let gitArgs;
        switch (args.action) {
          case 'status':
            gitArgs = ['status', '--porcelain=v1', '--branch', ...(relPath ? ['--', relPath] : [])];
            break;
          case 'diff':
            gitArgs = ['diff', '--no-color', '--stat', ...(args.staged ? ['--cached'] : []), ...(relPath ? ['--', relPath] : [])];
            break;
          case 'log':
            gitArgs = ['log', '--oneline', '--decorate', '-n', String(args.limit ?? 10)];
            break;
          case 'show':
            gitArgs = ['show', '--stat', '--no-color', 'HEAD'];
            break;
          case 'branch':
            gitArgs = ['branch', '--no-color', '-vv'];
            break;
          default:
            throw new ToolError(`Unsupported git action: ${args.action}`);
        }

        const result = await runGit(gitArgs, { cwd: workspace.root });
        if (result.available === false) {
          return { available: false, action: args.action, message: 'Git is not installed or not available on PATH.' };
        }
        const bounded = boundLines(result.stdout, maxLines);
        let detail = null;
        if (args.action === 'diff' && result.ok) {
          const full = await runGit(
            ['diff', '--no-color', ...(args.staged ? ['--cached'] : []), ...(relPath ? ['--', relPath] : [])],
            { cwd: workspace.root },
          );
          detail = boundLines(full.stdout, maxLines);
        }
        logger?.debug('git inspected', { action: args.action, ok: result.ok });
        return {
          available: true,
          action: args.action,
          ok: result.ok,
          exit_code: result.code,
          cwd: workspace.root,
          output: bounded.text,
          truncated: bounded.truncated || Boolean(detail?.truncated),
          ...(detail ? { diff: detail.text } : {}),
          ...(result.stderr ? { stderr: result.stderr.slice(0, 2000) } : {}),
        };
      },
    }),
  ];
}
