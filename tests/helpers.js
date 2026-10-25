import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/services/workspace.js';
import { validateConfig } from '../src/config/validate.js';
import { createSessionRecord } from '../src/services/sessions.js';

export async function makeTempDir(prefix = 'ryuu-test-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content);
  }
}

export async function createTestWorkspace({ files = {}, extra = {} } = {}) {
  const root = await makeTempDir();
  const defaults = {
    'package.json': `${JSON.stringify({ name: 'fixture-project', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2)}\n`,
    'README.md': '# Fixture\n\nA small project used by tests.\n',
    'src/app.js': "export function hello(name) {\n  return `hello ${name}`;\n}\n",
    'src/util.js': 'export const add = (a, b) => a + b;\n',
    'tests/app.test.js': "import test from 'node:test';\ntest('ok', () => {});\n",
    '.env': 'NVIDIA_API_KEY=nvapi-this-must-never-be-read\n',
    '.env.example': 'NVIDIA_API_KEY=YOUR_NVIDIA_API_KEY\n',
    'node_modules/dep/index.js': 'module.exports = 1;\n',
    '.git/config': '[core]\n\trepositoryformatversion = 0\n',
    'assets/logo.bin': Buffer.from([0, 1, 2, 3, 0, 5]),
  };
  await writeFiles(root, { ...defaults, ...files });
  const workspace = new Workspace(root);
  const config = testConfig(root, extra.config);
  return {
    root,
    workspace,
    config,
    async cleanup() {
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

export function testConfig(root, overrides = {}) {
  const raw = {
    apiKey: 'nvapi-test-key-123456',
    model: 'test/model',
    baseURL: 'https://example.invalid/v1',
    workspace: root,
    logLevel: 'silent',
    maxSteps: 6,
    approvalPolicy: 'auto',
    maxOutputTokens: 512,
    requestTimeoutMs: 5000,
    maxRetries: 0,
    maxFileBytes: 262144,
    maxSearchResults: 20,
    maxToolOutputBytes: 8192,
    maxTaskDurationMs: 60000,
    maxContextChars: 40000,
    // Keep unit tests offline: only the Serper backend is in the provider
    // order, so a failing fake fetch never falls through to a real MCP server.
    webSearchProviders: 'serper',
    webMcpMaxRetries: 0,
    cwd: root,
    ...overrides,
  };
  const { config } = validateConfig(raw, { requireApiKey: false, cwd: root });
  return config;
}

export function toolCall(name, args, id = null) {
  return {
    id: id || `call_${name}_${Math.random().toString(16).slice(2, 8)}`,
    name,
    argumentsText: typeof args === 'string' ? args : JSON.stringify(args),
    type: 'function',
  };
}

export function response({ content = '', toolCalls = [], usage = { prompt: 10, completion: 5, total: 15 } } = {}) {
  return {
    id: 'resp_test',
    model: 'test/model',
    content,
    toolCalls,
    finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    usage,
    durationMs: 1,
  };
}

/** Deterministic provider used by agent and integration tests (no network). */
export class ScriptedProvider {
  constructor(responses) {
    this.responses = [...responses];
    this.calls = [];
    this.config = { model: 'test/model' };
    this.processes = null;
    this.pingResult = { ok: true, model: 'test/model', latencyMs: 1, sample: 'OK' };
  }

  async chat(request) {
    this.calls.push(request);
    if (this.responses.length === 0) {
      throw new Error('ScriptedProvider ran out of responses');
    }
    const next = this.responses.shift();
    if (typeof next === 'function') return next(request);
    if (next instanceof Error) throw next;
    return next;
  }

  async ping() {
    return this.pingResult;
  }
}

/** Renderer that records events instead of writing to a terminal. */
export class RecordingRenderer {
  constructor() {
    this.events = [];
  }

  record(event, payload) {
    this.events.push({ event, payload });
  }

  stopActivity() {}
  processOutput(p) { this.record('processOutput', p); }

  taskStart(p) { this.record('taskStart', p); }
  plan(p) { this.record('plan', p); }
  stepStart(p) { this.record('stepStart', p); }
  progress(p) { this.record('progress', p); }
  fileDiff(p) { this.record('fileDiff', p); }
  thinkingStart(p) { this.record('thinkingStart', p); }
  thinkingEnd(p) { this.record('thinkingEnd', p); }
  note(p) { this.record('note', p); }
  toolStart(p) { this.record('toolStart', p); }
  toolEnd(p) { this.record('toolEnd', p); }
  toolDenied(p) { this.record('toolDenied', p); }
  reasoningDelta(p) { this.record('reasoningDelta', p); }
  reasoningEnd(p) { this.record('reasoningEnd', p); }
  contentDelta(p) { this.record('contentDelta', p); }
  warning(p) { this.record('warning', p); }
  error(p) { this.record('error', p); }
  heartbeat(p) { this.record('heartbeat', p); }
  final(p) { this.record('final', p); }
  approvalRequest(p) { this.record('approvalRequest', p); }
}

export function makeSession(task = 'test task', workspace = '/tmp') {
  return createSessionRecord({ task, model: 'test/model', workspace });
}
