import { VercelPluginError, VERCEL_CODES } from './errors.js';

/**
 * Klien Vercel API sisi plugin.
 *
 * CLI tidak memegang access token, jadi setiap panggilan diteruskan ke backend
 * (Integration Gateway) yang memasang token pengguna dan teamId instalasi.
 * Antarmuka dibuat mirip REST Vercel agar tools mudah dibaca.
 */
export class VercelApi {
  constructor({ backend, logger = null } = {}) {
    if (!backend) throw new Error('VercelApi membutuhkan backend client.');
    this.backend = backend;
    this.logger = logger;
  }

  async request(method, path, { query = null, body = undefined } = {}) {
    const { data } = await this.backend.proxy(method, path, { query, body });
    return data;
  }

  get(path, query = null) {
    return this.request('GET', path, { query });
  }

  post(path, body = undefined, query = null) {
    return this.request('POST', path, { body, query });
  }

  patch(path, body = undefined, query = null) {
    return this.request('PATCH', path, { body, query });
  }

  put(path, body = undefined, query = null) {
    return this.request('PUT', path, { body, query });
  }

  delete(path, body = undefined, query = null) {
    return this.request('DELETE', path, { body, query });
  }

  /**
   * Pagination Vercel memakai cursor `pagination.next` yang dikirim balik
   * sebagai `until`. Berhenti saat cursor habis atau batas tercapai.
   */
  async paginate(path, { query = {}, limit = 20, maxPages = 5, maxItems = 100, itemsKey = null } = {}) {
    const items = [];
    let pages = 0;
    let until = null;
    while (items.length < maxItems && pages < maxPages) {
      pages += 1;
      const data = await this.get(path, { ...query, limit, ...(until ? { until } : {}) });
      const key = itemsKey || Object.keys(data || {}).find((name) => Array.isArray(data[name]));
      const batch = Array.isArray(data) ? data : Array.isArray(data?.[key]) ? data[key] : [];
      if (!batch.length) break;
      items.push(...batch.slice(0, Math.max(0, maxItems - items.length)));
      const next = data?.pagination?.next;
      if (!next || items.length >= maxItems) break;
      until = next;
    }
    return items;
  }
}

/** Bungkus error jaringan/HTTP agar pesan ke pengguna konsisten. */
export function describeApiError(error) {
  if (error instanceof VercelPluginError) return error;
  const status = Number(error?.status || 0);
  return new VercelPluginError(error?.message || 'Permintaan Vercel gagal.', {
    code:
      status === 429
        ? VERCEL_CODES.RATE_LIMIT
        : status === 403
          ? VERCEL_CODES.SCOPE
          : status === 404
            ? VERCEL_CODES.NOT_FOUND
            : VERCEL_CODES.API,
    status,
    retryable: status === 429 || status >= 500,
  });
}
