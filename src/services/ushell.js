import { spawn } from 'node:child_process';

/**
 * Shell commands the user runs themselves (`/bash …` or `!…`).
 *
 * These are not model tool calls: the user typed the command, so it runs with
 * their own permissions and without an approval prompt. The environment is
 * still stripped of credential-looking variables, output is captured with a
 * bound, and the child is killed on abort so Ctrl+C cannot leave it behind.
 */

const SECRET_ENV = /(api[_-]?key|token|secret|password|passwd|credential|private[_-]?key)/i;

/** Copy of `env` without credential-looking variables. */
export function sanitizedEnv(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_ENV.test(key)) continue;
    if (value === undefined) continue;
    clean[key] = value;
  }
  return clean;
}

/** Keep the tail of an over-long capture, which is where failures are. */
function appendBounded(current, text, maxBytes) {
  const next = current + text;
  if (next.length <= maxBytes) return { value: next, truncated: false };
  return { value: next.slice(next.length - maxBytes), truncated: true };
}

/**
 * Run one shell command to completion.
 *
 * @returns {Promise<{command:string, cwd:string, stdout:string, stderr:string,
 *   exitCode:number|null, signal:string|null, durationMs:number,
 *   truncated:boolean, timedOut:boolean, error:string|null}>}
 */
export function runUserShell({
  command,
  cwd = process.cwd(),
  env = process.env,
  maxBytes = 200_000,
  timeoutMs = 0,
  signal = null,
} = {}) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    let timeoutTimer = null;
    let child = null;

    /**
     * Kill the whole process group, not just the shell wrapper.
     *
     * `shell: true` starts `/bin/sh -c <command>`; for a compound command the
     * shell forks the real process instead of exec'ing it, so signalling only
     * the shell leaves the child running and its pipes open — Ctrl+C would look
     * ignored until the command finished on its own.
     */
    const killTree = (signalName) => {
      if (!child?.pid) return;
      try {
        process.kill(-child.pid, signalName);
      } catch {
        try {
          child.kill(signalName);
        } catch {
          // already gone
        }
      }
    };

    const finish = (exitCode, signalName, error = null) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        command,
        cwd,
        stdout,
        stderr,
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: signalName || null,
        durationMs: Date.now() - startedAt,
        truncated,
        timedOut,
        error: error ? String(error.message || error) : null,
      });
    };

    const onAbort = () => {
      killTree('SIGTERM');
      killTimer = setTimeout(() => killTree('SIGKILL'), 2000);
      killTimer.unref?.();
    };

    try {
      child = spawn(String(command), {
        shell: true,
        cwd,
        env: sanitizedEnv(env),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (error) {
      finish(null, null, error);
      return;
    }

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    if (Number(timeoutMs) > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        killTree('SIGTERM');
        killTimer = setTimeout(() => killTree('SIGKILL'), 2000);
        killTimer.unref?.();
      }, Number(timeoutMs));
      timeoutTimer.unref?.();
    }

    child.stdout?.on('data', (chunk) => {
      const next = appendBounded(stdout, chunk.toString(), maxBytes);
      stdout = next.value;
      truncated = truncated || next.truncated;
    });
    child.stderr?.on('data', (chunk) => {
      const next = appendBounded(stderr, chunk.toString(), maxBytes);
      stderr = next.value;
      truncated = truncated || next.truncated;
    });
    child.on('error', (error) => finish(null, null, error));
    child.on('close', (code, signalName) => finish(code, signalName));
  });
}
