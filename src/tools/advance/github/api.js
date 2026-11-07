import { GitHubPluginError, GITHUB_CODES } from './errors.js';

/**
 * Klien GitHub API sisi plugin.
 *
 * CLI tidak memegang access token, jadi setiap panggilan diteruskan ke backend
 * (Integration Gateway) yang memasang token pengguna. Antarmuka sengaja dibuat
 * mirip REST GitHub agar tools mudah dibaca.
 */
export class GitHubApi {
  constructor({ backend, logger = null } = {}) {
    if (!backend) throw new Error('GitHubApi membutuhkan backend client.');
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

  patch(path, body = undefined) {
    return this.request('PATCH', path, { body });
  }

  put(path, body = undefined) {
    return this.request('PUT', path, { body });
  }

  delete(path, body = undefined) {
    return this.request('DELETE', path, { body });
  }

  /**
   * Ambil beberapa halaman berturut-turut. Backend meneruskan header `Link`
   * GitHub lewat `x-github-link`, sehingga CLI tahu kapan harus berhenti.
   */
  async paginate(path, { query = {}, perPage = 30, maxPages = 5, maxItems = 100 } = {}) {
    const items = [];
    let page = 1;
    let pages = 0;
    while (items.length < maxItems && pages < maxPages) {
      pages += 1;
      const { data, nextPage } = await this.backend.proxy('GET', path, {
        query: { ...query, per_page: perPage, page },
      });
      if (!Array.isArray(data)) break;
      items.push(...data.slice(0, Math.max(0, maxItems - items.length)));
      if (!nextPage) break;
      page += 1;
    }
    return items;
  }

  /** Cek kuota GitHub. */
  async rateLimit() {
    return this.get('/rate_limit');
  }
}

/** Bungkus error jaringan/HTTP agar pesan ke pengguna konsisten. */
export function describeApiError(error) {
  if (error instanceof GitHubPluginError) return error;
  const status = Number(error?.status || 0);
  return new GitHubPluginError(error?.message || 'Permintaan GitHub gagal.', {
    code: status === 429 ? GITHUB_CODES.RATE_LIMIT : GITHUB_CODES.API,
    status,
    retryable: status === 429 || status >= 500,
  });
}
