import { request as gaxiosRequest } from 'gaxios';
import { RyuuError } from '../../../../src/utils/errors.js';

/**
 * Auth client minimal untuk googleapis.
 *
 * googleapis hanya butuh objek dengan `request()` (dan `getRequestHeaders()`
 * untuk HTTP/2), jadi plugin tidak memakai google-auth-library sama sekali:
 * tidak ada client id, client secret, atau refresh langsung ke Google. Saat
 * access token kedaluwarsa, `onRefresh` meminta token baru ke backend API
 * (satu-satunya pemegang Client Secret).
 */

const AUTH_ERROR = 'DRIVE_AUTH';
const REFRESH_MARGIN_MS = 60 * 1000;

export class BackendTokenAuth {
  constructor({ accessToken, expiresAt = null, onRefresh = null, logger = null }) {
    this.accessToken = accessToken || null;
    this.expiresAt = Number.isFinite(expiresAt) ? expiresAt : null;
    this.onRefresh = onRefresh;
    this.logger = logger;
    this.refreshing = null;
  }

  setTokens({ accessToken, expiresAt = null }) {
    this.accessToken = accessToken || null;
    this.expiresAt = Number.isFinite(expiresAt) ? expiresAt : null;
    return this;
  }

  get expired() {
    if (!this.expiresAt) return false;
    return Date.now() > this.expiresAt - REFRESH_MARGIN_MS;
  }

  async ensureToken() {
    if (!this.accessToken) {
      throw new RyuuError('Access token Google Drive tidak tersedia. Jalankan /drive login.', {
        code: 'DRIVE_UNAUTHORIZED',
      });
    }
    if (!this.expired || typeof this.onRefresh !== 'function') return this.accessToken;
    if (!this.refreshing) {
      this.refreshing = Promise.resolve()
        .then(() => this.onRefresh())
        .then((tokens) => {
          if (tokens?.accessToken) {
            this.setTokens({ accessToken: tokens.accessToken, expiresAt: tokens.expiryDate });
          }
          return this.accessToken;
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    return this.refreshing;
  }

  async getRequestHeaders() {
    const token = await this.ensureToken();
    return { Authorization: `Bearer ${token}` };
  }

  async getAccessToken() {
    return { token: await this.ensureToken() };
  }

  async getUniverseDomain() {
    return undefined;
  }

  /** Dipakai googleapis-common: setiap request Drive lewat jalur ini. */
  async request(options = {}) {
    const token = await this.ensureToken();
    const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
    const response = await gaxiosRequest({ ...options, headers });
    return response;
  }
}
