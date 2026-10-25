import fsp from 'node:fs/promises';
import { ApprovalManager } from './approvals.js';
import { buildSystemPrompt, buildTaskBrief, buildToolCatalog, extractPlan, summarizeToolResult } from './planner.js';
import { Worklog } from './worklog.js';
import { compactMessages, conversationChars } from './context.js';
import { CancelledError, RyuuError, describeError, isRecoverableError } from '../utils/errors.js';
import { parseToolArguments, toToolArgumentsString, validateSchema } from '../utils/validation.js';
import { createSessionRecord } from '../services/sessions.js';
import { createUnifiedDiff } from '../services/diff.js';
import { buildProjectSummary } from '../tools/project.js';

const UNDO_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'create_file']);
const CHANGE_TOOLS = new Set(['write_file', 'edit_file', 'create_file', 'move_file', 'delete_file']);

/** How many times an identical failing call may be repeated before it is blocked. */
const MAX_REPEATED_FAILURES = 2;

const nowIso = () => new Date().toISOString();

const WRITE_TOOLS = new Set(['create_file', 'write_file', 'edit_file', 'move_file', 'delete_file']);

/** One short, human label for what a tool is about to touch. */
function describeToolTarget(name, args = {}) {
  if (name === 'run_command') {
    const argv = Array.isArray(args.argv) ? args.argv.join(' ') : String(args.shell_command || '');
    return argv.slice(0, 120);
  }
  if (name === 'start_process') return (args.argv || []).join(' ').slice(0, 120);
  if (name === 'search_files' || name === 'web_search') return String(args.query || args.pattern || '').slice(0, 90);
  if (name === 'read_url') return String(args.url || '').slice(0, 120);
  if (name === 'list_files' || name === 'tree') return String(args.path || '.').slice(0, 80);
  if (name === 'move_file') return `${args.from} -> ${args.to}`.slice(0, 120);
  if (args.path) {
    const lineRange = args.start_line || args.end_line ? ` lines ${args.start_line || 1}-${args.end_line || 'end'}` : '';
    return `${args.path}${lineRange}`.slice(0, 120);
  }
  return '';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sleep that rejects as soon as the task is cancelled. */
function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError('Task cancelled by user.'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError('Task cancelled by user.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wording that gets an empty model turn going again. Rotated so a model that
 * keeps replying with nothing is not told the exact same thing forever.
 */
function emptyResponseNudge(attempt) {
  const nudges = [
    'Your previous response was empty. Continue the task, use a tool, or give a final answer.',
    'The response was empty again. Reply with either a tool call or the final answer as text — never an empty turn.',
    'Still empty. Do not send an empty message: if the task is finished, write the result now; otherwise call the next tool.',
    'Empty response repeated. State the next concrete action and call the tool for it, or deliver the final answer.',
  ];
  return nudges[Math.min(Math.max(0, attempt - 1), nudges.length - 1)];
}

/**
 * Replace invalid `function.arguments` in a message history with valid JSON.
 *
 * The provider re-validates every tool call it receives, so a single broken
 * payload makes the whole next request fail with a 400. Repairing it in place
 * keeps the conversation usable and the task alive.
 *
 * @returns {number} how many calls were repaired
 */
function repairMessageHistory(messages = []) {
  let repaired = 0;
  for (const message of messages) {
    if (!message || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      const fn = call?.function;
      if (!fn) continue;
      const original = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
      const fixed = toToolArgumentsString(original);
      if (fixed !== original) {
        fn.arguments = fixed;
        repaired += 1;
      }
    }
  }
  return repaired;
}

/**
 * The autonomous loop:
 *   model -> tool calls -> validation -> approval -> real execution ->
 *   tool results -> model -> ... until final answer / limit / cancel.
 *
 * Tools always run sequentially, so two calls can never race on the same file.
 */
export class Agent {
  constructor({
    provider,
    registry,
    workspace,
    config,
    renderer = {},
    logger = null,
    approvals = null,
    sessionStore = null,
    undo = null,
    projectSummary = null,
    processes = null,
  }) {
    if (!provider) throw new Error('Agent requires a provider.');
    if (!registry) throw new Error('Agent requires a tool registry.');
    if (!workspace) throw new Error('Agent requires a workspace.');
    this.provider = provider;
    this.registry = registry;
    this.workspace = workspace;
    this.config = config;
    this.renderer = renderer;
    this.logger = logger;
    this.approvals = approvals || new ApprovalManager({ policy: config.approvalPolicy, logger, interactive: false });
    this.sessionStore = sessionStore;
    this.undo = undo;
    this.projectSummary = projectSummary;
    this.processes = processes;
    this.session = null;
    // Conversation memory shared by every task in this process.
    this.conversation = [];
    // Verified facts (files read/changed, commands, findings, plan) shared by
    // every task in this session. This is what stops a follow-up task from
    // re-reading and re-analysing work the agent already did.
    this.worklog = new Worklog();
    // The session prompt is assembled once and reused byte-for-byte.
    this.systemMessage = null;
    this.#systemPromptSource = null;
  }

  #systemPromptSource = null;

  /** Drop all remembered turns and the verified worklog. */
  clearMemory() {
    this.conversation = [];
    this.worklog.reset();
  }

  /** Verified session facts, exposed for /worklog and /memory. */
  getWorklog() {
    return this.worklog;
  }

  /**
   * Point the loop at another provider (used by /provider). The conversation
   * memory and worklog stay untouched, so a switch never loses context.
   */
  setProvider(provider) {
    if (!provider) throw new Error('Agent requires a provider.');
    this.provider = provider;
  }

  /**
   * Replace the remembered turns (used by /resume to restore a saved session).
   * A saved worklog can be restored with it so the agent resumes with the same
   * verified facts instead of re-reading every file.
   */
  setConversation(entries, { worklog = null } = {}) {
    this.conversation = Array.isArray(entries)
      ? entries
          .filter((entry) => entry && (entry.role === 'user' || entry.role === 'assistant'))
          .map((entry) => ({ role: entry.role, content: String(entry.content || '').slice(0, 8000) }))
      : [];
    this.worklog = worklog ? Worklog.fromJSON(worklog) : new Worklog();
    this.#boundConversation();
  }

  /** A read-only view of the remembered turns. */
  getConversation() {
    return this.conversation.map((entry) => ({ ...entry }));
  }

  /**
   * Remember a shell command the user ran themselves (`/bash`, `!cmd`).
   *
   * It becomes a user turn in the shared conversation, so the next task knows
   * what happened outside the model's own tool calls (tests run, files listed,
   * a deploy attempted) instead of asking the user to repeat it. Output is
   * bounded: this is context, not a log file.
   */
  recordUserShell({ command, cwd = '.', stdout = '', stderr = '', exitCode = null, durationMs = 0, truncated = false } = {}) {
    const text = String(command ?? '').trim();
    if (!text) return false;
    const output = [stdout, stderr]
      .map((part) => String(part ?? '').trimEnd())
      .filter((part) => part.length > 0)
      .join('\n');
    const bounded = output.length > 4000 ? `${output.slice(0, 4000)}\n… (output truncated for context)` : output;
    this.conversation.push({
      role: 'user',
      content: [
        `[user shell] $ ${text}`,
        `[cwd ${cwd}] exit ${exitCode ?? '?'} · ${Math.round(Number(durationMs) || 0)}ms${truncated ? ' · output truncated' : ''}`,
        bounded || '(no output)',
      ].join('\n'),
    });
    this.worklog.recordCommand({
      argv: ['sh', '-c', text],
      exitCode: Number.isInteger(exitCode) ? exitCode : null,
      durationMs: Number(durationMs) || null,
      status: 'user',
    });
    this.#boundConversation();
    return true;
  }

  /**
   * Remember one finished task so the next task can build on it.
   *
   * Only user/assistant text is kept — never raw tool messages — so the stored
   * history is always valid for the provider and stays small. The evidence line
   * preserves which files changed and which commands ran.
   */
  #remember(task, finalText, { status, changedFiles = [], commands = [] } = {}) {
    if (!task) return;
    const files = changedFiles.slice(0, 12);
    const ran = commands.slice(-5).map((cmd) => {
      const argv = Array.isArray(cmd.argv) ? cmd.argv.join(' ') : String(cmd.argv || '');
      return `${argv} -> exit ${cmd.exitCode ?? '?'}`;
    });
    const evidence = [files.length > 0 ? `files: ${files.join(', ')}` : '', ran.length > 0 ? `commands: ${ran.join('; ')}` : '']
      .filter(Boolean)
      .join(' · ');
    const reply = [
      finalText || `(no final answer; task ended with status: ${status})`,
      evidence ? `[evidence] status=${status} · ${evidence}` : `[evidence] status=${status}`,
    ].join('\n');
    this.conversation.push({ role: 'user', content: task }, { role: 'assistant', content: reply });
    this.worklog.recordTask({ task, status, changedFiles });
    this.#boundConversation();
  }

  /** Keep memory inside half of AGENT_MAX_CONTEXT_CHARS so a task still fits. */
  #boundConversation() {
    const budget = Math.max(2000, Math.floor(Number(this.config.maxContextChars) / 2));
    while (this.conversation.length > 4 && conversationChars(this.conversation) > budget) {
      this.conversation.splice(0, 2);
    }
    if (this.conversation.length > 100) {
      this.conversation.splice(0, this.conversation.length - 100);
    }
  }

  #emit(event, payload) {
    const fn = this.renderer?.[event];
    if (typeof fn === 'function') {
      try {
        fn.call(this.renderer, payload);
      } catch (error) {
        this.logger?.warn('renderer error', { event, error: error.message });
      }
    }
  }

  /**
   * Ask the model, with a heartbeat and automatic reconnection.
   *
   * A provider failure is not the end of the task: the link is re-established
   * with a bounded exponential backoff while the UI keeps beating, so the run
   * continues as soon as the API answers again. A history poisoned by an
   * invalid tool payload is repaired before the retry, because the provider
   * re-validates the whole conversation on every request.
   */
  async #requestModel(messages, { step, signal, onReasoning, onContent, onFirstToken = null, deadline, timeoutMs = null }) {
    // 0 means unlimited: the heartbeat keeps reconnecting until the provider
    // answers, the task deadline is reached, or the user cancels. A positive
    // value still caps the attempts for anyone who wants a hard stop.
    const configured = Number(this.config.maxRecoveryAttempts ?? 0);
    const maxAttempts = Number.isFinite(configured) && configured > 0 ? configured : Infinity;
    const attemptLabel = Number.isFinite(maxAttempts) ? maxAttempts : 0;
    const baseDelay = Math.max(100, Number(this.config.recoveryBackoffMs ?? 1000));
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) throw new CancelledError('Task cancelled by user.');
      try {
        // Capabilities are declared per provider; never assume every endpoint
        // supports tools or streaming, and never claim reasoning we did not get.
        const capabilities = this.provider.capabilities || null;
        const tools = capabilities?.tools === false ? [] : this.registry.toOpenAITools();
        const response = await this.provider.chat({
          messages,
          tools,
          signal,
          stream: capabilities?.streaming !== false,
          onReasoning,
          onContent,
          onFirstToken,
          // A stream that stops producing bytes is aborted instead of waiting
          // for the request timeout, so a hung provider is reported, not slept on.
          stallTimeoutMs: this.config.streamIdleTimeoutMs ?? 0,
          timeoutMs: timeoutMs ?? undefined,
        });
        if (attempt > 0) {
          this.#emit('heartbeat', {
            phase: 'restored',
            step,
            attempt,
            maxAttempts: attemptLabel,
            message: 'Provider link restored — the run continues.',
          });
        }
        return response;
      } catch (error) {
        if (error instanceof CancelledError || signal?.aborted) throw error;
        if (attempt >= maxAttempts || !isRecoverableError(error)) throw error;
        attempt += 1;
        if (error.code === 'INVALID_TOOL_ARGUMENTS') {
          const repaired = repairMessageHistory(messages);
          if (repaired > 0) {
            this.logger?.warn('repaired invalid tool-call arguments in history', { count: repaired });
          }
        }
        const delayMs = Math.min(30000, baseDelay * 2 ** (attempt - 1));
        if (deadline && Date.now() + delayMs > deadline) {
          // No time left to reconnect: surface the original failure.
          throw error;
        }
        this.#emit('heartbeat', {
          phase: 'retry',
          step,
          attempt,
          maxAttempts: attemptLabel,
          delayMs,
          code: error.code || 'PROVIDER_ERROR',
          message: error.message,
        });
        this.logger?.warn('provider recovery attempt', {
          code: error.code,
          attempt,
          maxAttempts: attemptLabel || 'unlimited',
          delayMs,
        });
        await abortableDelay(delayMs, signal);
      }
    }
  }

  /**
   * The project summary (manifest, scripts, language mix) used by the system
   * prompt. The host usually provides it; when it does not, it is built once
   * and cached so the model always knows the project's own commands.
   */
  async #projectSummary() {
    if (this.projectSummary !== undefined && this.projectSummary !== null) return this.projectSummary;
    try {
      this.projectSummary = await buildProjectSummary({ workspace: this.workspace });
    } catch (error) {
      this.logger?.warn('project summary unavailable', { error: error.message });
      this.projectSummary = null;
    }
    return this.projectSummary;
  }

  /**
   * The session prompt, assembled once and reused byte-for-byte.
   *
   * Rebuilding it per request did not change its content, but it re-serialized
   * the project summary and tool catalog on every step and made the prefix
   * unstable for provider-side caching. It is now built on the first request of
   * the session and only rebuilt if the host swaps the project summary.
   */
  async #systemPrompt() {
    const projectSummary = await this.#projectSummary();
    if (this.systemMessage && this.#systemPromptSource === projectSummary) return this.systemMessage;
    this.systemMessage = buildSystemPrompt({
      workspace: this.workspace.root,
      config: this.config,
      projectSummary,
      toolCatalog: buildToolCatalog(this.registry),
    });
    this.#systemPromptSource = projectSummary;
    return this.systemMessage;
  }

  /** The step/wall-clock budget shown in the task brief and near the deadline. */
  #budgetText({ stepLimit, deadline, modelCalls = 0 }) {
    const secondsLeft = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const steps = Number.isFinite(stepLimit) ? `up to ${stepLimit} steps` : 'unlimited steps';
    return `${steps} · ${secondsLeft}s of wall clock left · ${modelCalls} model call(s) made so far`;
  }

  /** Current mtime of a workspace path, or null when it cannot be stat'ed. */
  async #mtimeOf(relPath) {
    try {
      const resolved = this.workspace.resolve(relPath);
      const stat = await fsp.stat(resolved.absPath);
      return stat.mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * Keep the worklog in sync with a successful tool result. Reads are stamped
   * with the real mtime so "already read" can never hide a file that changed on
   * disk in the meantime.
   */
  async #noteWorklog(name, args, result) {
    if (!result || typeof result !== 'object') return;
    this.worklog.recordToolResult(name, args, result);
    if (name === 'read_file' && result.path) {
      const mtimeMs = await this.#mtimeOf(result.path);
      if (mtimeMs !== null) {
        this.worklog.recordRead({
          path: result.path,
          startLine: result.start_line,
          endLine: result.end_line,
          totalLines: result.total_lines,
          mtimeMs,
        });
      }
    }
  }

  async #captureBefore(name, args) {
    if (!this.undo || !['write_file', 'edit_file', 'delete_file'].includes(name)) return null;
    try {
      const file = await this.workspace.readText(args.path, { maxBytes: this.config.maxFileBytes });
      return { content: file.text };
    } catch (error) {
      if (error.code === 'NOT_FOUND') return { content: null };
      return null;
    }
  }

  async #recordUndo(name, args, result, before) {
    if (!this.undo) return;
    try {
      if (name === 'create_file') {
        this.undo.record({ kind: 'write', path: result.relPath, before: null, after: args.content });
      } else if (name === 'write_file' || name === 'edit_file') {
        const current = await this.workspace.readText(result.relPath || args.path);
        this.undo.record({
          kind: 'write',
          path: current.relPath,
          before: before?.content ?? null,
          after: current.text,
        });
      } else if (name === 'delete_file' && result.kind !== 'directory' && before?.content != null) {
        this.undo.record({ kind: 'delete', path: result.relPath, before: before.content });
      } else if (name === 'move_file') {
        this.undo.record({ kind: 'move', path: result.from, to: result.to });
      }
    } catch (error) {
      this.logger?.warn('failed to record undo snapshot', { tool: name, error: error.message });
    }
  }

  /**
   * The exact lines a file change produced, so the UI can show the user what
   * was rewritten (and they can cancel and correct it).
   */
  #fileDiffPayload(name, args, result, before) {
    if (!CHANGE_TOOLS.has(name) || !result) return null;
    const relPath = result.relPath || result.path || args?.path;
    if (!relPath) return null;
    if (name === 'move_file') {
      return { kind: 'move', path: result.to || relPath, from: result.from, to: result.to, added: 0, removed: 0, diff: '' };
    }
    if (name === 'delete_file') {
      return { kind: 'delete', path: relPath, added: 0, removed: 0, diff: '' };
    }
    let diff = '';
    if (name === 'edit_file' && typeof result.diff === 'string' && result.diff) {
      diff = result.diff;
    } else {
      const older = before?.content ?? '';
      const newer = typeof args?.content === 'string' ? args.content : '';
      if (older !== newer) {
        diff = createUnifiedDiff(older, newer, {
          oldLabel: `a/${relPath}`,
          newLabel: `b/${relPath}`,
          maxLines: 160,
        });
      }
    }
    let added = 0;
    let removed = 0;
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
    const kind = name === 'create_file' ? 'create' : name === 'write_file' ? 'write' : 'edit';
    return { kind, path: relPath, diff: diff.slice(0, 20000), added, removed };
  }

  #trackResult(name, args, result, session, taskProcesses) {
    if (CHANGE_TOOLS.has(name)) {
      const changed = result.relPath || result.to || result.path || args.path || args.from;
      if (changed) session.changedFiles = [...new Set([...session.changedFiles, changed])];
    }
    if (name === 'run_command') {
      session.commands.push({
        argv: result.argv || args.argv || [],
        status: result.status,
        exitCode: result.exit_code,
        durationMs: result.duration_ms,
        timedOut: result.timed_out,
        output: `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`.slice(-2000),
      });
      if (session.commands.length > 50) session.commands.shift();
    }
    if (name === 'start_process' && result.process_id) {
      taskProcesses.add(result.process_id);
    }
    if (name === 'stop_process' && result.id) taskProcesses.delete(result.id);
  }

  #truncateResult(result) {
    const limit = this.config.maxToolOutputBytes;
    let json;
    try {
      json = JSON.stringify(result);
    } catch {
      json = JSON.stringify({ error: 'Tool result was not serializable.' });
    }
    if (json.length <= limit) return json;
    return JSON.stringify({
      truncated: true,
      note: `Tool result exceeded ${limit} characters and was truncated. Narrow the request or use pagination.`,
      preview: json.slice(0, limit),
    });
  }

  #toolReply(messages, call, payload, session) {
    const content = this.#truncateResult(payload);
    messages.push({ role: 'tool', tool_call_id: call.id, content });
    session.transcript.push({
      role: 'tool',
      name: call.name,
      ok: payload?.ok !== false,
      content,
      at: nowIso(),
    });
    if (session.transcript.length > 200) session.transcript.shift();
  }

  #buildSummary({ status, finalText, plan, steps, startedAt, session, taskProcesses, error = null }) {
    const running = [...taskProcesses].map((id) => {
      try {
        const record = this.processes?.get(id);
        return record ? { id, label: record.label, status: record.status } : { id, status: 'unknown' };
      } catch {
        return { id, status: 'unknown' };
      }
    }).filter((entry) => entry.status === 'running');
    const tests = session.commands
      .filter((cmd) => /(^|[/\s])(test|tests|check|lint|typecheck|vitest|jest|pytest|tsc|eslint)([\s:]|$)/i.test(cmd.argv.join(' ')))
      .map((cmd) => ({ argv: cmd.argv.join(' '), exitCode: cmd.exitCode, passed: cmd.exitCode === 0 }));
    const summary = {
      sessionId: session.id,
      task: session.task,
      model: this.config.model,
      status,
      steps,
      maxSteps: Number.isFinite(this.config.maxSteps) && this.config.maxSteps > 0 ? this.config.maxSteps : null,
      durationMs: Date.now() - startedAt,
      finalText,
      plan,
      changedFiles: session.changedFiles,
      commands: session.commands.map((cmd) => ({
        argv: cmd.argv,
        status: cmd.status,
        exitCode: cmd.exitCode,
        durationMs: cmd.durationMs,
        timedOut: cmd.timedOut,
      })),
      tests,
      runningProcesses: running,
      tokenUsage: session.tokenUsage,
      metrics: {
        modelCalls: session.modelCalls || 0,
        requestMs: session.requestMs || 0,
        avgRequestMs: session.modelCalls ? Math.round((session.requestMs || 0) / session.modelCalls) : 0,
        firstTokenMs: session.firstTokenMs ?? null,
        cachedReads: session.cachedReads || 0,
        promptTokens: session.tokenUsage.prompt,
        completionTokens: session.tokenUsage.completion,
      },
      approvals: this.approvals.stats,
      issues: session.issues,
      undoCount: this.undo?.size ?? 0,
      logFile: this.logger?.logFile || null,
      error: error ? { code: error.code || 'ERROR', message: describeError(error) } : null,
    };
    return summary;
  }

  /**
   * Run one task to completion.
   * @returns {Promise<object>} deterministic summary with status and evidence
   */
  async run(task, { signal: externalSignal = null, sessionId = null } = {}) {
    if (typeof task !== 'string' || task.trim() === '') throw new RyuuError('Task must be a non-empty string.', { code: 'EMPTY_TASK' });
    const startedAt = Date.now();
    const deadline = startedAt + this.config.maxTaskDurationMs;
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const signal = controller.signal;

    // Steps are unlimited by default; AGENT_MAX_STEPS > 0 adds an optional cap.
    const stepLimit = Number(this.config.maxSteps) > 0 ? this.config.maxSteps : Infinity;
    const stepLimitLabel = Number.isFinite(stepLimit) ? stepLimit : null;

    const session = createSessionRecord({
      task: task.trim(),
      model: this.config.model,
      workspace: this.workspace.root,
      id: sessionId || undefined,
    });
    this.session = session;
    if (this.undo) this.undo.reset(session.id);
    const taskProcesses = new Set();

    let plan = '';
    let finalText = '';
    let status = 'failed';
    let steps = 0;
    let error = null;
    // One prompt per session, then memory, then a single task brief that
    // carries the task, the budget and every verified fact from earlier work.
    let messages = [
      { role: 'system', content: await this.#systemPrompt() },
      ...this.conversation.map((entry) => ({ ...entry })),
      {
        role: 'user',
        content: buildTaskBrief({
          task: task.trim(),
          worklog: this.worklog,
          budget: this.#budgetText({ stepLimit, deadline }),
        }),
      },
    ];
    const budgetCeiling = this.config.maxTaskDurationMs;
    let budgetWarned = false;
    session.transcript.push({ role: 'user', content: task.trim(), at: nowIso() });

    this.#emit('taskStart', {
      task: task.trim(),
      sessionId: session.id,
      model: this.config.model,
      workspace: this.workspace.root,
      maxSteps: stepLimitLabel,
    });
    this.logger?.info('task started', { sessionId: session.id, model: this.config.model, taskLength: task.length });

    const facts = () => ({
      task: task.trim(),
      plan,
      changedFiles: session.changedFiles,
      commands: session.commands,
      issues: session.issues,
    });

    const checkAbort = () => {
      if (signal.aborted) throw new CancelledError('Task cancelled by user.');
      if (Date.now() > deadline) {
        throw new RyuuError(
          `Task exceeded the ${Math.round(this.config.maxTaskDurationMs / 1000)}s time limit. Increase AGENT_MAX_TASK_DURATION_MS or split the task.`,
          { code: 'TASK_TIMEOUT' },
        );
      }
    };

    let currentReasoning = '';
    // Identical failing calls are counted so a looping model is stopped early.
    const failureCounts = new Map();
    try {
      let emptyResponses = 0;
      let finished = false;
      for (let step = 1; step <= stepLimit; step += 1) {
        checkAbort();
        steps = step;
        currentReasoning = '';
        // Past 70% of the wall clock, tell the model to converge once. Without
        // this the run only learned about the deadline when it was killed.
        if (!budgetWarned && Date.now() - startedAt > budgetCeiling * 0.7) {
          budgetWarned = true;
          messages.push({
            role: 'system',
            content: `BUDGET: about ${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s of wall clock left. Stop exploring, deliver the smallest correct result, and report what is left.`,
          });
          this.#emit('warning', { message: '70% of the time budget is used — asking the model to converge.' });
        }
        this.#emit('stepStart', { step, maxSteps: stepLimitLabel });
        const compacted = compactMessages(messages, { maxChars: this.config.maxContextChars, facts: facts() });
        if (compacted.compacted) {
          messages = compacted.messages;
          this.#emit('warning', { message: `Context compacted: ${compacted.removedGroups} older exchange(s) removed.` });
        }

        this.#emit('thinkingStart', { step, maxSteps: stepLimitLabel });
        const requestStarted = Date.now();
        let response;
        let firstTokenMs = null;
        session.modelCalls += 1;
        try {
          response = await this.#requestModel(messages, {
            step,
            signal,
            deadline,
            // A request can never outlive the task deadline.
            timeoutMs: Math.max(1000, Math.min(this.config.requestTimeoutMs, deadline - Date.now())),
            onReasoning: (text) => {
              if (!text) return;
              if (currentReasoning.length < 2_000_000) currentReasoning += text;
              this.#emit('reasoningDelta', { text });
            },
            onContent: (text) => {
              if (!text) return;
              this.#emit('contentDelta', { text });
            },
            onFirstToken: ({ latencyMs } = {}) => {
              firstTokenMs = latencyMs ?? null;
              if (session.firstTokenMs === null) session.firstTokenMs = firstTokenMs;
              this.#emit('progress', {
                step,
                maxSteps: stepLimitLabel,
                phase: 'thinking',
                firstTokenMs,
                requestMs: Date.now() - requestStarted,
                promptTokens: session.tokenUsage.prompt,
                completionTokens: session.tokenUsage.completion,
              });
            },
          });
        } finally {
          const requestMs = Date.now() - requestStarted;
          session.requestMs += requestMs;
          this.#emit('thinkingEnd', {
            step,
            durationMs: requestMs,
            firstTokenMs,
            usage: response?.usage || null,
            finishReason: response?.finishReason || null,
            truncated: response?.finishReason === 'length',
          });
        }
        const reasoning = response.reasoning || currentReasoning;
        const calls = response.toolCalls || [];
        const truncated = response.finishReason === 'length';

        // The plan is the model's forward-looking step list, and only a
        // response that continues with tool calls can carry one. A final
        // answer (no calls) is never a plan, so numbered explanation lists
        // inside the answer can no longer be mistaken for it. The plan is
        // emitted before the reasoning summary so it leads the step.
        if (calls.length > 0 && response.content && !plan) {
          const extracted = extractPlan(response.content);
          if (extracted) {
            plan = extracted;
            session.plan = plan;
            this.worklog.recordPlan(plan);
            this.#emit('plan', { plan });
            session.transcript.push({ role: 'assistant', content: plan, at: nowIso() });
          }
        }

        if (reasoning) {
          const logFile = this.logger?.writeReasoning({ sessionId: session.id, step, text: reasoning }) || null;
          this.#emit('reasoningEnd', { logFile });
        }
        session.tokenUsage.prompt += response.usage?.prompt || 0;
        session.tokenUsage.completion += response.usage?.completion || 0;
        session.tokenUsage.total = session.tokenUsage.prompt + session.tokenUsage.completion;

        if (truncated) {
          const issue = 'The model response hit AGENT_MAX_OUTPUT_TOKENS and was cut off; the truncated tool call was discarded instead of executed.';
          if (!session.issues.includes(issue)) session.issues.push(issue);
          this.#emit('warning', {
            message: 'Response truncated at the output-token cap — the incomplete tool call was NOT executed.',
          });
        }

        if (calls.length === 0) {
          const content = (response.content || '').trim();
          if (!content) {
            emptyResponses += 1;
            // An empty answer is a retry, never a fatal fault: nudge the model,
            // beat the heartbeat, wait a little longer each time, then ask
            // again. There is no attempt cap — only /cancel, the task deadline
            // or a non-retryable provider error ends this.
            messages.push({ role: 'user', content: emptyResponseNudge(emptyResponses) });
            const retryBase = Math.max(100, Number(this.config.recoveryBackoffMs ?? 500));
            const delayMs = Math.min(15000, retryBase * 2 ** Math.min(emptyResponses - 1, 5));
            this.#emit('heartbeat', {
              phase: 'retry',
              step,
              attempt: emptyResponses,
              maxAttempts: 0,
              delayMs,
              code: 'EMPTY_RESPONSE',
              message: 'The model returned an empty response — asking it again.',
            });
            this.logger?.warn('empty model response; retrying', { step, attempt: emptyResponses, delayMs });
            await abortableDelay(delayMs, signal);
            // Retrying must not eat the optional --max-steps budget: the next
            // iteration repeats this same step number.
            step -= 1;
            continue;
          }
          finalText = content;
          status = 'completed';
          finished = true;
          break;
        }
        emptyResponses = 0;
        if (response.content) {
          // When the answer already streamed live, the text is already on screen.
          const streamed = typeof this.renderer?.streamedResponse === 'function' && this.renderer.streamedResponse();
          if (!streamed) this.#emit('note', { text: response.content.slice(0, 600) });
        }

        messages.push({
          role: 'assistant',
          content: response.content || null,
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: 'function',
            // The provider re-validates every tool call on every request, so a
            // truncated payload is repaired (or replaced) before it is stored.
            function: { name: call.name, arguments: toToolArgumentsString(call.argumentsText) },
          })),
        });

        // A cut-off response can never be trusted as a real edit: executing a
        // repaired-but-truncated payload used to write half a file to disk.
        if (truncated && calls.length > 0) {
          for (const call of calls) {
            this.#toolReply(
              messages,
              call,
              {
                ok: false,
                error: {
                  code: 'TRUNCATED_RESPONSE',
                  message:
                    'Your response was cut off at the output-token limit, so this call is incomplete and was NOT executed. Re-send a smaller call: narrow the file range, shorten the content, or split the change into several edits.',
                },
              },
              session,
            );
          }
          this.#emit('workingEnd', { step });
          continue;
        }

        // Tools are about to run: hand the live status line over to the
        // "working" animation until the first tool result prints.
        this.#emit('workingStart', { step, maxSteps: stepLimitLabel, toolCalls: calls.length });
        const seenInStep = new Set();
        let callIndex = 0;
        for (const call of calls) {
          checkAbort();
          callIndex += 1;
          const duplicateKey = `${call.name}\u0000${call.argumentsText}`;
          if (seenInStep.has(duplicateKey)) {
            this.#toolReply(messages, call, { ok: false, error: { code: 'DUPLICATE_CALL', message: 'Duplicate tool call in the same step was ignored.' } }, session);
            continue;
          }
          seenInStep.add(duplicateKey);

          let args;
          const parsed = parseToolArguments(call.argumentsText);
          if (!parsed.ok) {
            // The AI produced a broken payload: report it precisely, keep the
            // agent alive with a heartbeat and let the model re-issue the call.
            this.#emit('heartbeat', {
              phase: 'degraded',
              step,
              code: 'INVALID_ARGUMENTS',
              message: `${call.name}: ${parsed.error}`,
            });
            this.#emit('warning', { message: `${call.name}: ${parsed.error}` });
            this.#toolReply(messages, call, {
              ok: false,
              error: {
                code: 'INVALID_ARGUMENTS',
                message: `${parsed.error}. Re-send the arguments as one compact JSON object that matches the schema (no markdown fence, no trailing comma, no truncation).`,
              },
            }, session);
            session.issues.push(`${call.name}: malformed arguments (${parsed.error})`);
            continue;
          }
          args = parsed.value;
          if (parsed.repaired) {
            this.#emit('heartbeat', {
              phase: 'degraded',
              step,
              code: 'ARGUMENTS_REPAIRED',
              message: `${call.name}: truncated arguments were repaired and the call is running.`,
            });
            this.#emit('warning', { message: `${call.name}: truncated arguments repaired before execution` });
            session.issues.push(`${call.name}: truncated arguments were repaired automatically`);
          }

          if (!this.registry.has(call.name)) {
            this.#emit('warning', { message: `Model requested unknown tool: ${call.name}` });
            this.#toolReply(messages, call, {
              ok: false,
              error: { code: 'UNKNOWN_TOOL', message: `Unknown tool: ${call.name}. Only registered tools are available.` },
            }, session);
            continue;
          }
          const tool = this.registry.get(call.name);
          const schemaErrors = validateSchema(tool.schema, args);
          if (schemaErrors.length > 0) {
            this.#toolReply(messages, call, {
              ok: false,
              error: { code: 'INVALID_ARGUMENTS', message: schemaErrors.join('; ') },
            }, session);
            this.#emit('warning', { message: `${call.name}: invalid arguments (${schemaErrors.join('; ')})` });
            continue;
          }

          // A file that is already in the session worklog and unchanged on
          // disk does not need to be read again: its content is already in the
          // conversation. This is the guard that stops the agent from
          // re-analysing files it has already analysed.
          if (call.name === 'read_file' && args.path) {
            const mtimeMs = await this.#mtimeOf(args.path);
            if (
              mtimeMs !== null &&
              this.worklog.canSkipRead(args.path, {
                startLine: args.start_line ?? 1,
                endLine: args.end_line ?? null,
                mtimeMs,
              })
            ) {
              const known = this.worklog.file(args.path);
              const range = known?.ranges?.at(-1);
              session.cachedReads += 1;
              this.#emit('toolEnd', {
                name: call.name,
                ok: true,
                durationMs: 0,
                cached: true,
                summary: `${args.path} already read and unchanged — not read again`,
              });
              this.#toolReply(
                messages,
                call,
                {
                  ok: true,
                  cached: true,
                  path: args.path,
                  earlier_range: range ? `${range[0]}-${range[1]}` : null,
                  note:
                    'This file is unchanged since you read it earlier in this session, so it was not read again. Its content is already in the conversation: use it, or read a different file or line range. Do not repeat this read.',
                },
                session,
              );
              continue;
            }
          }

          // A model that keeps re-issuing the same failing call is looping.
          // Block the third identical failure so the run spends its steps on
          // new information instead of the same exit code.
          const callKey = `${call.name}\u0000${(call.argumentsText || '').trim()}`;
          const previousFailures = failureCounts.get(callKey) || 0;
          if (previousFailures >= MAX_REPEATED_FAILURES) {
            this.#emit('warning', {
              message: `${call.name}: repeated failing call blocked after ${previousFailures} identical failures`,
            });
            this.#toolReply(messages, call, {
              ok: false,
              error: {
                code: 'REPEATED_FAILURE',
                message: `This exact ${call.name} call has already failed ${previousFailures} times with the same result, so it was not executed again. Repeating it unchanged cannot produce new information — change the tool, change the arguments, or report the finding to the user.`,
              },
            }, session);
            session.issues.push(`${call.name}: repeated identical failing call was blocked`);
            continue;
          }

          let preview = '';
          try {
            if (tool.preview) preview = String(await tool.preview(args, { workspace: this.workspace, config: this.config })).slice(0, 6000);
          } catch (previewError) {
            this.#toolReply(messages, call, {
              ok: false,
              error: { code: previewError.code || 'PREVIEW_FAILED', message: previewError.message },
            }, session);
            this.#emit('toolEnd', { name: call.name, ok: false, durationMs: 0, summary: previewError.message });
            continue;
          }

          const assessment = typeof tool.assess === 'function' ? tool.assess(args) : null;
          if (tool.requiresApproval) {
            const decision = await this.approvals.request({
              tool: call.name,
              risk: tool.risk,
              args,
              preview,
              reasons: assessment?.reasons || [],
              critical: assessment?.level === 'critical',
            });
            if (!decision.approved) {
              this.#emit('toolDenied', { name: call.name, reason: decision.reason });
              session.transcript.push({ role: 'tool', name: call.name, ok: false, content: decision.reason, at: nowIso() });
              this.#toolReply(messages, call, {
                ok: false,
                denied: true,
                error: {
                  code: 'APPROVAL_DENIED',
                  message: `The user did not approve ${call.name}. Do not retry this action without a new, explicit request.`,
                  reason: decision.reason,
                },
              }, session);
              continue;
            }
          }

          this.#emit('toolStart', {
            name: call.name,
            args,
            risk: tool.risk,
            index: callIndex,
            total: calls.length,
            detail: describeToolTarget(call.name, args),
          });
          const toolStarted = Date.now();
          const before = await this.#captureBefore(call.name, args);
          try {
            const { result } = await this.registry.execute(call.name, args, {
              workspace: this.workspace,
              config: this.config,
              logger: this.logger,
              processes: this.processes,
              signal,
              agent: this,
              session,
            });
            const durationMs = Date.now() - toolStarted;
            this.#trackResult(call.name, args, result, session, taskProcesses);
            await this.#noteWorklog(call.name, args, result);
            await this.#recordUndo(call.name, args, result, before);
            // A command that exits non-zero is a failed attempt too: count it
            // so the same command is not re-run forever.
            if (result?.ok === false) {
              failureCounts.set(callKey, previousFailures + 1);
            }
            this.#emit('toolEnd', {
              name: call.name,
              ok: true,
              durationMs,
              summary: summarizeToolResult(call.name, result),
            });
            // The command the user approved and what it actually printed: the
            // renderer shows a preview and keeps the complete output one click
            // (or `/expand <id>`) away.
            if (call.name === 'run_command' && result) {
              this.#emit('commandOutput', {
                argv: result.argv || args.argv || [],
                stdout: result.stdout ?? '',
                stderr: result.stderr ?? '',
                exitCode: result.exit_code ?? null,
                status: result.status ?? '',
                processId: result.process_id ?? null,
                timedOut: Boolean(result.timed_out),
                truncated: Boolean(result.truncated),
              });
            }
            const fileDiff = this.#fileDiffPayload(call.name, args, result, before);
            if (fileDiff) this.#emit('fileDiff', fileDiff);
            this.#toolReply(messages, call, { ok: true, result }, session);
            this.logger?.debug('tool succeeded', { name: call.name, durationMs });
          } catch (toolError) {
            const durationMs = Date.now() - toolStarted;
            const message = toolError?.message || String(toolError);
            failureCounts.set(callKey, previousFailures + 1);
            this.#emit('toolEnd', { name: call.name, ok: false, durationMs, summary: message });
            session.issues.push(`${call.name}: ${message.slice(0, 300)}`);
            this.#toolReply(messages, call, {
              ok: false,
              error: { code: toolError.code || 'TOOL_ERROR', message },
            }, session);
            this.logger?.warn('tool failed', { name: call.name, code: toolError.code, message: message.slice(0, 300) });
          }
        }
        this.#emit('workingEnd', { step });
      }

      if (!finished && status !== 'completed') {
        status = 'step-limit';
        session.issues.push(`Reached the ${stepLimitLabel}-step limit before the model gave a final answer.`);
        finalText = `Step limit (${stepLimitLabel}) reached. Partial work is recorded above; raise AGENT_MAX_STEPS (0 = unlimited) or continue with a narrower task.`;
      }
    } catch (caught) {
      error = caught;
      if (currentReasoning) {
        const logFile = this.logger?.writeReasoning({ sessionId: session.id, step: steps, text: currentReasoning }) || null;
        this.#emit('reasoningEnd', { logFile, partial: true });
      }
      if (caught instanceof CancelledError || signal.aborted) {
        status = 'cancelled';
        finalText = 'Task cancelled. No further tool calls were executed.';
      } else {
        status = 'failed';
        finalText = '';
        session.issues.push(describeError(caught));
        this.#emit('error', { error: caught });
      }
      this.logger?.warn('task ended with error', { code: caught.code, message: caught.message });
    } finally {
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
      // Do not leave processes from a cancelled/failed task running silently.
      if (status === 'cancelled' || status === 'failed') {
        const processes = this.processes;
        if (processes) {
          for (const id of taskProcesses) {
            try {
              const record = processes.get(id);
              if (record.status === 'running') {
                await processes.stop(id, { graceMs: 1000 }).catch(() => {});
              }
            } catch {
              // Process may have exited already.
            }
          }
        }
      }
    }

    session.status = status;
    session.steps = steps;
    session.durationMs = Date.now() - startedAt;
    session.tokenUsage.total = session.tokenUsage.prompt + session.tokenUsage.completion;
    // Persist the verified worklog so /resume and the next task continue
    // instead of re-reading everything.
    session.worklog = this.worklog.toJSON();
    if (finalText) session.transcript.push({ role: 'assistant', content: finalText, at: nowIso() });
    // Remember this exchange so the next task in the session knows about it.
    this.#remember(task.trim(), finalText, {
      status,
      changedFiles: session.changedFiles,
      commands: session.commands,
    });
    session.conversation = this.conversation.slice(-40);
    if (this.sessionStore) {
      try {
        await this.sessionStore.save(session);
      } catch (saveError) {
        this.logger?.warn('failed to save session', { error: saveError.message });
        session.issues.push(`Session could not be saved: ${saveError.message}`);
      }
    }

    const summary = this.#buildSummary({
      status,
      finalText,
      plan,
      steps,
      startedAt,
      session,
      taskProcesses,
      error,
    });
    this.#emit('final', summary);
    this.logger?.info('task finished', {
      sessionId: session.id,
      status,
      steps,
      durationMs: summary.durationMs,
      changedFiles: summary.changedFiles.length,
      issues: summary.issues.length,
    });
    return summary;
  }
}
