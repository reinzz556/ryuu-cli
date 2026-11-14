/**
 * OAuth for HTTP MCP servers.
 *
 * Ryuu's existing OAuth (GitHub/Drive/Vercel) is mediated by the Ryuu backend
 * for those specific integrations, so it cannot authorize an arbitrary MCP
 * server. This module implements the standard MCP OAuth client flow on top of
 * the SDK's own `auth()` helper and `OAuthClientProvider` interface — no
 * hand-rolled token exchange:
 *
 *   1. a loopback HTTP listener receives the authorization code,
 *   2. the SDK discovers metadata, registers the client (DCR) and builds the
 *      authorization URL with PKCE,
 *   3. the browser opens (or the URL is printed),
 *   4. the SDK exchanges the code and the tokens are stored 0600 in the MCP
 *      credentials file.
 *
 * Client information, tokens, the PKCE verifier and discovery state live in the
 * private credentials file; nothing here ever prints or logs a token.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { McpError } from './errors.js';
import { writeServerSecrets } from './config.js';

const DEFAULT_AUTH_TIMEOUT_MS = 180_000;

/** A tiny fixed redirect URI used for refresh-only use (no listener attached). */
const REFRESH_REDIRECT = 'http://127.0.0.1:0/callback';

/**
 * `OAuthClientProvider` backed by the MCP credentials file.
 *
 * The SDK states that values passed to `save*` must be stored unchanged; that is
 * exactly what happens here (`issuer` included), so a later run can refresh
 * without re-registering.
 */
export class FileOAuthProvider {
  constructor({ server, redirectUrl = REFRESH_REDIRECT, oauth = {}, persist = null, onAuthorization = null, scope = '' }) {
    this.server = server;
    this.serverUrl = server.url;
    this._redirectUrl = redirectUrl;
    this.data = { ...(oauth && typeof oauth === 'object' ? oauth : {}) };
    this.persist = persist;
    this.onAuthorization = onAuthorization;
    this.scope = scope;
  }

  get redirectUrl() {
    return this._redirectUrl;
  }

  get clientMetadata() {
    return {
      client_name: 'Ryuu CLI',
      client_uri: 'https://github.com/modelcontextprotocol/typescript-sdk',
      redirect_uris: [String(this._redirectUrl)],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }

  state() {
    const state = crypto.randomBytes(24).toString('base64url');
    this.data.state = state;
    return state;
  }

  clientInformation() {
    return this.data.clientInformation;
  }

  async saveClientInformation(clientInformation) {
    this.data.clientInformation = clientInformation;
    await this.#save();
  }

  tokens() {
    return this.data.tokens;
  }

  async saveTokens(tokens) {
    this.data.tokens = tokens;
    delete this.data.codeVerifier;
    await this.#save();
  }

  saveCodeVerifier(codeVerifier) {
    this.data.codeVerifier = codeVerifier;
  }

  codeVerifier() {
    if (!this.data.codeVerifier) {
      throw new McpError('The OAuth PKCE verifier is missing; start the login again with /mcp connect.', {
        code: 'MCP_OAUTH_STATE',
      });
    }
    return this.data.codeVerifier;
  }

  async redirectToAuthorization(authorizationUrl) {
    if (typeof this.onAuthorization === 'function') await this.onAuthorization(authorizationUrl);
  }

  saveDiscoveryState(state) {
    this.data.discoveryState = state;
  }

  discoveryState() {
    return this.data.discoveryState;
  }

  async invalidateCredentials(scope) {
    if (scope === 'all' || scope === 'client') delete this.data.clientInformation;
    if (scope === 'all' || scope === 'tokens') delete this.data.tokens;
    if (scope === 'all' || scope === 'verifier') delete this.data.codeVerifier;
    if (scope === 'all' || scope === 'discovery') delete this.data.discoveryState;
    await this.#save();
  }

  async #save() {
    if (typeof this.persist === 'function') await this.persist(this.data);
  }

  /** True when a refresh token is stored (no browser needed). */
  hasRefreshToken() {
    return Boolean(this.data.tokens?.refresh_token);
  }

  hasAccessToken() {
    return Boolean(this.data.tokens?.access_token);
  }
}

/** Open a URL with the platform handler; never fatal and never blocks. */
export function openBrowser(url) {
  const target = String(url ?? '');
  // The URL comes from the authorization server's metadata. Only a clean
  // http(s) URL is passed to the platform opener, so no shell metacharacter can
  // escape through `cmd /c start` on Windows.
  if (!/^https?:\/\/[^\s"'`&|<>^]+$/i.test(target)) return false;
  try {
    const [command, args] =
      process.platform === 'darwin'
        ? ['open', [target]]
        : process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '', target]]
          : ['xdg-open', [target]];
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Read one query parameter from the loopback callback. */
function callbackParams(req) {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/callback') return null;
    return {
      code: url.searchParams.get('code') || '',
      state: url.searchParams.get('state') || '',
      error: url.searchParams.get('error') || '',
      errorDescription: url.searchParams.get('error_description') || '',
    };
  } catch {
    return null;
  }
}

/**
 * Run the interactive authorization flow for one HTTP MCP server.
 *
 * @returns {Promise<{authorized: boolean, provider: FileOAuthProvider}>}
 */
export async function authorizeServer({
  server,
  oauth = {},
  persist = null,
  onUrl = null,
  open = true,
  timeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
  scope = '',
} = {}) {
  if (!server || server.transport !== 'http') {
    throw new McpError('OAuth is only available for HTTP MCP servers.', { code: 'MCP_OAUTH_UNSUPPORTED' });
  }

  let resolveCallback;
  let rejectCallback;
  const callbackPromise = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const listener = http.createServer((req, res) => {
    const params = callbackParams(req);
    if (!params) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(params.error ? 400 : 200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      params.error
        ? `<!doctype html><title>Ryuu MCP</title><p>Authorization failed: ${escapeHtml(params.error)}</p>`
        : '<!doctype html><title>Ryuu MCP</title><p>Authorization received. You can close this window.</p>',
    );
    if (params.error) {
      rejectCallback(
        new McpError(`Authorization was rejected: ${params.error}${params.errorDescription ? ` (${params.errorDescription})` : ''}`, {
          code: 'MCP_OAUTH_DENIED',
        }),
      );
      return;
    }
    resolveCallback(params);
  });

  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => resolve());
  }).catch((error) => {
    throw new McpError(`Cannot start the local OAuth callback listener: ${error.message}`, { code: 'MCP_OAUTH_LISTENER' });
  });

  const address = listener.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const redirectUrl = `http://127.0.0.1:${port}/callback`;
  const provider = new FileOAuthProvider({ server, redirectUrl, oauth, persist, scope });

  let timer = null;
  try {
    const printed = (url) => {
      if (typeof onUrl === 'function') onUrl(url);
      if (open) openBrowser(url);
    };
    provider.onAuthorization = printed;

    const first = await auth(provider, { serverUrl: server.url, scope: scope || undefined, fetchFn: fetch });
    if (first === 'AUTHORIZED') return { authorized: true, provider };

    const code = await Promise.race([
      callbackPromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new McpError('OAuth authorization timed out. Run /mcp connect again when you are ready.', {
              code: 'MCP_OAUTH_TIMEOUT',
            }),
          );
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);

    if (provider.data.state && code.state && code.state !== provider.data.state) {
      throw new McpError('The OAuth callback state did not match; the login was discarded.', { code: 'MCP_OAUTH_STATE' });
    }

    const result = await auth(provider, {
      serverUrl: server.url,
      authorizationCode: code.code,
      scope: scope || undefined,
      fetchFn: fetch,
    });
    if (result !== 'AUTHORIZED') {
      throw new McpError('The OAuth authorization did not complete.', { code: 'MCP_OAUTH_INCOMPLETE' });
    }
    await provider.persist?.(provider.data);
    return { authorized: true, provider };
  } finally {
    if (timer) clearTimeout(timer);
    await new Promise((resolve) => listener.close(() => resolve()));
  }
}

/** Save the provider state back to the private credentials file. */
export function oauthPersister(name, dir) {
  return (data) => writeServerSecrets(name, { oauth: data }, { dir, merge: true });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
