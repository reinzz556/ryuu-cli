/**
 * Network guards for URLs supplied by the model or found on a web page.
 *
 * `read_url` and MCP extraction must not become a way to reach the machine's
 * loopback services, the LAN, or cloud metadata endpoints. The guards reject
 * obvious names and private IP literals everywhere, and additionally resolve
 * DNS before a real local fetch. DNS rebinding is not fully solved by a
 * pre-check, but combined with re-checking every redirect it closes the common
 * paths without a custom HTTP agent.
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import { FetchError } from './errors.js';

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'instance-data.ec2.internal',
]);

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

function blocked(message) {
  return new FetchError(message, { code: 'READ_URL_BLOCKED' });
}

/** True for IPv4/IPv6 addresses that are loopback, private, link-local or metadata. */
export function isPrivateAddress(address) {
  const value = String(address || '').trim().toLowerCase();
  if (!value) return true;
  if (net.isIPv4(value)) {
    const [a, b] = value.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 169 && b === 254) return true; // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51) return true;
    if (a === 203 && b === 0) return true;
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (net.isIPv6(value)) {
    if (value === '::' || value === '::1') return true;
    if (value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')) return true;
    if (/^f[cd]/.test(value)) return true; // unique local
    if (/^ff/.test(value)) return true; // multicast
    if (value.startsWith('2001:db8')) return true;
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

/** Reject hostnames that are local by name (before any DNS lookup). */
export function isBlockedHostname(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  // Single-label names are resolved through local search domains.
  if (!host.includes('.') && !net.isIP(host)) return true;
  return false;
}

/**
 * Throw READ_URL_BLOCKED when a URL targets a local/private destination.
 * @param {URL|string} input
 * @param {object} [options]
 * @param {boolean} [options.resolve] also resolve DNS and inspect every address
 */
export async function assertPublicUrl(input, { resolve = false } = {}) {
  let url;
  try {
    url = input instanceof URL ? input : new URL(String(input));
  } catch {
    throw blocked('The URL is not valid.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw blocked(`Only http(s) URLs are allowed (received ${url.protocol}).`);
  }
  if (url.username || url.password) {
    throw blocked('URLs with embedded credentials are refused.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedHostname(host)) {
    throw blocked(`Refusing to fetch a local or internal host: ${host}`);
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw blocked(`Refusing to fetch a private address: ${host}`);
    return;
  }
  if (!resolve) return;
  let records;
  let timer;
  try {
    records = await Promise.race([
      dns.lookup(host, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new FetchError(`DNS lookup for ${host} timed out.`, {
            code: 'READ_URL_TIMEOUT',
            retryable: true,
          }));
        }, 5000);
        if (timer.unref) timer.unref();
      }),
    ]);
  } catch (error) {
    if (error instanceof FetchError) throw error;
    throw new FetchError(`Cannot resolve ${host}: ${error.message}`, {
      code: 'READ_URL_NETWORK',
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }
  for (const record of Array.isArray(records) ? records : []) {
    if (isPrivateAddress(record.address)) {
      throw blocked(`Refusing to fetch ${host}: it resolves to a private address (${record.address}).`);
    }
  }
}
