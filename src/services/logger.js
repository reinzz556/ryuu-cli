import fs from 'node:fs';
import path from 'node:path';
import { createRedactor } from '../utils/redaction.js';

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_REASONING_CHARS = 2_000_000;

/**
 * Leveled logger. Everything written to the log file and to stderr passes
 * through the redactor first. Model output and tool output are logged as
 * bounded previews, never full credential material.
 */
export class Logger {
  constructor({ level = 'info', file = null, secrets = [], stderr = null, echo = false, maxPreview = 2000 } = {}) {
    this.level = LEVELS[level] ?? LEVELS.info;
    this.levelName = level;
    this.file = file;
    this.stderr = stderr;
    this.echo = echo;
    this.maxPreview = maxPreview;
    this.redact = createRedactor(secrets);
    this.enabled = this.level < LEVELS.silent;
    if (this.file && this.enabled) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        this.#restrictPermissions();
        this.#rotateIfNeeded();
      } catch (error) {
        this.file = null;
        this.stderr?.write(`[warn] Cannot create log file: ${error.message}\n`);
      }
    }
  }

  get logFile() {
    return this.file;
  }

  setLevel(level) {
    if (LEVELS[level] === undefined) return;
    this.level = LEVELS[level];
    this.levelName = level;
    this.enabled = this.level < LEVELS.silent;
  }

  child(bindings = {}) {
    const logger = Object.create(this);
    logger.bindings = { ...(this.bindings || {}), ...bindings };
    logger.child = Logger.prototype.child;
    logger.log = Logger.prototype.log;
    logger.writeLine = Logger.prototype.writeLine;
    return logger;
  }

  debug(message, meta) {
    this.log('debug', message, meta);
  }

  info(message, meta) {
    this.log('info', message, meta);
  }

  warn(message, meta) {
    this.log('warn', message, meta);
  }

  error(message, meta) {
    this.log('error', message, meta);
  }

  log(level, message, meta) {
    if (LEVELS[level] < this.level) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: this.#preview(message),
      ...(this.bindings || {}),
    };
    if (meta !== undefined) {
      entry.meta = this.#sanitizeMeta(meta);
    }
    this.writeLine(entry);
  }

  #preview(value) {
    const text = typeof value === 'string' ? value : safeStringify(value);
    const bounded = text.length > this.maxPreview ? `${text.slice(0, this.maxPreview)}…[truncated]` : text;
    return this.redact(bounded);
  }

  #sanitizeMeta(meta) {
    const text = safeStringify(meta);
    const bounded = text.length > this.maxPreview ? `${text.slice(0, this.maxPreview)}…[truncated]` : text;
    const cleaned = this.redact(bounded);
    try {
      return JSON.parse(cleaned);
    } catch {
      return cleaned;
    }
  }

  /**
   * Persist provider-exposed reasoning separately from the main log. The text
   * is redacted and bounded; the returned path is safe to show in the UI.
   */
  writeReasoning({ sessionId = 'session', step = null, text = '' } = {}) {
    if (!this.file || !this.enabled || !text) return null;
    const safeId = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'session';
    const dir = path.join(path.dirname(this.file), 'reasoning');
    const file = path.join(dir, `reasoning-${safeId}.log`);
    const clean = this.redact(String(text));
    const body = clean.length > MAX_REASONING_CHARS
      ? `${clean.slice(0, MAX_REASONING_CHARS)}\n…[reasoning truncated at ${MAX_REASONING_CHARS} chars]`
      : clean;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(dir, 0o700);
          if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
        } catch {
          // Non-fatal; the text is still redacted.
        }
      }
      const header = `\n=== step ${step ?? '?'} · ${new Date().toISOString()} ===\n`;
      fs.appendFileSync(file, `${header}${body}\n`, { encoding: 'utf8', mode: 0o600 });
      return file;
    } catch (error) {
      this.stderr?.write(`[warn] Cannot write reasoning log: ${error.message}\n`);
      return null;
    }
  }

  writeLine(entry) {
    const line = this.redact(safeStringify(entry));
    if (this.file && this.enabled) {
      try {
        fs.appendFileSync(this.file, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
      } catch {
        // Logging must never crash the agent; keep stderr usable instead.
      }
    }
    if (this.echo && this.stderr) {
      this.stderr.write(`${line}\n`);
    }
  }

  /** Logs may contain workspace excerpts, so keep them owner-only on POSIX. */
  #restrictPermissions() {
    if (!this.file || process.platform === 'win32') return;
    try {
      fs.chmodSync(path.dirname(this.file), 0o700);
      if (fs.existsSync(this.file)) fs.chmodSync(this.file, 0o600);
    } catch {
      // Non-fatal: the log is still redacted even if chmod is unavailable.
    }
  }

  #rotateIfNeeded() {
    if (!this.file || !fs.existsSync(this.file)) return;
    const stat = fs.statSync(this.file);
    if (stat.size < MAX_LOG_BYTES) return;
    const backup = `${this.file}.1`;
    fs.rmSync(backup, { force: true });
    fs.renameSync(this.file, backup);
  }
}

export function createLogger(config, { stderr = process.stderr, secrets = [], echo = false } = {}) {
  return new Logger({
    level: config.logLevel,
    file: config.logDir ? path.join(config.logDir, 'agent.log') : null,
    secrets: [config.apiKey, ...secrets].filter(Boolean),
    stderr,
    echo,
  });
}

function safeStringify(value) {
  if (value instanceof Error) {
    return JSON.stringify({ name: value.name, message: value.message, code: value.code, stack: value.stack });
  }
  try {
    return JSON.stringify(value, (key, item) => (typeof item === 'bigint' ? item.toString() : item));
  } catch {
    return String(value);
  }
}
