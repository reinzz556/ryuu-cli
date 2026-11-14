/**
 * Shared helpers for the MCP tests.
 *
 * Every test gets its own MCP state directory, so nothing touches the user's
 * real `~/.config/ryuu/mcp`. Local fixtures are spawned with the same Node
 * binary that runs the tests; no test needs an account, network or API key.
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const STDIO_FIXTURE = path.resolve(HERE, '../fixtures/mcp-server.js');
export const HTTP_FIXTURE = path.resolve(HERE, '../fixtures/mcp-http-server.js');
export const OAUTH_FIXTURE = path.resolve(HERE, '../fixtures/mcp-oauth-server.js');

export async function mcpTempDir(prefix = 'ryuu-mcp-test-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** A server record for the local stdio fixture. */
export function stdioFixture(overrides = {}) {
  return {
    name: 'fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [STDIO_FIXTURE],
    ...overrides,
  };
}

/** Poll until `predicate` is truthy or the timeout expires. */
export async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 40 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Start one HTTP fixture and wait until it prints its port. */
async function startHttpLike(fixtureFile) {
  const child = spawn(process.execPath, [fixtureFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const port = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`HTTP fixture did not start: ${stderr}`)), 8000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/\{"port":(\d+)\}/);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`HTTP fixture exited with ${code}: ${stderr}`));
    });
  });
  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    token: 'fixture-token-123',
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

export function startHttpFixture() {
  return startHttpLike(HTTP_FIXTURE);
}

/** OAuth fixture: discovery + DCR + PKCE + token endpoint + protected MCP. */
export function startOAuthFixture() {
  return startHttpLike(OAUTH_FIXTURE);
}

/** A renderer double for command-level tests. */
export function commandRenderer({ styled = false } = {}) {
  const lines = [];
  const statusBlocks = [];
  return {
    lines: (text) => lines.push(String(text)),
    warn: (text) => lines.push(String(text)),
    success: (text) => lines.push(String(text)),
    error: ({ error }) => lines.push(String(error?.message || error)),
    mcpServers: styled
      ? (payload) => {
          statusBlocks.push(payload);
          lines.push(`MCP Servers: ${payload.summary}`);
        }
      : undefined,
    text: () => lines.join('\n'),
    linesList: lines,
    statusBlocks,
  };
}
