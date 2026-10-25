import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, isBlockedHostname, isPrivateAddress } from '../../src/utils/network.js';
import { createUrlTools } from '../../src/tools/url.js';
import { ToolRegistry } from '../../src/tools/registry.js';

test('private, loopback, link-local and metadata addresses are recognized', () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
});

test('local names and single-label hosts are refused; public URLs pass', async () => {
  for (const host of ['localhost', 'api.localhost', 'printer.local', 'metadata.google.internal', 'intranet']) {
    assert.equal(isBlockedHostname(host), true, host);
  }
  assert.equal(isBlockedHostname('example.com'), false);
  await assertPublicUrl('https://example.com/docs');
  for (const url of [
    'http://127.0.0.1:8080/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://localhost/',
    'https://user:pass@example.com/',
    'file:///etc/passwd',
  ]) {
    await assert.rejects(assertPublicUrl(url), (error) => error.code === 'READ_URL_BLOCKED', url);
  }
});

test('read_url refuses a private URL before any request is made', async () => {
  let calls = 0;
  const registry = new ToolRegistry();
  registry.register(createUrlTools({ fetch: async () => { calls += 1; return new Response('ok', { status: 200 }); } })[0]);
  await assert.rejects(
    registry.execute('read_url', { url: 'http://127.0.0.1:8080/admin' }),
    (error) => error.code === 'READ_URL_BLOCKED',
  );
  assert.equal(calls, 0);
});

test('a redirect to a cloud metadata address is blocked at the next hop', async () => {
  let calls = 0;
  const registry = new ToolRegistry();
  registry.register(
    createUrlTools({
      fetch: async () => {
        calls += 1;
        return new Response('', { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } });
      },
    })[0],
  );
  await assert.rejects(
    registry.execute('read_url', { url: 'https://example.com/start' }),
    (error) => error.code === 'READ_URL_BLOCKED',
  );
  assert.equal(calls, 1);
});
