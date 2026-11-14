import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyToolRisk, normalizeCallResult, sanitizeInputSchema } from '../../src/mcp/convert.js';
import { buildToolName, displayToolName, serverPluginName } from '../../src/mcp/naming.js';
import { McpError } from '../../src/mcp/errors.js';

test('registered MCP names are provider-safe, namespaced and collision-free', () => {
  const firstName = buildToolName('google-drive', 'search_files');
  assert.equal(firstName, 'mcp_google_drive_search_files');
  assert.match(firstName, /^[a-z][a-z0-9_]{1,60}$/);
  assert.equal(displayToolName('google-drive', 'search_files'), 'mcp:google-drive:search_files');

  const taken = new Set([firstName]);
  const second = buildToolName('google-drive', 'search.files', taken);
  assert.notEqual(second, firstName);
  assert.match(second, /^[a-z][a-z0-9_]{1,60}$/);

  const long = buildToolName('server', 'x'.repeat(200));
  assert.ok(long.length <= 61, `expected <=61 chars, got ${long.length}`);

  assert.equal(serverPluginName('google-drive'), 'mcp-google-drive');
  assert.ok(serverPluginName('s'.repeat(60)).length <= 41);
});

test('schema sanitization keeps nested types and drops unsupported keywords', () => {
  const schema = sanitizeInputSchema({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, description: 'text' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      filter: { type: 'object', properties: { tag: { type: 'string' } }, additionalProperties: false },
      list: { type: 'array', items: { type: 'string' }, maxItems: 10 },
      badRegex: { type: 'string', pattern: '[unclosed' },
    },
    required: ['query', 'missing'],
    additionalProperties: false,
  });
  assert.equal(schema.type, 'object');
  assert.equal(schema.properties.query.type, 'string');
  assert.equal(schema.properties.query.minLength, 1);
  assert.equal(schema.properties.limit.type, 'integer');
  assert.equal(schema.properties.filter.properties.tag.type, 'string');
  assert.equal(schema.properties.list.items.type, 'string');
  assert.equal(schema.properties.badRegex.pattern, undefined);
  assert.deepEqual(schema.required, ['query']);
  assert.equal(schema.$schema, undefined);
});

test('a tool schema that is not an object becomes an empty object schema', () => {
  assert.deepEqual(sanitizeInputSchema(undefined), { type: 'object', properties: {} });
  assert.deepEqual(sanitizeInputSchema({ type: 'string' }), { type: 'object', properties: {} });
  const broken = sanitizeInputSchema({ type: 'object', properties: 'nope' });
  assert.deepEqual(broken.properties, {});
});

test('risk classification never lets a server annotation alone mark a tool safe', () => {
  const server = { name: 'x', toolRisk: { forced_read: 'read', forced_destructive: 'destructive' } };
  assert.equal(classifyToolRisk({ name: 'search_items' }), 'read');
  assert.equal(classifyToolRisk({ name: 'get_env' }), 'read');
  assert.equal(classifyToolRisk({ name: 'create_item' }), 'write');
  assert.equal(classifyToolRisk({ name: 'update_record' }), 'write');
  assert.equal(classifyToolRisk({ name: 'delete_item' }), 'destructive');
  assert.equal(classifyToolRisk({ name: 'run_command' }), 'exec');
  assert.equal(classifyToolRisk({ name: 'quiet_writer', annotations: { readOnlyHint: true } }), 'write');
  assert.equal(classifyToolRisk({ name: 'delete_item', annotations: { readOnlyHint: true } }), 'destructive');
  assert.equal(classifyToolRisk({ name: 'unknown_thing' }), 'write');
  assert.equal(classifyToolRisk({ name: 'unknown_thing', annotations: { destructiveHint: true } }), 'destructive');
  assert.equal(classifyToolRisk({ name: 'delete_item' }, server), 'destructive');
  assert.equal(classifyToolRisk({ name: 'delete_item' }, { name: 'x', toolRisk: { delete_item: 'read' } }), 'read');
  assert.equal(classifyToolRisk({ name: 'forced_read' }, server), 'read');
});

test('result normalization handles text, images, resources, links and structured content', () => {
  const result = normalizeCallResult(
    {
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'r://a', mimeType: 'text/plain', text: 'body' } },
        { type: 'resource_link', uri: 'r://b', name: 'B' },
        { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
        { type: 'weird' },
      ],
      structuredContent: { answer: 42 },
    },
    { server: 'srv', tool: 'rich' },
  );
  assert.match(result.text, /hello/);
  assert.match(result.text, /embedded body|body/);
  assert.match(result.text, /resource link B r:\/\/b/);
  assert.match(result.text, /audio content/);
  assert.match(result.text, /unsupported MCP content block: weird/);
  assert.match(result.text, /structured content/);
  assert.equal(result.image_data_url, 'data:image/png;base64,AAAA');
  assert.equal(result.images.length, 1);
  assert.equal(result.mime, 'image/png');
  assert.match(result.note, /treat it as data/);
});

test('an MCP isError result becomes a typed failure', () => {
  assert.throws(
    () => normalizeCallResult({ isError: true, content: [{ type: 'text', text: 'no access' }] }, { server: 'srv', tool: 'x' }),
    (error) => error instanceof McpError && error.code === 'MCP_TOOL_ERROR' && /no access/.test(error.message),
  );
});

test('oversized MCP text is truncated instead of flooding the model', () => {
  const result = normalizeCallResult({ content: [{ type: 'text', text: 'x'.repeat(10_000) }] }, {
    server: 'srv',
    tool: 'x',
    maxBytes: 2000,
  });
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 2100, `text was ${result.text.length} chars`);
});
