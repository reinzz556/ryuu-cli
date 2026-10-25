import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRedactor } from '../utils/redaction.js';
import { SessionError } from '../utils/errors.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

export function createSessionId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

export function createSessionRecord({ task, model, workspace, id } = {}) {
  const now = new Date().toISOString();
  return {
    id: id || createSessionId(),
    task: task || '',
    model: model || '',
    workspace: workspace || '',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    steps: 0,
    durationMs: null,
    // Per-task model telemetry: how many calls, how long they took, how long
    // the first token took, and how many reads the worklog made unnecessary.
    modelCalls: 0,
    requestMs: 0,
    firstTokenMs: null,
    cachedReads: 0,
    metrics: {},
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    changedFiles: [],
    commands: [],
    issues: [],
    plan: '',
    transcript: [],
    // Conversation memory handed to the next task (user/assistant turns only).
    conversation: [],
  };
}

/**
 * Session store under `.ryuu/sessions` (gitignored). Stored transcript entries
 * are bounded previews only; full file contents and secrets are never persisted.
 */
export class SessionStore {
  constructor({ dir, secrets = [], logger = null }) {
    this.dir = dir;
    this.logger = logger;
    this.redact = createRedactor(secrets);
  }

  #fileFor(id) {
    if (!ID_PATTERN.test(id)) throw new SessionError(`Invalid session id: ${id}`, { id });
    return path.join(this.dir, `${id}.json`);
  }

  async #ensureDir() {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  /** Bound and redact a session before it touches disk. */
  sanitize(session) {
    const sanitized = {
      ...session,
      task: this.redact(String(session.task || '')).slice(0, 4000),
      plan: this.redact(String(session.plan || '')).slice(0, 4000),
      durationMs: Number.isFinite(session.durationMs) ? session.durationMs : null,
      modelCalls: Number(session.modelCalls) || 0,
      requestMs: Number(session.requestMs) || 0,
      firstTokenMs: Number.isFinite(session.firstTokenMs) ? session.firstTokenMs : null,
      cachedReads: Number(session.cachedReads) || 0,
      metrics: session.metrics && typeof session.metrics === 'object' ? { ...session.metrics } : {},
      worklog: this.#sanitizeWorklog(session.worklog),
      changedFiles: (session.changedFiles || []).slice(0, 500),
      commands: (session.commands || []).slice(0, 200).map((cmd) => ({
        ...cmd,
        argv: Array.isArray(cmd.argv) ? cmd.argv.map((part) => this.redact(String(part)).slice(0, 300)) : [],
        output: this.redact(String(cmd.output || '')).slice(0, 2000),
      })),
      issues: (session.issues || []).slice(0, 100).map((issue) => this.redact(String(issue)).slice(0, 1000)),
      conversation: (session.conversation || []).slice(-40).map((entry) => ({
        role: entry.role === 'assistant' ? 'assistant' : 'user',
        content: this.redact(String(entry.content || '')).slice(0, 4000),
      })),
      transcript: (session.transcript || []).slice(-200).map((entry) => ({
        role: entry.role,
        ...(entry.name ? { name: entry.name } : {}),
        ...(entry.ok !== undefined ? { ok: entry.ok } : {}),
        content: this.redact(String(entry.content || '')).slice(0, 4000),
        ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
        ...(entry.at ? { at: entry.at } : {}),
      })),
    };
    return sanitized;
  }

  /** Bounded, redacted worklog: enough to resume, small enough to store. */
  #sanitizeWorklog(worklog) {
    if (!worklog || typeof worklog !== 'object') return null;
    return {
      plan: this.redact(String(worklog.plan || '')).slice(0, 1500),
      files: (worklog.files || []).slice(-40).map((entry) => ({
        path: this.redact(String(entry?.path || '')).slice(0, 400),
        read: Boolean(entry?.read),
        changed: Boolean(entry?.changed),
        ranges: Array.isArray(entry?.ranges) ? entry.ranges.slice(-4) : [],
        mtimeMs: Number.isFinite(entry?.mtimeMs) ? entry.mtimeMs : null,
        totalLines: Number.isFinite(entry?.totalLines) ? entry.totalLines : null,
        lines: Number.isFinite(entry?.lines) ? entry.lines : null,
        tool: entry?.tool ? String(entry.tool).slice(0, 40) : null,
      })),
      commands: (worklog.commands || []).slice(-12).map((command) => ({
        argv: this.redact(String(command?.argv || '')).slice(0, 200),
        exitCode: command?.exitCode ?? null,
        durationMs: command?.durationMs ?? null,
        status: command?.status ? String(command.status).slice(0, 40) : null,
      })),
      findings: (worklog.findings || []).slice(-12).map((finding) => this.redact(String(finding)).slice(0, 300)),
      tasks: (worklog.tasks || []).slice(-6).map((entry) => ({
        task: this.redact(String(entry?.task || '')).slice(0, 160),
        status: String(entry?.status || '').slice(0, 40),
        changedFiles: (entry?.changedFiles || []).slice(0, 8).map((file) => this.redact(String(file)).slice(0, 400)),
      })),
    };
  }

  async save(session) {
    await this.#ensureDir();
    const sanitized = this.sanitize({ ...session, updatedAt: new Date().toISOString() });
    const file = this.#fileFor(sanitized.id);
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(sanitized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(tmp, file);
    this.logger?.debug('session saved', { id: sanitized.id, file });
    return sanitized;
  }

  async load(id) {
    const file = this.#fileFor(id);
    try {
      const text = await fsp.readFile(file, 'utf8');
      return JSON.parse(text);
    } catch (error) {
      if (error.code === 'ENOENT') throw new SessionError(`Session not found: ${id}`, { id });
      if (error instanceof SyntaxError) throw new SessionError(`Session file is corrupt: ${id}`, { id });
      throw new SessionError(`Cannot load session ${id}: ${error.message}`, { id });
    }
  }

  async list({ limit = 50 } = {}) {
    if (!fs.existsSync(this.dir)) return [];
    const entries = await fsp.readdir(this.dir);
    const sessions = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -5);
      if (!ID_PATTERN.test(id)) continue;
      try {
        const data = JSON.parse(await fsp.readFile(path.join(this.dir, entry), 'utf8'));
        sessions.push({
          id: data.id || id,
          task: (data.task || '').slice(0, 120),
          status: data.status,
          model: data.model,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          steps: data.steps || 0,
          durationMs: Number.isFinite(data.durationMs) ? data.durationMs : null,
          tokenUsage: data.tokenUsage || null,
          changedFiles: (data.changedFiles || []).length,
        });
      } catch {
        sessions.push({ id, task: '(unreadable session file)', status: 'corrupt', createdAt: null, updatedAt: null });
      }
    }
    sessions.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return sessions.slice(0, limit);
  }

  async delete(id) {
    const file = this.#fileFor(id);
    try {
      await fsp.unlink(file);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw new SessionError(`Cannot delete session ${id}: ${error.message}`, { id });
    }
  }

  async clear() {
    if (!fs.existsSync(this.dir)) return 0;
    const entries = await fsp.readdir(this.dir);
    let removed = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      await fsp.rm(path.join(this.dir, entry), { force: true });
      removed += 1;
    }
    return removed;
  }
}

/**
 * Project summary cache. The fingerprint covers manifests and directory shape,
 * so any relevant change invalidates the cached summary automatically.
 */
export class ProjectSummaryCache {
  constructor({ file, ttlMs = 0 }) {
    this.file = file;
    this.ttlMs = ttlMs;
  }

  fingerprint(workspace) {
    const hash = crypto.createHash('sha256');
    const manifests = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'pyproject.toml', 'go.mod', 'Cargo.toml'];
    for (const name of manifests) {
      const file = path.join(workspace, name);
      try {
        const stat = fs.statSync(file);
        hash.update(`${name}:${stat.size}:${stat.mtimeMs}`);
      } catch {
        hash.update(`${name}:-`);
      }
    }
    try {
      const top = fs.readdirSync(workspace, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith('.'))
        .map((entry) => `${entry.isDirectory() ? 'd' : 'f'}:${entry.name}`)
        .sort();
      hash.update(top.join('|'));
    } catch {
      hash.update('unreadable');
    }
    return hash.digest('hex').slice(0, 32);
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  get(workspace) {
    const cached = this.read();
    if (!cached) return null;
    const fingerprint = this.fingerprint(workspace);
    if (cached.fingerprint !== fingerprint) return null;
    if (this.ttlMs > 0 && Date.now() - new Date(cached.updatedAt).getTime() > this.ttlMs) return null;
    return cached;
  }

  set(workspace, summary) {
    const payload = {
      fingerprint: this.fingerprint(workspace),
      summary,
      updatedAt: new Date().toISOString(),
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      // Cache failures are never fatal.
    }
    return payload;
  }

  invalidate() {
    fs.rmSync(this.file, { force: true });
  }
}
