import { RyuuError } from '../../../../src/utils/errors.js';

/**
 * Error plugin Vercel.
 *
 * Setiap kegagalan membawa `code` stabil supaya command bisa memberi petunjuk
 * yang tepat tanpa memeriksa teks pesan. Tidak ada nilai token di pesan.
 */
export class VercelPluginError extends RyuuError {
  constructor(message, { code = 'VERCEL_ERROR', status = 0, retryable = false, reconnect = false, details = null } = {}) {
    super(message, { code, retryable, details });
    // RyuuError tidak menyimpan `status`; plugin membutuhkannya untuk
    // membedakan 401/403/429 dan memutuskan reconnect.
    this.status = status;
    this.reconnect = reconnect;
  }
}

export const VERCEL_CODES = Object.freeze({
  DISABLED: 'VERCEL_DISABLED',
  UNAUTHORIZED: 'VERCEL_UNAUTHORIZED',
  BUSY: 'VERCEL_BUSY',
  BACKEND: 'VERCEL_BACKEND',
  BACKEND_UNREACHABLE: 'VERCEL_BACKEND_UNREACHABLE',
  SESSION: 'VERCEL_SESSION',
  LOGIN_TIMEOUT: 'VERCEL_LOGIN_TIMEOUT',
  CONFIG: 'VERCEL_CONFIG',
  CREDENTIAL: 'VERCEL_CREDENTIAL',
  API: 'VERCEL_API',
  RATE_LIMIT: 'VERCEL_RATE_LIMIT',
  SCOPE: 'VERCEL_SCOPE_REQUIRED',
  NOT_FOUND: 'VERCEL_NOT_FOUND',
  DESTRUCTIVE: 'VERCEL_DESTRUCTIVE_BLOCKED',
});

/**
 * Terjemahkan kegagalan backend/Vercel menjadi kalimat yang bisa ditindaklanjuti.
 * Tidak pernah menyertakan header, token, atau secret.
 */
export function describeFailure(error, { action = 'permintaan' } = {}) {
  if (!error) return `${action} gagal tanpa keterangan.`;
  if (error instanceof VercelPluginError) return error.message;
  const status = Number(error.status || 0);
  if (status === 401) return 'Sesi CLI tidak valid atau sudah berakhir. Jalankan /vercel login lagi.';
  if (status === 403) return 'Akses ditolak. Periksa scope integrasi Vercel dan instalasinya.';
  if (status === 404) return 'Data yang diminta tidak ditemukan di Vercel.';
  if (status === 429) return 'Batas permintaan Vercel tercapai. Coba lagi beberapa saat lagi.';
  if (status >= 500) return 'Backend atau Vercel sedang bermasalah. Coba lagi nanti.';
  if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
    return 'Tidak dapat menghubungi backend integrasi Vercel. Periksa koneksi internet.';
  }
  return error.message || `${action} gagal.`;
}
