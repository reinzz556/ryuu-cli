#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { PACKAGE_ENV_FILE, buildRawConfig, checkRuntime, loadEnvFile } from './config/load.js';
import { validateConfig } from './config/validate.js';
import { ConfigError, formatErrorBlock } from './utils/errors.js';
import { createApp } from './cli/app.js';
import { formatDoctor, runDoctor } from './services/doctor.js';
import { createActiveProvider } from './providers/index.js';
import {
  SettingsStore,
  applySettingsToRaw,
  readSettings,
  settingsModelFor,
  settingsProviderId,
} from './config/settings.js';
import { buildSettingsRegistry } from './config/settings-registry.js';
import { buildProviders, parseExtraProviders } from './providers/catalog.js';
import { SettingsSession, runSettingsEditor } from './cli/settings-editor.js';
import { SettingsTui } from './cli/settings-tui.js';
import { applyPersistedModel, applyPersistedProvider, stateDirFor } from './services/preferences.js';
import { createLogger } from './services/logger.js';
import { Workspace } from './services/workspace.js';
import { readVersion } from './utils/version.js';

// The version lives in package.json; this module re-exports the reader so the
// CLI entry point and the tests keep one import site.
export { readVersion };

const HELP = `Ryuu Agent CLI — autonomous coding agent in your terminal

Usage:
  ryuu                      Start the interactive agent
  ryuu "task"               Run one task non-interactively
  ryuu --task "task"        Same, explicit flag
  echo "task" | ryuu        Read the task from stdin

Options:
  -h, --help                Show this help
  -v, --version             Show the version
      --doctor              Run diagnostics (offline)
      --live                With --doctor: one real API request
      --workspace <path>    Workspace override (AGENT_WORKSPACE)
      --provider <id>       Provider override (RYUU_PROVIDER), e.g. tokenharbor
      --model <id>          Model override for this run (RYUU_MODEL)
      --max-steps <n>       Optional step cap (0 = unlimited, default)
  -y, --yes                 Auto-approve file writes (commands still ask)
      --auto-approve        Auto-approve ALL actions incl. commands (AI works without asking)
      --read-only           Deny all writes and command execution
      --env-file <path>     Load a specific .env file
      --settings            Edit the global settings file and exit
      --settings --tui      Full-screen settings editor (requires a TTY)
      --settings --list     Print the editable settings and exit
      --no-color            Disable ANSI colors
      --plain               Plain output (no spinner/colors)
      --tui                 Full-screen UI: scrollable transcript, click/tap
                            blocks to expand, live composer (requires a TTY)
      --debug               Verbose logs and stack traces

Global settings live in ~/.config/ryuu/config.json (Windows: %APPDATA%\\ryuu,
macOS: ~/Library/Application Support/ryuu; RYUU_CONFIG_DIR overrides the folder).
Environment variables and .env still win over the settings file, and a .ryuu
preferences file for the current workspace wins over it too.

Commands inside the CLI: /help, /status, /worklog, /files, /tree, /tools,
/processes, /logs, /expand, /cancel, /history, /sessions, /diff, /undo, /config,
/doctor, /provider, /model, /addmodel, /delmodel, /cmodel, /custommodel,
/workspace, /clear, /memory, /resume, /bash, /exit.
A line starting with "!" runs a shell command yourself (same as /bash).
While a task runs, slash commands still work; a new prompt waits until it ends.

Documentation: README.md · Secrets: provider keys in .env (never commit it).
Providers: nvidia (NVIDIA_API_KEY), tokenharbor (TOKENHARBOR_API_KEY); list them
with /provider, or add your own with RYUU_PROVIDERS in .env.
`;

const SETTINGS_HELP = `Ryuu Agent CLI — global settings

Usage:
  ryuu --settings              Numbered line editor (saves every change immediately)
  ryuu --settings --tui        Full-screen editor (requires an interactive terminal)
  ryuu --settings --list       Print the editable settings and exit
  ryuu --settings --help       Show this help

Editor commands:
  <number> <value>             Save a value (values may contain spaces)
  /list                        Redraw the numbered list
  /show <number>               Show a setting, its description and constraints
  /reset <number>              Reset one setting to its default (asks first)
  /help                        Show the editor commands
  /exit                        Leave the editor (each change is already saved)

Secrets are always masked in the list and are never shown back.
The file is created on first save and written atomically with owner-only
permissions; a malformed file is reported and never overwritten.

Precedence: CLI flags > environment/.env > workspace .ryuu preferences >
global settings file > built-in defaults.
`;

/** Parse argv into options plus a positional task. */
export function parseArgs(argv) {
  const options = {
    task: null,
    doctor: false,
    live: false,
    help: false,
    version: false,
    tui: false,
    settings: false,
    list: false,
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inlineValue] = arg.startsWith('--') && arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const value = () => {
      if (inlineValue !== undefined) return inlineValue;
      index += 1;
      return argv[index];
    };
    switch (flag) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        options.version = true;
        break;
      case '--doctor':
        options.doctor = true;
        break;
      case '--live':
        options.live = true;
        break;
      case '--task':
        options.task = value();
        break;
      case '--workspace':
        options.workspace = value();
        break;
      case '--model':
        options.model = value();
        break;
      case '--provider':
        options.provider = value();
        break;
      case '--max-steps':
        options.maxSteps = value();
        break;
      case '--env-file':
        options.envFile = value();
        break;
      case '-y':
      case '--yes':
        options.yes = true;
        break;
      case '--auto-approve':
        options.autoApprove = true;
        break;
      case '--read-only':
        options.readOnly = true;
        break;
      case '--no-color':
        options.color = false;
        break;
      case '--plain':
        options.plain = true;
        break;
      case '--tui':
        options.tui = true;
        break;
      case '--settings':
        options.settings = true;
        break;
      case '--list':
        options.list = true;
        break;
      case '--debug':
        options.debug = true;
        break;
      case '--':
        positional.push(...argv.slice(index + 1));
        index = argv.length;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new ConfigError(`Unknown option: ${arg}. Run ryuu --help.`);
        }
        positional.push(arg);
    }
  }
  if (!options.task && positional.length > 0) options.task = positional.join(' ');
  return options;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text.trim();
}

function applyOverrides(raw, options) {
  if (options.workspace) raw.workspace = options.workspace;
  if (options.provider) raw.provider = options.provider;
  if (options.model) raw.model = options.model;
  if (options.maxSteps !== undefined) raw.maxSteps = options.maxSteps;
  if (options.readOnly) raw.approvalPolicy = 'read-only';
  if (options.debug) {
    raw.debug = 'true';
    raw.logLevel = 'debug';
  }
  return raw;
}

/** Providers available to the settings editor (built-ins plus RYUU_PROVIDERS). */
function settingsProviders(env) {
  let extras = [];
  try {
    extras = parseExtraProviders(env.RYUU_PROVIDERS, []);
  } catch {
    extras = [];
  }
  return buildProviders({ env, extras });
}

/**
 * `ryuu --settings [--tui|--list]`.
 *
 * Only the settings file and the provider catalog are touched: no agent, no
 * tools, no provider client and no model request are created here.
 */
async function runSettingsMode(options) {
  const env = process.env;
  const store = new SettingsStore({ env });
  const { data, exists } = await store.read();
  const providers = settingsProviders(env);
  const makeRegistry = (current) => buildSettingsRegistry({ providers, settings: current, env });

  if (options.list) {
    const session = new SettingsSession({ store, makeRegistry, data, file: store.file });
    process.stdout.write(`${session.listLines().join('\n')}\n`);
    return 0;
  }

  // A missing file is initialized before the editor opens, so an immediate exit
  // still leaves a private (0600) settings file behind instead of nothing.
  if (!exists) await store.save(data);

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    const needed = options.tui
      ? '--settings --tui needs an interactive terminal.'
      : '--settings needs an interactive terminal.';
    process.stderr.write(`[error] ${needed} Use \`ryuu --settings --list\` for a non-interactive listing.\n`);
    return 2;
  }
  if (options.tui) {
    const tui = new SettingsTui({
      input: process.stdin,
      output: process.stdout,
      store,
      makeRegistry,
      data,
      version: readVersion(),
      color: options.color ?? null,
    });
    try {
      await tui.run();
    } finally {
      tui.close();
    }
    return 0;
  }
  await runSettingsEditor({ store, makeRegistry, data });
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  // Wipe the terminal when the CLI is invoked so the banner starts on a clean
  // screen. console.clear() is a no-op when stdout is not a TTY (pipes, CI).
  console.clear();
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }

  if (options.help) {
    process.stdout.write(options.settings ? SETTINGS_HELP : HELP);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`ryuu-agent-cli ${readVersion()}\n`);
    return 0;
  }
  if (options.list && !options.settings) {
    process.stderr.write('--list is only valid with --settings. Run ryuu --settings --list.\n');
    return 2;
  }

  try {
    checkRuntime();
  } catch (error) {
    process.stderr.write(`${formatErrorBlock(error)}\n`);
    return 2;
  }

  try {
    // Project-local .env wins; the installed CLI's .env fills in the key when
    // `ryuu` is run from an unrelated folder.
    loadEnvFile({ envFile: options.envFile, fallbackFile: PACKAGE_ENV_FILE });
  } catch (error) {
    process.stderr.write(`${formatErrorBlock(error)}\n`);
    return 2;
  }

  // Settings mode never builds the agent, tools or a provider: it only reads
  // and writes the global settings file.
  if (options.settings) {
    try {
      return await runSettingsMode(options);
    } catch (error) {
      process.stderr.write(`${formatErrorBlock(error, { debug: options.debug })}\n`);
      return 2;
    }
  }

  // The global settings file is a lower-precedence default: a malformed file
  // warns and is left untouched instead of blocking the agent.
  let settings = null;
  try {
    settings = (await readSettings()).data;
  } catch (error) {
    process.stderr.write(`[warn] ${error.message}\n`);
  }

  let config;
  try {
    const raw = applyOverrides(buildRawConfig(process.env, { cwd: process.cwd() }), options);
    if (settings) applySettingsToRaw(raw, settings);
    // A provider/model picked with /provider and /model is persisted under
    // <workspace>/.ryuu and wins over env defaults on later runs; explicit
    // --provider/--model flags win for a single run and never rewrite the
    // saved choice. The global settings file is the last fallback before the
    // catalog defaults.
    const stateDir = stateDirFor(raw.workspace);
    await applyPersistedProvider(raw, { flagProvider: options.provider, stateDir });
    if (!raw.provider && settings) {
      const storedProvider = settingsProviderId(settings);
      if (storedProvider) raw.provider = storedProvider;
    }
    await applyPersistedModel(raw, {
      flagModel: options.model,
      stateDir,
      providerId: raw.provider || null,
    });
    if (!raw.model && settings && raw.provider) {
      const storedModel = settingsModelFor(settings, raw.provider);
      if (storedModel) raw.model = storedModel;
    }
    const result = validateConfig(raw, { requireApiKey: !options.doctor, cwd: process.cwd() });
    config = result.config;
    for (const warning of result.warnings) process.stderr.write(`[warn] ${warning}\n`);
  } catch (error) {
    process.stderr.write(`${formatErrorBlock(error, { debug: options.debug })}\n`);
    return 2;
  }

  if (options.doctor) {
    const logger = createLogger(config, { stderr: process.stderr });
    let workspace = null;
    try {
      workspace = new Workspace(config.workspace, { logger });
      const provider = config.apiKey ? createActiveProvider(config, { logger }) : null;
      const report = await runDoctor({ config, workspace, provider, live: options.live, logger });
      process.stdout.write(`${formatDoctor(report)}\n`);
      return report.ok ? 0 : 1;
    } catch (error) {
      process.stderr.write(`${formatErrorBlock(error, { debug: options.debug })}\n`);
      return 1;
    }
  }

  const task = options.task || (await readStdin());
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !options.task && !task;

  let app;
  try {
    app = await createApp({
      config,
      cliOptions: {
        interactive,
        yes: options.yes,
        autoApprove: options.autoApprove,
        plain: options.plain || !interactive,
        color: options.color,
        tui: options.tui,
      },
      version: readVersion(),
    });
  } catch (error) {
    process.stderr.write(`${formatErrorBlock(error, { debug: options.debug })}\n`);
    return 2;
  }

  if (interactive) {
    await app.runInteractive();
    // Belt and braces: whatever the UI left attached, a paused stdin lets the
    // process end as soon as /exit returns, instead of waiting for a keypress.
    process.stdin.pause?.();
    return 0;
  }

  if (!task) {
    process.stderr.write('No task provided in non-interactive mode.\n\n');
    process.stderr.write(HELP);
    await app.close();
    return 2;
  }

  app.banner();
  app.renderer.info(
    options.autoApprove
      ? 'Non-interactive mode: --auto-approve is active; all writes, commands and destructive actions are auto-approved. Shell execution is NOT a sandbox.'
      : "Non-interactive mode: approvals are denied unless --yes (writes) or --auto-approve (all actions) is used.",
  );
  try {
    const summary = await app.runTask(task);
    await app.close();
    if (summary.status === 'completed' || summary.status === 'step-limit') return summary.status === 'completed' ? 0 : 1;
    if (summary.status === 'cancelled') return 130;
    return 1;
  } catch (error) {
    process.stderr.write(`${formatErrorBlock(error, { debug: options.debug })}\n`);
    await app.close();
    return 3;
  }
}

function isInvokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

const invokedDirectly = isInvokedDirectly();
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${formatErrorBlock(error, { debug: true })}\n`);
      process.exitCode = 1;
    });
}
