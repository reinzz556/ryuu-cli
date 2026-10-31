import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../../src/agent/agent.js';
import { ApprovalManager } from '../../src/agent/approvals.js';
import { ProcessManager } from '../../src/services/processes.js';
import { SessionStore } from '../../src/services/sessions.js';
import { UndoManager } from '../../src/services/undo.js';
import { buildToolRegistry } from '../../src/tools/index.js';
import { ProviderError } from '../../src/utils/errors.js';
import { createTestWorkspace, RecordingRenderer, ScriptedProvider, response, testConfig, toolCall } from '../helpers.js';

async function setup({ responses, approvalPolicy = 'auto', confirm = async () => true, interactive = false, configOverrides = {} }) {
  const fixture = await createTestWorkspace();
  const config = testConfig(fixture.root, { approvalPolicy, ...configOverrides });
  const processes = new ProcessManager({ workspace: fixture.workspace, defaultTimeoutMs: 5000 });
  const registry = buildToolRegistry({ workspace: fixture.workspace, config, processes });
  const provider = new ScriptedProvider(responses);
  const renderer = new RecordingRenderer();
  const sessionStore = new SessionStore({ dir: config.historyDir });
  const undo = new UndoManager({ workspace: fixture.workspace, dir: config.undoDir });
  const approvals = new ApprovalManager({ policy: approvalPolicy, confirm: interactive ? confirm : null, interactive });
  const agent = new Agent({
    provider,
    registry,
    workspace: fixture.workspace,
    config,
    renderer,
    approvals,
    sessionStore,
    undo,
    processes,
  });
  return {
    fixture,
    config,
    processes,
    registry,
    provider,
    renderer,
    sessionStore,
    undo,
    approvals,
    agent,
    async cleanup() {
      await processes.stopAll();
      await fixture.cleanup();
    },
  };
}

test('runs tools, applies an approved edit, records undo and returns evidence', async () => {
  const ctx = await setup({
    responses: [
      response({
        content: '1. Inspect the file\n2. Update the greeting\n3. Verify the result',
        toolCalls: [toolCall('read_file', { path: 'src/app.js' })],
      }),
      response({ toolCalls: [toolCall('edit_file', { path: 'src/app.js', old_text: 'hello ${name}', new_text: 'hi ${name}' })] }),
      response({ content: 'Updated src/app.js so hello() returns "hi <name>".' }),
    ],
  });
  try {
    const summary = await ctx.agent.run('change the greeting');
    assert.equal(summary.status, 'completed');
    assert.equal(summary.steps, 3);
    assert.ok(summary.plan.includes('Inspect the file'));
    assert.ok((await ctx.fixture.workspace.readText('src/app.js')).text.includes('hi ${name}'));
    assert.deepEqual(summary.changedFiles, ['src/app.js']);
    assert.equal(summary.undoCount, 1);
    assert.equal(ctx.undo.last().before.includes('hello ${name}'), true);
    assert.ok(ctx.renderer.events.some((event) => event.event === 'plan'));
    assert.ok(ctx.renderer.events.some((event) => event.event === 'toolEnd' && event.payload.ok));

    const saved = await ctx.sessionStore.load(summary.sessionId);
    assert.equal(saved.status, 'completed');
    assert.equal(saved.changedFiles[0], 'src/app.js');

    // Tool protocol: assistant tool_calls are followed by matching tool messages.
    const secondRequest = ctx.provider.calls[1].messages;
    const assistant = secondRequest.find((message) => message.role === 'assistant' && message.tool_calls);
    const toolMessage = secondRequest.find((message) => message.role === 'tool');
    assert.equal(toolMessage.tool_call_id, assistant.tool_calls[0].id);
    assert.match(toolMessage.content, /export function hello/);
  } finally {
    await ctx.cleanup();
  }
});

test('runs an approved command and records real stdout, stderr, exit code and duration', async () => {
  const ctx = await setup({
    responses: [
      response({
        toolCalls: [toolCall('run_command', {
          argv: [process.execPath, '-e', "console.log('REAL_OUT'); console.error('REAL_ERR'); process.exit(3);"],
          timeout_ms: 10000,
        })],
      }),
      response({ content: 'The command was executed and exited with code 3.' }),
    ],
    approvalPolicy: 'ask',
    confirm: async () => true,
    interactive: true,
  });
  try {
    const summary = await ctx.agent.run('run the check');
    assert.equal(summary.status, 'completed');
    assert.equal(summary.commands.length, 1);
    assert.equal(summary.commands[0].exitCode, 3);
    assert.ok(summary.commands[0].durationMs >= 0);
    assert.equal(summary.commands[0].timedOut, false);

    const toolMessage = ctx.provider.calls[1].messages.find((message) => message.role === 'tool');
    assert.match(toolMessage.content, /REAL_OUT/);
    assert.match(toolMessage.content, /REAL_ERR/);
    assert.match(toolMessage.content, /"exit_code":3/);

    const saved = await ctx.sessionStore.load(summary.sessionId);
    assert.equal(saved.commands[0].exitCode, 3);
    assert.match(saved.commands[0].output, /REAL_OUT/);
    assert.match(saved.commands[0].output, /REAL_ERR/);
  } finally {
    await ctx.cleanup();
  }
});

test('denied approval prevents the write and is reported to the model', async () => {
  const ctx = await setup({
    responses: [
      response({ toolCalls: [toolCall('write_file', { path: 'src/app.js', content: 'overwritten\n' })] }),
      response({ content: 'The write was not applied because approval was denied.' }),
    ],
    approvalPolicy: 'ask',
    confirm: async () => false,
    interactive: true,
  });
  try {
    const before = (await ctx.fixture.workspace.readText('src/app.js')).text;
    const summary = await ctx.agent.run('overwrite the file');
    assert.equal(summary.status, 'completed');
    assert.equal((await ctx.fixture.workspace.readText('src/app.js')).text, before);
    assert.equal(summary.changedFiles.length, 0);
    assert.ok(ctx.renderer.events.some((event) => event.event === 'toolDenied'));
    const toolMessage = ctx.provider.calls[1].messages.find((message) => message.role === 'tool');
    assert.match(toolMessage.content, /APPROVAL_DENIED/);
  } finally {
    await ctx.cleanup();
  }
});

test('read-only policy denies writes without prompting', async () => {
  let prompted = false;
  const ctx = await setup({
    responses: [
      response({ toolCalls: [toolCall('write_file', { path: 'src/app.js', content: 'nope\n' })] }),
      response({ content: 'Cannot write in read-only mode.' }),
    ],
    approvalPolicy: 'read-only',
    confirm: async () => { prompted = true; return true; },
    interactive: true,
  });
  try {
    const summary = await ctx.agent.run('write');
    assert.equal(summary.status, 'completed');
    assert.equal(prompted, false);
    assert.equal(summary.changedFiles.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('handles unknown tools and malformed arguments without crashing', async () => {
  const ctx = await setup({
    responses: [
      response({
        toolCalls: [
          toolCall('definitely_not_a_tool', { x: 1 }, 'call_unknown'),
          toolCall('read_file', '{not valid json', 'call_bad_json'),
          toolCall('read_file', { path: '../outside.txt' }, 'call_escape'),
        ],
      }),
      response({ content: 'Recovered from invalid tool calls.' }),
    ],
  });
  try {
    const summary = await ctx.agent.run('try bad calls');
    assert.equal(summary.status, 'completed');
    const toolMessages = ctx.provider.calls[1].messages.filter((message) => message.role === 'tool');
    assert.equal(toolMessages.length, 3);
    assert.match(toolMessages[0].content, /UNKNOWN_TOOL/);
    assert.match(toolMessages[1].content, /INVALID_ARGUMENTS/);
    assert.match(toolMessages[2].content, /PATH_ESCAPE/);
    assert.equal(toolMessages[0].tool_call_id, 'call_unknown');
  } finally {
    await ctx.cleanup();
  }
});

test('streams provider reasoning to the renderer and reports the reasoning log', async () => {
  const ctx = await setup({
    responses: [
      (request) => {
        request.onReasoning?.('checking the file ');
        request.onReasoning?.('before editing');
        return { ...response({ content: 'Done after reviewing.' }), reasoning: 'checking the file before editing' };
      },
    ],
  });
  try {
    const summary = await ctx.agent.run('inspect before editing');
    assert.equal(summary.status, 'completed');
    const deltas = ctx.renderer.events.filter((event) => event.event === 'reasoningDelta');
    assert.deepEqual(deltas.map((event) => event.payload.text), ['checking the file ', 'before editing']);
    const ended = ctx.renderer.events.find((event) => event.event === 'reasoningEnd');
    assert.ok(ended, 'reasoningEnd must be emitted after the response');
    assert.equal(ended.payload.logFile, null);
  } finally {
    await ctx.cleanup();
  }
});

test('runs an approved command and captures real exit code and output', async () => {
  const prompts = [];
  const ctx = await setup({
    responses: [
      response({
        toolCalls: [toolCall('run_command', { argv: [process.execPath, '-e', "console.log('command-output');"] })],
      }),
      response({ content: 'Command ran successfully.' }),
    ],
    approvalPolicy: 'auto',
    confirm: async (request) => { prompts.push(request.tool); return true; },
    interactive: true,
  });
  try {
    const summary = await ctx.agent.run('run a command');
    assert.equal(summary.status, 'completed');
    assert.deepEqual(prompts, ['run_command']);
    assert.equal(summary.commands.length, 1);
    assert.equal(summary.commands[0].exitCode, 0);
    assert.ok(summary.commands[0].argv.includes('-e'));
    const toolMessage = ctx.provider.calls[1].messages.find((message) => message.role === 'tool');
    assert.match(toolMessage.content, /command-output/);
    assert.match(toolMessage.content, /"ok":true/);
  } finally {
    await ctx.cleanup();
  }
});

test('non-interactive command execution is denied without a prompt', async () => {
  const ctx = await setup({
    responses: [
      response({ toolCalls: [toolCall('run_command', { argv: [process.execPath, '-e', "console.log('should-not-run')"] })] }),
      response({ content: 'Command denied.' }),
    ],
    approvalPolicy: 'ask',
    interactive: false,
  });
  try {
    const summary = await ctx.agent.run('run');
    assert.equal(summary.status, 'completed');
    assert.equal(summary.commands.length, 0);
    const toolMessage = ctx.provider.calls[1].messages.find((message) => message.role === 'tool');
    assert.match(toolMessage.content, /APPROVAL_DENIED/);
  } finally {
    await ctx.cleanup();
  }
});

test('stops at the step limit with an explicit status', async () => {
  const ctx = await setup({
    responses: Array.from({ length: 5 }, () => response({ toolCalls: [toolCall('list_files', {})] })),
    configOverrides: { maxSteps: 2 },
  });
  try {
    const summary = await ctx.agent.run('loop forever');
    assert.equal(summary.status, 'step-limit');
    assert.equal(summary.steps, 2);
    assert.ok(summary.issues.some((issue) => /step limit/i.test(issue)));
    assert.match(summary.finalText, /Step limit/);
  } finally {
    await ctx.cleanup();
  }
});

test('has no step limit by default and keeps going past 20 steps', async () => {
  const responses = Array.from({ length: 25 }, () => response({ toolCalls: [toolCall('list_files', { path: 'src' })] }));
  responses.push(response({ content: 'Finished after many steps.' }));
  const ctx = await setup({ responses, configOverrides: { maxSteps: 0 } });
  try {
    const summary = await ctx.agent.run('keep working');
    assert.equal(summary.status, 'completed');
    assert.equal(summary.steps, 26);
    assert.equal(summary.maxSteps, null);
    assert.equal(ctx.provider.calls.length, 26);
    assert.equal(summary.issues.filter((issue) => /step limit/i.test(issue)).length, 0);
    assert.equal(summary.finalText, 'Finished after many steps.');
  } finally {
    await ctx.cleanup();
  }
});

test('already-aborted tasks are cancelled without calling the provider', async () => {
  const ctx = await setup({ responses: [response({ content: 'should not happen' })] });
  const controller = new AbortController();
  controller.abort();
  try {
    const summary = await ctx.agent.run('do work', { signal: controller.signal });
    assert.equal(summary.status, 'cancelled');
    assert.equal(ctx.provider.calls.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('empty responses are retried with a heartbeat instead of failing the task', async () => {
  const ctx = await setup({
    responses: [
      response({ content: '', toolCalls: [] }),
      response({ content: '', toolCalls: [] }),
      response({ content: '', toolCalls: [] }),
      response({ content: 'Recovered final answer.' }),
    ],
    configOverrides: { recoveryBackoffMs: 100 },
  });
  try {
    const summary = await ctx.agent.run('empty then answer');
    assert.equal(summary.status, 'completed');
    assert.equal(summary.finalText, 'Recovered final answer.');
    assert.equal(ctx.provider.calls.length, 4, 'every empty turn is retried');
    assert.equal(summary.steps, 1, 'empty retries do not consume the step budget');
    assert.equal(summary.error, null, 'no EMPTY_RESPONSE fault is reported');

    const retries = ctx.renderer.events.filter(
      (event) => event.event === 'heartbeat' && event.payload.code === 'EMPTY_RESPONSE',
    );
    assert.equal(retries.length, 3);
    assert.equal(retries[0].payload.maxAttempts, 0, '0 is reported as unlimited');
    assert.match(ctx.provider.calls[3].messages.at(-1).content, /empty/i, 'the model is nudged each time');
  } finally {
    await ctx.cleanup();
  }
});

test('maxRecoveryAttempts 0 keeps reconnecting well past the old five-attempt limit', async () => {
  const failures = Array.from(
    { length: 6 },
    () => new ProviderError('Cannot reach the NVIDIA API', { code: 'PROVIDER_NETWORK', retryable: true }),
  );
  const ctx = await setup({
    responses: [...failures, response({ content: 'finally' })],
    configOverrides: { maxRecoveryAttempts: 0, recoveryBackoffMs: 100 },
  });
  // The exponential backoff is real time in production; compress it here
  // rather than making the suite wait ~6s for six reconnects.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...args) => realSetTimeout(fn, 0, ...args);
  try {
    const summary = await ctx.agent.run('survive six drops');
    assert.equal(summary.status, 'completed');
    assert.equal(summary.finalText, 'finally');
    assert.equal(ctx.provider.calls.length, 7, 'all six failures were retried');
    const retries = ctx.renderer.events.filter(
      (event) => event.event === 'heartbeat' && event.payload.phase === 'retry',
    );
    assert.equal(retries.length, 6);
    assert.equal(retries.at(-1).payload.maxAttempts, 0);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    await ctx.cleanup();
  }
});

test('provider failures are reported, not hidden', async () => {
  const ctx = await setup({
    responses: [new ProviderError('Invalid key', { code: 'AUTH_INVALID', status: 401 })],
  });
  try {
    const summary = await ctx.agent.run('do something');
    assert.equal(summary.status, 'failed');
    assert.equal(summary.error.code, 'AUTH_INVALID');
    assert.ok(ctx.renderer.events.some((event) => event.event === 'error'));
  } finally {
    await ctx.cleanup();
  }
});

test('secret files cannot be read through the agent', async () => {
  const ctx = await setup({
    responses: [
      response({ toolCalls: [toolCall('read_file', { path: '.env' }, 'call_secret')] }),
      response({ content: 'I cannot read .env files.' }),
    ],
  });
  try {
    const summary = await ctx.agent.run('read the env file');
    assert.equal(summary.status, 'completed');
    const toolMessage = ctx.provider.calls[1].messages.find((message) => message.role === 'tool');
    assert.match(toolMessage.content, /SECRET_FILE_BLOCKED/);
    assert.ok(!toolMessage.content.includes('nvapi-this-must-never-be-read'));
    assert.ok(!JSON.stringify(ctx.provider.calls).includes('nvapi-this-must-never-be-read'));
    assert.equal(summary.changedFiles.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('remembers earlier tasks so the next task keeps the conversation', async () => {
  const ctx = await setup({
    responses: [
      response({ content: 'FIRST_ANSWER_MARKER' }),
      response({ content: 'SECOND_ANSWER_MARKER' }),
      response({ content: 'THIRD_ANSWER_MARKER' }),
    ],
  });
  try {
    const first = await ctx.agent.run('ALPHA_TASK_MARKER: rename the greeting');
    assert.equal(first.status, 'completed');
    const firstRequest = JSON.stringify(ctx.provider.calls[0].messages);
    assert.ok(firstRequest.includes('ALPHA_TASK_MARKER'));
    assert.ok(!firstRequest.includes('FIRST_ANSWER_MARKER'), 'memory must start empty');
    assert.equal(ctx.agent.getConversation().length, 2, 'the first task is remembered for the next one');

    const second = await ctx.agent.run('BETA_TASK_MARKER: what did I just ask?');
    const secondRequest = JSON.stringify(ctx.provider.calls[1].messages);
    assert.ok(secondRequest.includes('ALPHA_TASK_MARKER'), 'the previous task must be remembered');
    assert.ok(secondRequest.includes('FIRST_ANSWER_MARKER'), 'the previous answer must be remembered');
    assert.ok(secondRequest.includes('BETA_TASK_MARKER'), 'the current task must still be last');
    assert.equal(ctx.agent.getConversation().length, 4);

    const saved = await ctx.sessionStore.load(second.sessionId);
    assert.ok(Array.isArray(saved.conversation));
    assert.equal(saved.conversation.length, 4, 'the conversation is persisted for /resume');
    assert.equal(saved.conversation[0].role, 'user');
    assert.equal(saved.conversation[1].role, 'assistant');

    ctx.agent.clearMemory();
    assert.deepEqual(ctx.agent.getConversation(), []);
    await ctx.agent.run('GAMMA_TASK_MARKER: fresh start');
    assert.ok(
      !JSON.stringify(ctx.provider.calls[2].messages).includes('ALPHA_TASK_MARKER'),
      '/clear must drop the remembered history',
    );
  } finally {
    await ctx.cleanup();
  }
});

test('a final answer with numbered lists is never mistaken for the plan', async () => {
  const ctx = await setup({
    responses: [
      response({ content: 'Berikut overview:\n1. Satu\n2. Dua\n3. Tiga' }),
    ],
  });
  try {
    const summary = await ctx.agent.run('overview dong');
    assert.equal(summary.status, 'completed');
    assert.equal(summary.plan, '', 'a closing answer must not become the plan');
    assert.equal(ctx.renderer.events.filter((event) => event.event === 'plan').length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('the plan is emitted before the reasoning summary of the same step', async () => {
  const ctx = await setup({
    responses: [
      (request) => {
        request.onReasoning?.('thinking about the steps');
        return response({
          content: '1. Inspect\n2. Fix',
          toolCalls: [toolCall('read_file', { path: 'src/app.js' })],
        });
      },
      response({ content: 'done' }),
    ],
  });
  try {
    await ctx.agent.run('fix it');
    const kinds = ctx.renderer.events.map((event) => event.event);
    assert.ok(kinds.includes('plan'));
    assert.ok(kinds.includes('reasoningEnd'));
    assert.ok(
      kinds.indexOf('plan') < kinds.indexOf('reasoningEnd'),
      'the plan must lead the step; the reasoning summary follows',
    );
  } finally {
    await ctx.cleanup();
  }
});

test('streams the final answer to the renderer while it is being written', async () => {
  const ctx = await setup({
    responses: [
      (request) => {
        request.onContent?.('Partial ');
        request.onContent?.('answer text');
        return response({ content: 'Partial answer text' });
      },
    ],
  });
  try {
    const summary = await ctx.agent.run('give me an answer');
    assert.equal(summary.status, 'completed');
    assert.equal(summary.finalText, 'Partial answer text');
    const deltas = ctx.renderer.events.filter((event) => event.event === 'contentDelta');
    assert.deepEqual(deltas.map((event) => event.payload.text), ['Partial ', 'answer text']);
  } finally {
    await ctx.cleanup();
  }
});

test('a truncated tool call is repaired, executed, and never poisons the next request', async () => {
  const ctx = await setup({
    responses: [
      response({ toolCalls: [toolCall('read_file', '{"path":"src/app.js"')] }),
      response({ content: 'Read the file after repairing the payload.' }),
    ],
  });
  try {
    const summary = await ctx.agent.run('read the app file');
    assert.equal(summary.status, 'completed');

    // The repaired call really ran.
    const toolMessage = ctx.provider.calls[1].messages.find((message) => message.role === 'tool');
    assert.match(toolMessage.content, /export function hello/);

    // The stored history carries a valid JSON object string, so the provider
    // cannot reject the next request with a 400.
    const assistant = ctx.provider.calls[1].messages.find((message) => message.role === 'assistant' && message.tool_calls);
    assert.equal(typeof assistant.tool_calls[0].function.arguments, 'string');
    assert.doesNotThrow(() => JSON.parse(assistant.tool_calls[0].function.arguments));
    assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { path: 'src/app.js' });

    const heartbeats = ctx.renderer.events.filter((event) => event.event === 'heartbeat');
    assert.ok(heartbeats.some((event) => event.payload.code === 'ARGUMENTS_REPAIRED'), 'the repair must be visible');
  } finally {
    await ctx.cleanup();
  }
});

test('unrecoverable tool arguments fail the step but keep the conversation valid', async () => {
  const ctx = await setup({
    responses: [
      response({ toolCalls: [toolCall('read_file', '{not valid json')] }),
      response({ content: 'Recovered from invalid tool calls.' }),
    ],
  });
  try {
    const summary = await ctx.agent.run('try bad calls');
    assert.equal(summary.status, 'completed');

    const assistant = ctx.provider.calls[1].messages.find((message) => message.role === 'assistant' && message.tool_calls);
    assert.doesNotThrow(() => JSON.parse(assistant.tool_calls[0].function.arguments));

    const toolMessage = ctx.provider.calls[1].messages.find((message) => message.role === 'tool');
    assert.match(toolMessage.content, /INVALID_ARGUMENTS/);
    assert.ok(
      ctx.renderer.events.some((event) => event.event === 'heartbeat' && event.payload.phase === 'degraded'),
      'a broken response must produce a heartbeat',
    );
  } finally {
    await ctx.cleanup();
  }
});

test('a dropped provider link is reconnected with a heartbeat and the task continues', async () => {
  const ctx = await setup({
    responses: [
      new ProviderError('Cannot reach the NVIDIA API', { code: 'PROVIDER_NETWORK', retryable: true }),
      response({ content: 'Reconnected and finished.' }),
    ],
    configOverrides: { maxRecoveryAttempts: 3, recoveryBackoffMs: 100 },
  });
  try {
    const summary = await ctx.agent.run('survive a network blip');
    assert.equal(summary.status, 'completed');
    assert.equal(summary.finalText, 'Reconnected and finished.');
    assert.equal(ctx.provider.calls.length, 2, 'the request must be replayed');

    const heartbeats = ctx.renderer.events.filter((event) => event.event === 'heartbeat');
    const retry = heartbeats.find((event) => event.payload.phase === 'retry');
    assert.ok(retry, 'a retry heartbeat must be emitted');
    assert.equal(retry.payload.attempt, 1);
    assert.equal(retry.payload.code, 'PROVIDER_NETWORK');
    assert.ok(heartbeats.some((event) => event.payload.phase === 'restored'), 'a restored heartbeat must be emitted');
  } finally {
    await ctx.cleanup();
  }
});

test('a provider failure that cannot be recovered is reported instead of retried forever', async () => {
  const ctx = await setup({
    responses: [new ProviderError('Invalid key', { code: 'AUTH_INVALID', status: 401 })],
    configOverrides: { maxRecoveryAttempts: 3, recoveryBackoffMs: 100 },
  });
  try {
    const summary = await ctx.agent.run('do something');
    assert.equal(summary.status, 'failed');
    assert.equal(summary.error.code, 'AUTH_INVALID');
    assert.equal(ctx.provider.calls.length, 1, 'a fatal error must not be retried');
  } finally {
    await ctx.cleanup();
  }
});

test('an identical failing command is blocked instead of being repeated forever', async () => {
  const argv = ['grep', '-rn', 'zzz_no_match_zzz', 'src'];
  const ctx = await setup({
    responses: [
      response({ toolCalls: [toolCall('run_command', { argv })] }),
      response({ toolCalls: [toolCall('run_command', { argv })] }),
      response({ toolCalls: [toolCall('run_command', { argv })] }),
      response({ content: 'No match exists; the pattern does not occur in src.' }),
    ],
    approvalPolicy: 'ask',
    confirm: async () => true,
    interactive: true,
  });
  try {
    const summary = await ctx.agent.run('find the pattern');
    assert.equal(summary.status, 'completed');
    assert.equal(summary.commands.length, 2, 'the third identical call must not run again');

    const toolMessages = ctx.provider.calls[3].messages.filter((message) => message.role === 'tool');
    const blocked = toolMessages.find((message) => /REPEATED_FAILURE/.test(message.content));
    assert.ok(blocked, 'the loop must be reported to the model');
    assert.match(blocked.content, /change the tool/);
  } finally {
    await ctx.cleanup();
  }
});

test('the system prompt tells the model which tools and project commands exist', async () => {
  const ctx = await setup({ responses: [response({ content: 'ok' })] });
  try {
    await ctx.agent.run('what can you do');
    const prompt = ctx.provider.calls[0].messages[0].content;
    assert.match(prompt, /TOOL CATALOG/);
    assert.match(prompt, /read_file\(/);
    assert.match(prompt, /run_command\(/);
    assert.match(prompt, /search_files\(/);
    assert.match(prompt, /ARGUMENT RULES/);
    assert.match(prompt, /HEARTBEAT AND RECOVERY/, 'recovery guidance must stay in the prompt');
    assert.match(prompt, /npm run test/, 'the project scripts must be listed');
  } finally {
    await ctx.cleanup();
  }
});

test('a file already read and unchanged is not read again in the same task', async () => {
  const ctx = await setup({
    responses: [
      response({ toolCalls: [toolCall('read_file', { path: 'src/app.js' })] }),
      response({ toolCalls: [toolCall('read_file', { path: 'src/app.js' })] }),
      response({ content: 'Used the content I already had.' }),
    ],
  });
  try {
    const summary = await ctx.agent.run('read the same file twice');
    assert.equal(summary.status, 'completed');
    assert.equal(summary.metrics.cachedReads, 1, 'the second read must be served from the worklog');

    const toolMessages = ctx.provider.calls[2].messages.filter((message) => message.role === 'tool');
    assert.match(toolMessages.at(-1).content, /"cached":true/);
    assert.ok(
      ctx.renderer.events.some((event) => event.event === 'toolEnd' && event.payload.cached === true),
      'the cache hit must be visible in the activity feed',
    );
    assert.ok(
      ctx.renderer.events.every((event) => event.event !== 'toolStart' || event.payload.name !== 'read_file' || event.payload.index === 1),
      'only the first read of the file runs as a real tool call',
    );
  } finally {
    await ctx.cleanup();
  }
});

test('the verified worklog carries across tasks so a follow-up does not restart', async () => {
  const ctx = await setup({
    responses: [
      response({ toolCalls: [toolCall('read_file', { path: 'src/app.js' })] }),
      response({ content: 'FIRST_TASK_DONE' }),
      response({ toolCalls: [toolCall('read_file', { path: 'src/app.js' })] }),
      response({ content: 'SECOND_TASK_DONE' }),
    ],
  });
  try {
    await ctx.agent.run('FIRST_TASK_MARKER: inspect the greeting');
    const secondSummary = await ctx.agent.run('SECOND_TASK_MARKER: continue from there');

    // The provider records the live message array, so find the brief by content.
    const secondRequest = ctx.provider.calls[2].messages;
    const brief = secondRequest.find((message) => message.role === 'user' && String(message.content).includes('TASK BRIEF'))?.content || '';
    assert.match(brief, /TASK BRIEF/);
    assert.match(brief, /SECOND_TASK_MARKER/);
    assert.match(brief, /SESSION WORKLOG/);
    assert.match(brief, /src\/app\.js/, 'the worklog must name the file that was already read');
    assert.match(brief, /BUDGET/);
    assert.equal(secondSummary.metrics.cachedReads, 1, 'the follow-up read must be skipped');

    // The prompt is assembled once per session: both tasks send the same bytes.
    assert.equal(
      ctx.provider.calls[0].messages[0].content,
      ctx.provider.calls[2].messages[0].content,
      'the session prompt must be stable across tasks and steps',
    );
  } finally {
    await ctx.cleanup();
  }
});

test('a file change is reported to the UI with the exact diff lines', async () => {
  const ctx = await setup({
    responses: [
      response({ toolCalls: [toolCall('edit_file', { path: 'src/app.js', old_text: 'hello ${name}', new_text: 'hi ${name}' })] }),
      response({ content: 'done' }),
    ],
  });
  try {
    await ctx.agent.run('change the greeting');
    const diff = ctx.renderer.events.find((event) => event.event === 'fileDiff');
    assert.ok(diff, 'an edit must emit a fileDiff event');
    assert.equal(diff.payload.path, 'src/app.js');
    assert.equal(diff.payload.kind, 'edit');
    assert.equal(diff.payload.added, 1);
    assert.equal(diff.payload.removed, 1);
    assert.match(diff.payload.diff, /-.*hello \$\{name\}/);
    assert.match(diff.payload.diff, /\+.*hi \$\{name\}/);
  } finally {
    await ctx.cleanup();
  }
});

test('a write is reported with a full-file diff', async () => {
  const ctx = await setup({
    responses: [
      response({ toolCalls: [toolCall('create_file', { path: 'src/extra.js', content: 'export const x = 1;\nexport const y = 2;\n' })] }),
      response({ content: 'created' }),
    ],
  });
  try {
    await ctx.agent.run('add a file');
    const diff = ctx.renderer.events.find((event) => event.event === 'fileDiff');
    assert.ok(diff);
    assert.equal(diff.payload.kind, 'create');
    assert.equal(diff.payload.path, 'src/extra.js');
    assert.equal(diff.payload.added, 2);
  } finally {
    await ctx.cleanup();
  }
});

test('a response cut off at the token cap is never executed as a write', async () => {
  const ctx = await setup({
    responses: [
      { ...response({ toolCalls: [toolCall('create_file', { path: 'src/half.js', content: 'export const half = ' })] }), finishReason: 'length' },
      response({ content: 'The write was not applied because the response was truncated.' }),
    ],
  });
  try {
    const summary = await ctx.agent.run('write a big file');
    assert.equal(summary.status, 'completed');
    await assert.rejects(() => ctx.fixture.workspace.readText('src/half.js'), /not found|NOT_FOUND/i);
    assert.equal(summary.changedFiles.length, 0);
    const toolMessage = ctx.provider.calls[1].messages.find((message) => message.role === 'tool');
    assert.match(toolMessage.content, /TRUNCATED_RESPONSE/);
    assert.ok(summary.issues.some((issue) => /cut off/i.test(issue)));
  } finally {
    await ctx.cleanup();
  }
});

test('a response cut off before its tool call never ends the task as completed', async () => {
  const ctx = await setup({
    responses: [
      {
        ...response({
          content:
            'The boot.node works perfectly. Now let me build the clean launcher.js. I will base it on the proven pattern and write the whole file in one go.',
        }),
        finishReason: 'length',
      },
      { ...response({ content: 'Still cut off while writing the tool call.' }), finishReason: 'length' },
      response({ content: 'Wrote src/launcher.js with the smaller edit and verified it.' }),
    ],
  });
  try {
    const summary = await ctx.agent.run('build the launcher');
    assert.equal(summary.status, 'completed');
    assert.equal(ctx.provider.calls.length, 3, 'both truncated responses are re-asked');

    // The model is told that nothing ran, and that the next call must be smaller.
    // Every recorded request shares the live message array, so the assertions
    // read the final conversation instead of a per-call snapshot.
    const turns = ctx.provider.calls.at(-1).messages;
    const userNudges = turns.filter((message) => message.role === 'user').map((message) => String(message.content));
    assert.ok(
      userNudges.some((text) => /cut off at the output-token limit/i.test(text) && /smaller tool call/i.test(text)),
      'the first retry explains that nothing ran and asks for a smaller call',
    );
    assert.ok(userNudges.some((text) => /output-token cap/i.test(text)), 'the second retry is rotated wording');
    // Its own partial answer stays in the history so it resumes instead of restarting.
    assert.ok(
      turns.some(
        (message) => message.role === 'assistant' && /clean launcher\.js/.test(String(message.content || '')),
      ),
      'the cut-off text is kept in history',
    );
    const truncationRetries = ctx.renderer.events.filter(
      (event) => event.event === 'heartbeat' && event.payload.code === 'TRUNCATED_RESPONSE',
    );
    assert.equal(truncationRetries.length, 2, 'each cut-off response is visible as a heartbeat');
    assert.ok(summary.issues.some((issue) => /cut off/i.test(issue)));
  } finally {
    await ctx.cleanup();
  }
});

test('repeated truncation stops the task as truncated instead of faking completion', async () => {
  const responses = Array.from({ length: 4 }, (_, index) => ({
    ...response({ content: `Answer attempt ${index} that never reaches a tool call.` }),
    finishReason: 'length',
  }));
  const ctx = await setup({ responses });
  try {
    const summary = await ctx.agent.run('write a very large file');
    assert.equal(summary.status, 'truncated');
    assert.notEqual(summary.status, 'completed');
    assert.equal(summary.changedFiles.length, 0);
    assert.equal(ctx.provider.calls.length, 4, 'the retry budget is bounded');
    assert.ok(summary.issues.some((issue) => /output-token cap/i.test(issue)));
    assert.match(summary.finalText, /stopped instead of being reported as complete/i);
  } finally {
    await ctx.cleanup();
  }
});

test('per-request telemetry reaches the renderer: first token, usage and latency', async () => {
  const ctx = await setup({
    responses: [
      (request) => {
        request.onFirstToken?.({ latencyMs: 12 });
        return response({ content: 'ok', usage: { prompt: 21, completion: 7, total: 28 } });
      },
    ],
  });
  try {
    const summary = await ctx.agent.run('say ok');
    const ended = ctx.renderer.events.find((event) => event.event === 'thinkingEnd');
    assert.equal(ended.payload.firstTokenMs, 12);
    assert.equal(ended.payload.usage.prompt, 21);
    assert.equal(ended.payload.finishReason, 'stop');
    assert.ok(ctx.renderer.events.some((event) => event.event === 'progress' && event.payload.firstTokenMs === 12));
    assert.equal(summary.metrics.firstTokenMs, 12);
    assert.equal(summary.metrics.modelCalls, 1);
    assert.equal(summary.metrics.avgRequestMs >= 0, true);
  } finally {
    await ctx.cleanup();
  }
});

test('the saved session records duration, metrics and the worklog for /resume', async () => {
  const ctx = await setup({
    responses: [
      response({ toolCalls: [toolCall('read_file', { path: 'src/app.js' })] }),
      response({ content: 'done' }),
    ],
  });
  try {
    const summary = await ctx.agent.run('inspect and finish');
    const saved = await ctx.sessionStore.load(summary.sessionId);
    assert.ok(saved.durationMs >= 0, 'the session must store its duration');
    assert.equal(saved.modelCalls, 2);
    assert.ok(saved.worklog && saved.worklog.files.some((file) => file.path === 'src/app.js'));
  } finally {
    await ctx.cleanup();
  }
});

test('compaction mid-task keeps the session prompt and the task valid', async () => {
  const ctx = await setup({
    responses: [
      response({ toolCalls: [toolCall('read_file', { path: 'big1.txt' })] }),
      response({ toolCalls: [toolCall('read_file', { path: 'big2.txt' })] }),
      response({ toolCalls: [toolCall('read_file', { path: 'big3.txt' })] }),
      response({ content: 'Finished after compaction.' }),
    ],
    configOverrides: { maxContextChars: 8000 },
  });
  try {
    for (const name of ['big1.txt', 'big2.txt', 'big3.txt']) {
      await ctx.fixture.workspace.createText(name, `${'x'.repeat(7000)}\n`);
    }
    const summary = await ctx.agent.run('read three big files');
    assert.equal(summary.status, 'completed');
    assert.ok(
      ctx.renderer.events.some((event) => event.event === 'warning' && /Context compacted/.test(event.payload.message)),
      'the run must actually have compacted',
    );
    assert.ok(
      ctx.provider.calls.every((call) => /OPERATING CONTRACT/.test(call.messages[0].content)),
      'the session prompt survives compaction on every request',
    );
  } finally {
    await ctx.cleanup();
  }
});
