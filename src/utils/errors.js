/**
 * Central error types. Every failure surfaced to the user should be one of
 * these so the CLI can render a consistent, actionable message.
 */

export class RyuuError extends Error {
  constructor(message, { code = 'RYUU_ERROR', details, cause, retryable = false } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
    };
  }
}

export class ConfigError extends RyuuError {
  constructor(message, details) {
    super(message, { code: 'CONFIG_INVALID', details });
  }
}

export class ValidationError extends RyuuError {
  constructor(message, details) {
    super(message, { code: 'VALIDATION_FAILED', details });
  }
}

export class PathEscapeError extends RyuuError {
  constructor(message, details) {
    super(message, { code: 'PATH_ESCAPE', details });
  }
}

export class SecretFileError extends RyuuError {
  constructor(message, details) {
    super(message, { code: 'SECRET_FILE_BLOCKED', details });
  }
}

export class NotFoundError extends RyuuError {
  constructor(message, details) {
    super(message, { code: 'NOT_FOUND', details });
  }
}

export class FileChangedError extends RyuuError {
  constructor(message, details) {
    super(message, { code: 'FILE_CHANGED', details });
  }
}

export class ApprovalDeniedError extends RyuuError {
  constructor(message = 'Action denied by the user.', details) {
    super(message, { code: 'APPROVAL_DENIED', details });
  }
}

export class ToolNotFoundError extends RyuuError {
  constructor(name) {
    super(`Unknown tool: ${name}`, { code: 'UNKNOWN_TOOL' });
  }
}

export class ToolError extends RyuuError {
  constructor(message, details) {
    super(message, { code: 'TOOL_ERROR', details });
  }
}

export class SearchError extends RyuuError {
  constructor(message, { code = 'SEARCH_FAILED', status, retryable = false, details } = {}) {
    super(message, { code, retryable, details });
    this.status = status;
  }
}

export class FetchError extends RyuuError {
  constructor(message, { code = 'FETCH_FAILED', status, retryable = false, details } = {}) {
    super(message, { code, retryable, details });
    this.status = status;
  }
}

export class ProviderError extends RyuuError {
  constructor(message, { code = 'PROVIDER_ERROR', status, retryable = false, details, cause } = {}) {
    super(message, { code, retryable, details, cause });
    this.status = status;
  }
}

export class CancelledError extends RyuuError {
  constructor(message = 'Operation cancelled.') {
    super(message, { code: 'CANCELLED' });
  }
}

export class ProcessError extends RyuuError {
  constructor(message, details) {
    super(message, { code: 'PROCESS_ERROR', details });
  }
}

export class SessionError extends RyuuError {
  constructor(message, details) {
    super(message, { code: 'SESSION_ERROR', details });
  }
}

/** Human-friendly one-line description, including provider status when present. */
export function describeError(error) {
  if (!error) return 'Unknown error';
  const status = error.status ? ` (HTTP ${error.status})` : '';
  const code = error.code ? ` [${error.code}]` : '';
  return `${error.message || String(error)}${status}${code}`;
}

/** Full block including stack, intended for --debug or the log file. */
export function formatErrorBlock(error, { debug = false } = {}) {
  if (!error) return 'Unknown error';
  const lines = [describeError(error)];
  if (error.details) {
    lines.push(`Details: ${typeof error.details === 'string' ? error.details : JSON.stringify(error.details)}`);
  }
  if (debug && error.stack) lines.push(error.stack);
  else lines.push('Run with --debug (or press /doctor) for more diagnostics.');
  return lines.join('\n');
}

export function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'CANCELLED';
}

/**
 * True when a failure is worth another attempt.
 *
 * Two kinds qualify:
 *   - transient provider failures (network, timeout, 5xx, rate limit) that
 *     are flagged `retryable`;
 *   - a poisoned tool-call payload, which the agent repairs locally before
 *     replaying the request.
 *
 * Cancellation is never recoverable.
 */
export function isRecoverableError(error) {
  if (!error) return false;
  if (error instanceof CancelledError) return false;
  if (error.code === 'CANCELLED') return false;
  if (error.retryable === true) return true;
  return error.code === 'INVALID_TOOL_ARGUMENTS';
}
