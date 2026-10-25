import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createApp } from '../../src/cli/app.js';
import { ProviderError } from '../../src/utils/errors.js';
import { createTestWorkspace, response, testConfig, toolCall } from '../helpers.js';

function captureStream() {
  let data = '';
  const stream = new Writable({
    write(chunk, encoding, callback) {
      data += chunk.toString();
      callback();
    },
  });
  stream.isTTY = false;
  stream.getData = () => data;
  return stream;
}

function fakeInput() {
  const stream = new Writable({
    write(chunk, encoding, callback) {
      callback();
    },
  });
  stream.isTTY = false;
  return stream;
}

/**
 * A provider that behaves like the real NVIDIA endpoint: it validates every
 * tool call in the conversation and rejects the whole request with a 400 when
 * one payload is not a valid JSON object string.
 *
 * This is the failure from the production log:
 *   `messages[17].tool_calls[1].function.arguments` must be a valid JSON
 *    object string: EOF while parsing a value
 */
class StrictNvidiaProvider {
  constructor(responses) {
    this.responses = [...responses];
    this.requests = [];
    this.rejections = [];
    this.config = { model: 'test/model' };
  }

  async chat(request) {
    request.messages.forEach((message, index) => {
      for (const call of message.tool_calls || []) {
        const args = call.function?.arguments;
        let parsed = null;
        try {
          parsed = JSON.parse(args);
        } catch (error) {
          parsed = null;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          this.rejections.push({ index, args });
          throw new ProviderError(
            `NVIDIA API rejected the request (400). 400 Validation: \`messages[${index}].tool_calls[0].function.arguments\` must be a valid JSON object string`,
            { code: 'BAD_REQUEST', status: 400 },
          );
        }
      }
    });
    this.requests.push(request);
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(request);
    return next;
  }
}

async function setup({ responses, configOverrides = {} }) {
  const fixture = await createTestWorkspace();
  const config = testConfig(fixture.root, { approvalPolicy: 'ask', ...configOverrides });
  const provider = new StrictNvidiaProvider(responses);
  const stdout = captureStream();
  const stderr = captureStream();
  const app = await createApp({
    config,
    cliOptions: { interactive: false, plain: true, autoApprove: true },
    stdout,
    stderr,
    input: fakeInput(),
    provider,
    version: '0.1.0',
  });
  return {
    fixture,
    config,
    provider,
    stdout,
    app,
    async cleanup() {
      await app.close();
      await fixture.cleanup();
    },
  };
}

test('a truncated tool call never triggers the 400 that killed the run', async () => {
  const argv = ['grep', '-rn', 'reply(undefined)', 'plugins', 'lib', 'config', 'tools', 'engines'];
  const ctx = await setup({
    responses: [
      // Exactly the shape from the log: the payload stops mid-array.
      response({ toolCalls: [toolCall('run_command', '{"argv":["grep","-rn","reply(undefined)","plugins","lib","config","tools","engines",', 'call_1')] }),
      response({ content: 'No match for reply(undefined) in the scanned folders.' }),
    ],
  });
  try {
    const summary = await ctx.app.runTask('cari pola reply(undefined)');
    assert.equal(summary.status, 'completed');
    assert.equal(summary.error, null);
    assert.deepEqual(ctx.provider.rejections, [], 'no request may be rejected with a 400');
    assert.equal(ctx.provider.requests.length, 2, 'the run continued after the broken payload');

    // The command really ran with the repaired arguments.
    assert.equal(summary.commands.length, 1);
    assert.deepEqual(summary.commands[0].argv, argv);

    // Every stored tool call is a valid JSON object string.
    for (const request of ctx.provider.requests) {
      for (const message of request.messages) {
        for (const call of message.tool_calls || []) {
          assert.doesNotThrow(() => JSON.parse(call.function.arguments));
        }
      }
    }
  } finally {
    await ctx.cleanup();
  }
});

test('unrecoverable arguments are reported to the model and the run survives', async () => {
  const ctx = await setup({
    responses: [
      response({ toolCalls: [toolCall('read_file', '{not valid json', 'call_bad')] }),
      response({ content: 'Recovered from the broken payload.' }),
    ],
  });
  try {
    const summary = await ctx.app.runTask('baca file');
    assert.equal(summary.status, 'completed');
    assert.deepEqual(ctx.provider.rejections, []);
    const toolMessage = ctx.provider.requests[1].messages.find((message) => message.role === 'tool');
    assert.match(toolMessage.content, /INVALID_ARGUMENTS/);
  } finally {
    await ctx.cleanup();
  }
});

test('a dropped link is reconnected and the task still finishes', async () => {
  const ctx = await setup({
    responses: [
      new ProviderError('Cannot reach the NVIDIA API (ENOTFOUND)', { code: 'PROVIDER_NETWORK', retryable: true }),
      response({ content: 'Reconnected and done.' }),
    ],
    configOverrides: { maxRecoveryAttempts: 3, recoveryBackoffMs: 100 },
  });
  try {
    const summary = await ctx.app.runTask('jalankan tugas');
    assert.equal(summary.status, 'completed');
    assert.equal(summary.finalText, 'Reconnected and done.');
    assert.match(ctx.stdout.getData(), /heartbeat/i, 'the user must see a heartbeat while reconnecting');
  } finally {
    await ctx.cleanup();
  }
});
