import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import test from 'node:test';

import { vercelPaths } from '../../plugins/vercel/config.js';
import {
    clearCredentials,
    describeCredentials,
    loadCredentials,
    saveCredentials,
} from '../../plugins/vercel/credentials.js';
import { tempDir } from './helpers.js';

const CLI_TOKEN = `vcli_${'a'.repeat(43)}`;

async function setup(env = {}) {
    const dir = await tempDir();
    const paths = vercelPaths({ env: { RYUU_CONFIG_DIR: dir, ...env } });
    return { dir, paths };
}

test('credentials round-trip encrypted and never store the raw CLI token', async () => {
    const { dir, paths } = await setup();
    await saveCredentials(
        {
            cliToken: CLI_TOKEN,
            ryuuUserId: 'ryuu-1',
            cliTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            backend: 'https://api.example.test',
            account: { vercelUserId: 'user_1', username: 'octo', email: 'octo@example.test' },
            configuration: { id: 'icfg_abc123456', teamId: 'team_abc123456' },
        },
        { paths },
    );

    const raw = await fsp.readFile(paths.credentialFile);
    assert.ok(!raw.toString('utf8').includes(CLI_TOKEN), 'token is encrypted at rest');
    if (process.platform !== 'win32') {
        assert.equal((await fsp.stat(paths.credentialFile)).mode & 0o777, 0o600);
        assert.equal((await fsp.stat(paths.keyFile)).mode & 0o777, 0o600);
    }

    const loaded = await loadCredentials({ paths });
    assert.equal(loaded.cliToken, CLI_TOKEN);
    assert.equal(loaded.account.username, 'octo');
    assert.equal(loaded.configuration.id, 'icfg_abc123456');

    const described = describeCredentials(loaded);
    assert.equal(described.connected, true);
    assert.equal(Object.prototype.hasOwnProperty.call(described, 'cliToken'), false, 'never printed');
});

test('an env key overrides the key file and a wrong key fails closed', async () => {
    const key = crypto.randomBytes(32).toString('hex');
    const { paths } = await setup({ RYUU_VERCEL_KEY: key });
    await saveCredentials({ cliToken: CLI_TOKEN }, { paths });
    assert.equal((await loadCredentials({ paths })).cliToken, CLI_TOKEN);

    const wrong = crypto.randomBytes(32).toString('hex');
    await assert.rejects(
        () => loadCredentials({ paths, env: { RYUU_VERCEL_KEY: wrong } }),
        /tidak dapat didekripsi/i,
    );
});

test('a corrupt credential file is rejected with an actionable error', async () => {
    const { paths } = await setup();
    await fsp.mkdir(paths.dir, { recursive: true });
    await fsp.writeFile(paths.credentialFile, 'garbage');
    await assert.rejects(() => loadCredentials({ paths }), /rusak|tidak dikenali/i);
});

test('clearCredentials removes the local token and key', async () => {
    const { paths } = await setup();
    await saveCredentials({ cliToken: CLI_TOKEN }, { paths });
    await clearCredentials({ paths });
    assert.equal(await loadCredentials({ paths }), null);
    await assert.rejects(() => fsp.access(paths.keyFile));
});

test('saving rejects a token that is not a CLI token', async () => {
    const { paths } = await setup();
    await assert.rejects(() => saveCredentials({ cliToken: 'eyJhbGciOi...' }, { paths }), /tidak valid/);
});
