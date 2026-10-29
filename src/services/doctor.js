import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkRuntime } from '../config/load.js';
import { redact } from '../utils/redaction.js';

const execFileAsync = promisify(execFile);

const PASS = 'pass';
const WARN = 'warn';
const FAIL = 'fail';
const SKIP = 'skip';

/**
 * Diagnostics that never print secrets. With { live: true } it performs one
 * small chat request; otherwise it stays fully offline.
 */
export async function runDoctor({ config, workspace, provider = null, live = false, logger = null } = {}) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  try {
    const runtime = checkRuntime();
    add('runtime', runtime.major >= 25 ? PASS : WARN, `Node.js ${process.version} (target: Node.js 25.x)`);
  } catch (error) {
    add('runtime', FAIL, error.message);
  }

  const apiKeyPath = config.apiKeyPath || 'providers.nvidia.apiKey';
  const providerName = config.providerName || 'NVIDIA Integrate API';
  const providerId = config.providerId || 'nvidia';
  add(
    'config',
    config.apiKey ? PASS : FAIL,
    config.apiKey ? `${apiKeyPath} is set (value hidden)` : `${apiKeyPath} is missing`,
  );
  add('provider.endpoint', PASS, `${providerName} (${providerId}) at ${config.baseURL} (OpenAI-compatible chat.completions)`);
  add('provider.model', config.apiKey ? PASS : WARN, config.model);
  const providerRows = Array.isArray(config.providers) ? config.providers : [];
  add(
    'provider.catalog',
    providerRows.length > 0 ? PASS : FAIL,
    providerRows.length > 0
      ? providerRows
          .map((provider) => `${provider.id}${provider.id === providerId ? '*' : ''}: ${provider.apiKey ? 'key set' : `no key (${provider.apiKeyPath})`}`)
          .join(' · ')
      : 'no providers configured',
  );
  add(
    'web_search',
    config.webSearchApiKey ? PASS : SKIP,
    config.webSearchApiKey
      ? `${config.webSearchEndpoint} (key hidden, ${config.webSearchResults} result cap)`
      : 'Disabled: set webSearch.serperApiKey in config.json to enable the web_search tool.',
  );

  if (workspace) {
    try {
      const probeName = `.ryuu/doctor-probe-${crypto.randomBytes(3).toString('hex')}.txt`;
      await workspace.writeText(probeName, 'ryuu doctor probe\n');
      const readBack = await workspace.readText(probeName);
      await workspace.remove(probeName);
      add('workspace.write', readBack.text.startsWith('ryuu doctor probe') ? PASS : FAIL, `Read/write OK in ${workspace.root}`);
    } catch (error) {
      add('workspace.write', FAIL, `Cannot write inside workspace: ${error.message}`);
    }
  } else {
    add('workspace.write', FAIL, 'Workspace is not available');
  }

  for (const [label, dir] of [['state.history', config.historyDir], ['state.logs', config.logDir], ['state.undo', config.undoDir]]) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      await fsp.access(dir, fs.constants.W_OK);
      add(label, PASS, dir);
    } catch (error) {
      add(label, FAIL, `${dir} is not writable: ${error.message}`);
    }
  }

  try {
    const { stdout } = await execFileAsync('git', ['--version'], { timeout: 5000 });
    add('git', PASS, stdout.trim());
  } catch {
    add('git', WARN, 'Git is not installed; /diff and inspect_git will report unavailable.');
  }

  if (!config.apiKey) {
    add('provider.connectivity', SKIP, `Skipped: no API key. Set ${apiKeyPath}, then run /doctor live.`);
  } else if (!live) {
    add('provider.connectivity', SKIP, 'Offline check only. Run /doctor live (or `ryuu --doctor --live`) for one small API call.');
  } else if (!provider) {
    add('provider.connectivity', FAIL, 'Provider is not initialized.');
  } else {
    const result = await provider.ping();
    if (result.ok) {
      add('provider.connectivity', PASS, `${providerName} · ${result.model} responded in ${result.latencyMs}ms`);
    } else {
      add('provider.connectivity', FAIL, redact(`${result.error.code}: ${result.error.message}`));
    }
  }

  logger?.info('doctor finished', { ok: !checks.some((check) => check.status === FAIL), live });
  return {
    live,
    ok: !checks.some((check) => check.status === FAIL),
    checks,
  };
}

export function formatDoctor(report) {
  const icon = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' };
  const lines = ['Ryuu Agent CLI doctor'];
  for (const check of report.checks) {
    lines.push(`[${icon[check.status] || check.status}] ${check.name}: ${check.detail}`);
  }
  lines.push(report.ok ? 'Result: ready (warnings are informational).' : 'Result: blocking issues found.');
  return lines.join('\n');
}

export function doctorLogPath(config) {
  return path.join(config.logDir, 'agent.log');
}
