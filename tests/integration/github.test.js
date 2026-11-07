import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

import { createGitHubPlugin } from '../../src/tools/advance/github/manager.js';
import { createGitHubCommand } from '../../src/tools/advance/github/command.js';
import { loadCredentials } from '../../src/tools/advance/github/credentials.js';
import { syncPluginTools, unregisterPluginTools } from '../../src/tools/advance/index.js';
import { ToolRegistry } from '../../src/tools/registry.js';

const CLI_TOKEN = `ghcli_${'c'.repeat(43)}`;
const PAIRING = 'p'.repeat(43);

async function startMockBackend() {
  const state = {
    polls: 0,
    disconnectCalls: 0,
    proxyCalls: [],
    lastAuth: null,
  };

  const readBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  };

  const send = (res, status, result, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify({ success: status < 400, result }));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = req.method === 'POST' ? await readBody(req) : {};
    const auth = req.headers.authorization || null;
    if (auth) state.lastAuth = auth;

    if (req.method === 'POST' && url.pathname === '/integrations/github/connect') {
      return send(res, 200, {
        sessionId: `ghs_${'s'.repeat(32)}`,
        pairingSecret: PAIRING,
        state: 'state-abcdefghijklmnop',
        url: 'http://127.0.0.1/authorize?state=state-abcdefghijklmnop',
        redirectUri: 'http://127.0.0.1/integrations/github/callback',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/integrations/github/session/')) {
      if (req.headers['x-ryuu-pairing'] !== PAIRING) {
        return send(res, 404, { message: 'pairing salah', code: 'GITHUB_SESSION_NOT_FOUND' });
      }
      state.polls += 1;
      if (state.polls < 2) return send(res, 200, { status: 'pending' });
      return send(res, 200, {
        status: 'authorized',
        cliToken: CLI_TOKEN,
        cliTokenExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
        ryuuUserId: 'ryuu-test',
        account: {
          connected: true,
          login: 'octocat',
          name: 'The Octocat',
          type: 'User',
          htmlUrl: 'https://github.com/octocat',
          scope: 'read:user user:email',
          installations: [{ id: 77, account: 'octocat', accountType: 'User' }],
        },
        enabled: true,
      });
    }

    if (req.method === 'GET' && url.pathname === '/integrations/github/status') {
      return send(res, 200, {
        connected: true,
        enabled: true,
        github: { id: '1001', login: 'octocat', name: 'The Octocat', type: 'User' },
        token: {
          accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
          hasRefreshToken: true,
          expired: false,
          needsReconnect: false,
        },
        installations: [{ id: 77, account: 'octocat' }],
        backend: { ok: true, apiVersion: '2022-11-28' },
        config: { ok: true, missing: [] },
      });
    }

    if (req.method === 'GET' && url.pathname === '/integrations/github/account') {
      return send(res, 200, {
        connected: true,
        login: 'octocat',
        name: 'The Octocat',
        type: 'User',
        htmlUrl: 'https://github.com/octocat',
        avatarUrl: 'https://avatars.githubusercontent.com/u/1001',
        scope: 'read:user',
        installations: [],
      });
    }

    if (req.method === 'POST' && url.pathname === '/integrations/github/test') {
      return send(res, 200, {
        ok: true,
        report: [
          { label: 'GET /user', ok: true, detail: 'login sebagai octocat' },
          { label: 'Rate limit', ok: true, detail: '4990/5000' },
        ],
      });
    }

    if (req.method === 'POST' && url.pathname === '/integrations/github/refresh') {
      return send(res, 200, {
        refreshed: true,
        token: { accessExpiresAt: new Date(Date.now() + 7200_000).toISOString(), hasRefreshToken: true },
        account: { login: 'octocat' },
      });
    }

    if (req.method === 'POST' && url.pathname === '/integrations/github/disconnect') {
      state.disconnectCalls += 1;
      return send(res, 200, { disconnected: true, revoked: true });
    }

    if (req.method === 'POST' && url.pathname === '/integrations/github/enable') {
      return send(res, 200, { enabled: true, account: { login: 'octocat' } });
    }

    if (req.method === 'POST' && url.pathname === '/integrations/github/disable') {
      return send(res, 200, { enabled: false, account: { login: 'octocat' } });
    }

    if (url.pathname === '/integrations/github/api/user' && req.method === 'GET') {
      state.proxyCalls.push({ path: url.pathname, method: req.method });
      return send(res, 200, {
        id: 1001,
        login: 'octocat',
        name: 'The Octocat',
        type: 'User',
        public_repos: 8,
        html_url: 'https://github.com/octocat',
      });
    }

    if (url.pathname === '/integrations/github/api/user/repos' && req.method === 'GET') {
      const page = Number(url.searchParams.get('page') || '1');
      state.proxyCalls.push({ path: url.pathname, method: req.method, page });
      if (page === 1) {
        return send(
          res,
          200,
          [{ id: 1, name: 'hello', full_name: 'octocat/hello', owner: { login: 'octocat' }, private: false }],
          { 'x-github-link': '<http://127.0.0.1/integrations/github/api/user/repos?page=2>; rel="next"' },
        );
      }
      return send(res, 200, [
        { id: 2, name: 'world', full_name: 'octocat/world', owner: { login: 'octocat' }, private: true },
      ]);
    }

    return send(res, 404, { message: `mock backend: ${req.method} ${url.pathname} tidak dikenal` });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, state };
}

async function makePlugin(base) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ryuu-gh-int-'));
  const paths = {
    dir,
    configFile: path.join(dir, 'config.json'),
    credentialFile: path.join(dir, 'credentials.enc'),
    stateFile: path.join(dir, 'state.json'),
    keyFile: path.join(dir, '.keys', 'github.key'),
  };
  const plugin = createGitHubPlugin({
    paths,
    backendUrl: base,
    pollIntervalMs: 5,
    sessionTimeoutMs: 5000,
  });
  return { dir, paths, plugin };
}

test('login → tool terdaftar → tool berjalan → disable/enable → logout memakai backend lokal', async (t) => {
  const { server, base, state } = await startMockBackend();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { dir, paths, plugin } = await makePlugin(base);
  const registry = new ToolRegistry();
  const output = [];
  const print = (text) => output.push(String(text));
  const command = createGitHubCommand({ plugin, registry, confirm: async () => true, openBrowser: false });

  await command('login', print);
  const loginOutput = output.join('\n');
  assert.match(loginOutput, /Autentikasi berhasil/);
  assert.match(loginOutput, /octocat/);
  assert.equal(loginOutput.includes(CLI_TOKEN), false, 'token CLI tidak boleh dicetak');
  assert.equal(state.polls >= 2, true);

  const stored = await loadCredentials({ paths });
  assert.equal(stored.cliToken, CLI_TOKEN);
  const raw = (await fsp.readFile(paths.credentialFile)).toString('latin1');
  assert.equal(raw.includes(CLI_TOKEN), false);
  assert.equal(raw.includes('gho_'), false);
  assert.equal(raw.includes('ghr_'), false);

  // Login otomatis mengaktifkan dan command mendaftarkan tool.
  assert.equal(await plugin.isEnabled(), true);
  assert.equal(registry.plugins.get('github')?.toolNames.length, 36);

  const me = await registry.execute('github_get_me', {}, {});
  assert.equal(me.result.ok, true);
  assert.equal(me.result.account.login, 'octocat');
  assert.equal(state.proxyCalls.some((call) => call.path.endsWith('/api/user')), true);

  const repos = await registry.execute('github_list_repositories', { per_page: 1 }, {});
  assert.equal(repos.result.count, 2);
  assert.deepEqual(repos.result.repositories.map((repo) => repo.name), ['hello', 'world']);
  assert.equal(state.proxyCalls.filter((call) => call.path.endsWith('/api/user/repos')).length, 2);

  output.length = 0;
  await command('status', print);
  assert.match(output.join('\n'), /STATUS GITHUB/);
  assert.match(output.join('\n'), /terhubung/);

  output.length = 0;
  await command('account', print);
  assert.match(output.join('\n'), /@octocat/);

  output.length = 0;
  await command('disable', print);
  assert.equal(registry.has('github_get_me'), false);
  await assert.rejects(
    () => plugin.requireClient(),
    (error) => error.code === 'GITHUB_DISABLED',
  );

  output.length = 0;
  await command('enable', print);
  assert.equal(registry.has('github_get_me'), true);

  output.length = 0;
  await command('logout', print);
  assert.equal(state.disconnectCalls, 1);
  assert.equal(await loadCredentials({ paths }), null);
  assert.equal(await plugin.isAuthenticated(), false);
  assert.equal(unregisterPluginTools(plugin, registry), 0);
  assert.equal(registry.has('github_get_me'), false);
  assert.match(output.join('\n'), /diputus/);

  // Tidak ada token GitHub mentah yang tertinggal di folder data CLI.
  const files = await fsp.readdir(dir, { recursive: true }).catch(() => []);
  for (const file of files) {
    const full = path.join(dir, String(file));
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat?.isFile()) continue;
    const content = (await fsp.readFile(full)).toString('latin1');
    assert.equal(content.includes('gho_'), false, `${file} tidak boleh memuat access token GitHub`);
    assert.equal(content.includes('ghr_'), false, `${file} tidak boleh memuat refresh token GitHub`);
  }
});
