import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { McpManager } from '../../src/mcp/index.js';
import { credentialsFile, readSecrets, serversFile } from '../../src/mcp/config.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { mcpTempDir, startOAuthFixture } from '../unit/mcp-helpers.js';

test('OAuth: discovery, dynamic registration, PKCE, token exchange, protected call and token reuse', async () => {
  const auth = await startOAuthFixture();
  const dir = await mcpTempDir();
  const registry = new ToolRegistry();
  const authUrls = [];
  const manager = new McpManager({
    registry,
    dir,
    interactive: true,
    openBrowser: false,
    onAuthUrl: async (url) => {
      authUrls.push(url);
      // Stand in for the user's browser: follow the authorization redirect,
      // which lands on the loopback listener created by authorizeServer().
      const response = await fetch(url);
      assert.equal(response.status, 200, 'the local OAuth callback must receive the code');
    },
  });

  try {
    await manager.addServer({
      name: 'oauthsrv',
      transport: 'http',
      url: auth.url,
      allowPrivateNetwork: true,
      auth: { type: 'oauth' },
    });

    await manager.connect('oauthsrv', { interactive: true });
    assert.equal(authUrls.length, 1, 'the authorization flow ran exactly once');
    const authorizeUrl = new URL(authUrls[0]);
    assert.equal(authorizeUrl.searchParams.get('response_type'), 'code');
    assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authorizeUrl.searchParams.get('client_id'));

    assert.ok(registry.has('mcp_oauthsrv_whoami'));
    const call = await registry.execute('mcp_oauthsrv_whoami', {});
    const identity = JSON.parse(call.result.text);
    assert.equal(identity.user, 'oauth-fixture');

    const secrets = await readSecrets('oauthsrv', { dir });
    assert.equal(secrets.oauth.tokens.access_token, 'oauth-access-token');
    assert.equal(secrets.oauth.tokens.refresh_token, 'oauth-refresh-token');
    assert.ok(secrets.oauth.clientInformation.client_id);
    const mode = (await fsp.stat(credentialsFile('oauthsrv', dir))).mode & 0o777;
    assert.equal(mode, 0o600);

    const serversText = await fsp.readFile(serversFile(dir), 'utf8');
    assert.equal(serversText.includes('oauth-access-token'), false);
    assert.equal(serversText.includes('oauth-refresh-token'), false);
    assert.equal(serversText.includes('oauthsrv'), true);

    // A later connect reuses the stored tokens; no browser flow is triggered.
    await manager.disconnect('oauthsrv');
    await manager.connect('oauthsrv', { interactive: true });
    assert.equal(authUrls.length, 1, 'stored tokens must be reused, not re-authorized');
    assert.ok(registry.has('mcp_oauthsrv_whoami'));
  } finally {
    await manager.close().catch(() => {});
    await auth.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
