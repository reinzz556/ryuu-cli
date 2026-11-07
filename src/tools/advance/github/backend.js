import { GitHubPluginError, GITHUB_CODES } from './errors.js';
import { GITHUB_BACKEND_URL } from './config.js';

/**
 * Klien backend integrasi GitHub.
 *
 * Backend adalah satu-satunya pemegang Client Secret, Private Key, dan token
 * pengguna. CLI hanya memegang `cliToken` (per akun, diterbitkan setelah OAuth
 * berhasil) yang dikirim sebagai Bearer pada endpoint terautentikasi.
 */
export const GITHUB_API_PREFIX = '/integrations/github';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class GitHubBackendClient {
  constructor({
    baseUrl = GITHUB_BACKEND_URL,
    getToken = () => null,
    fetchImpl = null,
    logger = null,
    timeoutMs = 20_000,
  } = {}) {
    this.baseUrl = String(baseUrl || GITHUB_BACKEND_URL).replace(/\/+$/, '');
    this.getToken = getToken;
    this.fetchImpl = fetchImpl || fetch;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
  }

  endpoint(path) {
    return `${this.baseUrl}${GITHUB_API_PREFIX}${path}`;
  }

  async request(path, { method = 'GET', body = undefined, auth = true, headers = {}, timeoutMs = null } = {}) {
    const token = auth ? this.getToken() : null;
    if (auth && !token) {
      throw new GitHubPluginError('Belum login ke GitHub. Jalankan /github login.', {
        code: GITHUB_CODES.UNAUTHORIZED,
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
      throw new GitHubPluginError(
        typeof error?.code === 'string' && error.code.startsWith('E')
          ? 'Tidak dapat menghubungi backend integrasi GitHub (masalah jaringan).'
          : 'Backend integrasi GitHub tidak merespons. Coba lagi.',
        {
          code: GITHUB_CODES.BACKEND_UNREACHABLE,
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
      throw new GitHubPluginError(message, {
        code:
          (result && typeof result === 'object' && result.code) ||
          (response.status === 429 ? GITHUB_CODES.RATE_LIMIT : GITHUB_CODES.BACKEND),
        status: response.status,
        retryable: RETRYABLE_STATUS.has(response.status),
        reconnect: Boolean(result && typeof result === 'object' && result.reconnect),
        details: result && typeof result === 'object' ? result.details || result.missing || null : null,
      });
    }
    return { result: result ?? {}, headers: response.headers, status: response.status };
  }

  async startSession({ label = null, loginHint = null } = {}) {
    const { result } = await this.request('/connect', {
      method: 'POST',
      auth: false,
      body: { ...(label ? { label } : {}), ...(loginHint ? { loginHint } : {}) },
    });
    if (!result.sessionId || !result.pairingSecret || !result.url) {
      throw new GitHubPluginError('Backend tidak mengembalikan sesi login yang valid.', {
        code: GITHUB_CODES.SESSION,
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

  async startDevice() {
    const { result } = await this.request('/device/start', { method: 'POST', auth: false });
    if (!result.sessionId || !result.pairingSecret || !result.userCode) {
      throw new GitHubPluginError('Backend tidak mengembalikan kode device flow yang valid.', {
        code: GITHUB_CODES.SESSION,
        status: 502,
      });
    }
    return result;
  }

  async pollDevice({ sessionId, pairingSecret }) {
    const { result } = await this.request('/device/poll', {
      method: 'POST',
      auth: false,
      body: { sessionId, pairingSecret },
      timeoutMs: 20_000,
    });
    return result;
  }

  async status() {
    return (await this.request('/status')).result;
  }

  async account() {
    return (await this.request('/account')).result;
  }

  async test() {
    return (await this.request('/test', { method: 'POST' })).result;
  }

  async refresh() {
    return (await this.request('/refresh', { method: 'POST' })).result;
  }

  async disconnect() {
    return (await this.request('/disconnect', { method: 'POST' })).result;
  }

  async setEnabled(enabled) {
    return (await this.request(enabled ? '/enable' : '/disable', { method: 'POST' })).result;
  }

  /**
   * Proxy ke GitHub REST. Backend memasang token pengguna; CLI tidak pernah
   * melihat token tersebut. `nextPage` berasal dari header Link yang diteruskan
   * backend sebagai `x-github-link`.
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
    const link = response.headers?.get?.('x-github-link') || '';
    return { data: response.result, nextPage: /rel="next"/.test(link) };
  }
}
