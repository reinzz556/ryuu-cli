/**
 * `/mcp` — one command surface for every MCP server.
 *
 * It is registered with the existing command dispatcher (`createCommands`), so it
 * works in the line REPL and in the TUI exactly like `/provider` or `/plugin`.
 * The wizard is interactive by design; every other subcommand also works while a
 * task is running.
 *
 * Secrets are never printed: env/cert/header values are only ever shown as
 * `set (redacted)`, and a bearer token is read from a file instead of being typed
 * into a terminal that echoes.
 */

import fsp from 'node:fs/promises';
import { MCP_DEFAULTS, credentialsDir, logsDir, mcpRoot, serversFile, writeServerSecrets } from './config.js';
import { validateHttpUrl } from './security.js';

const HELP = [
  'MCP (Model Context Protocol) servers add tools to the agent at runtime.',
  '',
  'Usage:',
  '  /mcp                              list configured servers and connection state',
  '  /mcp help                         show this help',
  '  /mcp list                         same as /mcp',
  '  /mcp status                       connected/total summary and per-server state',
  '  /mcp add                          interactive wizard',
  '  /mcp add <name>                   wizard with the name pre-filled',
  '  /mcp remove <name>                delete a server, its credentials and its log',
  '  /mcp enable <name>                enable and connect',
  '  /mcp disable <name>               disconnect and keep the configuration',
  '  /mcp connect <name>               connect and register its tools',
  '  /mcp disconnect <name>            close the connection and unregister its tools',
  '  /mcp restart <name>               reconnect from scratch (also /mcp reconnect)',
  '  /mcp reconnect <name>             same as restart',
  '  /mcp refresh <name>               re-read tools/resources/prompts from the server',
  '  /mcp test <name>                  open a temporary connection and report capabilities',
  '  /mcp info <name>                  configuration, capabilities, paths (no secrets)',
  '  /mcp tools <name>                 tools, risk and approval state',
  '  /mcp resources <name> [uri]       list resources, or read one',
  '  /mcp prompts <name> [prompt] [k=v] list prompts, or render one',
  '  /mcp logs <name> [lines]          recent redacted log lines',
  '  /mcp config                       paths, defaults and file permissions',
  '  /mcp token <name> <file>          replace the bearer token from a private file',
  '',
  'STDIO servers are spawned directly (never through a shell); HTTP servers go',
  'through the same SSRF guard as read_url. Tools that are not clearly read-only',
  'always pass through the normal approval gate.',
].join('\n');

const SUBCOMMANDS = new Set([
  'help',
  'list',
  'status',
  'add',
  'remove',
  'enable',
  'disable',
  'restart',
  'reconnect',
  'connect',
  'disconnect',
  'info',
  'tools',
  'resources',
  'prompts',
  'logs',
  'config',
  'test',
  'refresh',
  'token',
]);

const STATE_STYLE = {
  connected: { symbol: '●', label: 'Connected' },
  connecting: { symbol: '◐', label: 'Connecting' },
  disconnected: { symbol: '○', label: 'Disconnected' },
  disabled: { symbol: '⊘', label: 'Disabled' },
  error: { symbol: '✕', label: 'Error' },
};

/** Split a space-separated argument line while keeping quoted values intact. */
function splitArgs(text) {
  const out = [];
  let current = '';
  let quote = null;
  for (const char of String(text ?? '')) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function modeOf(stats) {
  return `0${(stats.mode & 0o777).toString(8)}`;
}

function describeCapabilities(capabilities = {}) {
  const caps = capabilities && typeof capabilities === 'object' ? capabilities : {};
  const names = [
    caps.tools !== undefined ? 'tools' : null,
    caps.resources !== undefined ? 'resources' : null,
    caps.prompts !== undefined ? 'prompts' : null,
    caps.logging !== undefined ? 'logging' : null,
    caps.completions !== undefined ? 'completions' : null,
    caps.experimental && Object.keys(caps.experimental).length > 0 ? 'experimental' : null,
  ].filter(Boolean);
  return names.length > 0 ? names.join(', ') : 'none advertised';
}

function escapeLine(value, max = 300) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .slice(0, max);
}

/**
 * @param {object} options
 * @param {import('./manager.js').McpManager|null} options.manager
 * @param {(text: string) => void} options.print
 * @param {(question: string) => Promise<string|null>} [options.ask]
 * @param {(question: string) => Promise<boolean>} [options.confirm]
 * @param {boolean} [options.interactive]
 * @param {object} [options.renderer]
 */
export function createMcpCommand({ manager, print, ask = null, confirm = null, interactive = false, renderer = null } = {}) {
  const unavailable = () =>
    print(
      'MCP is not available in this session (no MCP manager was created).\n' +
        'Start Ryuu normally to enable MCP support; see docs/mcp.md.',
    );

  const stateRows = async () => {
    const status = await manager.status();
    renderer?.mcpServers?.({
      title: 'MCP SERVERS',
      summary: `${status.connected} connected · ${status.total} configured`,
      rows: status.rows.map((row) => ({
        name: row.name,
        state: row.state,
        symbol: STATE_STYLE[row.state]?.symbol || '○',
        label: STATE_STYLE[row.state]?.label || row.state,
        detail: row.state === 'connected' ? `${row.tools} tool(s)` : row.error ? escapeLine(row.error, 100) : row.enabled ? '' : 'disabled',
      })),
    });
    if (!renderer?.mcpServers) print(plainStatus(status));
    return status;
  };

  const plainStatus = (status) =>
    [
      `MCP Servers: ${status.connected} connected · ${status.total} configured`,
      ...status.rows.map((row) => {
        const style = STATE_STYLE[row.state] || { symbol: '○', label: row.state };
        const detail = row.state === 'connected' ? `${row.tools} tool(s)` : row.error ? escapeLine(row.error, 90) : '';
        return `  ${row.name.padEnd(18)} ${style.symbol} ${style.label}${detail ? `  ${detail}` : ''}`;
      }),
      status.total === 0 ? '  (no servers yet — run /mcp add)' : '',
    ]
      .filter(Boolean)
      .join('\n');

  async function readTokenFile(file) {
    const target = String(file ?? '').trim();
    if (!target) return { ok: false, reason: 'no file given' };
    try {
      const stats = await fsp.stat(target);
      if (!stats.isFile()) return { ok: false, reason: 'not a regular file' };
      const text = (await fsp.readFile(target, 'utf8')).trim();
      if (!text) return { ok: false, reason: 'the file is empty' };
      if (text.length > 16_384) return { ok: false, reason: 'the file is too large for a token' };
      return { ok: true, token: text, worldReadable: process.platform !== 'win32' && (stats.mode & 0o077) !== 0 };
    } catch (error) {
      return { ok: false, reason: error.code === 'ENOENT' ? 'file not found' : error.message };
    }
  }

  async function wizard(nameHint = '') {
    if (!interactive || typeof ask !== 'function' || typeof confirm !== 'function') {
      return print(
        [
          '/mcp add needs an interactive terminal: it asks for the command/URL and tests the connection.',
          'In a non-interactive run, author the server directly in:',
          `  ${serversFile()}`,
          'See docs/mcp.md for the file format. Secrets belong in the credentials file, not servers.json.',
        ].join('\n'),
      );
    }

    const name = String(nameHint || (await ask('Server name (lowercase, e.g. github): ')) || '').trim().toLowerCase();
    if (!name) return print('Cancelled: no name was given.');
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(name)) {
      return print('Invalid name. Use 2-32 lowercase letters, digits, "_" or "-", starting with a letter.');
    }
    const existing = await manager.status();
    if (existing.rows.some((row) => row.name === name)) {
      return print(`An MCP server named ${name} already exists. Remove it first with /mcp remove ${name}.`);
    }

    const transportInput = String((await ask('Transport [stdio/http] (stdio): ')) || '').trim().toLowerCase();
    const transport = transportInput || 'stdio';
    if (!['stdio', 'http'].includes(transport)) return print('Transport must be "stdio" or "http". Nothing was saved.');

    const input = {
      name,
      transport,
      args: [],
      env: {},
      headers: {},
      auth: { type: 'none' },
    };

    if (transport === 'stdio') {
      const command = String((await ask('Command (absolute path or a name on PATH): ')) || '').trim();
      if (!command) return print('A stdio server needs a command. Nothing was saved.');
      input.command = command;
      const argsLine = await ask('Arguments (space separated, optional): ');
      input.args = splitArgs(argsLine || '');
      const cwd = String((await ask('Working directory (optional, Enter for the current one): ')) || '').trim();
      if (cwd) input.cwd = cwd;
      for (let index = 0; index < 32; index += 1) {
        const line = String((await ask('Environment variable KEY=value (Enter to finish): ')) || '').trim();
        if (!line) break;
        const separator = line.indexOf('=');
        if (separator <= 0) {
          print('  Ignored: use KEY=value.');
          continue;
        }
        const key = line.slice(0, separator).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          print(`  Ignored: ${JSON.stringify(key)} is not a valid environment variable name.`);
          continue;
        }
        input.env[key] = line.slice(separator + 1);
      }
    } else {
      const url = String((await ask('Server URL (https://…): ')) || '').trim();
      if (!url) return print('An HTTP server needs a URL. Nothing was saved.');
      try {
        await validateHttpUrl(url, { resolve: false });
        input.url = url;
      } catch (error) {
        const allow = await confirm(`${error.message}\nAllow private/local addresses for this server? [y/N] `);
        if (!allow) return print('Cancelled: the URL points to a blocked address.');
        try {
          await validateHttpUrl(url, { allowPrivate: true, resolve: false });
        } catch (retryError) {
          return print(`Invalid URL: ${retryError.message} Nothing was saved.`);
        }
        input.url = url;
        input.allowPrivateNetwork = true;
      }

      for (let index = 0; index < 32; index += 1) {
        const line = String((await ask('HTTP header Name: value (Enter to finish; values are stored privately): ')) || '').trim();
        if (!line) break;
        const separator = line.indexOf(':');
        if (separator <= 0) {
          print('  Ignored: use Name: value.');
          continue;
        }
        const header = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,80}$/.test(header)) {
          print('  Ignored: that is not a valid HTTP header name.');
          continue;
        }
        input.headers[header] = value;
      }

      const auth = String((await ask('Authentication [none/bearer/oauth] (none): ')) || '').trim().toLowerCase() || 'none';
      if (!['none', 'bearer', 'oauth'].includes(auth)) return print('Authentication must be none, bearer or oauth. Nothing was saved.');
      input.auth = { type: auth };
      if (auth === 'bearer') {
        const header = String((await ask('Token header name (Authorization): ')) || '').trim() || 'Authorization';
        input.auth.header = header;
        const tokenFile = await ask('Path to a file containing the token (read now, never printed; Enter to skip): ');
        if (tokenFile) {
          const result = await readTokenFile(tokenFile);
          if (!result.ok) {
            print(`  Token not read: ${result.reason}. The server will be saved without a token.`);
          } else {
            input.token = result.token;
            if (result.worldReadable) print('  Warning: that token file is readable by other users; chmod 600 it.');
            print('  Token read and will be stored owner-only (0600); it is never printed again.');
          }
        }
      }
    }

    print(
      [
        '',
        'Review:',
        `  name        ${name}`,
        `  transport   ${transport}`,
        ...(transport === 'stdio'
          ? [
              `  command     ${input.command}`,
              `  arguments   ${input.args.length ? input.args.join(' ') : '(none)'}`,
              ...(input.cwd ? [`  cwd         ${input.cwd}`] : []),
              `  env         ${Object.keys(input.env).length ? Object.keys(input.env).join(', ') + ' (values redacted)' : '(none)'}`,
            ]
          : [
              `  url         ${input.url}`,
              `  headers     ${Object.keys(input.headers).length ? Object.keys(input.headers).join(', ') + ' (values redacted)' : '(none)'}`,
              `  auth        ${input.auth.type}${input.token ? ' · token set (redacted)' : ''}`,
            ]),
        '',
      ].join('\n'),
    );

    const save = await confirm('Save this MCP server? [y/N] ');
    if (!save) return print('Cancelled. Nothing was saved.');

    try {
      await manager.addServer(input);
      print(`Saved ${name} to ${serversFile()} (config without secrets, credentials 0600).`);
    } catch (error) {
      return print(`Could not save ${name}: ${error.message}`);
    }

    if (input.auth.type === 'oauth') {
      print(`OAuth is required: run /mcp connect ${name} to authorize in the browser, then test.`);
      const connectNow = await confirm('Authorize and connect now? [y/N] ');
      if (!connectNow) return;
      try {
        await manager.connect(name, { interactive: true });
        const info = await manager.info(name);
        print(`Connected. ${info.runtime.tools.length} tool(s) registered; the agent can use them now.`);
      } catch (error) {
        print(`Connection failed: ${error.message}`);
      }
      return;
    }

    const test = await confirm('Test the connection now? [y/N] ');
    if (!test) return print('Saved. Run /mcp connect ' + name + ' when you are ready.');
    const report = await manager.test(name);
    if (!report.ok) return print(`Saved, but the connection test failed: ${report.error}`);
    const risks = report.tools.reduce((count, tool) => count + (tool.risk === 'read' ? 0 : 1), 0);
    print(
      [
        `Connection OK in ${report.durationMs}ms.`,
        `  ${report.tools.length} tool(s) · ${risks} approval-gated · ${report.resources} resource(s) · ${report.prompts} prompt(s)`,
        ...report.tools.slice(0, 12).map((tool) => `    ${name}:${tool.name}  [${tool.risk}]`),
      ].join('\n'),
    );
    try {
      await manager.connect(name);
      print(`Registered ${report.tools.length} tool(s); the agent can call them on the next step.`);
    } catch (error) {
      print(`Saved, but connecting failed: ${error.message}`);
    }
  }

  async function requireName(parts, usage) {
    const name = parts[0];
    if (!name) {
      print(`Usage: ${usage}`);
      return null;
    }
    const status = await manager.status();
    if (!status.rows.some((row) => row.name === name)) {
      print(`Unknown MCP server: ${name}. Run /mcp list to see configured servers.`);
      return null;
    }
    return name;
  }

  async function handleMcp(args = '') {
    if (!manager) return unavailable();
    const parts = splitArgs(args);
    const sub = (parts[0] || 'list').toLowerCase();
    if (!SUBCOMMANDS.has(sub)) {
      return print(`Unknown /mcp subcommand: ${sub}\n\n${HELP}`);
    }

    if (sub === 'help' || sub === '?') return print(HELP);
    if (sub === 'list') {
      const status = await stateRows();
      if (status.total === 0) print('No MCP servers configured yet. Run /mcp add to create one.');
      return;
    }
    if (sub === 'status') {
      const name = parts[1];
      if (!name) {
        const status = await stateRows();
        print('Run /mcp info <name> for one server, /mcp test <name> to check a connection.');
        return status;
      }
      return handleMcp(`info ${name}`);
    }
    if (sub === 'config') {
      return printConfig();
    }
    if (sub === 'add') return wizard(parts[1]);

    const name = await requireName(parts.slice(1), `/mcp ${sub} <name>`);
    if (!name) return undefined;

    if (sub === 'remove') {
      if (typeof confirm !== 'function') {
        return print('Removing a server needs confirmation. Run /mcp remove in an interactive session.');
      }
      const approved = await confirm(`Remove MCP server ${name}, its credentials and its log? [y/N] `);
      if (!approved) return print('Cancelled. Nothing was removed.');
      const removed = await manager.removeServer(name);
      return print(
        removed
          ? `Removed ${name}. Its tools are no longer available to the agent.`
          : `${name} was not configured.`,
      );
    }

    if (sub === 'enable' || sub === 'disable') {
      try {
        const record = await manager.setEnabled(name, sub === 'enable');
        const status = await manager.status();
        const row = status.rows.find((entry) => entry.name === name);
        return print(
          sub === 'enable'
            ? row?.state === 'connected'
              ? `${name} enabled and connected (${row.tools} tool(s)).`
              : `${name} enabled, but not connected: ${row?.error || 'see /mcp logs ' + name}.`
            : `${name} disabled; its configuration is kept and its tools were unregistered.`,
        );
      } catch (error) {
        return print(`Could not ${sub} ${name}: ${error.message}`);
      }
    }

    if (sub === 'connect' || sub === 'restart' || sub === 'reconnect') {
      try {
        const info = await manager.connect(name, { interactive: true });
        return print(
          `${name} ${sub === 'connect' ? 'connected' : 'reconnected'} · ${info.runtime.tools.length} tool(s) · ` +
            `${info.runtime.resources.length} resource(s) · ${info.runtime.prompts.length} prompt(s)`,
        );
      } catch (error) {
        return print(`Could not connect ${name}: ${error.message}`);
      }
    }

    if (sub === 'disconnect') {
      await manager.disconnect(name);
      return print(`${name} disconnected; its tools were unregistered until the next connect.`);
    }

    if (sub === 'refresh') {
      try {
        const result = await manager.refresh(name);
        return print(`${name} refreshed · ${result.tools} tool(s) · ${result.resources} resource(s) · ${result.prompts} prompt(s)`);
      } catch (error) {
        return print(`Could not refresh ${name}: ${error.message}`);
      }
    }

    if (sub === 'test') {
      print(`Testing ${name} with a temporary connection (the live connection is untouched)…`);
      const report = await manager.test(name);
      if (!report.ok) return print(`${name} ✕ ${report.error} (${report.durationMs}ms)`);
      return print(
        [
          `${name} ✓ connected in ${report.durationMs}ms`,
          `  capabilities: ${describeCapabilities(report.capabilities)}`,
          `  tools: ${report.tools.length} · resources: ${report.resources} · prompts: ${report.prompts}`,
          ...report.tools.slice(0, 20).map((tool) => `    ${tool.name.padEnd(32)} [${tool.risk}]`),
          report.tools.length > 20 ? `    … ${report.tools.length - 20} more` : '',
          'The test did not call any tool.',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }

    if (sub === 'info') {
      const info = await manager.info(name);
      const server = info.server;
      return print(
        [
          `MCP server: ${server.name}`,
          `  state        ${info.runtime.state}${info.runtime.connectedAt ? ` · since ${info.runtime.connectedAt}` : ''}`,
          `  enabled      ${server.enabled ? 'yes' : 'no'} · autoConnect ${server.autoConnect ? 'yes' : 'no'}`,
          `  transport    ${server.transport}`,
          ...(server.transport === 'stdio'
            ? [
                `  command      ${server.command}`,
                `  arguments    ${(server.args || []).join(' ') || '(none)'}`,
                ...(server.cwd ? [`  cwd          ${server.cwd}`] : []),
                `  env keys     ${server.envKeys.length ? server.envKeys.join(', ') + ' (values redacted)' : '(none)'}`,
              ]
            : [
                `  url          ${server.url}`,
                `  auth         ${server.auth.type}${server.auth.header && server.auth.type === 'bearer' ? ` via ${server.auth.header}` : ''}`,
                `  headers      ${server.headerNames.length ? server.headerNames.join(', ') + ' (values redacted)' : '(none)'}`,
                `  private net  ${server.allowPrivateNetwork ? 'allowed' : 'blocked'}`,
              ]),
          `  timeouts     connect ${server.connectTimeoutMs}ms · call ${server.callTimeoutMs}ms · result cap ${formatBytes(server.maxResultBytes)}`,
          `  capabilities ${describeCapabilities(info.runtime.capabilities)}`,
          `  server       ${info.runtime.serverVersion ? `${info.runtime.serverVersion.name} ${info.runtime.serverVersion.version}` : 'not reported'}`,
          `  tools        ${info.runtime.tools.length}`,
          `  resources    ${info.runtime.resources.length}`,
          `  prompts      ${info.runtime.prompts.length}`,
          `  last error   ${info.runtime.error || 'none'}`,
          '',
          'Paths (secrets are never shown):',
          `  config       ${info.paths.servers}`,
          `  credentials  ${info.paths.credentials}`,
          `  log          ${info.paths.log}`,
        ].join('\n'),
      );
    }

    if (sub === 'tools') {
      const info = await manager.info(name);
      if (info.runtime.tools.length === 0) {
        return print(
          info.runtime.state === 'connected'
            ? `${name} exposes no tools (it may only provide resources/prompts).`
            : `${name} is not connected. Run /mcp connect ${name}.`,
        );
      }
      return print(
        [
          `Tools exposed by ${name} (${info.runtime.tools.length}):`,
          ...info.runtime.tools.map(
            (tool) =>
              `  ${tool.display.padEnd(40)} ${tool.risk.padEnd(12)} ${tool.risk === 'read' ? 'auto' : 'approval'}  ${tool.description}`,
          ),
          '',
          'Risk is inferred from the tool name and the server annotation; anything not clearly',
          'read-only is approval-gated and destructive tools are marked critical.',
        ].join('\n'),
      );
    }

    if (sub === 'resources') {
      const uri = parts[2];
      if (!uri) {
        const info = await manager.info(name);
        if (info.runtime.resources.length === 0) return print(`${name} exposes no resources.`);
        return print(
          [
            `Resources exposed by ${name} (${info.runtime.resources.length}):`,
            ...info.runtime.resources.map((item) => `  ${item.uri}${item.name ? `  (${item.name})` : ''}${item.mimeType ? ` · ${item.mimeType}` : ''}`),
            '',
            `Read one with /mcp resources ${name} <uri>`,
          ].join('\n'),
        );
      }
      try {
        const result = await manager.readResource(name, uri);
        const contents = Array.isArray(result?.contents) ? result.contents : [];
        if (contents.length === 0) return print(`${name} returned no content for ${uri}.`);
        return print(
          contents
            .map((item) => {
              if (typeof item.text === 'string') return `[${item.uri || uri}]\n${item.text.slice(0, 12_000)}`;
              if (typeof item.blob === 'string') {
                return `[${item.uri || uri}] binary (${item.mimeType || 'application/octet-stream'}, ${formatBytes(Math.ceil((item.blob.length * 3) / 4))}); not printed.`;
              }
              return `[${item.uri || uri}] empty`;
            })
            .join('\n\n'),
        );
      } catch (error) {
        return print(`Could not read ${uri}: ${error.message}`);
      }
    }

    if (sub === 'prompts') {
      const promptName = parts[2];
      if (!promptName) {
        const info = await manager.info(name);
        if (info.runtime.prompts.length === 0) return print(`${name} exposes no prompts.`);
        return print(
          [
            `Prompts exposed by ${name} (${info.runtime.prompts.length}):`,
            ...info.runtime.prompts.map(
              (prompt) =>
                `  ${prompt.name}${prompt.arguments.length ? `  (${prompt.arguments.map((arg) => (arg.required ? `${arg.name}*` : arg.name)).join(', ')})` : ''}  ${prompt.description}`,
            ),
            '',
            `Render one with /mcp prompts ${name} <prompt> key=value … (it is shown, never executed)`,
          ].join('\n'),
        );
      }
      const promptArgs = {};
      for (const pair of parts.slice(3)) {
        const separator = pair.indexOf('=');
        if (separator <= 0) return print(`Invalid argument ${JSON.stringify(pair)}; use key=value.`);
        promptArgs[pair.slice(0, separator)] = pair.slice(separator + 1);
      }
      try {
        const result = await manager.getPrompt(name, promptName, promptArgs);
        const messages = Array.isArray(result?.messages) ? result.messages : [];
        return print(
          [
            `Prompt ${name}:${promptName}${result?.description ? ` — ${result.description}` : ''}`,
            ...messages.map((message) => {
              const content = message?.content;
              const text = typeof content === 'string' ? content : content?.type === 'text' ? content.text : `[${content?.type || 'unknown'} content]`;
              return `\n[${message?.role || 'user'}]\n${text}`;
            }),
            '',
            'Rendered only. Nothing was sent to the agent.',
          ].join('\n'),
        );
      } catch (error) {
        return print(`Could not render prompt ${promptName}: ${error.message}`);
      }
    }

    if (sub === 'logs') {
      const count = Number(parts[2]);
      try {
        const log = await manager.logs(name, { lines: Number.isInteger(count) && count > 0 ? count : 80 });
        return print(
          [log.file, log.text || '(no log entries yet)', '', 'Secrets are redacted before a line is written.'].join('\n'),
        );
      } catch (error) {
        return print(`Could not read the log: ${error.message}`);
      }
    }

    if (sub === 'token') {
      const file = parts[2];
      if (!file) return print(`Usage: /mcp token ${name} <file>   (the file is read, never echoed)`);
      const read = await readTokenFile(file);
      if (!read.ok) return print(`Token not set: ${read.reason}.`);
      try {
        await writeServerSecrets(name, { token: read.token }, { dir: manager.dir, merge: true });
        if (read.worldReadable) print('Warning: that token file is readable by other users; chmod 600 it.');
        return print(`Token stored owner-only for ${name}. Run /mcp reconnect ${name} to use it.`);
      } catch (error) {
        return print(`Could not store the token: ${error.message}`);
      }
    }

    return print(HELP);
  };

  async function printConfig() {
    const status = await manager.status();
    const dir = manager.dir;
    const lines = [
      'MCP CONFIGURATION',
      `  root         ${mcpRoot(dir)}`,
      `  servers      ${serversFile(dir)}`,
      `  credentials  ${credentialsDir(dir)}/`,
      `  logs         ${logsDir(dir)}/`,
      `  servers      ${status.total} configured · ${status.connected} connected`,
      `  defaults     connect ${MCP_DEFAULTS.connectTimeoutMs}ms · call ${MCP_DEFAULTS.callTimeoutMs}ms · result cap ${formatBytes(MCP_DEFAULTS.maxResultBytes)}`,
    ];
    for (const [label, file] of [
      ['servers.json', serversFile(dir)],
      ['credentials/*.json', credentialsDir(dir)],
    ]) {
      try {
        const stats = await fsp.stat(file);
        const mode = modeOf(stats);
        const privateEnough = (stats.mode & 0o077) === 0;
        lines.push(`  mode         ${label} ${mode}${privateEnough ? '' : '  ← readable by other users; chmod 700/600'}`);
      } catch {
        lines.push(`  mode         ${label} (not created yet)`);
      }
    }
    lines.push('', 'Secrets are stored separately from servers.json and are never printed.');
    print(lines.join('\n'));
  }

  handleMcp.help = HELP;
  handleMcp.stateStyle = STATE_STYLE;
  return handleMcp;
}
