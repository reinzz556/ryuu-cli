import { VercelPluginError, VERCEL_CODES } from './errors.js';
import { VERCEL_BACKEND_URL } from './config.js';

/**
 * Klien backend integrasi Vercel.
 *
 * Backend adalah satu-satunya pemegang Client Secret dan access token Vercel.
 * CLI hanya memegang `cliToken` (per akun/configuration) yang dikirim sebagai
 * Bearer pada endpoint terautentikasi.
 */
export const VERCEL_API_PREFIX = '/integrations/vercel';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class VercelBackendClient {
  constructor({
    baseUrl = VERCEL_BACKEND_URL,
    getToken = () => null,
    fetchImpl = null,
    logger = null,
    timeoutMs = 25_000,
  } = {}) {
    this.baseUrl = String(baseUrl || VERCEL_BACKEND_URL).replace(/\/+$/, '');
    this.getToken = getToken;
    this.fetchImpl = fetchImpl || fetch;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
  }

  endpoint(path) {
    return `${this.baseUrl}${VERCEL_API_PREFIX}${path}`;
  }

  async request(path, { method = 'GET', body = undefined, auth = true, headers = {}, timeoutMs = null } = {}) {
    const token = auth ? this.getToken() : null;
    if (auth && !token) {
      throw new VercelPluginError('Belum login ke Vercel. Jalankan /vercel login.', {
        code: VERCEL_CODES.UNAUTHORIZED,
        status: 401,
        reconnect: true,
      });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || this.timeoutMs);
    timer.unref?.();
    let response;
    try {
      response = await this.fetchImpl(this.endpoint(path), {
        method,
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      throw new VercelPluginError(
        typeof error?.code === 'string' && error.code.startsWith('E')
          ? 'Tidak dapat menghubungi backend integrasi Vercel (masalah jaringan).'
          : 'Backend integrasi Vercel tidak merespons. Coba lagi.',
        {
          code: VERCEL_CODES.BACKEND_UNREACHABLE,
          status: 0,
          retryable: true,
          details: error instanceof Error ? error.message : null,
        },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    const result = parsed && typeof parsed === 'object' && 'result' in parsed ? parsed.result : parsed;
    if (!response.ok || parsed?.success === false) {
      const message =
        (result && typeof result === 'object' && (result.message || result.error)) ||
        (typeof result === 'string' ? result : '') ||
        `Backend menjawab HTTP ${response.status}`;
      throw new VercelPluginError(message, {
        code:
          (result && typeof result === 'object' && result.code) ||
          (response.status === 429 ? VERCEL_CODES.RATE_LIMIT : VERCEL_CODES.BACKEND),
        status: response.status,
        retryable: RETRYABLE_STATUS.has(response.status),
        reconnect: Boolean(result && typeof result === 'object' && result.reconnect),
        details: result && typeof result === 'object' ? result.details || result.missing || null : null,
      });
    }
    return { result: result ?? {}, headers: response.headers, status: response.status };
  }

  async startSession({ label = null } = {}) {
    const { result } = await this.request('/connect', {
      method: 'POST',
      auth: false,
      body: { ...(label ? { label } : {}) },
    });
    if (!result.sessionId || !result.pairingSecret || !result.url) {
      throw new VercelPluginError('Backend tidak mengembalikan sesi login yang valid.', {
        code: VERCEL_CODES.SESSION,
        status: 502,
      });
    }
    return result;
  }

  async pollSession({ sessionId, pairingSecret }) {
    const { result } = await this.request(`/session/${encodeURIComponent(sessionId)}`, {
      auth: false,
      headers: { 'x-ryuu-pairing': pairingSecret },
      timeoutMs: 15_000,
    });
    return result;
  }

  async status() {
    return (await this.request('/status')).result;
  }

  async account() {
    return (await this.request('/account')).result;
  }

  async configurations() {
    return (await this.request('/configurations')).result;
  }

  async test() {
    return (await this.request('/test', { method: 'POST' })).result;
  }

  async disconnect() {
    return (await this.request('/logout', { method: 'POST' })).result;
  }

  async setEnabled(enabled) {
    return (await this.request(enabled ? '/enable' : '/disable', { method: 'POST' })).result;
  }

  /**
   * Proxy ke Vercel REST. Backend memasang token pengguna dan teamId instalasi;
   * CLI tidak pernah melihat keduanya.
   */
  async proxy(method, apiPath, { query = null, body = undefined } = {}) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const item of value) search.append(key, String(item));
      } else {
        search.set(key, String(value));
      }
    }
    const suffix = search.toString() ? `?${search.toString()}` : '';
    const path = `/api${String(apiPath || '').startsWith('/') ? apiPath : `/${apiPath}`}${suffix}`;
    const response = await this.request(path, { method, body: body !== undefined ? body : undefined });
    return { data: response.result, status: response.status };
  }
}
