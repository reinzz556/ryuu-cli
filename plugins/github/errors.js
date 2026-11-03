import { RyuuError } from '../../src/utils/errors.js';

/**
 * Error plugin GitHub.
 *
 * Setiap kegagalan membawa `code` yang stabil supaya command bisa memberi
 * petunjuk yang tepat tanpa memeriksa teks pesan.
 */
export class GitHubPluginError extends RyuuError {
  constructor(message, { code = 'GITHUB_ERROR', status = 0, retryable = false, reconnect = false, details = null } = {}) {
    super(message, { code, status, retryable, details });
    this.reconnect = reconnect;
  }
}

export const GITHUB_CODES = Object.freeze({
  DISABLED: 'GITHUB_DISABLED',
  UNAUTHORIZED: 'GITHUB_UNAUTHORIZED',
  BUSY: 'GITHUB_BUSY',
  BACKEND: 'GITHUB_BACKEND',
  BACKEND_UNREACHABLE: 'GITHUB_BACKEND_UNREACHABLE',
  SESSION: 'GITHUB_SESSION',
  LOGIN_TIMEOUT: 'GITHUB_LOGIN_TIMEOUT',
  CONFIG: 'GITHUB_CONFIG',
  CREDENTIAL: 'GITHUB_CREDENTIAL',
  API: 'GITHUB_API',
  RATE_LIMIT: 'GITHUB_RATE_LIMIT',
  NOT_FOUND: 'GITHUB_NOT_FOUND',
  DESTRUCTIVE: 'GITHUB_DESTRUCTIVE_BLOCKED',
});

/**
 * Terjemahkan kegagalan backend/GitHub menjadi kalimat Bahasa Indonesia yang
 * bisa ditindaklanjuti. Tidak pernah menyertakan header, token, atau secret.
 */
export function describeFailure(error, { action = 'permintaan' } = {}) {
  if (!error) return `${action} gagal tanpa keterangan.`;
  if (error instanceof GitHubPluginError) return error.message;
  const status = Number(error.status || 0);
  if (status === 401) return 'Sesi CLI tidak valid atau sudah berakhir. Jalankan /github login lagi.';
  if (status === 403) return 'Akses ditolak. Periksa permission GitHub App dan instalasinya.';
  if (status === 404) return 'Data yang diminta tidak ditemukan di GitHub.';
  if (status === 429) return 'Batas permintaan GitHub tercapai. Coba lagi beberapa saat lagi.';
  if (status >= 500) return 'Backend atau GitHub sedang bermasalah. Coba lagi nanti.';
  if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
    return 'Tidak dapat menghubungi backend integrasi GitHub. Periksa koneksi internet.';
  }
  return error.message || `${action} gagal.`;
}
