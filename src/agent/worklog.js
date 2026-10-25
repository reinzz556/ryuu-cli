/**
 * Session worklog — the facts the agent has already established.
 *
 * The conversation is the model's short-term memory, but it is bounded,
 * compacted, and dropped between tasks. That forced the agent to re-read the
 * same files and re-derive the same conclusions on every follow-up task, which
 * was the single largest source of wasted time and tokens.
 *
 * This module keeps a small, deterministic record of *verified* work — which
 * files were read (and which line ranges), which files changed, which commands
 * ran with which exit codes, and what the agent planned — so the next request
 * can be told "you already know this" instead of asking it to start over.
 *
 * Nothing here is model-generated: every entry comes from a real tool result.
 */

const MAX_FILES = 40;
const MAX_COMMANDS = 12;
const MAX_FINDINGS = 12;
const MAX_TASKS = 6;
const MAX_BRIEF_CHARS = 6000;

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const formatDuration = (ms) => {
  const value = Number(ms || 0);
  if (value < 1000) return `${value}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.floor(value / 60000)}m${Math.round((value % 60000) / 1000)}s`;
};

export class Worklog {
  constructor({ maxChars = MAX_BRIEF_CHARS } = {}) {
    this.maxChars = maxChars;
    this.files = new Map();
    this.commands = [];
    this.findings = [];
    this.tasks = [];
    this.plan = '';
  }

  reset() {
    this.files.clear();
    this.commands = [];
    this.findings = [];
    this.tasks = [];
    this.plan = '';
  }

  get size() {
    return this.files.size + this.commands.length + this.findings.length;
  }

  /** A file entry, or null when the path was never seen in this session. */
  file(relPath) {
    if (!relPath) return null;
    return this.files.get(String(relPath).split('\\').join('/')) || null;
  }

  /**
   * True when re-reading this exact path/range cannot produce new information:
   * the file was read before, the same range was requested, and the file's
   * mtime has not changed since.
   */
  canSkipRead(relPath, { startLine = 1, endLine = null, mtimeMs = null } = {}) {
    const entry = this.file(relPath);
    if (!entry || !entry.read) return false;
    if (!entry.ranges.some(([start, end]) => start === startLine && (endLine === null || end === endLine))) {
      return false;
    }
    // Unknown freshness is never treated as fresh: re-reading a file that may
    // have changed is cheaper than acting on a stale snapshot.
    if (mtimeMs === null || mtimeMs === undefined || entry.mtimeMs === null) return false;
    return Number(mtimeMs) === Number(entry.mtimeMs);
  }

  recordPlan(plan) {
    const value = String(plan || '').trim();
    if (!value) return;
    this.plan = value.slice(0, 1500);
  }

  note(finding) {
    const value = clean(finding, 300);
    if (!value || this.findings.includes(value)) return;
    this.findings.push(value);
    if (this.findings.length > MAX_FINDINGS) this.findings.shift();
  }

  recordRead({ path: relPath, startLine = 1, endLine = null, totalLines = null, mtimeMs = null } = {}) {
    const key = this.#key(relPath);
    if (!key) return;
    const entry = this.files.get(key) || { path: key, read: false, changed: false, ranges: [], mtimeMs: null, totalLines: null, tool: 'read_file' };
    entry.read = true;
    entry.tool = 'read_file';
    entry.totalLines = totalLines ?? entry.totalLines;
    if (mtimeMs !== null && mtimeMs !== undefined) entry.mtimeMs = Number(mtimeMs);
    const end = endLine ?? totalLines ?? startLine;
    if (!entry.ranges.some(([start, stop]) => start === startLine && stop === end)) {
      entry.ranges.push([startLine, end]);
      if (entry.ranges.length > 8) entry.ranges.shift();
    }
    this.files.set(key, entry);
    this.#trimFiles();
  }

  recordChange({ path: relPath, tool = 'write_file', lines = null, mtimeMs = null } = {}) {
    const key = this.#key(relPath);
    if (!key) return;
    const entry = this.files.get(key) || { path: key, read: false, changed: false, ranges: [], mtimeMs: null, totalLines: null, tool };
    entry.changed = true;
    entry.tool = tool;
    if (lines !== null && lines !== undefined) entry.lines = Number(lines);
    if (mtimeMs !== null && mtimeMs !== undefined) entry.mtimeMs = Number(mtimeMs);
    // After an edit the earlier read is stale: a verification read is allowed.
    entry.read = false;
    entry.ranges = [];
    this.files.set(key, entry);
    this.#trimFiles();
  }

  recordCommand({ argv = [], exitCode = null, durationMs = null, status = null } = {}) {
    const text = Array.isArray(argv) ? argv.join(' ') : String(argv || '');
    if (!text) return;
    this.commands.push({
      argv: text.slice(0, 200),
      exitCode: exitCode === undefined ? null : exitCode,
      durationMs: durationMs === undefined ? null : durationMs,
      status: status || (exitCode === 0 ? 'ok' : 'failed'),
    });
    if (this.commands.length > MAX_COMMANDS) this.commands.shift();
  }

  recordTask({ task = '', status = '', changedFiles = [] } = {}) {
    const entry = {
      task: clean(task, 140),
      status: clean(status, 30),
      changedFiles: (changedFiles || []).slice(0, 8),
    };
    if (!entry.task) return;
    this.tasks.push(entry);
    if (this.tasks.length > MAX_TASKS) this.tasks.shift();
  }

  /** Feed a successful tool result into the worklog. */
  recordToolResult(name, args = {}, result = {}) {
    if (!result || typeof result !== 'object') return;
    if (name === 'read_file' && result.path) {
      this.recordRead({
        path: result.path,
        startLine: result.start_line,
        endLine: result.end_line,
        totalLines: result.total_lines,
        mtimeMs: result.mtime_ms ?? args.expected_mtime_ms ?? null,
      });
      return;
    }
    if (name === 'file_info' && result.path) {
      const entry = this.file(result.path);
      if (entry) {
        if (result.mtime_ms !== undefined) entry.mtimeMs = Number(result.mtime_ms);
        if (result.lines !== undefined) entry.totalLines = Number(result.lines);
      }
      return;
    }
    if (name === 'edit_file' && result.path) {
      this.recordChange({ path: result.path, tool: name, lines: result.lines, mtimeMs: result.mtime_ms });
      return;
    }
    if ((name === 'write_file' || name === 'create_file') && (result.relPath || result.path)) {
      this.recordChange({ path: result.relPath || result.path, tool: name, lines: result.lines, mtimeMs: result.mtime_ms });
      return;
    }
    if (name === 'move_file') {
      if (result.from) this.recordChange({ path: result.from, tool: 'delete_file' });
      if (result.to) this.recordChange({ path: result.to, tool: 'create_file' });
      return;
    }
    if (name === 'delete_file' && result.relPath) {
      this.recordChange({ path: result.relPath, tool: 'delete_file' });
      return;
    }
    if (name === 'run_command') {
      this.recordCommand({ argv: result.argv || args.argv, exitCode: result.exit_code, durationMs: result.duration_ms, status: result.status });
      return;
    }
    if (name === 'search_files') {
      const query = args.query || args.pattern || args.text || '';
      const count = result.count ?? result.matches?.length ?? 0;
      if (query) this.note(`search_files "${clean(query, 80)}" -> ${count} match(es)`);
      return;
    }
    if (name === 'project_summary') {
      this.note(`project_summary: ${result.name || 'unnamed'} · ${result.totalFilesScanned ?? 0} files scanned`);
      return;
    }
    if (name === 'read_url') {
      const url = clean(result.final_url || result.url || args.url || '', 160);
      if (url) {
        const via = result.extraction === 'mcp' && result.provider ? ` · via ${result.provider} MCP` : '';
        this.note(`read_url ${url} -> HTTP ${result.status ?? '?'} · ${(result.text || '').length} chars${via}`);
      }
      return;
    }
    if (name === 'web_search') {
      const query = clean(args.query || result.query || '', 80);
      if (!query) return;
      const count = result.result_count ?? result.results?.length ?? 0;
      const provider = result.provider ? ` · provider: ${result.provider}` : '';
      const fallback = result.fallback_used ? ' · fallback' : '';
      const top = result.results?.[0]?.url ? ` · top: ${clean(result.results[0].url, 120)}` : '';
      this.note(`web_search "${query}" -> ${count} result(s)${provider}${fallback}${top}`);
    }
  }

  /**
   * The brief handed to the model once per task. It is deliberately short and
   * factual: paths, line ranges, exit codes — the things that stop a re-read.
   */
  brief({ maxChars = this.maxChars, budget = null } = {}) {
    const lines = ['SESSION WORKLOG — verified facts from earlier work in this session.'];
    lines.push('Treat these as ground truth. Do not re-analyse, re-list, or re-read them unless the file changed on disk.');

    const changed = [...this.files.values()].filter((entry) => entry.changed);
    const read = [...this.files.values()].filter((entry) => entry.read && !entry.changed);
    if (changed.length > 0) {
      lines.push('', 'FILES YOU ALREADY CHANGED (verify narrowly or run a test — do not read them back in full):');
      for (const entry of changed.slice(-16)) {
        lines.push(`- ${entry.path} · ${entry.tool}${entry.lines ? ` · ${entry.lines} lines` : ''}`);
      }
    }
    if (read.length > 0) {
      lines.push('', 'FILES ALREADY READ (content was sent earlier — reuse it instead of reading again):');
      for (const entry of read.slice(-16)) {
        const ranges = entry.ranges.slice(-3).map(([start, end]) => `${start}-${end}`).join(', ') || 'all';
        lines.push(`- ${entry.path} · lines ${ranges}${entry.totalLines ? ` of ${entry.totalLines}` : ''}`);
      }
    }
    if (this.commands.length > 0) {
      lines.push('', 'COMMANDS ALREADY RUN (re-running the same argv cannot produce new information):');
      for (const command of this.commands.slice(-8)) {
        const exit = command.exitCode === null || command.exitCode === undefined ? '?' : command.exitCode;
        lines.push(`- ${command.argv} -> exit ${exit}${command.durationMs ? ` (${formatDuration(command.durationMs)})` : ''}`);
      }
    }
    if (this.findings.length > 0) {
      lines.push('', 'FINDINGS ALREADY ESTABLISHED:');
      for (const finding of this.findings.slice(-8)) lines.push(`- ${finding}`);
    }
    if (this.plan) {
      lines.push('', 'PLAN IN PROGRESS (continue it, do not start a new one):', ...this.plan.split('\n').slice(0, 8).map((line) => `- ${line.trim()}`));
    }
    if (this.tasks.length > 0) {
      lines.push('', 'EARLIER TASKS IN THIS SESSION:');
      for (const entry of this.tasks.slice(-4)) {
        lines.push(`- "${entry.task}" -> ${entry.status}${entry.changedFiles.length ? ` · changed: ${entry.changedFiles.join(', ')}` : ''}`);
      }
    }
    if (budget) lines.push('', `BUDGET REMAINING: ${budget}`);
    return lines.join('\n').slice(0, maxChars);
  }

  /** Serializable, bounded snapshot for the session file. */
  toJSON() {
    return {
      files: [...this.files.values()].slice(-MAX_FILES).map((entry) => ({
        path: entry.path,
        read: Boolean(entry.read),
        changed: Boolean(entry.changed),
        ranges: entry.ranges.slice(-4),
        mtimeMs: entry.mtimeMs ?? null,
        totalLines: entry.totalLines ?? null,
        lines: entry.lines ?? null,
        tool: entry.tool || null,
      })),
      commands: this.commands.slice(-MAX_COMMANDS),
      findings: this.findings.slice(-MAX_FINDINGS),
      tasks: this.tasks.slice(-MAX_TASKS),
      plan: this.plan,
    };
  }

  static fromJSON(data) {
    const log = new Worklog();
    if (!data || typeof data !== 'object') return log;
    for (const entry of data.files || []) {
      if (!entry?.path) continue;
      log.files.set(entry.path, {
        path: entry.path,
        read: Boolean(entry.read),
        changed: Boolean(entry.changed),
        ranges: Array.isArray(entry.ranges) ? entry.ranges.filter(Array.isArray).slice(-4) : [],
        mtimeMs: entry.mtimeMs ?? null,
        totalLines: entry.totalLines ?? null,
        lines: entry.lines ?? null,
        tool: entry.tool || null,
      });
    }
    log.commands = Array.isArray(data.commands) ? data.commands.slice(-MAX_COMMANDS) : [];
    log.findings = Array.isArray(data.findings) ? data.findings.slice(-MAX_FINDINGS) : [];
    log.tasks = Array.isArray(data.tasks) ? data.tasks.slice(-MAX_TASKS) : [];
    log.plan = String(data.plan || '');
    return log;
  }

  #key(relPath) {
    const value = String(relPath || '').trim().split('\\').join('/').replace(/^\.\//, '');
    if (!value) return '';
    return value.slice(0, 400);
  }

  #trimFiles() {
    while (this.files.size > MAX_FILES) {
      const oldest = this.files.keys().next().value;
      this.files.delete(oldest);
    }
  }
}
