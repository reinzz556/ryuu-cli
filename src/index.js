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
import { createProvider } from './providers/nvidia.js';
import { applyPersistedModel, stateDirFor } from './services/preferences.js';
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
      --model <id>          Model override (NVIDIA_MODEL)
      --max-steps <n>       Optional step cap (0 = unlimited, default)
  -y, --yes                 Auto-approve file writes (commands still ask)
      --auto-approve        Auto-approve ALL actions incl. commands (AI works without asking)
      --read-only           Deny all writes and command execution
      --env-file <path>     Load a specific .env file
      --no-color            Disable ANSI colors
      --plain               Plain output (no spinner/colors)
      --tui                 Full-screen UI: scrollable transcript, click/tap
                            blocks to expand, live composer (requires a TTY)
      --debug               Verbose logs and stack traces

Commands inside the CLI: /help, /status, /worklog, /files, /tree, /tools,
/processes, /logs, /expand, /cancel, /history, /sessions, /diff, /undo, /config,
/doctor, /model, /addmodel, /delmodel, /cmodel, /custommodel, /workspace, /clear,
/memory, /resume, /bash, /exit.
A line starting with "!" runs a shell command yourself (same as /bash).
While a task runs, slash commands still work; a new prompt waits until it ends.

Documentation: README.md · Secrets: NVIDIA_API_KEY in .env (never commit it).
`;

/** Parse argv into options plus a positional task. */
export function parseArgs(argv) {
  const options = { task: null, doctor: false, live: false, help: false, version: false, tui: false };
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
  if (options.model) raw.model = options.model;
  if (options.maxSteps !== undefined) raw.maxSteps = options.maxSteps;
  if (options.readOnly) raw.approvalPolicy = 'read-only';
  if (options.debug) {
    raw.debug = 'true';
    raw.logLevel = 'debug';
  }
  return raw;
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
    process.stdout.write(HELP);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`ryuu-agent-cli ${readVersion()}\n`);
    return 0;
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

  let config;
  try {
    const raw = applyOverrides(buildRawConfig(process.env, { cwd: process.cwd() }), options);
    // A model picked with /model is persisted under <workspace>/.ryuu and wins
    // over NVIDIA_MODEL on later runs; an explicit --model flag still wins for
    // a single run and never rewrites the saved choice.
    await applyPersistedModel(raw, {
      flagModel: options.model,
      stateDir: stateDirFor(raw.workspace),
    });
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
      const provider = config.apiKey ? createProvider(config, { logger }) : null;
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
