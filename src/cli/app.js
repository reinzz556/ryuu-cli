import path from 'node:path';
import process from 'node:process';
import { Workspace } from '../services/workspace.js';
import { ProcessManager } from '../services/processes.js';
import { SessionStore, ProjectSummaryCache } from '../services/sessions.js';
import { UndoManager } from '../services/undo.js';
import { createLogger } from '../services/logger.js';
import { buildProjectSummary } from '../tools/project.js';
import { buildToolRegistry } from '../tools/index.js';
import { createActiveProvider, selectionFor } from '../providers/index.js';
import { Agent } from '../agent/agent.js';
import { ApprovalManager } from '../agent/approvals.js';
import { Renderer } from './renderer.js';
import { Tui } from './tui.js';
import { PromptSession } from './prompts.js';
import { createCommands, parseCommandLine, shellCommandFromLine } from './commands.js';
import { runDoctor } from '../services/doctor.js';
import { readProviderModel, stateDirFor, writeProviderPreference } from '../services/preferences.js';
import { RyuuError } from '../utils/errors.js';
import { readVersion } from '../utils/version.js';

/**
 * Read one task from the prompt. Enter sends the task immediately, which is
 * what a terminal user expects; a trailing backslash keeps typing on the next
 * line (`...\` then a line without `\` finishes). The old contract — type the
 * task, then press Enter again on an empty line — made the CLI look frozen: it
 * sat on a bare `>` prompt with no task uplink and no spinner.
 *
 * Exported for tests: `ask` is injected so no readline is involved.
 */
export async function collectTask({ firstLine, ask, onContinue = null }) {
  const lines = [String(firstLine ?? '')];
  while (lines[lines.length - 1].endsWith('\\')) {
    lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1).replace(/\s+$/, '');
    if (onContinue) onContinue();
    const line = await ask('  ↳ ');
    if (line === null) return null; // Ctrl+C / EOF while composing
    lines.push(line);
  }
  return lines.join('\n').trim();
}

/**
 * Wire the UI, agent, tools, provider, processes and local state together.
 * Everything is dependency-injectable so integration tests can use a fake
 * provider without touching the network.
 */
export async function createApp({
  config,
  cliOptions = {},
  stdout = process.stdout,
  stderr = process.stderr,
  input = process.stdin,
  provider: injectedProvider = null,
  registry: injectedRegistry = null,
  renderer: injectedRenderer = null,
  webManager: injectedWebManager = null,
  version = readVersion(),
} = {}) {
  const interactive = cliOptions.interactive ?? Boolean(input.isTTY && stdout.isTTY);
  // --tui needs a real terminal; otherwise the line interface is used, which is
  // the default and stays untouched.
  const useTui =
    Boolean(cliOptions.tui) && interactive && !cliOptions.plain && Boolean(input.isTTY && stdout.isTTY);
  if (cliOptions.tui && !useTui) {
    stderr?.write?.('[warn] --tui needs an interactive terminal (and cannot be combined with --plain); using the line interface.\n');
  }
  const tui = useTui ? new Tui({ input, output: stdout, version, color: cliOptions.color ?? null }) : null;
  const renderer = injectedRenderer || tui || new Renderer({
    stdout,
    stderr,
    plain: Boolean(cliOptions.plain),
    color: cliOptions.color ?? null,
    debug: Boolean(config.debug),
  });
  const providerSecrets = (config.providers || []).map((entry) => entry.apiKey);
  const searchSecrets = [
    config.webSearchApiKey,
    config.youApiKey,
    config.firecrawlApiKey,
    config.tavilyApiKey,
  ].filter(Boolean);
  const logger = createLogger(config, { stderr, secrets: [...providerSecrets, ...searchSecrets] });
  if (config.webMcpDebug) logger.setLevel('debug');
  const workspace = new Workspace(config.workspace, { logger });
  const processes = new ProcessManager({
    workspace,
    logger,
    logDir: config.logDir,
    maxBufferBytes: Math.max(65536, config.maxToolOutputBytes),
    defaultTimeoutMs: config.requestTimeoutMs,
  });
  const sessionStore = new SessionStore({
    dir: config.historyDir,
    secrets: [config.apiKey, ...providerSecrets, ...searchSecrets],
    logger,
  });
  const undo = new UndoManager({ workspace, dir: config.undoDir, logger });
  const registry = injectedRegistry || buildToolRegistry({
    workspace,
    config,
    processes,
    logger,
    webManager: injectedWebManager,
    onEvent: (event) => renderer.webSearchStatus?.(event),
  });
  const provider = injectedProvider || createActiveProvider(config, { logger });
  if (!provider.config) provider.config = config;
  provider.processes = processes;
  const projectCache = new ProjectSummaryCache({ file: path.join(config.cacheDir, 'project-summary.json') });

  let prompts = null;
  let awaitingApproval = false;
  let lastSummary = null;
  let activeTask = null;
  let stopping = false;
  let lastSigintAt = 0;
  let projectSummary = null;
  let closed = false;
  let approvals = null;
  // Assigned below; declared here so the Ctrl+C handler can read it safely.
  let state = null;

  // Live stdout/stderr from a running command, streamed into the activity
  // region while the tool is still running instead of after it exits.
  processes.on('output', ({ stream, text, record }) => {
    if (!activeTask || record?.status !== 'running') return;
    if (typeof renderer.processOutput !== 'function') return;
    renderer.processOutput({ id: record.id, stream, text });
  });

  const onSigint = () => {
    if (state?.activeShell) {
      state.activeShell.controller.abort();
      renderer.warn('Cancelling shell command…');
      return;
    }
    if (activeTask) {
      activeTask.controller.abort();
      renderer.warn('Cancelling task…');
      if (awaitingApproval) prompts?.reset();
      return;
    }
    const now = Date.now();
    if (now - lastSigintAt < 1500) {
      stopping = true;
      prompts?.close();
      return;
    }
    lastSigintAt = now;
    renderer.info('Press Ctrl+C again to exit, or type /exit.');
  };

  if (interactive) {
    if (tui) {
      // The TUI is both the renderer and the prompt: its composer lives in the
      // same retained frame as the transcript.
      tui.onSigint = onSigint;
      prompts = tui;
    } else {
      prompts = new PromptSession({ input, output: stdout, onSigint, mouse: Boolean(renderer.ansi) });
      // Clicks, panel keys and the panel's ability to sit above the prompt.
      prompts.isOverlayOpen = () => renderer.isBlockViewOpen?.() ?? false;
      prompts.onMouse = (event) => renderer.handleMouse?.(event);
      prompts.onOverlayKey = (key) => renderer.handleBlockViewKey?.(key);
      prompts.onBeforeSubmit = () => renderer.closeBlockView?.();
      renderer.setPromptController?.({
        metrics: () => prompts.metrics(),
        repaint: () => prompts.repaint(),
        resetCursor: () => prompts.resetCursor(),
      });
    }
  }

  const confirm = async (request) => {
    if (!prompts) return false;
    renderer.approvalRequest(request);
    awaitingApproval = true;
    try {
      const answer = await prompts.confirm('  Approve? [y/N/a] ');
      if (answer.all) {
        approvals.autoApproveWrites = true;
        renderer.info('Writes will be auto-approved for the rest of this session. Commands still require approval.');
      }
      return answer.value;
    } finally {
      awaitingApproval = false;
    }
  };

  approvals = new ApprovalManager({
    policy: config.approvalPolicy,
    logger,
    interactive,
    confirm: prompts ? confirm : null,
    autoApproveWrites: Boolean(cliOptions.yes),
    autoApproveAll: Boolean(cliOptions.autoApprove),
  });

  const agent = new Agent({
    provider,
    registry,
    workspace,
    config,
    renderer,
    logger,
    approvals,
    sessionStore,
    undo,
    processes,
  });

  async function getProjectSummary({ force = false } = {}) {
    if (projectSummary && !force) return projectSummary;
    const cached = force ? null : projectCache.get(workspace.root);
    if (cached?.summary) {
      projectSummary = cached.summary;
      return projectSummary;
    }
    try {
      projectSummary = await buildProjectSummary({ workspace });
      projectCache.set(workspace.root, projectSummary);
    } catch (error) {
      logger.warn('project summary unavailable', { error: error.message });
      projectSummary = null;
    }
    return projectSummary;
  }

  async function runTask(task) {
    if (activeTask) throw new RyuuError('A task is already running. Use /cancel before starting another.', { code: 'TASK_BUSY' });
    const controller = new AbortController();
    activeTask = { controller, task };
    try {
      agent.projectSummary = await getProjectSummary();
      return await agent.run(task, { signal: controller.signal });
    } finally {
      activeTask = null;
    }
  }

  async function confirmLocal(question) {
    if (!prompts) return false;
    const answer = await prompts.confirm(question);
    return answer.value;
  }

  /** Limitations advertised by the active provider (never assumed present). */
  function providerLimitations() {
    const capabilities = provider.capabilities || config.capabilities || {};
    const notes = [];
    if (capabilities.tools === false) {
      notes.push(
        `${config.providerName} does not advertise tool calling: the agent can answer, but cannot read or change files through tools.`,
      );
    }
    if (capabilities.streaming === false) {
      notes.push(`${config.providerName} does not advertise streaming: responses arrive as one block.`);
    }
    return notes;
  }

  /**
   * Switch the active provider (used by /provider). The provider object is
   * updated in place, so the agent keeps its conversation memory and worklog.
   */
  async function switchProvider(providerId, { model = null } = {}) {
    const stateDir = stateDirFor(config.workspace);
    const remembered = model ? null : await readProviderModel(stateDir, providerId);
    const selection = selectionFor(config, providerId, { model: model || remembered || null });
    if (typeof provider.updateSelection === 'function') {
      provider.updateSelection(selection);
    } else if (provider.config) {
      // Test doubles: keep their config view in sync with the effective one.
      Object.assign(provider.config, selection);
    }
    Object.assign(config, {
      providerId: selection.providerId,
      provider: selection.providerId,
      providerName: selection.providerName,
      apiKeyEnv: selection.apiKeyEnv,
      apiKey: selection.apiKey,
      baseURL: selection.baseURL,
      model: selection.model,
      capabilities: selection.capabilities,
    });
    const persisted = await writeProviderPreference(stateDir, selection.providerId);
    return { ...selection, persisted };
  }

  state = {
    config,
    workspace,
    registry,
    processes,
    sessionStore,
    undo,
    renderer,
    provider,
    approvals,
    webSearch: registry.webSearchManager || injectedWebManager || null,
    interactive,
    getAgent: () => agent,
    getLastSummary: () => lastSummary,
    getActiveTask: () => activeTask,
    switchProvider,
    providerLimitations,
    cancelActiveTask: () => {
      if (!activeTask) return false;
      activeTask.controller.abort();
      return true;
    },
    confirmLocal,
  };

  const commands = createCommands(state);

  // Keep the last summary available to /status.
  const originalFinal = renderer.final?.bind(renderer);
  if (typeof originalFinal === 'function') {
    renderer.final = (summary) => {
      lastSummary = summary;
      originalFinal(summary);
    };
  }

  function banner() {
    renderer.banner({
      version,
      model: config.model,
      provider: config.providerName,
      workspace: workspace.root,
      node: process.version,
      approvalPolicy: cliOptions.autoApprove
        ? `${config.approvalPolicy} + --auto-approve (all actions)`
        : config.approvalPolicy,
      logFile: logger.logFile,
    });
    for (const note of providerLimitations()) renderer.warn(note);
  }

  async function readTask(firstLine) {
    return collectTask({
      firstLine,
      ask: (question) => prompts.ask(question),
      onContinue: () =>
        renderer.muted('  … continuation line · finish the task on a line without \\ to send'),
    });
  }

  async function runInteractive() {
    banner();
    // The running task is not awaited here: the composer stays usable while the
    // agent works, so slash commands can be sent at any time. A second prompt
    // is refused instead of being queued behind the running task.
    let taskPromise = null;
    while (!stopping) {
      const prefix = renderer.prompt();
      const line = await prompts.ask(prefix);
      if (line === null) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = parseCommandLine(trimmed) || shellCommandFromLine(trimmed);
      try {
        if (parsed) {
          if (parsed.name === 'exit') break;
          await commands.execute(parsed);
          continue;
        }
        if (activeTask) {
          renderer.warn(
            'A task is already running. Slash commands still work (e.g. /status, /model, /expand, /cancel); ' +
              'send a new prompt once it finishes or after /cancel.',
          );
          continue;
        }
        const task = await readTask(trimmed);
        if (task === null) break;
        taskPromise = runTask(task)
          .catch((error) => {
            if (error?.code === 'TASK_BUSY') renderer.warn(error.message);
            else renderer.error({ error });
          })
          .finally(() => {
            taskPromise = null;
          });
      } catch (error) {
        if (error.code === 'TASK_BUSY') renderer.warn(error.message);
        else renderer.error({ error });
      }
    }
    // close() aborts anything still running, so wait for it only afterwards.
    await close();
    if (taskPromise) await taskPromise.catch(() => {});
  }

  async function close() {
    if (closed) return;
    closed = true;
    stopping = true;
    renderer.closeBlockView?.();
    if (state?.activeShell) state.activeShell.controller.abort();
    if (activeTask) activeTask.controller.abort();
    renderer.stopActivity();
    prompts?.close();
    const stopped = await processes.stopAll({ graceMs: 1500 }).catch(() => 0);
    if (stopped > 0) logger.info('stopped processes on exit', { count: stopped });
    await registry.webSearchManager?.close?.().catch(() => {});
    logger.info('session closed');
  }

  return {
    config,
    workspace,
    processes,
    registry,
    provider,
    sessionStore,
    undo,
    approvals,
    webSearch: registry.webSearchManager || injectedWebManager || null,
    renderer,
    logger,
    commands,
    agent,
    interactive,
    version,
    banner,
    runTask,
    runInteractive,
    runDoctor: (live = false) => runDoctor({ config, workspace, provider, live }),
    getProjectSummary,
    getLastSummary: () => lastSummary,
    cancelActiveTask: state.cancelActiveTask,
    setProvider: switchProvider,
    providerLimitations,
    close,
  };
}
