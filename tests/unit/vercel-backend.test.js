import assert from 'node:assert/strict';
import test from 'node:test';

import { VercelBackendClient } from '../../plugins/vercel/backend.js';
import { VercelApi } from '../../plugins/vercel/api.js';

function response(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        async text() {
            return body === undefined ? '' : JSON.stringify(body);
        },
    };
}

test('connect posts to the Vercel gateway without a token', async () => {
    let seen = null;
    const client = new VercelBackendClient({
        baseUrl: 'https://api.example.test/',
        fetchImpl: async (url, options) => {
            seen = { url, options };
            return response({ success: true, result: { sessionId: 'vcs_x', pairingSecret: 'p', url: 'https://vercel.com/i/x/new?state=s' } });
        },
    });
    const session = await client.startSession({ label: 'test' });
    assert.equal(seen.url, 'https://api.example.test/integrations/vercel/connect');
    assert.equal(seen.options.method, 'POST');
    assert.equal(seen.options.headers.authorization, undefined);
    assert.equal(JSON.parse(seen.options.body).label, 'test');
    assert.match(session.url, /vercel\.com/);

    const polled = await client.pollSession({ sessionId: 'vcs_x', pairingSecret: 'secret-value' });
    assert.equal(seen.url, 'https://api.example.test/integrations/vercel/session/vcs_x');
    assert.equal(seen.options.headers['x-ryuu-pairing'], 'secret-value');
    assert.equal(polled.status, undefined);
});

test('authenticated calls send the bearer token and surface reconnect', async () => {
    const client = new VercelBackendClient({
        baseUrl: 'https://api.example.test',
        getToken: () => 'vcli_token-value',
        fetchImpl: async (url, options) => {
            assert.equal(options.headers.authorization, 'Bearer vcli_token-value');
            return response({ success: false, result: { message: 'sesi berakhir', reconnect: true, code: 'VERCEL_CLI_UNAUTHORIZED' } }, 401);
        },
    });
    await assert.rejects(() => client.status(), (error) => {
        assert.equal(error.status, 401);
        assert.equal(error.reconnect, true);
        return true;
    });
});

test('missing token fails before any request', async () => {
    let called = false;
    const client = new VercelBackendClient({ fetchImpl: async () => ((called = true), response({})) });
    await assert.rejects(() => client.status(), (error) => error.status === 401 && /login/i.test(error.message));
    assert.equal(called, false);
});

test('the proxy builds encoded queries and forwards bodies', async () => {
    let seen = null;
    const client = new VercelBackendClient({
        baseUrl: 'https://api.example.test',
        getToken: () => 'vcli_x',
        fetchImpl: async (url, options) => {
            seen = { url, options };
            return response({ success: true, result: { id: 'dpl_1' } });
        },
    });
    const api = new VercelApi({ backend: client });
    const result = await api.post('/v13/deployments', { name: 'web' }, { target: 'production', regions: ['iad1', 'sfo1'] });
    assert.equal(seen.url, 'https://api.example.test/integrations/vercel/api/v13/deployments?target=production&regions=iad1&regions=sfo1');
    assert.deepEqual(JSON.parse(seen.options.body), { name: 'web' });
    assert.equal(result.id, 'dpl_1');
});

test('a network failure is reported without leaking anything', async () => {
    const client = new VercelBackendClient({
        getToken: () => 'vcli_x',
        fetchImpl: async () => {
            const error = new Error('connect ECONNREFUSED');
            error.code = 'ECONNREFUSED';
            throw error;
        },
    });
    await assert.rejects(() => client.status(), (error) => {
        assert.equal(error.code, 'VERCEL_BACKEND_UNREACHABLE');
        assert.ok(!error.message.includes('vcli_x'));
        return true;
    });
});
