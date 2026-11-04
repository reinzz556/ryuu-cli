import assert from 'node:assert/strict';
import test from 'node:test';

import { createVercelTools } from '../../plugins/vercel/tools.js';

function fakeApi(handlers = {}) {
    const calls = [];
    const record = (method) => async (path, second, third) => {
        const isRead = method === 'GET';
        calls.push({ method, path, body: isRead ? undefined : second, query: isRead ? second : third });
        const handler = handlers[`${method} ${path}`] || handlers[method];
        return typeof handler === 'function' ? handler(path, second) : (handler ?? {});
    };
    return { api: { get: record('GET'), post: record('POST'), patch: record('PATCH'), put: record('PUT'), delete: record('DELETE') }, calls };
}

const makePlugin = ({ confirmDestructive = true, api = {} } = {}) => ({
    loadConfig: async () => ({ enabled: true, confirmDestructive }),
    requireClient: async () => api,
});

const toolsOf = (options) => createVercelTools(makePlugin(options));
const find = (tools, name) => tools.find((tool) => tool.name === name);

test('every tool is unique, prefixed and carries a valid schema', () => {
    const tools = toolsOf();
    assert.equal(tools.length, 46);
    const names = tools.map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length);
    for (const tool of tools) {
        assert.match(tool.name, /^vercel_[a-z0-9_]+$/);
        assert.equal(tool.schema.type, 'object');
        assert.ok(tool.description.length > 20);
        assert.equal(tool.requiresApproval, tool.risk !== 'read');
    }
    for (const required of ['vercel_get_user', 'vercel_list_projects', 'vercel_create_deployment', 'vercel_list_env', 'vercel_list_dns_records', 'vercel_update_edge_config_items', 'vercel_get_billing']) {
        assert.ok(names.includes(required), `${required} exists`);
    }
});

test('destructive tools require approval and reads do not', () => {
    const tools = toolsOf();
    for (const name of ['vercel_delete_project', 'vercel_delete_deployment', 'vercel_delete_env', 'vercel_remove_domain', 'vercel_delete_dns_record', 'vercel_delete_edge_config']) {
        const tool = find(tools, name);
        assert.equal(tool.risk, 'destructive', name);
        assert.equal(tool.requiresApproval, true, name);
    }
    for (const name of ['vercel_get_user', 'vercel_list_projects', 'vercel_list_deployments', 'vercel_list_domains']) {
        assert.equal(find(tools, name).requiresApproval, false, name);
    }
    for (const name of ['vercel_promote_deployment', 'vercel_rollback_deployment', 'vercel_cancel_deployment']) {
        assert.equal(find(tools, name).requiresApproval, true, name);
    }
});

test('vercel_get_user accepts the real wrapped { user } response', async () => {
    const { api } = fakeApi({
        GET: { user: { id: 'user_live', username: 'octo', email: 'octo@example.test', name: 'Octo', defaultTeamId: 'team_1' } },
    });
    const result = await find(toolsOf({ api }), 'vercel_get_user').handler({});
    assert.equal(result.ok, true);
    assert.equal(result.user.id, 'user_live');
    assert.equal(result.user.username, 'octo');
    assert.equal(result.user.defaultTeamId, 'team_1');
});

test('deployment creation requires a real source', async () => {
    const { api, calls } = fakeApi({ POST: { id: 'dpl_new' } });
    const tool = find(toolsOf({ api }), 'vercel_create_deployment');
    await assert.rejects(() => tool.handler({ name: 'web' }), /gitSource|files/);
    assert.equal(calls.length, 0, 'no request without a source');

    const result = await tool.handler({
        name: 'web',
        target: 'production',
        gitSource: { type: 'github', repo: 'octo/web', ref: 'main' },
    });
    assert.equal(result.ok, true);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].path, '/v13/deployments');
    assert.deepEqual(calls[0].body.gitSource, { type: 'github', repo: 'octo/web', ref: 'main' });
    assert.equal(calls[0].body.name, 'web');
});

test('file uploads are validated and base64 accepted', async () => {
    const { api, calls } = fakeApi({ POST: { id: 'dpl_files' } });
    const tool = find(toolsOf({ api }), 'vercel_create_deployment');
    await assert.rejects(() => tool.handler({ name: 'x', files: [{ file: '../etc/passwd', data: 'aGk=' }] }), /tidak valid/);
    const result = await tool.handler({ name: 'x', files: [{ file: 'index.html', data: 'aGk=' }] });
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0].body.files, [{ file: 'index.html', data: 'aGk=' }]);
});

test('environment variables never return their value', async () => {
    const { api, calls } = fakeApi({
        GET: { envs: [{ id: 'env_1', key: 'API_URL', value: 'https://secret.example', target: ['production'], type: 'encrypted' }] },
        POST: { created: { id: 'env_2', key: 'TOKEN', value: 'super-secret', target: ['production'] } },
    });
    const tools = toolsOf({ api });
    const list = await find(tools, 'vercel_list_env').handler({ project: 'web' });
    assert.equal(list.envs[0].key, 'API_URL');
    assert.equal(JSON.stringify(list).includes('https://secret.example'), false);

    const create = await find(tools, 'vercel_create_env').handler({
        project: 'web',
        key: 'TOKEN',
        value: 'super-secret',
        target: ['production'],
    });
    assert.equal(JSON.stringify(create).includes('super-secret'), false);
    assert.equal(calls[1].body.value, 'super-secret', 'value is sent to Vercel');
    assert.match(create.note, /deployment baru/);
});

test('destructive env changes are blocked when confirmDestructive is off', async () => {
    const { api, calls } = fakeApi({ DELETE: {} });
    const tool = find(toolsOf({ api, confirmDestructive: false }), 'vercel_delete_env');
    await assert.rejects(
        () => tool.handler({ project: 'web', envIdOrKey: 'API_URL' }),
        (error) => error.code === 'VERCEL_DESTRUCTIVE_BLOCKED',
    );
    assert.equal(calls.length, 0);
});

test('project tools forward filters and validation', async () => {
    const { api, calls } = fakeApi({ GET: { projects: [{ id: 'prj_1', name: 'web' }] } });
    const tools = toolsOf({ api });
    const list = await find(tools, 'vercel_list_projects').handler({ limit: 5, search: 'web' });
    assert.equal(list.projects[0].name, 'web');
    assert.deepEqual(calls[0].query, { limit: 5, search: 'web' });

    await assert.rejects(() => find(tools, 'vercel_get_project').handler({ project: '../etc' }), /tidak valid/);
    const targets = await find(tools, 'vercel_get_env_targets').handler({ project: 'ok' });
    assert.deepEqual(targets.supported, ['production', 'preview', 'development']);
});

test('promote and rollback hit the documented project endpoints', async () => {
    const { api, calls } = fakeApi({ POST: {} });
    const tools = toolsOf({ api });
    await find(tools, 'vercel_promote_deployment').handler({ project: 'web', deployment: 'dpl_abc123' });
    await find(tools, 'vercel_rollback_deployment').handler({ project: 'web', deployment: 'dpl_old123' });
    assert.equal(calls[0].path, '/v10/projects/web/promote/dpl_abc123');
    assert.equal(calls[1].path, '/v9/projects/web/rollback/dpl_old123');
});

test('edge config item batches accept upserts and validate deletes', async () => {
    const { api, calls } = fakeApi({ PATCH: {} });
    const tool = find(toolsOf({ api }), 'vercel_update_edge_config_items');
    await tool.handler({ edgeConfigId: `ecfg_${'a'.repeat(10)}`, items: [{ operation: 'upsert', key: 'flag', value: true }] });
    assert.deepEqual(calls[0].body.items, [{ operation: 'upsert', key: 'flag', value: true }]);
    await assert.rejects(
        () => tool.handler({ edgeConfigId: `ecfg_${'a'.repeat(10)}`, items: [{ operation: 'delete' }] }),
        /key/,
    );
});
