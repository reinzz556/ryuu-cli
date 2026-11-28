import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readVersion } from '../utils/version.js';

/**
 * Self-update: ask npm for the latest published version and, when it is newer
 * than the running one, replace the installed package directory with it.
 *
 * The check is meant to run in the background while Ryuu works. Nothing here
 * touches the user's config, sessions or workspace: only the installed package
 * directory is staged and swapped, with the old copy kept until the new one is
 * in place. `RYUU_NO_UPDATE_CHECK=1` disables the check (tests and CI set it
 * implicitly too).
 */

export const PACKAGE_NAME = '@ryuu-reinzz/ryuu-cli';
export const UPDATE_DISABLE_ENV = 'RYUU_NO_UPDATE_CHECK';

const REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`;
const CHECK_TIMEOUT_MS = 2000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Absolute path of the package as it is installed (the directory with package.json). */
export function packageRoot() {
  return path.resolve(HERE, '..', '..');
}

/**
 * True when Ryuu runs from a node_modules install, the only layout this updater
 * may rewrite. A git checkout is left untouched: replacing its source would
 * destroy uncommitted work.
 */
export function isModuleInstall(root = packageRoot()) {
  const marker = `${path.sep}node_modules${path.sep}`;
  return root.includes(marker) || root.endsWith(`${path.sep}node_modules`);
}

/** Parsed semver, or null for anything that is not `x.y.z[-pre][+build]`. */
export function parseVersion(value) {
  const match = VERSION_RE.exec(String(value ?? '').trim());
  if (!match) return null;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Semver ordering: -1 when `a` is older, 0 when equal, 1 when newer. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    const difference = left.numbers[index] - right.numbers[index];
    if (difference !== 0) return Math.sign(difference);
  }
  // A release outranks any of its prereleases.
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const difference = compareIdentifiers(leftPart, rightPart);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** True only when both versions parse and `candidate` is strictly newer. */
export function isNewerVersion(candidate, current) {
  if (!parseVersion(candidate) || !parseVersion(current)) return false;
  return compareVersions(candidate, current) > 0;
}

/**
 * The check is off in tests and CI unless explicitly forced, so a normal test
 * run never touches the network or rewrites an install.
 */
export function updateCheckEnabled(env = process.env) {
  const disabled = env[UPDATE_DISABLE_ENV];
  if (typeof disabled === 'string' && disabled !== '0' && disabled.toLowerCase() !== 'false') return false;
  if (env.NODE_TEST_CONTEXT) return false;
  const ci = env.CI;
  if (typeof ci === 'string' && ci !== '0' && ci.toLowerCase() !== 'false') return false;
  return true;
}

/** Latest published version, or null on any failure (update checks never throw). */
export async function fetchLatestVersion({ fetchImpl = globalThis.fetch, signal = null } = {}) {
  if (typeof fetchImpl !== 'function') return null;
  const response = await fetchImpl(REGISTRY_URL, {
    signal: signal || undefined,
    headers: { accept: 'application/json' },
    redirect: 'follow',
  });
  if (!response?.ok) return null;
  const body = await response.json();
  return typeof body?.version === 'string' ? body.version : null;
}

/**
 * Start the background check. `promise` resolves to the update info once, or
 * null when there is nothing to do; it never rejects. `cancel()` aborts the
 * request so a short-lived run does not wait on it.
 */
export function startUpdateCheck({
  currentVersion = readVersion(),
  fetchImpl = globalThis.fetch,
  timeoutMs = CHECK_TIMEOUT_MS,
  root = packageRoot(),
  env = process.env,
} = {}) {
  const noop = { promise: Promise.resolve(null), cancel() {} };
  if (!updateCheckEnabled(env) || !parseVersion(currentVersion)) return noop;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, Number(timeoutMs) || CHECK_TIMEOUT_MS));
  timer.unref?.();

  const promise = (async () => {
    try {
      const latest = await fetchLatestVersion({ fetchImpl, signal: controller.signal });
      if (!latest || !isNewerVersion(latest, currentVersion)) return null;
      return { current: currentVersion, latest, root, installable: isModuleInstall(root) };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();

  return {
    promise,
    cancel() {
      clearTimeout(timer);
      controller.abort();
    },
  };
}

function commandName(base) {
  return process.platform === 'win32' ? `${base}.cmd` : base;
}

/**
 * Run a command to completion. Used for npm/tar only; output is captured so a
 * failure can name the real reason instead of an exit code.
 */
function runCommand(command, args, { cwd = null, timeoutMs = 120000, env = null } = {}) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const child = spawn(command, windows ? args.map((arg) => String(arg)) : args, {
      cwd: cwd || undefined,
      env: env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: windows,
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${path.basename(command)} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, Math.max(1000, Number(timeoutMs) || 120000));
    timer.unref?.();
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${path.basename(command)} exited with code ${code}`));
    });
  });
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace `root` with `staged`, keeping the installed `node_modules`, and roll
 * back to the previous copy if anything fails. The old directory stays next to
 * `root` until the new one is installed and its dependencies reconciled.
 */
export async function swapPackage({ root = packageRoot(), staged, version = null, run = runCommand } = {}) {
  if (!staged) throw new Error('No staged package to install');
  const parent = path.dirname(root);
  const backup = path.join(parent, `.${path.basename(root)}.backup-${process.pid}-${Date.now()}`);
  let movedAside = false;
  let placed = false;
  try {
    await fsp.rename(root, backup);
    movedAside = true;
    await fsp.rename(staged, root);
    placed = true;

    const oldModules = path.join(backup, 'node_modules');
    if (await pathExists(oldModules)) {
      const newModules = path.join(root, 'node_modules');
      try {
        await fsp.rename(oldModules, newModules);
      } catch {
        await fsp.cp(oldModules, newModules, { recursive: true });
      }
    }

    // The published dependencies may have changed; npm reconciles them against
    // the reused node_modules, and a failure here restores the old install.
    await run(commandName('npm'), ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--silent'], {
      cwd: root,
      timeoutMs: 240000,
    });

    await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
    return { updated: true, version };
  } catch (error) {
    if (placed) await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    if (movedAside) await fsp.rename(backup, root).catch(() => {});
    throw error;
  }
}

/**
 * Download `latest` from npm and swap it into `root`. Everything is staged in a
 * temporary directory next to the install (same filesystem, so the final move
 * is a rename) and that directory is always removed.
 */
export async function installUpdate({ latest, root = packageRoot(), run = runCommand, logger = null } = {}) {
  if (!latest) throw new Error('No target version to install');
  const parent = path.dirname(root);
  const workspace = await fsp.mkdtemp(path.join(parent, '.ryuu-update-'));
  try {
    await run(commandName('npm'), ['pack', `${PACKAGE_NAME}@${latest}`, '--pack-destination', workspace, '--silent'], {
      timeoutMs: 180000,
    });
    const tarball = (await fsp.readdir(workspace)).find((name) => name.endsWith('.tgz'));
    if (!tarball) throw new Error('npm pack did not produce a tarball');

    const extractDir = path.join(workspace, 'extract');
    await fsp.mkdir(extractDir, { recursive: true });
    await run(commandName('tar'), ['-xzf', path.join(workspace, tarball), '-C', extractDir], { timeoutMs: 120000 });

    const staged = path.join(extractDir, 'package');
    const stagedPackage = JSON.parse(await fsp.readFile(path.join(staged, 'package.json'), 'utf8'));
    if (stagedPackage.version !== latest) {
      throw new Error(`packed version ${stagedPackage.version} does not match ${latest}`);
    }
    if (!(await pathExists(path.join(staged, 'src', 'index.js')))) {
      throw new Error('the packed package has no src/index.js');
    }

    const result = await swapPackage({ root, staged, version: latest, run });
    logger?.info('self-update installed', { from: readVersion(), to: latest });
    return result;
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}
