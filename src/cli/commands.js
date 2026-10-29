import path from 'node:path';
import { DEFAULT_PROVIDER_ID, modelsFor, normalizeModelId, providerById } from '../providers/catalog.js';
import {
  MAX_CUSTOM_MODELS,
  addCustomModel,
  preferencesFile,
  readCustomModels,
  removeCustomModel,
  stateDirFor,
  writeModelPreference,
} from '../services/preferences.js';
import { describeConfig } from '../config/validate.js';
import { formatDoctor, runDoctor } from '../services/doctor.js';
import { createUnifiedDiff, diffStats } from '../services/diff.js';
import { PROVIDER_INFO } from '../services/websearch/providers.js';
import { runUserShell } from '../services/ushell.js';
import { RyuuError } from '../utils/errors.js';

export function parseCommandLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('/')) return null;
  const [name, ...rest] = trimmed.slice(1).split(/\s+/);
  if (!name) return null;
  return { name: name.toLowerCase(), args: rest.join(' '), parts: rest };
}

/**
 * `!cmd` is a shell line, not a prompt: it runs `/bash cmd` without the model.
 * Returns null for anything that is not a shell line.
 */
export function shellCommandFromLine(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed.startsWith('!')) return null;
  const command = trimmed.slice(1).trim();
  return { name: 'bash', args: command, parts: command ? command.split(/\s+/) : [] };
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * CLI flags accepted at startup (see parseArgs in src/index.js), shown by
 * /help so users can discover them without leaving the REPL.
 */
const CLI_FLAGS = [
  ['--help', 'show the startup help and exit'],
  ['--version', 'show the version and exit'],
  ['--doctor', 'run offline diagnostics'],
  ['--doctor --live', 'diagnostics plus one real API request'],
  ['--workspace <path>', 'workspace override for this run'],
  ['--provider <id>', 'provider override for this run, e.g. tokenharbor'],
  ['--model <id>', 'model override for this run'],
  ['--max-steps <n>', 'step cap; 0 = unlimited (default)'],
  ['--yes', 'auto-approve file writes; commands still ask'],
  ['--auto-approve', 'auto-approve ALL actions incl. commands; the agent works without asking'],
  ['--read-only', 'deny all writes and command execution'],
  ['--no-color', 'disable ANSI colors'],
  ['--plain', 'plain output; no spinner or colors'],
  ['--tui', 'full-screen UI with expandable blocks (needs a TTY)'],
  ['--debug', 'verbose logs and stack traces'],
];

/**
 * Slash commands. Handlers print through the renderer and may return
 * { exit: true } to leave the REPL.
 */
export function createCommands(state) {
  const { config, workspace, registry, processes, sessionStore, undo, renderer, provider, interactive } = state;
  const webSearch = state.webSearch || registry?.webSearchManager || null;

  const print = (text) => renderer.lines(text);

  const commands = new Map();

  // `details` is the optional tutorial shown by `/help <command>`.
  const define = (name, description, usage, handler, details = null) => {
    commands.set(name, { name, description, usage, handler, details });
  };

  const stateDir = () => stateDirFor(config.workspace);

  /** Effective provider descriptors (built-in plus config.json extraProviders). */
  const providerList = () => (Array.isArray(config.providers) ? config.providers : []);
  const currentProviderId = () => config.providerId || DEFAULT_PROVIDER_ID;
  const currentProvider = () => providerById(providerList(), currentProviderId()) || providerList()[0] || null;

  /** Provider catalog models plus the ids added with /addmodel, de-duplicated. */
  const modelList = async () => {
    const provider = currentProvider();
    const custom = await readCustomModels(stateDir(), provider?.id || currentProviderId());
    const entries = modelsFor(provider, custom);
    return { custom, entries, all: entries.map((entry) => entry.id), provider };
  };

  const modelLabel = (entry) => (entry.name && entry.name !== entry.id ? `  (${entry.name})` : '');
  const capabilityText = (capabilities = {}) =>
    [
      capabilities.streaming === false ? null : 'streaming',
      capabilities.tools === false ? null : 'tools',
      capabilities.reasoning ? 'reasoning' : null,
      capabilities.multimodal ? 'multimodal' : null,
    ]
      .filter(Boolean)
      .join('+') || 'text only';

  define('help', 'Show commands or details for one command', '/help [command]', async (args) => {
    const target = args.trim().replace(/^\//, '');
    if (target) {
      const command = commands.get(target);
      if (!command) return print(`Unknown command: /${target}. Run /help.`);
      const details = command.details ? `\n\n${command.details}` : '';
      return print(`/${command.name} ${command.usage}\n  ${command.description}${details}`);
    }
    const rows = [...commands.values()].map((command) => `  /${command.name.padEnd(12)} ${command.description}`);
    const flagRows = CLI_FLAGS.map(([flag, description]) => `  ${flag.padEnd(20)} ${description}`);
    print(
      [
        'Ryuu commands',
        ...rows,
        '',
        'CLI flags (set at startup, e.g. `ryuu --auto-approve "task"`, and listed in `ryuu --help`):',
        ...flagRows,
        '',
        'Anything not starting with / is sent to the agent as a task.',
        'Run /help <command> for usage and examples (e.g. /help addmodel).',
      ].join('\n'),
    );
  });

  define('exit', 'Exit the CLI', '/exit', async () => ({ exit: true }));

  define('clear', 'Forget conversation memory so the next task starts fresh', '/clear', async () => {
    const agent = state.getAgent();
    if (agent?.session) agent.session = null;
    agent?.clearMemory?.();
    undo.reset(null);
    print('Conversation memory and the session worklog were cleared. The next task starts with no prior context; saved session files are untouched.');
  });

  define('memory', 'Show what the agent remembers between tasks', '/memory [clear]', async (args) => {
    const sub = args.trim().toLowerCase();
    const agent = state.getAgent();
    if (sub === 'clear') {
      agent?.clearMemory?.();
      return print('Conversation memory cleared.');
    }
    const conversation = agent?.getConversation?.() || [];
    if (conversation.length === 0) {
      return print(
        'Conversation memory is empty.\nEvery completed task is remembered for the next one in this session; /clear forgets it.',
      );
    }
    const tasks = conversation.filter((entry) => entry.role === 'user');
    const chars = conversation.reduce((total, entry) => total + String(entry.content || '').length, 0);
    print(
      [
        `Conversation memory: ${tasks.length} task(s) · ${conversation.length} message(s) · ${chars} chars`,
        `Worklog: ${agent?.getWorklog?.()?.size ?? 0} verified fact(s) — run /worklog to inspect.`,
        'Remembered tasks (oldest first):',
        ...tasks.map((entry) => `  · ${String(entry.content).replace(/\s+/g, ' ').slice(0, 110)}`),
        '',
        'Used as context for the next task. /clear forgets it, /resume <id> loads a saved one.',
      ].join('\n'),
    );
  });

  define('worklog', 'Show the verified facts the agent will reuse instead of re-reading', '/worklog', async () => {
    const agent = state.getAgent();
    const worklog = agent?.getWorklog?.();
    if (!worklog || worklog.size === 0) {
      return print('The worklog is empty. Files read/changed, commands and findings are recorded as the agent works.');
    }
    print(worklog.brief({ maxChars: 8000 }));
  });

  define('resume', 'Restore a saved session\u2019s conversation memory', '/resume <session-id>', async (args) => {
    const id = args.trim();
    if (!id) return print('Usage: /resume <session-id>   (list ids with /history)');
    const agent = state.getAgent();
    if (!agent) return print('Agent is not available.');
    const session = await sessionStore.load(id);
    const conversation = Array.isArray(session.conversation) ? session.conversation : [];
    if (conversation.length === 0) {
      return print(`Session ${id} has no stored conversation memory to resume.`);
    }
    agent.setConversation(conversation, { worklog: session.worklog || null });
    print(`Resumed ${conversation.length} message(s) from session ${id}.`);
    print(
      session.worklog
        ? 'The saved worklog was restored too, so files already read or changed are not re-read.'
        : 'The next task will be answered with that context. Run /memory to inspect it.',
    );
  });

  define('status', 'Show provider, model, workspace, limits and the last task result', '/status', async () => {
    const last = state.getLastSummary();
    const running = processes.list({ includeCompleted: false }).filter((proc) => proc.status === 'running');
    const lines = [
      `model        ${config.model}`,
      `provider     ${config.providerName || 'NVIDIA Integrate API'} (${currentProviderId()})`,
      `endpoint     ${config.baseURL}`,
      `key          ${config.apiKeyPath || 'providers.nvidia.apiKey'} ${config.apiKey ? 'set (redacted)' : '(not set)'}`,
      `caps         ${capabilityText(config.capabilities)}`,
      `workspace    ${workspace.root}`,
      `node         ${process.version} (${process.platform})`,
      `approval     ${config.approvalPolicy}`,
      `limits       ${config.maxSteps > 0 ? `${config.maxSteps} steps` : 'unlimited steps'} · ${config.maxOutputTokens} output tokens · ${config.requestTimeoutMs}ms timeout`,
      `state        ${config.historyDir}`,
      `log          ${config.logDir}/agent.log`,
      `processes    ${running.length} running`,
      `undo         ${undo.size} recorded change(s)`,
    ];
    if (last) {
      lines.push(
        '',
        `last task    ${last.status} · ${last.steps} step(s) · ${(last.durationMs / 1000).toFixed(1)}s`,
        `changed      ${last.changedFiles.length ? last.changedFiles.join(', ') : 'none'}`,
        `tokens       ${last.tokenUsage.prompt} prompt / ${last.tokenUsage.completion} completion`,
      );
      if (last.metrics) {
        lines.push(
          `model        ${last.metrics.modelCalls} call(s) · avg ${((last.metrics.avgRequestMs || 0) / 1000).toFixed(1)}s` +
            (last.metrics.firstTokenMs !== null ? ` · first token ${(last.metrics.firstTokenMs / 1000).toFixed(1)}s` : '') +
            (last.metrics.cachedReads ? ` · ${last.metrics.cachedReads} read(s) reused` : ''),
        );
      }
    }
    if (state.getActiveTask()) lines.push('', 'A task is currently running. Use /cancel to abort it.');
    print(lines.join('\n'));
  });

  const MODEL_LIST_HINT =
    'Add an id with /addmodel <model-id>, remove one with /delmodel <model-id>.\n' +
    'The CLI does not check whether a model exists on the server; a wrong id fails when used.\n' +
    'Models are listed per provider: switch with /provider <id> first.';

  define(
    'provider',
    'List AI providers and their key status, or switch provider',
    '/provider [id]',
    async (args) => {
      const requested = args.trim().toLowerCase();
      const list = providerList();
      if (list.length === 0) {
        return print('No providers are configured. This build has no provider catalog.');
      }
      if (!requested) {
        const rows = list.map((entry) => {
          const active = entry.id === currentProviderId();
          const key = entry.apiKey ? 'key set (redacted)' : `no key (${entry.apiKeyPath})`;
          const models = `${entry.models?.length || 0} model(s) · default ${entry.defaultModel}`;
          return `  ${entry.id.padEnd(12)} ${String(entry.name).padEnd(24)} ${key.padEnd(28)} ${models}${active ? '  \u2190 current' : ''}`;
        });
        return print(
          [
            'PROVIDERS',
            ...rows,
            '',
            `Current provider: ${config.providerName || currentProviderId()} (${currentProviderId()}) · model ${config.model}`,
            'A key is only ever shown as set/not set; values are never printed.',
            'Usage: /provider <id>   (e.g. /provider tokenharbor)',
            'Add providers in config.json (extraProviders); add models with /addmodel.',
          ].join('\n'),
        );
      }
      if (typeof state.switchProvider !== 'function') {
        return print('Provider switching is not available in this session.');
      }
      const known = providerById(list, requested);
      if (!known) {
        return print(
          `Unknown provider: ${requested}. Known providers: ${list.map((entry) => entry.id).join(', ')}.`,
        );
      }
      try {
        const selection = await state.switchProvider(known.id);
        print(
          `Provider set to ${selection.providerName} (${selection.providerId}) · model ${selection.model}` +
            (selection.persisted ? '; saved, so it stays selected in future runs.' : '.') +
            ' Conversation history and the worklog were kept.',
        );
        for (const note of state.providerLimitations?.() || []) print(note);
      } catch (error) {
        print(`Cannot switch provider: ${error.message}`);
      }
    },
    [
      '  How to use:',
      '    1. /provider                     list providers, keys and defaults',
      '    2. /provider tokenharbor         switch for this and later runs',
      '    3. /model                        list that provider\u2019s models',
      '',
      '  Notes:',
      '    - A provider needs its own key, stored under providers.<id>.apiKey in',
      '      config.json. Missing keys are reported by setting name, never by value.',
      '    - Switching keeps conversation history and the worklog.',
      '    - Register more providers with extraProviders in config.json.',
    ].join('\n'),
  );

  define(
    'model',
    'List the current provider\u2019s models, or switch model by number',
    '/model [n]',
    async (args) => {
      const requested = args.trim();
      const { custom, entries, all, provider: activeProvider } = await modelList();
      if (!requested) {
        const rows = entries.map(
          (entry, index) =>
            `  ${index + 1}  ${entry.id}${modelLabel(entry)}${entry.id === config.model ? '  \u2190 current' : ''}${custom.includes(entry.id) ? '  (added)' : ''}`,
        );
        const builtin = activeProvider?.models?.length || 0;
        return print(
          [
            `Current model: ${config.model}`,
            `Provider: ${activeProvider?.name || currentProviderId()} (${activeProvider?.id || currentProviderId()}) · ${capabilityText(activeProvider?.capabilities || config.capabilities)}`,
            '',
            'Available models:',
            ...rows,
            '',
            `Usage: /model <n>   (e.g. /model ${Math.min(2, all.length)})`,
            `${all.length} listed · ${builtin} built-in · ${custom.length} added`,
            MODEL_LIST_HINT,
          ].join('\n'),
        );
      }
      if (!/^\d+$/.test(requested)) {
        return print(
          'Use a number, not a model id. Run /model to see the numbered list, or /addmodel <model-id> to add one.',
        );
      }
      const index = Number(requested) - 1;
      if (index < 0 || index >= all.length) {
        return print(`Unknown model number: ${requested}. Valid: 1-${all.length}. Run /model to see the list.`);
      }
      const model = all[index];
      config.model = model;
      if (provider.config) provider.config.model = model;
      const saved = await writeModelPreference(stateDir(), model, { providerId: currentProviderId() });
      print(
        `Model set to ${model} (#${index + 1}) for subsequent requests` +
          (saved ? '; saved, so it stays selected in future runs.' : '.') +
          ' Tool-calling support depends on the model and endpoint.',
      );
    },
    [
      '  The list is the built-in catalog plus every id added with /addmodel.',
      '  Both the list and the selected model live in .ryuu/preferences.json, so',
      '  they survive restarts. /addmodel and /delmodel change the list; /model <n>',
      '  and /cmodel <name> change the current model.',
    ].join('\n'),
  );

  define(
    'addmodel',
    'Add a model id to the /model list (existence is not checked)',
    '/addmodel <model-id>',
    async (args) => {
      const name = args.trim();
      if (!name) {
        return print(
          [
            'Usage: /addmodel <model-id>',
            'Example: /addmodel meta-llama/llama-3.3-70b-instruct',
            'The id is added to the /model list and saved in .ryuu/preferences.json.',
            'No availability check is made: a wrong id only fails when it is used.',
            'Run /help addmodel for the full tutorial.',
          ].join('\n'),
        );
      }
      const activeProvider = currentProvider();
      if ((activeProvider?.models || []).some((entry) => entry.id === name)) {
        return print(`${name} is already a built-in catalog model for ${activeProvider.id}. Run /model to see its number.`);
      }
      const result = await addCustomModel(stateDir(), name, currentProviderId());
      if (!result.ok) {
        if (result.reason === 'exists') {
          return print(`${name} is already in the model list. Run /model to see its number.`);
        }
        if (result.reason === 'invalid') {
          return print(
            [
              `"${name}" is not a usable model id.`,
              'Use letters, digits and . _ : / - (no spaces), e.g. meta-llama/llama-3.3-70b-instruct.',
              'Nothing was added.',
            ].join('\n'),
          );
        }
        if (result.reason === 'limit') {
          return print(
            `The list already holds ${MAX_CUSTOM_MODELS} added model(s). Remove one with /delmodel <model-id> first.`,
          );
        }
        return print(
          `Could not save ${name} to ${preferencesFile(stateDir())}. The model list is unchanged.`,
        );
      }
      const { all } = await modelList();
      const index = all.indexOf(name) + 1;
      print(
        [
          `Added ${name} to the model list (#${index}).`,
          `Switch to it with /model ${index}.`,
          'No availability check was made: if this id does not exist (or the endpoint cannot call',
          'tools for it), requests using it will fail — that is on the id you entered.',
        ].join('\n'),
      );
    },
    [
      '  How to use:',
      '    1. /addmodel vendor/model-name   add it to the numbered /model list',
      '    2. /model                        see the list (added ids are marked "(added)")',
      '    3. /model <n>                    switch to it for subsequent requests',
      '',
      '  Notes:',
      '    - Saved in .ryuu/preferences.json next to this workspace\u2019s sessions,',
      '      so it survives restarts; restarting the CLI keeps the list.',
      '    - The id is stored as typed (letters, digits, . _ : / -; no spaces).',
      '    - Existence, quota and tool-calling support are NOT checked. A bad id',
      '      only fails when the model is used, and that is the user\u2019s risk.',
      '    - At most ' + MAX_CUSTOM_MODELS + ' added models; /delmodel <model-id> removes one.',
    ].join('\n'),
  );

  define(
    'delmodel',
    'Remove a model added with /addmodel from the /model list',
    '/delmodel <model-id>',
    async (args) => {
      const name = args.trim();
      if (!name) {
        return print(
          [
            'Usage: /delmodel <model-id>',
            'Example: /delmodel meta-llama/llama-3.3-70b-instruct',
            'Only ids added with /addmodel can be removed; built-in catalog models stay.',
            'Run /help delmodel for the full tutorial.',
          ].join('\n'),
        );
      }
      const activeProvider = currentProvider();
      if ((activeProvider?.models || []).some((entry) => entry.id === name)) {
        return print(
          `${name} is a built-in catalog model and cannot be removed (provider ${activeProvider.id}). /delmodel only removes ids added with /addmodel.`,
        );
      }
      const result = await removeCustomModel(stateDir(), name, currentProviderId());
      if (!result.ok) {
        if (result.reason === 'missing') {
          return print(
            `${name} is not in the added-model list. Run /model to see it (built-in ids are listed too).`,
          );
        }
        return print(
          `Could not update ${preferencesFile(stateDir())}. The model list is unchanged.`,
        );
      }
      const lines = [`Removed ${name} from the model list.`];
      if (config.model === name) {
        lines.push(
          'It is still the current model for this session; pick another with /model <n> or /cmodel <name>.',
        );
      }
      print(lines.join('\n'));
    },
    [
      '  How to use:',
      '    1. /delmodel vendor/model-name   remove an id added with /addmodel',
      '    2. /model                        confirm the remaining list',
      '',
      '  Notes:',
      '    - Built-in catalog models cannot be deleted; only added ids.',
      '    - Removing the current model keeps it selected for this session.',
      '      Choose another with /model <n>, or set one directly with /cmodel <name>.',
      '    - Removing an id that is not in the added list changes nothing.',
    ].join('\n'),
  );

  define('cmodel', 'Set a custom model id for the current provider (user risk if it does not exist)', '/cmodel <name> | /custommodel <name>', async (args) => {
    const name = args.trim();
    if (!name) {
      return print(
        'Usage: /cmodel <name>  (alias: /custommodel <name>)\n' +
          `Example: /cmodel ${currentProvider()?.defaultModel || 'deepseek-v4.1-flash:free'}\n` +
          'Peringatan: ketersediaan model di server provider adalah tanggung jawab user. Jika model tidak ada, gunakan /model untuk daftar model yang tersedia atau coba nama custom model lain.',
      );
    }
    if (!normalizeModelId(name)) {
      return print(
        [
          `"${name}" is not a usable model id.`,
          'Use letters, digits and . _ : / - (no spaces), e.g. deepseek-v4.1-flash:free.',
          'Nothing was changed.',
        ].join('\n'),
      );
    }
    config.model = name;
    if (provider.config) provider.config.model = name;
    const saved = await writeModelPreference(stateDirFor(config.workspace), name, { providerId: currentProviderId() });
    print(
      `Custom model set to ${name} for ${config.providerName || currentProviderId()} for subsequent requests` +
        (saved ? '; saved, so it stays selected in future runs.' : '.') +
        ' Jika model ini tidak tersedia di server provider, permintaan akan gagal — gunakan /model untuk model yang tersedia atau coba nama custom model lain.',
    );
  });

  define('custommodel', 'Alias for /cmodel — set a custom NVIDIA model name (user risk if the model does not exist)', '/custommodel <name>', async (args) => {
    commands.get('cmodel').handler(args);
  });

  let runningShell = null;

  define(
    'bash',
    'Run a shell command yourself (not a prompt); output is added to the AI context',
    '/bash <command>',
    async (args) => {
      const command = args.trim().replace(/^!\s*/, '').trim();
      if (!command) {
        return print(
          [
            'Usage: /bash <command>',
            'Example: /bash npm test',
            'Tip: a line starting with "!" runs the same way, e.g. !git status',
            'Output is printed in full and both the command and its output are added to the session context.',
          ].join('\n'),
        );
      }
      if (config.approvalPolicy === 'read-only') {
        return renderer.warn('The read-only policy blocks shell commands. Start without --read-only to use /bash.');
      }
      if (runningShell) {
        return renderer.warn('A shell command is already running. Wait for it to finish or press Ctrl+C.');
      }
      const controller = new AbortController();
      runningShell = { controller, command };
      // The REPL checks this to cancel a long shell command with Ctrl+C.
      state.activeShell = runningShell;
      try {
        const result = await runUserShell({
          command,
          cwd: workspace.root,
          maxBytes: Math.max(20_000, Number(config.maxToolOutputBytes) * 4 || 200_000),
          signal: controller.signal,
        });
        renderer.shellResult?.({
          command,
          cwd: workspace.root,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          truncated: result.truncated,
          signal: result.signal,
          error: result.error,
        });
        state.getAgent()?.recordUserShell?.({
          command,
          cwd: workspace.root,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          truncated: result.truncated,
        });
        if (result.error) renderer.warn(`Shell command failed to start: ${result.error}`);
        else print('  added to session context — the AI will see it on the next task.');
      } finally {
        runningShell = null;
        state.activeShell = null;
      }
    },
    [
      '  How to use:',
      '    /bash npm test              run one command in the workspace',
      '    !git status                 same thing, without typing /bash',
      '',
      '  Notes:',
      '    - This is your own shell, not a model tool call: no approval prompt is',
      '      shown, but --read-only still refuses it.',
      '    - The full captured output is printed; very long output keeps the tail',
      '      (bounded capture) and is marked as truncated.',
      '    - The command and its output are stored as a user turn in the session',
      '      conversation, so the next task knows what you ran and what happened.',
      '    - Ctrl+C cancels a running shell command.',
    ].join('\n'),
  );

  define('workspace', 'Show the workspace the agent is allowed to touch', '/workspace', async () => {
    print(
      [
        `Workspace: ${workspace.root}`,
        'Path switching is intentionally not supported mid-session: processes, approvals and sessions are scoped to it.',
        'Start a new session with ryuu --workspace /path.',
      ].join('\n'),
    );
  });

  define('files', 'List files in the workspace', '/files [path]', async (args) => {
    const listing = await workspace.list(args.trim() || '.', { limit: 200, includeHidden: true });
    const rows = listing.entries.map((entry) => `  ${entry.kind === 'dir' ? 'd' : entry.kind === 'file' ? 'f' : '?'} ${entry.path}${entry.size !== null ? ` (${formatBytes(entry.size)})` : ''}`);
    print([`${listing.total} entr${listing.total === 1 ? 'y' : 'ies'} in ${listing.path}`, ...rows, listing.truncated ? '  … truncated (use limit/pagination via tools)' : ''].join('\n'));
  });

  define('tree', 'Show a bounded directory tree', '/tree [path]', async (args) => {
    const result = await workspace.tree(args.trim() || '.', { depth: 3, maxEntries: 200 });
    print(result.text);
  });

  define('tools', 'List registered tools and their risk level', '/tools', async () => {
    const rows = registry.list().map((tool) => `  ${tool.name.padEnd(20)} ${tool.risk.padEnd(12)} ${tool.requiresApproval ? 'approval' : 'auto'}`);
    print([`${registry.list().length} tools`, ...rows].join('\n'));
  });

  define('processes', 'List running and recent processes', '/processes', async () => {
    const rows = processes.list();
    if (rows.length === 0) return print('No processes started in this session.');
    print(
      rows
        .map((proc) => `  ${proc.id.padEnd(4)} ${proc.status.padEnd(8)} pid ${String(proc.pid ?? '-').padEnd(8)} ${proc.argv.join(' ')}${proc.exitCode !== null ? ` · exit ${proc.exitCode}` : ''}`)
        .join('\n'),
    );
  });

  define('logs', 'Show captured output for a process, or recent process logs', '/logs [process-id]', async (args) => {
    const id = args.trim();
    if (!id) {
      const rows = processes.list();
      print(
        [
          `Log file: ${config.logDir}/agent.log`,
          rows.length ? 'Processes (use /logs <id>):' : 'No processes started in this session.',
          ...rows.map((proc) => `  ${proc.id} · ${proc.label} · ${proc.status}`),
        ].join('\n'),
      );
      return;
    }
    const output = processes.getOutput(id, { tailBytes: 12000 });
    print(
      [
        `${output.id} · ${output.status} · exit ${output.exitCode ?? '-'} · ${output.durationMs ?? '?'}ms`,
        '--- stdout ---',
        output.stdout || '(empty)',
        '--- stderr ---',
        output.stderr || '(empty)',
        output.truncated ? '(captured output was truncated)' : '',
      ].join('\n'),
    );
  });

  define('expand', 'List reasoning / run_command blocks, or open one in full', '/expand [block-id]', async (args) => {
    const raw = args.trim().replace(/^#/, '');
    if (!raw) {
      renderer.lines(renderer.blockListText());
      return;
    }
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      renderer.warn('Usage: /expand <block-id>   (run /expand with no argument to list blocks)');
      return;
    }
    if (!renderer.hasBlock(id)) {
      renderer.warn(`No block #${id}. Run /expand to list the blocks of this session.`);
      return;
    }
    renderer.openBlockView(id);
  });

  define('copy', 'Copy a prompt you already sent to the terminal clipboard', '/copy [n]', async (args) => {
    const raw = args.trim();
    if (raw && !/^\d+$/.test(raw)) {
      renderer.warn('Usage: /copy [n]   (n = how many prompts back; default: the latest)');
      return;
    }
    const result = renderer.copyTask?.(raw ? Number(raw) : 0);
    if (!result) {
      renderer.warn('This interface cannot copy to the clipboard.');
      return;
    }
    if (result.ok) return;
    if (result.reason === 'no-task') {
      renderer.warn('Nothing to copy yet: send a prompt first.');
      return;
    }
    renderer.warn('Clipboard copy needs an interactive terminal that supports OSC 52.');
  });

  define('cancel', 'Cancel the running task or stop a process', '/cancel [process-id]', async (args) => {
    const target = args.trim();
    if (/^p\d+$/.test(target)) {
      const result = await processes.stop(target);
      return print(`Process ${target}: ${result.status}${result.exitCode !== null ? ` (exit ${result.exitCode})` : ''}`);
    }
    if (state.cancelActiveTask()) return print('Cancellation requested for the running task.');
    if (processes.list({ includeCompleted: false }).some((proc) => proc.status === 'running')) {
      return print('No task is running. Use /cancel <process-id> to stop a process.');
    }
    print('Nothing to cancel.');
  });

  define('history', 'Show recent saved sessions', '/history', async () => {
    const sessions = await sessionStore.list({ limit: 15 });
    if (sessions.length === 0) return print('No saved sessions yet. Each completed task is stored locally (secrets excluded).');
    print(
      [
        'Recent sessions:',
        ...sessions.map(
          (session) =>
            `  ${session.id}  ${String(session.status || '?').padEnd(10)} ${String(session.updatedAt || '').slice(0, 19)}  ` +
            `${session.durationMs ? `${(session.durationMs / 1000).toFixed(0)}s`.padEnd(6) : ''.padEnd(6)}  ${session.task}`,
        ),
        '',
        `Storage: ${config.historyDir}`,
        'Use /sessions show <id> for details.',
      ].join('\n'),
    );
  });

  define('sessions', 'Manage local sessions: list | show <id> | delete <id> | clear', '/sessions [list|show <id>|delete <id>|clear]', async (args) => {
    const [sub, id] = args.trim().split(/\s+/);
    if (!sub || sub === 'list') return commands.get('history').handler('');
    if (sub === 'show') {
      if (!id) return print('Usage: /sessions show <id>');
      const session = await sessionStore.load(id);
      print(
        [
          `Session ${session.id}`,
          `task      ${session.task}`,
          `status    ${session.status}`,
          `created   ${session.createdAt}`,
          `updated   ${session.updatedAt}`,
          `model     ${session.model}`,
          `steps     ${session.steps}`,
          `duration  ${session.durationMs ? `${(session.durationMs / 1000).toFixed(1)}s` : 'unknown'}`,
          `changed   ${(session.changedFiles || []).join(', ') || 'none'}`,
          `commands  ${(session.commands || []).map((cmd) => (cmd.argv || []).join(' ')).join('; ') || 'none'}`,
          `issues    ${(session.issues || []).join('; ') || 'none'}`,
          `tokens    ${session.tokenUsage?.prompt ?? 0} prompt / ${session.tokenUsage?.completion ?? 0} completion` +
            (session.modelCalls ? ` · ${session.modelCalls} model call(s)` : ''),
        ].join('\n'),
      );
      print('\nTranscript:');
      for (const entry of (session.transcript || []).slice(-20)) {
        print(`  [${entry.role}${entry.name ? `:${entry.name}` : ''}] ${String(entry.content || '').split('\n')[0].slice(0, 160)}`);
      }
      return;
    }
    if (sub === 'delete') {
      if (!id) return print('Usage: /sessions delete <id>');
      const removed = await sessionStore.delete(id);
      return print(removed ? `Deleted session ${id}.` : `Session not found: ${id}`);
    }
    if (sub === 'clear') {
      if (!interactive) return print('Refusing to clear session history in non-interactive mode.');
      const answer = await state.confirmLocal('Delete ALL locally stored sessions? [y/N] ');
      if (!answer) return print('Cancelled.');
      const count = await sessionStore.clear();
      return print(`Deleted ${count} session file(s).`);
    }
    print('Usage: /sessions [list|show <id>|delete <id>|clear]');
  });

  define('diff', 'Show a diff of agent changes (or git diff if available)', '/diff', async () => {
    const entries = undo.entries.filter((entry) => entry.kind === 'write' || entry.kind === 'delete');
    if (entries.length > 0) {
      const chunks = [];
      for (const entry of entries.slice(-5)) {
        let current = '';
        try {
          current = (await workspace.readText(entry.path)).text;
        } catch {
          current = entry.kind === 'delete' ? entry.before : '';
        }
        const before = entry.kind === 'delete' ? entry.before : entry.before ?? '';
        const diff = createUnifiedDiff(before, current, { oldLabel: `a/${entry.path}`, newLabel: `b/${entry.path}`, maxLines: 120 });
        const stats = diffStats(before, current);
        chunks.push(diff ? `${diff}\n(${stats.added} added, ${stats.removed} removed)` : `(no changes) ${entry.path}`);
      }
      return print(chunks.join('\n\n'));
    }
    try {
      const tool = registry.get('inspect_git');
      const result = await tool.handler({ action: 'diff', max_lines: 300 }, { workspace, config });
      if (result.available === false) return print('No agent-recorded changes and Git is not available.');
      return print(result.diff || result.output || 'Working tree is clean.');
    } catch (error) {
      return print(`No agent-recorded changes. Git diff failed: ${error.message}`);
    }
  });

  define('undo', 'Revert the last agent file change', '/undo [confirm]', async (args = '') => {
    if (undo.size === 0) return print('Nothing to undo in this session.');
    const last = undo.list().at(-1);
    print(`Last change: ${last.kind} ${last.path}${last.to ? ` -> ${last.to}` : ''} (${last.at})`);
    if (interactive) {
      const approved = await state.confirmLocal('Revert this change? [y/N] ');
      if (!approved) return print('Cancelled.');
    } else if (args.trim() !== 'confirm') {
      return print('Refusing to undo in non-interactive mode without the explicit "confirm" argument.');
    }
    const entry = await undo.revertLast();
    highlight(renderer, `Reverted ${entry.kind} on ${entry.path}${entry.to ? ` -> ${entry.path}` : ''}.`);
  });

  define('web', 'Manage multi-provider web search: status | providers | test | enable/disable <id>', '/web [status|providers|test|enable <id>|disable <id>]', async (args = '') => {
    const parts = String(args).trim().split(/\s+/).filter(Boolean);
    const sub = (parts[0] || 'status').toLowerCase();
    const id = (parts[1] || '').toLowerCase();
    if (!webSearch) return print('Web search is not available in this session.');

    if (sub === 'providers') {
      const rows = webSearch.list().map((item) => {
        const info = PROVIDER_INFO[item.id] || {};
        const key = info.requiresKey ? `key: ${info.keySetting}` : info.keySetting ? `optional key: ${info.keySetting}` : 'no key';
        return [
          `  ${item.label.padEnd(12)} ${item.transport.padEnd(16)} ${key}`,
          `    ${info.note || ''}`,
          `    docs: ${info.docs || '-'}`,
        ].join('\n');
      });
      return print(['WEB SEARCH PROVIDERS', ...rows].join('\n'));
    }

    if (sub === 'test') {
      print('Checking MCP connections and tool discovery (no search query is run, so no search credits are used)…');
      const rows = await webSearch.probe();
      const lines = rows.map((row) => {
        if (row.skipped) return `  ${row.label.padEnd(12)} ! ${row.reason}`;
        if (!row.ok) return `  ${row.label.padEnd(12)} ✕ ${row.reason} · ${row.durationMs}ms`;
        const tools = row.tools?.length ? `tools: ${row.tools.join(', ')}` : 'no tools discovered';
        return `  ${row.label.padEnd(12)} ✓ ${row.durationMs}ms · ${tools}`;
      });
      return print(['WEB SEARCH TEST', ...lines, '', 'Discovery only: no provider was queried.'].join('\n'));
    }

    if (sub === 'enable' || sub === 'disable') {
      if (!id) return print(`Usage: /web ${sub} <provider-id>`);
      if (!webSearch.setEnabled(id, sub === 'enable')) {
        return print(`Unknown provider: ${id}. Use /web providers to list them.`);
      }
      return print(`${id} ${sub === 'enable' ? 'enabled' : 'disabled'} for this session (not written to disk).`);
    }

    if (sub !== 'status') return print('Usage: /web [status|providers|test|enable <id>|disable <id>]');
    const rows = webSearch.list();
    const lines = rows.map((item) => {
      const state = item.enabled === false
        ? 'disabled'
        : !item.configured
          ? 'missing key'
          : item.circuitOpen
            ? `circuit open (${Math.ceil(item.circuitRetryInMs / 1000)}s)`
            : item.connected
              ? 'connected'
              : 'ready';
      const caps = [item.capabilities?.search ? 'search' : null, item.capabilities?.extract ? 'extract' : null].filter(Boolean).join('+') || 'none';
      const last = item.lastStatus
        ? ` · last: ${item.lastStatus}${item.lastReason ? ` (${item.lastReason})` : ''}${item.lastDurationMs ? ` ${item.lastDurationMs}ms` : ''}`
        : '';
      return `  ${item.label.padEnd(12)} ${state.padEnd(20)} ${caps.padEnd(14)}${last}`;
    });
    return print(
      [
        'WEB SEARCH',
        `  order: ${rows.map((item) => item.id).join(' → ') || '(none)'}`,
        `  fallback: ${webSearch.fallbackEnabled ? 'on' : 'off'} · timeout: ${webSearch.timeoutMs}ms · retries: ${webSearch.maxRetries}`,
        ...lines,
        '',
        'Use /web test to check connections, /web enable <id> to change this session.',
      ].join('\n'),
    );
  });

  define('config', 'Show effective configuration (secrets redacted)', '/config', async () => {
    const described = describeConfig(config);
    const width = Math.max(...Object.keys(described).map((key) => key.length));
    print(Object.entries(described).map(([key, value]) => `${key.padEnd(width)}  ${value}`).join('\n'));
  });

  define('doctor', 'Run diagnostics; add "live" for one real API request', '/doctor [live]', async (args) => {
    const live = args.trim() === 'live' || args.trim() === '--live';
    print('Running diagnostics…');
    const report = await runDoctor({ config, workspace, provider, live });
    print(formatDoctor(report));
    if (live) print('Note: a live check consumes provider quota and depends on network access.');
  });

  return {
    list: () => [...commands.keys()],
    has: (name) => commands.has(name),
    get: (name) => commands.get(name),
    async execute(parsed) {
      const command = commands.get(parsed.name);
      if (!command) {
        print(`Unknown command: /${parsed.name}. Run /help.`);
        return;
      }
      try {
        return await command.handler(parsed.args, parsed.parts);
      } catch (error) {
        const message = error instanceof RyuuError ? error.message : `${error.message}`;
        print(`Command failed: ${message}`);
      }
    },
  };
}

function highlight(renderer, message) {
  renderer.success(message);
}
