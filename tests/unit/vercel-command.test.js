import assert from 'node:assert/strict';
import test from 'node:test';

import { createVercelCommand, formatStatus } from '../../plugins/vercel/command.js';
import { ConfigError } from '../../src/utils/errors.js';

function fakeApi() {
    const calls = [];
    const api = {
        calls,
        async get(path, query) {
            calls.push({ method: 'GET', path, query });
            if (path === '/v9/projects') return { projects: [{ id: 'prj_1', name: 'web', framework: 'nextjs', latestDeployments: [{ readyState: 'READY', url: 'web.vercel.app' }] }] };
            if (path === '/v6/deployments') return { deployments: [{ id: 'dpl_1', readyState: 'READY', target: 'production', url: 'web.vercel.app', createdAt: Date.now() }] };
            if (path.endsWith('/env')) return { envs: [{ key: 'API_URL', type: 'encrypted', target: ['production'], value: 'https://internal.example' }] };
            if (path.endsWith('/events')) return [{ created: Date.now(), level: 'error', text: 'build failed' }, { created: Date.now(), level: 'info', text: 'installing' }];
            return {};
        },
        async post(path, body) {
            calls.push({ method: 'POST', path, body });
            return { id: 'dpl_new', readyState: 'QUEUED' };
        },
        async patch(path, body) {
            calls.push({ method: 'PATCH', path, body });
            return {};
        },
        async delete(path) {
            calls.push({ method: 'DELETE', path });
            return {};
        },
    };
    return api;
}

function fakePlugin(api) {
    return {
        pathsInfo: { configFile: '/tmp/vercel/config.json', credentialFile: '/tmp/vercel/credentials.enc' },
        loadConfig: async () => ({ enabled: true, confirmDestructive: true, defaultProject: 'web' }),
        requireClient: async () => api,
        authInfo: async () => ({ connected: true, username: 'octo', cliTokenExpiresAt: null }),
        isAuthenticated: async () => true,
        isEnabled: async () => true,
        test: async () => ({ ok: true, report: [{ label: 'GET /v2/user', ok: true, detail: 'ok' }] }),
        configureUrl: async () => 'https://api.example.test/integrations/vercel/configure',
        configView: async () => ({ lines: { enabled: 'true', backend: 'https://api.example.test' } }),
        login: async () => ({ connected: true }),
        logout: async () => ({ connected: false }),
    };
}

const registry = { plugins: new Map(), tools: new Map(), registerPlugin() {} };

async function run(args, { plugin = fakePlugin(fakeApi()), confirm = null } = {}) {
    const lines = [];
    const handler = createVercelCommand({ plugin, registry, confirm });
    await handler(args, (line) => lines.push(String(line)));
    return lines.join('\n');
}

test('/vercel help lists the real subcommands', async () => {
    const output = await run('');
    assert.match(output, /Vercel Integration/);
    assert.match(output, /\/vercel login/);
    assert.match(output, /\/vercel env add/);
    assert.match(output, /\/vercel edge list/);
});

test('/vercel projects prints project and latest deployment', async () => {
    const api = fakeApi();
    const output = await run('projects', { plugin: fakePlugin(api) });
    assert.match(output, /PROJECT VERCEL/);
    assert.match(output, /web/);
    assert.match(output, /READY/);
    assert.deepEqual(api.calls[0].query, { limit: 20 });
});

test('/vercel env list never prints the stored value', async () => {
    const output = await run('env list');
    assert.match(output, /API_URL/);
    assert.ok(!output.includes('https://internal.example'), 'secret value is not displayed');
});

test('/vercel logs filters problems and uses the documented events endpoint', async () => {
    const api = fakeApi();
    const output = await run('logs dpl_abc123 --problems', { plugin: fakePlugin(api) });
    assert.match(output, /build failed/);
    assert.doesNotMatch(output, /installing/);
    assert.equal(api.calls[0].path, '/v2/deployments/dpl_abc123/events');
});

test('destructive project deletion respects the confirmation prompt', async () => {
    const api = fakeApi();
    const output = await run('project delete web', { plugin: fakePlugin(api), confirm: async () => false });
    assert.match(output, /Dibatalkan/);
    assert.equal(api.calls.filter((call) => call.method === 'DELETE').length, 0);

    const confirmedApi = fakeApi();
    const confirmed = await run('project delete web --yes', { plugin: fakePlugin(confirmedApi), confirm: async () => false });
    assert.match(confirmed, /Project dihapus: web/);
    assert.equal(confirmedApi.calls[0].path, '/v9/projects/web');
});

test('/vercel deploy requires a real source and reports the deployment', async () => {
    const refused = await run('deploy web');
    assert.match(refused, /sumber/);
    assert.match(refused, /--git|--file/);
    const api = fakeApi();
    const output = await run('deploy web --git octo/web --ref main --target production', { plugin: fakePlugin(api) });
    assert.match(output, /Deployment dimulai/);
    const call = api.calls.find((item) => item.method === 'POST');
    assert.equal(call.path, '/v13/deployments');
    assert.equal(call.body.target, 'production');
    assert.deepEqual(call.body.gitSource, { type: 'github', repo: 'octo/web', ref: 'main' });
});

test('/vercel login and configure print their URL as a copyable block', async () => {
    const blocks = [];
    const plugin = {
        ...fakePlugin(fakeApi()),
        isEnabled: async () => false,
        login: async ({ showCode }) =>
            showCode({ label: 'login url', text: 'https://vercel.com/integrations/ryuu-cli/new?state=abc' }),
        configureUrl: async () => 'https://api.example.test/integrations/vercel/configure?configurationId=icfg_x',
    };
    const handler = createVercelCommand({ plugin, registry, showCode: (block) => blocks.push(block) });
    await handler('login --no-browser', () => {});
    await handler('configure', () => {});

    assert.deepEqual(
        blocks.map((block) => block.label),
        ['login url', 'konfigurasi url'],
        'both URLs use the framed copy block, like /github login',
    );
    assert.match(blocks[0].text, /vercel\.com/);
    assert.match(blocks[1].text, /integrations\/vercel\/configure/);
});

test('/vercel test and configure work without the API client', async () => {
    const tested = await run('test');
    assert.match(tested, /DIAGNOSTIK VERCEL/);
    const configured = await run('configure');
    assert.match(configured, /integrations\/vercel\/configure/);
});

test('an invalid config is shown on the terminal before any subcommand runs', async () => {
    const api = fakeApi();
    const plugin = {
        ...fakePlugin(api),
        configDiagnostic: async () => ({
            ok: false,
            path: '/tmp/vercel/config.json',
            error: new ConfigError(
                'Konfigurasi Vercel tidak valid di /tmp/vercel/config.json: Unexpected token. File tidak diubah.',
                { path: '/tmp/vercel/config.json', reason: 'Unexpected token } in JSON at position 42' },
            ),
        }),
    };
    const output = await run('projects', { plugin });
    assert.match(output, /KONFIGURASI VERCEL TIDAK VALID/);
    assert.match(output, /Unexpected token/);
    assert.match(output, /tidak dijalankan/);
    assert.match(output, /Hapus file tersebut/);
    assert.match(output, /"enabled": false/);
    assert.ok(!output.includes('clientSecret\"'), 'the example snippet holds no secret');
    assert.equal(api.calls.length, 0, 'no API call is made with a broken config');
});

test('a config generated automatically is announced in the terminal', async () => {
    const plugin = {
        ...fakePlugin(fakeApi()),
        configDiagnostic: async () => ({
            ok: true,
            path: '/tmp/vercel/config.json',
            config: { enabled: false, defaultProject: null, backend: 'https://restapi.ryuu-dev.my.id' },
            created: { path: '/tmp/vercel/config.json', at: '2026-11-04T00:00:00.000Z' },
        }),
    };
    const output = await run('config show', { plugin });
    assert.match(output, /DIBUAT OTOMATIS/);
    assert.match(output, /\/tmp\/vercel\/config.json/);
    assert.match(output, /KONFIGURASI VERCEL \(NON-RAHASIA\)/);
});

test('unknown subcommands print usage instead of pretending to work', async () => {
    const output = await run('teleport');
    assert.match(output, /Subcommand tidak dikenal/);
    assert.match(output, /\/vercel login/);
});

test('formatStatus reports disabled and unauthenticated states honestly', async () => {
    const status = await formatStatus(
        {
            status: async () => ({
                enabled: false,
                authenticated: false,
                auth: { connected: false },
                paths: { configFile: '/tmp/c', credentialFile: '/tmp/k' },
                toolCount: 46,
                lastCheck: null,
                settings: { backend: 'https://api.example.test' },
            }),
            name: 'vercel',
        },
        null,
    );
    assert.match(status, /Integrasi\s+: nonaktif/);
    assert.match(status, /belum login/);
    assert.match(status, /\/vercel login/);
});
