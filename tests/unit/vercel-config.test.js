import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
    configurationPageUrl,
    describeVercelConfig,
    ensureVercelConfig,
    exampleVercelConfig,
    readVercelConfig,
    updateVercelConfig,
    validateConfigEntry,
    vercelPaths,
    writeVercelConfig,
} from '../../plugins/vercel/config.js';
import { tempDir } from './helpers.js';

test('config paths follow the OS and RYUU_CONFIG_DIR', async () => {
    const linux = vercelPaths({ env: {}, home: '/home/dev', platform: 'linux' });
    assert.match(linux.configFile, /\.config\/ryuu\/integrations\/vercel\/config\.json$/);
    assert.match(linux.keyFile, /\.config\/ryuu\/\.keys\/vercel\.key$/);

    const mac = vercelPaths({ env: {}, home: '/Users/dev', platform: 'darwin' });
    assert.match(mac.configFile, /Application Support\/ryuu\/integrations\/vercel\/config\.json$/);

    const win = vercelPaths({ env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' }, platform: 'win32' });
    assert.match(win.configFile, /vercel[\\/]config\.json$/);

    const dir = await tempDir();
    const overridden = vercelPaths({ env: { RYUU_CONFIG_DIR: dir } });
    assert.equal(overridden.configFile, path.join(dir, 'integrations', 'vercel', 'config.json'));
});

test('secrets and backend routes cannot be written from the CLI', () => {
    for (const key of ['clientSecret', 'webhookSecret', 'cliToken', 'backend', 'accessToken', '__proto__']) {
        assert.throws(() => validateConfigEntry(key, 'x'), /tidak dapat diubah|tidak dikenal/i, key);
    }
    assert.throws(() => validateConfigEntry('defaultTeam', 'not-a-team'), /team_/);
    assert.equal(validateConfigEntry('defaultTeam', 'team_abc123456'), 'team_abc123456');
    assert.equal(validateConfigEntry('defaultTeam', 'none'), null);
    assert.equal(validateConfigEntry('enabled', 'true'), true);
    assert.equal(validateConfigEntry('confirmDestructive', 'false'), false);
    assert.equal(validateConfigEntry('defaultProject', 'my-web'), 'my-web');
});

test('config round-trips atomically with owner-only permissions', async () => {
    const dir = await tempDir();
    const paths = vercelPaths({ env: { RYUU_CONFIG_DIR: dir } });
    const initial = await readVercelConfig({ paths });
    assert.equal(initial.enabled, false);
    assert.equal(initial.clientId, 'oac_QIA7cjvSFkhNHbGKCxl2vkR9');
    assert.equal(initial.backend, 'https://restapi.ryuu-dev.my.id');

    await writeVercelConfig({ ...initial, enabled: true, defaultProject: 'web' }, { paths });
    const raw = await fsp.readFile(paths.configFile, 'utf8');
    assert.ok(!raw.includes('clientSecret'), 'CLI config never stores a secret');
    const loaded = await readVercelConfig({ paths });
    assert.equal(loaded.enabled, true);
    assert.equal(loaded.defaultProject, 'web');
    if (process.platform !== 'win32') {
        assert.equal((await fsp.stat(paths.configFile)).mode & 0o777, 0o600);
    }

    await updateVercelConfig('defaultTeam', 'team_abc123456', { paths });
    assert.equal((await readVercelConfig({ paths })).defaultTeam, 'team_abc123456');
    assert.equal((await readVercelConfig({ paths })).enabled, true, 'other keys survive an update');
});

test('a corrupt config is reported and left untouched', async () => {
    const dir = await tempDir();
    const paths = vercelPaths({ env: { RYUU_CONFIG_DIR: dir } });
    await fsp.mkdir(paths.dir, { recursive: true });
    await fsp.writeFile(paths.configFile, '{not json');
    await assert.rejects(() => readVercelConfig({ paths }), /tidak valid/);
    assert.equal(await fsp.readFile(paths.configFile, 'utf8'), '{not json');
});

test('a missing config file is generated automatically with defaults', async () => {
    const dir = await tempDir();
    const paths = vercelPaths({ env: { RYUU_CONFIG_DIR: dir } });
    const before = await fsp.stat(paths.configFile).then(() => true, () => false);
    assert.equal(before, false, 'no config file exists yet');

    const { config, created } = await ensureVercelConfig({ paths });
    assert.equal(created, true);
    assert.equal(config.enabled, false);
    assert.equal(config.clientId, 'oac_QIA7cjvSFkhNHbGKCxl2vkR9');
    assert.equal(config.backend, 'https://restapi.ryuu-dev.my.id');

    const raw = await fsp.readFile(paths.configFile, 'utf8');
    const written = JSON.parse(raw);
    assert.deepEqual(Object.keys(written).sort(), Object.keys(exampleVercelConfig()).sort());
    assert.ok(!raw.includes('clientSecret'), 'the generated file never holds a secret');
    if (process.platform !== 'win32') {
        assert.equal((await fsp.stat(paths.configFile)).mode & 0o777, 0o600);
    }

    const again = await ensureVercelConfig({ paths });
    assert.equal(again.created, false, 'an existing file is not rewritten');
});

test('auto-generation never overwrites an invalid config', async () => {
    const dir = await tempDir();
    const paths = vercelPaths({ env: { RYUU_CONFIG_DIR: dir } });
    await fsp.mkdir(paths.dir, { recursive: true });
    await fsp.writeFile(paths.configFile, '{oops');
    await assert.rejects(() => ensureVercelConfig({ paths }), (error) => {
        assert.match(error.message, /tidak valid/);
        assert.match(error.message, /hapus file/i);
        assert.equal(error.details.path, paths.configFile);
        return true;
    });
    assert.equal(await fsp.readFile(paths.configFile, 'utf8'), '{oops');

    await fsp.writeFile(paths.configFile, '[]');
    await assert.rejects(() => ensureVercelConfig({ paths }), /objek JSON/);
});

test('the configuration page URL is built from the backend URL', () => {
    const url = configurationPageUrl({ backend: 'https://api.example.test/' }, { configurationId: 'icfg_abc123456' });
    assert.equal(url, 'https://api.example.test/integrations/vercel/configure?configurationId=icfg_abc123456');
    assert.equal(configurationPageUrl({ backend: 'https://api.example.test' }), 'https://api.example.test/integrations/vercel/configure');
});

test('describeVercelConfig never exposes a token', () => {
    const described = describeVercelConfig({
        enabled: true,
        autoRefresh: true,
        confirmDestructive: true,
        defaultTeam: null,
        defaultProject: null,
        clientId: 'oac_x',
        backend: 'https://api.example.test',
    });
    assert.equal(described.clientSecret, 'tidak ada di CLI (disimpan di backend)');
    assert.equal(described.accessToken, 'tidak ada di CLI (disimpan di backend, terenkripsi)');
    assert.ok(!JSON.stringify(described).includes('vcli_'));
});
