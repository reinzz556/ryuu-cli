import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  PACKAGE_NAME,
  compareVersions,
  installUpdate,
  isModuleInstall,
  isNewerVersion,
  startUpdateCheck,
  swapPackage,
  updateCheckEnabled,
} from '../../src/services/update.js';
import { makeTempDir } from '../helpers.js';

test('orders semantic versions, releases over prereleases', () => {
  assert.equal(compareVersions('0.7.2', '0.7.2'), 0);
  assert.equal(compareVersions('0.7.10', '0.7.9'), 1);
  assert.equal(compareVersions('0.6.99', '0.7.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.2'), 1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);

  assert.equal(isNewerVersion('0.7.3', '0.7.2'), true);
  assert.equal(isNewerVersion('0.7.2', '0.7.2'), false);
  assert.equal(isNewerVersion('0.7.1', '0.7.2'), false);
  assert.equal(isNewerVersion('not-a-version', '0.7.2'), false);
});

test('recognises an npm module layout and ignores a git checkout', () => {
  assert.equal(isModuleInstall(path.join('/opt', 'node_modules', '@ryuu-reinzz', 'ryuu-cli')), true);
  assert.equal(isModuleInstall(path.join('/opt', 'node_modules', 'ryuu-cli')), true);
  assert.equal(isModuleInstall(path.join('/home', 'dev', 'agents', 'ryuu')), false);
});

test('the update check is off in tests and CI', () => {
  assert.equal(updateCheckEnabled({}), true);
  assert.equal(updateCheckEnabled({ RYUU_NO_UPDATE_CHECK: '1' }), false);
  assert.equal(updateCheckEnabled({ RYUU_NO_UPDATE_CHECK: '0' }), true);
  assert.equal(updateCheckEnabled({ NODE_TEST_CONTEXT: 'child-v8' }), false);
  assert.equal(updateCheckEnabled({ CI: 'true' }), false);
  assert.equal(updateCheckEnabled({ CI: 'false' }), true);
});

test('reports only a newer published version, and stays silent on failure', async () => {
  const root = path.join('/tmp', 'node_modules', '@ryuu-reinzz', 'ryuu-cli');
  const respond = (version, status = 200) =>
    async () => new Response(JSON.stringify({ version }), { status });

  // `env: {}` opts out of the test-runner guard this suite runs under.
  const check = (options) => startUpdateCheck({ currentVersion: '0.7.2', root, env: {}, ...options }).promise;

  assert.deepEqual(await check({ fetchImpl: respond('0.8.0') }), {
    current: '0.7.2',
    latest: '0.8.0',
    root,
    installable: true,
  });

  assert.equal(await check({ fetchImpl: respond('0.7.2') }), null);
  assert.equal(await check({ fetchImpl: respond('0.7.1') }), null);
  assert.equal(await check({ fetchImpl: respond('0.8.0', 500) }), null);
  assert.equal(
    await check({
      fetchImpl: async () => {
        throw new Error('offline');
      },
    }),
    null,
  );

  const checkout = await check({
    fetchImpl: respond('0.8.0'),
    root: path.join('/home', 'dev', 'agents', 'ryuu'),
  });
  assert.equal(checkout.installable, false, 'a git checkout must never be rewritten');
});

async function writePackage(dir, version, source) {
  await fsp.mkdir(path.join(dir, 'src'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version }), 'utf8');
  await fsp.writeFile(path.join(dir, 'src', 'index.js'), source, 'utf8');
}

test('swaps the package, keeps node_modules and removes the backup', async () => {
  const base = await makeTempDir('ryuu-update-');
  try {
    const root = path.join(base, 'node_modules', '@ryuu-reinzz', 'ryuu-cli');
    await writePackage(root, '1.0.0', 'old');
    await fsp.mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
    await fsp.writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'dep', 'utf8');

    const staged = path.join(base, 'staged');
    await writePackage(staged, '1.0.1', 'new');

    const calls = [];
    const run = async (command, args, options = {}) => {
      calls.push({ command, args, cwd: options.cwd });
    };
    const result = await swapPackage({ root, staged, version: '1.0.1', run });

    assert.equal(result.updated, true);
    assert.equal(result.version, '1.0.1');
    assert.equal(JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8')).version, '1.0.1');
    assert.equal(await fsp.readFile(path.join(root, 'src', 'index.js'), 'utf8'), 'new');
    assert.equal(await fsp.readFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'utf8'), 'dep');

    assert.equal(calls.length, 1, 'dependencies are reconciled once');
    assert.equal(calls[0].cwd, root);
    assert.ok(calls[0].args.includes('--omit=dev'));

    const leftovers = (await fsp.readdir(path.dirname(root))).filter((name) => name.includes('.backup-'));
    assert.deepEqual(leftovers, []);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('restores the previous install when the new one cannot be installed', async () => {
  const base = await makeTempDir('ryuu-update-');
  try {
    const root = path.join(base, 'node_modules', '@ryuu-reinzz', 'ryuu-cli');
    await writePackage(root, '1.0.0', 'old');
    const staged = path.join(base, 'staged');
    await writePackage(staged, '1.0.1', 'new');

    const run = async () => {
      throw new Error('npm install failed');
    };
    await assert.rejects(swapPackage({ root, staged, version: '1.0.1', run }), /npm install failed/);

    assert.equal(JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8')).version, '1.0.0');
    assert.equal(await fsp.readFile(path.join(root, 'src', 'index.js'), 'utf8'), 'old');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('downloads the tarball, validates it and installs the requested version', async () => {
  const base = await makeTempDir('ryuu-install-');
  try {
    const root = path.join(base, 'node_modules', '@ryuu-reinzz', 'ryuu-cli');
    await writePackage(root, '1.0.0', 'old');

    const run = async (command, args) => {
      if (args[0] === 'pack') {
        const destination = args[args.indexOf('--pack-destination') + 1];
        await fsp.writeFile(path.join(destination, 'ryuu-cli-2.0.0.tgz'), '', 'utf8');
        return;
      }
      if (args[0] === '-xzf') {
        const destination = args[args.indexOf('-C') + 1];
        await writePackage(path.join(destination, 'package'), '2.0.0', 'v2');
      }
    };

    const result = await installUpdate({ latest: '2.0.0', root, run });
    assert.equal(result.updated, true);
    assert.equal(result.version, '2.0.0');
    assert.equal(await fsp.readFile(path.join(root, 'src', 'index.js'), 'utf8'), 'v2');
    assert.equal(JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8')).version, '2.0.0');

    const leftovers = (await fsp.readdir(path.dirname(root))).filter((name) => name.startsWith('.ryuu-'));
    assert.deepEqual(leftovers, [], 'the staging directory is always cleaned up');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('rejects a tarball whose version does not match the request', async () => {
  const base = await makeTempDir('ryuu-install-');
  try {
    const root = path.join(base, 'node_modules', '@ryuu-reinzz', 'ryuu-cli');
    await writePackage(root, '1.0.0', 'old');

    const run = async (command, args) => {
      if (args[0] === 'pack') {
        const destination = args[args.indexOf('--pack-destination') + 1];
        await fsp.writeFile(path.join(destination, 'ryuu-cli-9.9.9.tgz'), '', 'utf8');
        return;
      }
      if (args[0] === '-xzf') {
        const destination = args[args.indexOf('-C') + 1];
        await writePackage(path.join(destination, 'package'), '1.9.9', 'v2');
      }
    };

    await assert.rejects(installUpdate({ latest: '2.0.0', root, run }), /does not match/);
    assert.equal(await fsp.readFile(path.join(root, 'src', 'index.js'), 'utf8'), 'old');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});
