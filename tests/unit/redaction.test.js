import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor, redact, redactDeep } from '../../src/utils/redaction.js';

test('redacts NVIDIA keys and generic tokens', () => {
  const key = 'nvapi-abcdef1234567890';
  const text = redact(`key=${key} and Authorization: Bearer abcdefghijklmnop`);
  assert.ok(!text.includes(key));
  assert.match(text, /\[REDACTED:nvidia-key\]/);
  assert.match(text, /Bearer \[REDACTED\]/);
});

test('redacts key-value secrets and private keys', () => {
  const text = redact('api_key: "supersecretvalue"\npassword=hunter2\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----');
  assert.ok(!text.includes('supersecretvalue'));
  assert.ok(!text.includes('hunter2'));
  assert.ok(text.includes('BEGIN RSA PRIVATE KEY'));
  assert.match(text, /REDACTED/);
});

test('createRedactor removes exact configured secrets of any shape', () => {
  const redactor = createRedactor(['my-custom-secret-value']);
  assert.equal(redactor('token is my-custom-secret-value!'), 'token is [REDACTED]!');
  assert.equal(redactor(null), null);
});

test('redactDeep handles nested objects and cycles', () => {
  const value = { apiKey: 'nvapi-secret123456', nested: { token: 'abc', note: 'Bearer abcdefghijkl' } };
  value.self = value;
  const cleaned = redactDeep(value);
  assert.equal(cleaned.apiKey, '[REDACTED]');
  assert.equal(cleaned.self, '[Circular]');
  assert.ok(!JSON.stringify(cleaned).includes('nvapi-secret123456'));
});
