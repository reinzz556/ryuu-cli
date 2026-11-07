import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_GITHUB_CONFIG,
  GITHUB_BACKEND_URL,
  githubPaths,
  readGitHubConfig,
  updateGitHubConfig,
  validateConfigEntry,
  writeGitHubConfig,
} from '../../src/tools/advance/github/config.js';
import {
  clearCredentials,
  describeCredentials,
  loadCredentials,
  saveCredentials,
} from '../../src/tools/advance/github/credentials.js';
import { createGitHubPlugin } from '../../src/tools/advance/github/manager.js';
import { createGitHubCommand } from '../../src/tools/advance/github/command.js';
import { syncPluginTools, unregisterPluginTools } from '../../src/tools/advance/index.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ApprovalManager } from '../../src/agent/approvals.js';
import { parseCommandLine } from '../../src/cli/commands.js';

async function tempPaths() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ryuu-gh-unit-'));
  const paths = {
    dir,
    configFile: path.join(dir, 'config.json'),
    credentialFile: path.join(dir, 'credentials.enc'),
    stateFile: path.join(dir, 'state.json'),
    keyFile: path.join(dir, '.keys', 'github.key'),
  };
  return { dir, paths };
}

async function makePlugin(overrides = {}) {
  const { dir, paths } = await tempPaths();
  const plugin = createGitHubPlugin({
    paths,
    backendUrl: 'http://127.0.0.1:9',
    fetchImpl: async () => {
      throw new Error('fetch tidak diharapkan pada test ini');
    },
    ...overrides,
  });
  return { dir, paths, plugin };
}

test('konfigurasi CLI tidak memuat rahasia dan key sensitif tidak bisa diubah', async () => {
  const { paths } = await tempPaths();
  const config = await readGitHubConfig({ paths });
  assert.equal(config.enabled, false);
  assert.equal(config.autoRefresh, true);
  assert.equal(config.confirmDestructive, true);
  assert.equal(config.backend, GITHUB_BACKEND_URL);
  assert.equal(config.clientId, 'Iv23liIt8Xh4waFhX0y1');
  // Client ID publik boleh ada; secret dan token tidak.
  for (const key of ['clientSecret', 'privateKey', 'privateKeyPath', 'webhookSecret', 'accessToken', 'refreshToken', 'cliToken', 'token']) {
    assert.equal(config[key], undefined, `${key} tidak boleh ada di konfigurasi CLI`);
    assert.throws(() => validateConfigEntry(key, 'x'), /tidak dapat diubah/);
  }
  assert.equal(JSON.stringify(config).includes('d379466c'), false);

  assert.equal(validateConfigEntry('enabled', 'true'), true);
  assert.equal(validateConfigEntry('confirmDestructive', 'false'), false);
  assert.equal(validateConfigEntry('defaultRepo', 'ryuu-reinzz/ryuu-cli'), 'ryuu-reinzz/ryuu-cli');
  assert.equal(validateConfigEntry('defaultRepo', 'none'), null);
  assert.throws(() => validateConfigEntry('defaultRepo', 'bukan-repo'), /owner\/repo/);
  assert.throws(() => validateConfigEntry('tidakAda', '1'), /tidak dikenal/);

  await updateGitHubConfig('enabled', true, { paths });
  assert.equal((await readGitHubConfig({ paths })).enabled, true);

  // File yang ditulis tangan tidak bisa menyelundupkan nilai aplikasi.
  await writeGitHubConfig(
    { ...DEFAULT_GITHUB_CONFIG, backend: 'https://evil.example', clientId: 'evil', clientSecret: 'boo' },
    { paths },
  );
  const cleaned = await readGitHubConfig({ paths });
  assert.equal(cleaned.backend, GITHUB_BACKEND_URL);
  assert.equal(cleaned.clientId, 'Iv23liIt8Xh4waFhX0y1');
  assert.equal(cleaned.clientSecret, undefined);
});

test('githubPaths mengikuti direktori konfigurasi OS', () => {
  const linux = githubPaths({ env: { XDG_CONFIG_HOME: '/tmp/xdg' }, home: '/home/ryuu', platform: 'linux' });
  assert.equal(linux.dir, path.join('/tmp/xdg', 'ryuu', 'integrations', 'github'));
  const mac = githubPaths({ env: {}, home: '/Users/ryuu', platform: 'darwin' });
  assert.equal(mac.dir, path.join('/Users/ryuu', 'Library', 'Application Support', 'ryuu', 'integrations', 'github'));
  const win = githubPaths({ env: { APPDATA: 'C:\\Users\\ryuu\\AppData\\Roaming' }, home: 'C:\\Users\\ryuu', platform: 'win32' });
  assert.equal(win.dir, path.join('C:\\Users\\ryuu\\AppData\\Roaming', 'ryuu', 'integrations', 'github'));
});

test('credential CLI terenkripsi, tidak memuat access token, dan bisa dihapus', async () => {
  const { paths } = await tempPaths();
  assert.equal(await loadCredentials({ paths }), null);

  const cliToken = `ghcli_${'a'.repeat(43)}`;
  await saveCredentials(
    {
      cliToken,
      ryuuUserId: 'ryuu-1',
      cliTokenExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
      account: { login: 'octocat', name: 'The Octocat', type: 'User', scope: 'read:user' },
      backend: GITHUB_BACKEND_URL,
    },
    { paths },
  );

  const stored = await loadCredentials({ paths });
  assert.equal(stored.cliToken, cliToken);
  assert.equal(stored.account.login, 'octocat');

  const raw = (await fsp.readFile(paths.credentialFile)).toString('latin1');
  assert.equal(raw.includes(cliToken), false);
  assert.equal(raw.includes('gho_'), false);
  assert.equal(raw.includes('ghr_'), false);

  if (process.platform !== 'win32') {
    assert.equal((await fsp.stat(paths.credentialFile)).mode & 0o777, 0o600);
    assert.equal((await fsp.stat(paths.keyFile)).mode & 0o777, 0o600);
  }
  // Kunci enkripsi berada di luar folder kredensial.
  assert.equal(path.dirname(paths.keyFile) === paths.dir, false);

  const described = describeCredentials(stored);
  assert.equal(described.connected, true);
  assert.equal(described.login, 'octocat');
  assert.equal(JSON.stringify(described).includes(cliToken), false);

  await clearCredentials({ paths });
  assert.equal(await loadCredentials({ paths }), null);
});

test('tool GitHub terdaftar dengan schema valid dan risk level yang benar', async () => {
  const { plugin } = await makePlugin();
  const registry = new ToolRegistry();
  registry.registerPlugin({ name: plugin.name, version: plugin.version, tools: plugin.tools });

  const names = registry.plugins.get('github').toolNames;
  assert.equal(names.length, 36);
  assert.equal(new Set(names).size, names.length);
  for (const expected of [
    'github_get_me',
    'github_list_repositories',
    'github_get_file_contents',
    'github_create_issue',
    'github_create_pull_request',
    'github_merge_pull_request',
    'github_create_release',
    'github_list_workflows',
    'github_rerun_workflow',
  ]) {
    assert.ok(names.includes(expected), `${expected} harus terdaftar`);
  }

  const read = plugin.tools.find((tool) => tool.name === 'github_get_me');
  assert.equal(read.risk, 'read');
  assert.equal(read.requiresApproval, false);
  for (const name of ['github_create_issue', 'github_update_repository', 'github_create_release', 'github_rerun_workflow']) {
    const tool = plugin.tools.find((entry) => entry.name === name);
    assert.equal(tool.risk, 'write');
    assert.equal(tool.requiresApproval, true, `${name} harus melewati approval`);
  }
  for (const name of ['github_delete_file', 'github_merge_pull_request', 'github_delete_repository']) {
    const tool = plugin.tools.find((entry) => entry.name === name);
    assert.equal(tool.risk, 'destructive');
    assert.equal(tool.requiresApproval, true);
  }
  assert.ok(names.includes('github_delete_repository'));
});

test('approval system menolak write pada read-only dan menyetujui pada policy auto', async () => {
  const readOnly = new ApprovalManager({ policy: 'read-only', interactive: false });
  const denied = await readOnly.request({ tool: 'github_create_issue', risk: 'write', args: {} });
  assert.equal(denied.approved, false);

  const auto = new ApprovalManager({ policy: 'auto', interactive: false });
  const allowed = await auto.request({ tool: 'github_create_issue', risk: 'write', args: {} });
  assert.equal(allowed.approved, true);

  const read = await readOnly.request({ tool: 'github_get_me', risk: 'read', args: {} });
  assert.equal(read.approved, true);
});

test('confirmDestructive=false memblokir operasi destruktif sebelum menyentuh jaringan', async () => {
  const { paths, plugin } = await makePlugin();
  await writeGitHubConfig(
    { ...DEFAULT_GITHUB_CONFIG, enabled: true, confirmDestructive: false },
    { paths },
  );
  const remove = plugin.tools.find((tool) => tool.name === 'github_delete_file');
  await assert.rejects(
    () => remove.handler({ owner: 'octocat', repo: 'hello', path: 'a.txt', message: 'hapus', sha: 'abc' }),
    (error) => {
      assert.equal(error.code, 'GITHUB_DESTRUCTIVE_BLOCKED');
      return true;
    },
  );

  const dropRepo = plugin.tools.find((tool) => tool.name === 'github_delete_repository');
  await assert.rejects(
    () => dropRepo.handler({ owner: 'octocat', repo: 'hello', confirm: 'octocat/hello' }),
    (error) => {
      assert.equal(error.code, 'GITHUB_DESTRUCTIVE_BLOCKED');
      return true;
    },
  );
});

test('github_delete_repository menuntut konfirmasi owner/repo yang sama persis', async () => {
  const { plugin } = await makePlugin();
  const tool = plugin.tools.find((entry) => entry.name === 'github_delete_repository');
  assert.equal(tool.schema.required.includes('confirm'), true);

  const cases = [
    { confirm: '' },
    { confirm: 'hello' },
    { confirm: 'octocat/other' },
    { confirm: 'other/hello' },
  ];
  for (const extra of cases) {
    await assert.rejects(
      () => tool.handler({ owner: 'octocat', repo: 'hello', ...extra }),
      (error) => {
        assert.equal(error.code, 'VALIDATION_FAILED');
        assert.match(error.message, /octocat\/hello/);
        return true;
      },
      `confirm "${extra.confirm}" harus ditolak`,
    );
  }
});

test('command /github memakai parser Ryuu dan mencetak status tanpa token', async () => {
  const parsed = parseCommandLine('/github status');
  assert.equal(parsed.name, 'github');
  assert.equal(parsed.args, 'status');

  const { plugin } = await makePlugin();
  const registry = new ToolRegistry();
  registry.registerPlugin({ name: plugin.name, version: plugin.version, tools: plugin.tools });
  const output = [];
  const print = (text) => output.push(String(text));
  const command = createGitHubCommand({ plugin, registry, confirm: async () => true, openBrowser: false });

  await command('', print);
  assert.match(output.join('\n'), /GitHub Integration/);
  assert.match(output.join('\n'), /\/github login/);

  output.length = 0;
  await command('status', print);
  const status = output.join('\n');
  assert.match(status, /STATUS GITHUB/);
  assert.match(status, /Autentikasi\s+: belum login/);
  assert.equal(status.includes('ghcli_'), false);
  assert.equal(status.includes('gho_'), false);

  output.length = 0;
  await command('config', print);
  const configText = output.join('\n');
  assert.match(configText, /KONFIGURASI GITHUB/);
  assert.match(configText, /Iv23liIt8Xh4waFhX0y1/);
  assert.match(configText, /Client Secret.*tidak ada di CLI/);

  output.length = 0;
  await command('tidak-ada', print);
  assert.match(output.join('\n'), /Subcommand tidak dikenal/);
});

test('sesi lokal kedaluwarsa tidak dianggap terhubung tetapi tetap bisa di-logout', async () => {
  const { paths, plugin } = await makePlugin();
  await saveCredentials(
    {
      cliToken: `ghcli_${'e'.repeat(43)}`,
      cliTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      account: { login: 'octocat' },
    },
    { paths },
  );
  plugin.stored = null;

  const status = await plugin.status();
  assert.equal(status.authenticated, false);
  assert.equal(status.sessionExpired, true);
  assert.equal(status.remote, null, 'status tidak boleh memanggil backend dengan sesi kedaluwarsa');

  const output = [];
  const command = createGitHubCommand({
    plugin,
    registry: new ToolRegistry(),
    confirm: async () => true,
    openBrowser: false,
  });
  await command('status', (text) => output.push(String(text)));
  assert.match(output.join('\n'), /kedaluwarsa/);

  output.length = 0;
  await command('logout', (text) => output.push(String(text)));
  assert.equal(await loadCredentials({ paths }), null);
});

test('sync tool menghormati status enabled dan authenticated', async () => {
  const { paths, plugin } = await makePlugin();
  const registry = new ToolRegistry();
  assert.equal(await syncPluginTools(plugin, registry), 0);

  await writeGitHubConfig({ ...DEFAULT_GITHUB_CONFIG, enabled: true }, { paths });
  assert.equal(await syncPluginTools(plugin, registry), 0, 'enabled tanpa login tidak mendaftarkan tool');

  await saveCredentials({ cliToken: `ghcli_${'b'.repeat(43)}`, account: { login: 'octocat' } }, { paths });
  plugin.stored = null;
  const count = await syncPluginTools(plugin, registry);
  assert.equal(count, 36);
  assert.equal(registry.has('github_get_me'), true);

  const removed = unregisterPluginTools(plugin, registry);
  assert.equal(removed, 36);
  assert.equal(registry.has('github_get_me'), false);
});
