import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_GOOGLE_DRIVE_CONFIG,
  drivePaths,
  readDriveConfig,
  updateDriveConfig,
  validateConfigEntry,
  writeDriveConfig,
} from '../../src/tools/advance/google-drive/config.js';
import { clearCredentials, loadCredentials, saveCredentials, describeCredentials } from '../../src/tools/advance/google-drive/credentials.js';

import { ZipWriter } from '../../src/tools/advance/google-drive/zip-writer.js';
import { extractZip, listZipEntries, assertSafeEntryName, resolveInside } from '../../src/tools/advance/google-drive/zip-reader.js';
import { collectFiles, isExcluded, compilePatterns, HARD_EXCLUDES } from '../../src/tools/advance/google-drive/backup.js';
import { createGoogleDrivePlugin } from '../../src/tools/advance/google-drive/manager.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { syncPluginTools, unregisterPluginTools } from '../../src/tools/advance/index.js';

async function tempHome() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ryuu-drive-test-'));
  return dir;
}

function fixturePaths(home) {
  return drivePaths({ env: { RYUU_CONFIG_DIR: path.join(home, 'config') }, home, platform: 'linux' });
}

test('plugin config: defaults carry no Google credentials, editable keys validated', async () => {
  const home = await tempHome();
  const paths = fixturePaths(home);
  const config = await readDriveConfig({ paths });
  // The CLI must never hold the Google client id/secret.
  assert.equal(config.clientId, undefined);
  assert.equal(config.clientSecret, undefined);
  assert.equal(JSON.stringify(config).includes('GOCSPX'), false);
  assert.equal(JSON.stringify(config).includes('apps.googleusercontent.com'), false);
  assert.equal(config.enabled, false);
  assert.equal(config.oauthBackend, 'https://restapi.ryuu-dev.my.id');
  assert.equal(config.oauthCliPath, '/admin/tools/drive-cli');
  assert.ok(config.excludePatterns.includes('node_modules'));

  // Credentials and the backend endpoint can never be changed from a command.
  for (const key of ['clientId', 'clientSecret', 'scopes', 'oauthBackend', 'oauthCliPath', 'rootKey', 'driveKey', 'secret']) {
    assert.throws(() => validateConfigEntry(key, 'x'), /tidak dapat diubah/);
  }
  assert.throws(() => validateConfigEntry('nope', '1'), /tidak dikenal/);
  assert.equal(validateConfigEntry('enabled', 'true'), true);
  assert.equal(validateConfigEntry('maxUploadSize', '2048'), 2048);
  assert.throws(() => validateConfigEntry('maxUploadSize', '1'), />= 1024|antara 1024/);

  await updateDriveConfig('enabled', true, { paths });
  const again = await readDriveConfig({ paths });
  assert.equal(again.enabled, true);
  // A hand-written config file cannot introduce credentials either.
  await writeDriveConfig({ ...again, clientId: 'evil', oauthBackend: 'https://evil.example' }, { paths });
  const cleaned = await readDriveConfig({ paths });
  assert.equal(cleaned.clientId, undefined);
  assert.equal(cleaned.oauthBackend, 'https://restapi.ryuu-dev.my.id');
});

test('credentials: encrypted at rest, decryptable, and removable', async () => {
  const home = await tempHome();
  const paths = fixturePaths(home);
  assert.equal(await loadCredentials({ paths }), null);

  await saveCredentials(
    {
      tokens: { access_token: 'at-123', refresh_token: 'rt-456', expiry_date: Date.now() + 1000, scope: 'drive.file' },
      account: { email: 'user@example.com' },
    },
    { paths, env: {} },
  );
  const raw = await fsp.readFile(paths.credentialFile);
  assert.ok(!raw.includes(Buffer.from('rt-456')), 'refresh token must not appear in plaintext');
  const stored = await loadCredentials({ paths, env: {} });
  assert.equal(stored.refreshToken, 'rt-456');
  const described = describeCredentials(stored);
  assert.equal(described.connected, true);
  assert.ok(!JSON.stringify(described).includes('rt-456'), 'describeCredentials must never leak tokens');

  // The key lives outside the credential directory.
  assert.ok(!path.dirname(paths.keyFile).startsWith(paths.dir));
  await clearCredentials({ paths, env: {} });
  assert.equal(await loadCredentials({ paths, env: {} }), null);
});

test('oauth: authorization URL is built by the backend, never by the CLI', async () => {
  const backend = await import('../../src/tools/advance/google-drive/oauth-backend.js');
  // The endpoint is hardcoded: no config, command or env can change it.
  assert.equal(backend.DRIVE_OAUTH_BACKEND, 'https://restapi.ryuu-dev.my.id');
  assert.equal(backend.backendEndpoint(), 'https://restapi.ryuu-dev.my.id/admin/tools/drive-cli');
  // The drive login key is built in, so no caller supplies a credential...
  assert.equal(typeof backend.startLogin, 'function');
  assert.equal(typeof backend.waitForTokens, 'function');
  assert.equal(typeof backend.refreshAccessToken, 'function');
  assert.equal(typeof backend.revokeRemoteToken, 'function');
  // ...and nothing needs a refresh token from the caller any more.
  await assert.rejects(() => backend.refreshAccessToken({}), /Izin Drive/);
  assert.deepEqual(await backend.revokeRemoteToken({}), {
    revoked: false,
    reason: 'tidak ada izin tersimpan',
  });
});

test('oauth: the embedded drive key is a derived header, never a stored secret', async () => {
  const { driveLoginToken, driveLoginHeaders, DRIVE_LOGIN_HEADER } = await import(
    '../../src/tools/advance/google-drive/secret.js'
  );
  const token = driveLoginToken();
  // base64url of an HMAC digest: fixed length, URL-safe, stable across calls.
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(token, driveLoginToken());
  assert.deepEqual(driveLoginHeaders(), { [DRIVE_LOGIN_HEADER]: token });
  // The obfuscated material must not appear verbatim in the derived token.
  assert.equal(token.includes('3e2334bf'), false);
  // The admin root key is a different, unrelated value: it is not the token.
  assert.notEqual(token, 'ryuu-admin-root-key-placeholder');
});

test('oauth: token client refreshes through the backend and hides the token', async () => {
  const { BackendTokenAuth } = await import('../../src/tools/advance/google-drive/token-client.js');
  let calls = 0;
  const auth = new BackendTokenAuth({
    accessToken: 'old-token',
    expiresAt: Date.now() - 1000,
    onRefresh: async () => {
      calls += 1;
      return { accessToken: 'new-token', expiryDate: Date.now() + 3600_000 };
    },
  });
  assert.deepEqual(await auth.getRequestHeaders(), { Authorization: 'Bearer new-token' });
  assert.equal(calls, 1);
  // A fresh token is reused without another backend round trip.
  await auth.getRequestHeaders();
  assert.equal(calls, 1);
  assert.equal((await auth.getAccessToken()).token, 'new-token');
  await assert.rejects(() => new BackendTokenAuth({}).getRequestHeaders(), /tidak tersedia/);
});

test('zip: streaming roundtrip preserves content and rejects Zip Slip', async () => {
  const dir = await tempHome();
  const src = path.join(dir, 'src');
  await fsp.mkdir(path.join(src, 'nested'), { recursive: true });
  await fsp.writeFile(path.join(src, 'a.txt'), 'hello ryuu\n'.repeat(200));
  await fsp.writeFile(path.join(src, 'nested', 'b.bin'), Buffer.from([0, 1, 2, 3, 255]));
  const zipPath = path.join(dir, 'out.zip');

  const writer = new ZipWriter({ file: zipPath, compressionLevel: 6 });
  await writer.open();
  await writer.addFile('a.txt', path.join(src, 'a.txt'));
  await writer.addFile('nested/b.bin', path.join(src, 'nested', 'b.bin'));
  const summary = await writer.close();
  assert.equal(summary.fileCount, 2);

  const entries = await listZipEntries(zipPath);
  assert.deepEqual(entries.map((entry) => entry.name), ['a.txt', 'nested/b.bin']);

  const dest = path.join(dir, 'restored');
  const result = await extractZip({ zipPath, destination: dest });
  assert.equal(result.fileCount, 2);
  assert.equal(await fsp.readFile(path.join(dest, 'a.txt'), 'utf8'), 'hello ryuu\n'.repeat(200));
  assert.deepEqual([...await fsp.readFile(path.join(dest, 'nested', 'b.bin'))], [0, 1, 2, 3, 255]);

  // Overwriting is refused unless explicitly allowed.
  await assert.rejects(() => extractZip({ zipPath, destination: dest }), /sudah ada/);
  await extractZip({ zipPath, destination: dest, overwrite: true });

  assert.throws(() => assertSafeEntryName('../../etc/passwd'), /path traversal/);
  assert.throws(() => assertSafeEntryName('/etc/passwd'), /path absolut/);
  assert.throws(() => resolveInside(dest, '../escape.txt'), /path traversal/);
});

test('backup: exclusion patterns and hard-excluded secrets', async () => {
  const matchers = compilePatterns(['node_modules', '*.log', 'cache']);
  assert.equal(isExcluded('node_modules/pkg/index.js', matchers), true);
  assert.equal(isExcluded('debug.log', matchers), true);
  assert.equal(isExcluded('src/app.js', matchers), false);
  assert.ok(HARD_EXCLUDES.includes('.env'));

  const dir = await tempHome();
  await fsp.mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'node_modules', 'x', 'i.js'), 'no');
  await fsp.writeFile(path.join(dir, '.env'), 'SECRET=1');
  await fsp.writeFile(path.join(dir, 'app.js'), 'yes');
  const collected = await collectFiles({ root: dir, excludePatterns: ['node_modules'] });
  const names = collected.files.map((file) => file.relPath).sort();
  assert.deepEqual(names, ['app.js']);
});

test('lifecycle: disabled or unauthenticated never yields registered tools', async () => {
  const home = await tempHome();
  const paths = fixturePaths(home);
  const plugin = createGoogleDrivePlugin({ paths });
  const registry = new ToolRegistry();

  assert.equal(await syncPluginTools(plugin, registry), 0);
  assert.equal(registry.list().length, 0);

  await updateDriveConfig('enabled', true, { paths });
  // Enabled but not authenticated: still nothing for the model.
  assert.equal(await syncPluginTools(plugin, registry), 0);
  assert.equal(registry.list().length, 0);

  // Simulate stored credentials, then registration succeeds once.
  await saveCredentials({ tokens: { access_token: 't', refresh_token: 'r' } }, { paths, env: {} });
  const count = await syncPluginTools(plugin, registry);
  assert.equal(count, plugin.tools.length);
  assert.equal(registry.plugins.get('google-drive').toolNames.length, count);
  assert.ok(registry.has('drive_backup'));
  assert.ok(registry.has('drive_restore'));
  assert.ok(registry.toOpenAITools().some((tool) => tool.function.name === 'drive_search'));

  // Risk levels drive the existing approval manager.
  assert.equal(registry.get('drive_search').risk, 'read');
  assert.equal(registry.get('drive_upload').risk, 'write');
  assert.equal(registry.get('drive_delete').risk, 'destructive');
  assert.equal(registry.get('drive_delete_backup').risk, 'destructive');

  // Disabling removes the tools again.
  assert.equal(unregisterPluginTools(plugin, registry), count);
  assert.equal(registry.list().length, 0);

  // A tool call on a disabled plugin is refused even with stale arguments.
  await plugin.disable();
  await assert.rejects(
    () => plugin.requireClient(),
    (error) => error.code === 'DRIVE_DISABLED',
  );
});

test('tool schemas stay valid and require no credentials at definition time', async () => {
  const home = await tempHome();
  const plugin = createGoogleDrivePlugin({ paths: fixturePaths(home) });
  const names = plugin.tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, 'tool names must be unique');
  for (const tool of plugin.tools) {
    assert.match(tool.name, /^drive_[a-z_]+$/);
    assert.ok(tool.description.length > 20);
    assert.equal(tool.schema.type, 'object');
    assert.ok(tool.schema.properties);
    assert.ok(['read', 'write', 'exec', 'destructive'].includes(tool.risk));
  }
  const backup = plugin.tools.find((tool) => tool.name === 'drive_backup');
  assert.ok(backup.schema.required.includes('sourcePath'));
});
