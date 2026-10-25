import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import path from 'node:path';
import { ProcessError } from '../utils/errors.js';
import { redact } from '../utils/redaction.js';

const SECRET_ENV_PATTERN = /(API_KEY|ACCESS_TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|GITHUB_TOKEN|GH_TOKEN|NVIDIA_API_KEY)/i;
const POSIX = process.platform !== 'win32';

/** Running child processes, used by the last-resort exit cleanup. */
const ACTIVE = new Set();
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const record of ACTIVE) {
      try {
        if (POSIX && record.pid) process.kill(-record.pid, 'SIGKILL');
        else if (record.pid) process.kill(record.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });
}

/** Strip credential-looking variables from a child environment. */
export function buildChildEnv(base = process.env, { allow = [], extra = {} } = {}) {
  const allowSet = new Set(allow);
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (SECRET_ENV_PATTERN.test(key) && !allowSet.has(key)) continue;
    env[key] = value;
  }
  env.RYUU_AGENT = '1';
  return { ...env, ...extra };
}

function appendBounded(state, chunk, limit) {
  const combined = state.text + chunk;
  if (combined.length <= limit) {
    state.text = combined;
    return;
  }
  state.truncated = true;
  const head = Math.max(0, Math.floor(limit * 0.4));
  const tail = Math.max(0, limit - head);
  state.text = `${combined.slice(0, head)}\n…[output truncated]…\n${combined.slice(combined.length - tail)}`;
}

/**
 * Session-scoped process manager. Commands use spawn with an argument array
 * and shell:false by default; shell syntax requires an explicit, separately
 * approved tool path. Shell execution is not a sandbox.
 */
export class ProcessManager extends EventEmitter {
  constructor({ workspace, logger = null, maxBufferBytes = 65536, defaultTimeoutMs = 120000, maxProcesses = 8, logDir = null } = {}) {
    super();
    if (!workspace) throw new ProcessError('ProcessManager requires a workspace.');
    this.workspace = workspace;
    this.logger = logger;
    this.maxBufferBytes = maxBufferBytes;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.maxProcesses = maxProcesses;
    this.logDir = logDir;
    this.records = new Map();
    this.completed = [];
    this.counter = 0;
    installExitHook();
  }

  #nextId() {
    this.counter += 1;
    return `p${this.counter}`;
  }

  #runningCount() {
    return [...this.records.values()].filter((record) => record.status === 'running').length;
  }

  /**
   * @param {object} options
   * @param {string[]} [options.argv] argument array (preferred, shell:false)
   * @param {string} [options.shellCommand] raw shell string (requires allowShell)
   * @param {string} [options.cwd] workspace-relative working directory
   * @param {number} [options.timeoutMs] 0 disables the timeout
   * @param {string} [options.label]
   */
  start({ argv, shellCommand = null, cwd = '.', timeoutMs, label, env = {}, allowShell = false } = {}) {
    if (this.#runningCount() >= this.maxProcesses) {
      throw new ProcessError(`Too many running processes (limit ${this.maxProcesses}). Stop one with stop_process.`);
    }

    const useShell = Boolean(shellCommand);
    if (useShell && !allowShell) {
      throw new ProcessError('Shell execution is disabled. Set AGENT_ALLOW_SHELL=true to permit an approved shell command.');
    }
    let command;
    let args;
    if (useShell) {
      command = shellCommand;
      args = [];
    } else {
      if (!Array.isArray(argv) || argv.length === 0) {
        throw new ProcessError('argv must be a non-empty array of strings, e.g. ["npm", "test"].');
      }
      if (argv.length > 200) throw new ProcessError('Too many arguments (max 200).');
      for (const part of argv) {
        if (typeof part !== 'string' || part.length === 0) throw new ProcessError('Every argv entry must be a non-empty string.');
        if (part.includes('\0')) throw new ProcessError('Arguments must not contain NUL bytes.');
        if (part.length > 20000) throw new ProcessError('Argument is too long (max 20000 chars).');
      }
      [command, ...args] = argv;
    }

    const resolvedCwd = this.workspace.resolve(cwd || '.');
    let stat;
    try {
      stat = fs.statSync(resolvedCwd.absPath);
    } catch {
      throw new ProcessError(`Working directory not found: ${resolvedCwd.relPath}`);
    }
    if (!stat.isDirectory()) throw new ProcessError(`Working directory is not a directory: ${resolvedCwd.relPath}`);

    const id = this.#nextId();
    const startedAt = Date.now();
    const record = {
      id,
      pid: null,
      label: label || (useShell ? command : argv.join(' ')).slice(0, 120),
      argv: useShell ? [command] : argv,
      shellCommand: useShell ? command : null,
      cwd: resolvedCwd.relPath,
      status: 'running',
      startedAt,
      startedAtIso: new Date(startedAt).toISOString(),
      endedAt: null,
      durationMs: null,
      exitCode: null,
      signal: null,
      timedOut: false,
      stopRequested: false,
      error: null,
      truncated: false,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    };
    record.done = new Promise((resolveDone) => {
      record.resolveDone = resolveDone;
    });
    this.records.set(id, record);

    const child = spawn(command, args, {
      cwd: resolvedCwd.absPath,
      shell: useShell,
      detached: POSIX,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildChildEnv(process.env, { extra: env }),
      windowsHide: true,
    });
    record.pid = child.pid ?? null;
    record.child = child;
    if (POSIX && child.pid) ACTIVE.add(record);

    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    child.stdout?.on('data', (chunk) => {
      const text = outDecoder.write(chunk);
      appendBounded(record.stdout, text, this.maxBufferBytes);
      record.truncated = record.truncated || record.stdout.truncated;
      this.emit('output', { id, stream: 'stdout', text, record });
    });
    child.stderr?.on('data', (chunk) => {
      const text = errDecoder.write(chunk);
      appendBounded(record.stderr, text, this.maxBufferBytes);
      record.truncated = record.truncated || record.stderr.truncated;
      this.emit('output', { id, stream: 'stderr', text, record });
    });

    let timeoutTimer = null;
    const effectiveTimeout = timeoutMs === undefined ? this.defaultTimeoutMs : timeoutMs;
    if (effectiveTimeout > 0) {
      timeoutTimer = setTimeout(() => {
        if (record.status !== 'running') return;
        record.timedOut = true;
        this.logger?.warn('process timeout, terminating', { id, timeoutMs: effectiveTimeout });
        this.#kill(record, 'SIGTERM');
        const force = setTimeout(() => this.#kill(record, 'SIGKILL'), 2000);
        force.unref();
      }, effectiveTimeout);
      timeoutTimer.unref?.();
    }

    const finalize = (exitCode, signal, spawnError = null) => {
      if (record.status !== 'running') return;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (outDecoder.end) appendBounded(record.stdout, outDecoder.end() || '', this.maxBufferBytes);
      if (errDecoder.end) appendBounded(record.stderr, errDecoder.end() || '', this.maxBufferBytes);
      const endedAt = Date.now();
      record.endedAt = endedAt;
      record.endedAtIso = new Date(endedAt).toISOString();
      record.durationMs = endedAt - startedAt;
      record.exitCode = exitCode;
      record.signal = signal;
      record.error = spawnError ? spawnError.message : null;
      if (spawnError) record.status = 'failed';
      else if (record.timedOut) record.status = 'timeout';
      else if (record.stopRequested) record.status = 'killed';
      else record.status = exitCode === 0 ? 'exited' : 'failed';
      delete record.child;
      ACTIVE.delete(record);
      this.completed.unshift(record);
      if (this.completed.length > 100) this.completed.pop();
      this.emit('exit', { record });
      this.#persist(record);
      record.resolveDone(record);
    };

    child.on('error', (error) => {
      finalize(null, null, error);
    });
    child.on('close', (code, signal) => {
      finalize(code, signal);
    });

    this.emit('started', { record });
    this.logger?.info('process started', { id, pid: record.pid, argv: record.argv, cwd: record.cwd, shell: useShell });
    return record;
  }

  #kill(record, signal) {
    if (!record.pid || record.status !== 'running') return;
    try {
      if (POSIX) process.kill(-record.pid, signal);
      else process.kill(record.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') this.logger?.warn('failed to signal process', { id: record.id, signal, error: error.message });
    }
  }

  /** Stop a process: graceful SIGTERM, then SIGKILL after graceMs. */
  async stop(id, { graceMs = 3000, signal = 'SIGTERM' } = {}) {
    const record = this.records.get(id);
    if (!record) throw new ProcessError(`Unknown process id: ${id}`, { id });
    if (record.status !== 'running') return { id, stopped: false, status: record.status, exitCode: record.exitCode };
    record.stopRequested = true;
    this.#kill(record, signal);
    const killed = await Promise.race([
      record.done.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), graceMs)),
    ]);
    if (!killed) {
      this.#kill(record, 'SIGKILL');
      await Promise.race([record.done, new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
    return { id, stopped: true, status: record.status, exitCode: record.exitCode, signal: record.signal, durationMs: record.durationMs };
  }

  async stopAll({ graceMs = 2000 } = {}) {
    const running = [...this.records.values()].filter((record) => record.status === 'running');
    await Promise.allSettled(running.map((record) => this.stop(record.id, { graceMs })));
    return running.length;
  }

  get(id) {
    const record = this.records.get(id) || this.completed.find((item) => item.id === id);
    if (!record) throw new ProcessError(`Unknown process id: ${id}`, { id });
    return record;
  }

  getOutput(id, { stream = 'both', tailBytes = 8000 } = {}) {
    const record = this.get(id);
    const tail = (state) => {
      if (state.text.length <= tailBytes) return state.text;
      return `…[showing last ${tailBytes} chars]…\n${state.text.slice(state.text.length - tailBytes)}`;
    };
    const result = { id: record.id, status: record.status, exitCode: record.exitCode, signal: record.signal, durationMs: record.durationMs };
    if (stream === 'stdout' || stream === 'both') result.stdout = tail(record.stdout);
    if (stream === 'stderr' || stream === 'both') result.stderr = tail(record.stderr);
    result.truncated = record.stdout.truncated || record.stderr.truncated;
    return result;
  }

  list({ includeCompleted = true } = {}) {
    const running = [...this.records.values()].filter((record) => record.status === 'running');
    const rows = running.map(summarize);
    if (includeCompleted) rows.push(...this.completed.slice(0, 20).map(summarize));
    return rows;
  }

  #persist(record) {
    if (!this.logDir) return;
    try {
      fs.mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
      const payload = {
        id: record.id,
        label: record.label,
        argv: record.argv,
        cwd: record.cwd,
        status: record.status,
        exitCode: record.exitCode,
        signal: record.signal,
        startedAt: record.startedAtIso,
        endedAt: record.endedAtIso,
        durationMs: record.durationMs,
        truncated: record.truncated,
        stdout: redact(record.stdout.text),
        stderr: redact(record.stderr.text),
      };
      fs.writeFileSync(path.join(this.logDir, `process-${record.id}.log`), `${JSON.stringify(payload, null, 2)}\n`, {
        mode: 0o600,
      });
    } catch {
      // Persistence failures must not break execution.
    }
  }

  /** All records with metadata, used for final summaries. */
  history() {
    return [...this.completed].reverse().map(summarize);
  }
}

function summarize(record) {
  return {
    id: record.id,
    pid: record.pid,
    label: record.label,
    argv: record.argv,
    cwd: record.cwd,
    status: record.status,
    exitCode: record.exitCode,
    signal: record.signal,
    startedAt: record.startedAtIso,
    endedAt: record.endedAtIso,
    durationMs: record.durationMs,
    timedOut: record.timedOut,
    truncated: record.truncated,
  };
}
