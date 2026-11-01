/**
 * OAuth Google Drive lewat backend API — sisi CLI.
 *
 * Ryuu CLI tidak memegang Client ID, Client Secret, PKCE verifier, maupun
 * redirect URI. Semua itu milik `website/api`:
 *
 *   start   POST { action: 'start' }      → { state, url }   (URL login)
 *   poll    POST { action: 'poll', state } → { found, accessToken, ... }
 *   refresh POST { action: 'refresh', refreshToken } → token baru
 *   revoke  POST { action: 'revoke', token }         → cabut token
 *
 * URL backend di-hardcode di bawah: tidak ada command, config, atau
 * environment variable yang bisa mengubahnya.
 *
 * Otorisasi memakai kunci khusus login Drive (`secret.js`, header
 * `x-ryuu-drive-auth`) yang di server hanya berlaku untuk route ini — bukan
 * root key admin, yang tidak pernah ada di sisi CLI.
 */
import { RyuuError } from '../../src/utils/errors.js';
import { driveLoginHeaders } from './secret.js';

const OAUTH_ERROR = 'DRIVE_AUTH';

/** Endpoint backend tetap. Bukan konfigurasi pengguna. */
export const DRIVE_OAUTH_BACKEND = 'https://restapi.ryuu-dev.my.id';
export const DRIVE_OAUTH_CLI_PATH = '/admin/tools/drive-cli';

const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const POLL_INTERVAL_MS = 2000;
/** Status yang berarti gangguan sesaat; polling dilanjutkan. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const oauthError = (message, extra = {}) => new RyuuError(message, { code: OAUTH_ERROR, ...extra });

export function backendEndpoint() {
  return `${DRIVE_OAUTH_BACKEND}${DRIVE_OAUTH_CLI_PATH}`;
}

async function post(payload, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response;
  try {
    response = await fetch(backendEndpoint(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...driveLoginHeaders(),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    throw oauthError(`Tidak dapat menghubungi backend OAuth (${error.message}).`, {
      status: 0,
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }

  const body = await response.json().catch(() => null);
  const result = body && typeof body === 'object' && 'result' in body ? body.result : body;
  if (!response.ok || (body && body.success === false)) {
    const message =
      (result && typeof result === 'object' && (result.message || result.error)) ||
      (typeof result === 'string' ? result : '') ||
      `backend menjawab HTTP ${response.status}`;
    throw oauthError(`Backend OAuth menolak permintaan: ${message}`, {
      status: response.status,
      retryable: RETRYABLE_STATUS.has(response.status),
    });
  }
  return result || {};
}

/** Mulai sesi login; mengembalikan URL Google dan `state` untuk polling. */
export async function startLogin({ loginHint = null } = {}) {
  const result = await post({ action: 'start', ...(loginHint ? { loginHint } : {}) });
  if (!result.state || !result.url) throw oauthError('Backend tidak mengembalikan URL otorisasi.');
  if (!STATE_RE.test(String(result.state))) throw oauthError('Backend mengembalikan state yang tidak valid.');
  return {
    state: String(result.state),
    url: String(result.url),
    redirectUri: result.redirectUri || null,
    scope: result.scope || null,
    expiresIn: Number.isFinite(result.expiresIn) ? result.expiresIn : null,
  };
}

/**
 * Tunggu sampai backend menerima token dari Google.
 * Resolusi: { accessToken, refreshToken, expiryDate, scope, tokenType }.
 */
export async function waitForTokens({ state, timeoutMs = 300000, intervalMs = POLL_INTERVAL_MS, signal = null } = {}) {
  if (!STATE_RE.test(String(state || ''))) throw oauthError('State sesi login tidak valid.');
  const deadline = Date.now() + timeoutMs;
  let lastRejection = null;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw oauthError('Login dibatalkan.');
    let result = null;
    try {
      result = await post({ action: 'poll', state });
      lastRejection = null;
    } catch (error) {
      lastRejection = error;
      // Gangguan jaringan sesaat atau rate limit: teruskan polling.
      if (!error.retryable) throw error;
      if (signal?.aborted) throw oauthError('Login dibatalkan.');
    }
    if (result?.found) {
      if (result.error) {
        throw oauthError(`Google menolak permintaan otorisasi: ${result.error}.`);
      }
      if (!result.accessToken) throw oauthError('Backend tidak mengembalikan access token.');
      return {
        accessToken: String(result.accessToken),
        refreshToken: result.refreshToken ? String(result.refreshToken) : null,
        grantId: typeof result.grantId === 'string' ? result.grantId : null,
        expiryDate: Number.isFinite(result.expiryDate) ? result.expiryDate : null,
        scope: result.scope || '',
        tokenType: result.tokenType || 'Bearer',
      };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (lastRejection && !lastRejection.retryable) throw lastRejection;
  const minutes = Math.max(1, Math.round(timeoutMs / 60000));
  throw oauthError(`Waktu login habis (${minutes} menit). Jalankan /drive login lagi.`);
}

/**
 * Perbarui access token memakai `grantId` dari login (bukan kunci aplikasi).
 * Server yang memegang refresh token untuk grant itu.
 */
export async function refreshAccessToken({ grantId } = {}) {
  if (!grantId) throw oauthError('Izin Drive tidak tersedia. Jalankan /drive login.');
  const result = await post({ action: 'refresh', grantId });
  if (!result.accessToken) throw oauthError('Backend tidak mengembalikan access token baru.');
  return {
    accessToken: String(result.accessToken),
    refreshToken: result.refreshToken ? String(result.refreshToken) : null,
    grantId: typeof result.grantId === 'string' ? result.grantId : grantId,
    expiryDate: Number.isFinite(result.expiryDate) ? result.expiryDate : null,
    scope: result.scope || '',
    tokenType: result.tokenType || 'Bearer',
  };
}

/** Cabut izin (best effort); kegagalan tidak boleh memblokir logout. */
export async function revokeRemoteToken({ grantId } = {}) {
  if (!grantId) return { revoked: false, reason: 'tidak ada izin tersimpan' };
  try {
    const result = await post({ action: 'revoke', grantId }, { timeoutMs: 10000 });
    return result.revoked ? { revoked: true } : { revoked: false, reason: 'ditolak backend' };
  } catch (error) {
    return { revoked: false, reason: error.message };
  }
}
