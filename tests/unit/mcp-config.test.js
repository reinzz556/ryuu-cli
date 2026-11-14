import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  appendServerLog,
  credentialsFile,
  listServers,
  logFile,
  mcpRoot,
  readSecrets,
  readStore,
  removeServer,
  serversFile,
  setServerEnabled,
  splitServerInput,
  upsertServer,
} from '../../src/mcp/config.js';
import { mcpTempDir } from './mcp-helpers.js';

test('server input validation rejects unusable names, transports and URLs', () => {
  assert.throws(() => splitServerInput({ name: 'bad name', transport: 'stdio', command: 'x' }), /Invalid MCP server name/);
  assert.throws(() => splitServerInput({ name: 'ok', transport: 'ftp', command: 'x' }), /Transport must be/);
  assert.throws(() => splitServerInput({ name: 'ok', transport: 'stdio' }), /needs a command/);
  assert.throws(
    () => splitServerInput({ name: 'ok', transport: 'http', url: 'https://user:pass@example.com/mcp' }),
    /must not embed credentials/,
  );
  assert.throws(() => splitServerInput({ name: 'ok', transport: 'http', url: 'file:///etc/passwd' }), /http:\/\/ or https/);
  assert.throws(
    () => splitServerInput({ name: 'ok', transport: 'stdio', command: 'node', env: { 'BAD-KEY': '1' } }),
    /not valid/,
  );
  assert.throws(
    () => splitServerInput({ name: 'ok', transport: 'http', url: 'https://example.com/mcp', headers: { 'X-A': 'a\nb' } }),
    /line break/,
  );
  assert.throws(() => splitServerInput({ name: 'ok', transport: 'stdio', command: 'node', token: 1, auth: { type: 'basic' } }), /auth.type/);
});

test('secrets are stored separately, owner-only, and never in servers.json', async () => {
  const dir = await mcpTempDir();
  try {
    await upsertServer(
      {
        name: 'github',
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { 'X-API-Key': 'header-secret-value' },
        auth: { type: 'bearer' },
        token: 'bearer-secret-value',
      },
      { dir },
    );
    await upsertServer(
      {
        name: 'local',
        transport: 'stdio',
        command: process.execPath,
        args: ['server.js'],
        env: { MCP_SECRET: 'env-secret-value' },
      },
      { dir },
    );

    const serversText = await fsp.readFile(serversFile(dir), 'utf8');
    assert.equal(serversText.includes('bearer-secret-value'), false);
    assert.equal(serversText.includes('header-secret-value'), false);
    assert.equal(serversText.includes('env-secret-value'), false);
    // Key names are kept so /mcp info can explain the configuration.
    assert.match(serversText, /X-API-Key/);
    assert.match(serversText, /MCP_SECRET/);

    const serversMode = (await fsp.stat(serversFile(dir))).mode & 0o777;
    assert.equal(serversMode, 0o600);
    const credentialsMode = (await fsp.stat(credentialsFile('github', dir))).mode & 0o777;
    assert.equal(credentialsMode, 0o600);
    const dirMode = (await fsp.stat(mcpRoot(dir))).mode & 0o777;
    assert.equal(dirMode, 0o700);

    const githubSecrets = await readSecrets('github', { dir });
    assert.equal(githubSecrets.token, 'bearer-secret-value');
    assert.equal(githubSecrets.headers['X-API-Key'], 'header-secret-value');
    const localSecrets = await readSecrets('local', { dir });
    assert.equal(localSecrets.env.MCP_SECRET, 'env-secret-value');

    const listed = await listServers({ dir });
    assert.deepEqual(
      listed.map((server) => server.name),
      ['github', 'local'],
    );
    const github = listed.find((server) => server.name === 'github');
    assert.deepEqual(github.headerNames, ['X-API-Key']);
    assert.equal(github.auth.type, 'bearer');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('enable/disable persists and keeps the credentials', async () => {
  const dir = await mcpTempDir();
  try {
    await upsertServer({ name: 'local', transport: 'stdio', command: 'node', token: 'keep-me' }, { dir });
    await setServerEnabled('local', false, { dir });
    const [server] = await listServers({ dir });
    assert.equal(server.enabled, false);
    assert.equal((await readSecrets('local', { dir })).token, 'keep-me');
    await setServerEnabled('local', true, { dir });
    assert.equal((await listServers({ dir }))[0].enabled, true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('removing a server deletes its credentials and log', async () => {
  const dir = await mcpTempDir();
  try {
    await upsertServer({ name: 'local', transport: 'stdio', command: 'node', env: { A: 'b' } }, { dir });
    await appendServerLog('local', 'INFO hello', { dir });
    assert.ok(await fsp.stat(credentialsFile('local', dir)));
    assert.ok(await fsp.stat(logFile('local', dir)));
    await removeServer('local', { dir });
    await assert.rejects(fsp.stat(credentialsFile('local', dir)), { code: 'ENOENT' });
    await assert.rejects(fsp.stat(logFile('local', dir)), { code: 'ENOENT' });
    assert.deepEqual(await listServers({ dir }), []);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a malformed servers.json is reported, never overwritten', async () => {
  const dir = await mcpTempDir();
  try {
    await fsp.mkdir(mcpRoot(dir), { recursive: true, mode: 0o700 });
    await fsp.writeFile(serversFile(dir), '{ this is not json', { mode: 0o600 });
    await assert.rejects(readStore({ dir }), /not valid JSON/);
    assert.equal(await fsp.readFile(serversFile(dir), 'utf8'), '{ this is not json');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a symlinked servers.json is refused on write', async () => {
  const dir = await mcpTempDir();
  try {
    await fsp.mkdir(mcpRoot(dir), { recursive: true, mode: 0o700 });
    const target = path.join(dir, 'elsewhere.json');
    await fsp.writeFile(target, '{"version":1,"servers":{}}\n');
    await fsp.symlink(target, serversFile(dir));
    await assert.rejects(upsertServer({ name: 'local', transport: 'stdio', command: 'node' }, { dir }), /symlink/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('per-tool risk overrides are validated and kept', async () => {
  const dir = await mcpTempDir();
  try {
    const record = await upsertServer(
      {
        name: 'local',
        transport: 'stdio',
        command: 'node',
        toolRisk: { search: 'read', delete_thing: 'destructive', bogus: 'nonsense' },
      },
      { dir },
    );
    assert.deepEqual(record.toolRisk, { search: 'read', delete_thing: 'destructive' });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
