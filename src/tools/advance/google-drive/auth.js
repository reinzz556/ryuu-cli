import { spawn } from 'node:child_process';

/**
 * Helper autentikasi sisi CLI — TANPA kredensial.
 *
 * Semua langkah OAuth (authorization URL, PKCE verifier, penukaran code,
 * refresh token, revoke) dikerjakan backend `website/api`, yang satu-satunya
 * memegang Client ID & Client Secret. Modul ini hanya menyisakan hal yang
 * memang milik CLI: membuka browser dan menerjemahkan pesan kegagalan.
 *
 * Tidak ada loopback callback server di sini: redirect Google menuju route
 * publik backend (`/admin/tools/drive-callback`).
 */

/** Best-effort browser launch; returns false when no opener is available. */
export function openBrowser(url) {
  const target = String(url);
  const attempts =
    process.platform === 'darwin'
      ? [['open', [target]]]
      : process.platform === 'win32'
        ? [['cmd', ['/c', 'start', '', target]]]
        : [['xdg-open', [target]], ['sensible-browser', [target]], ['gio', ['open', target]]];
  return attempts.some(([command, args]) => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true });
      child.on('error', () => {});
      child.unref();
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Turn a Google/network failure into an Indonesian hint. The message never
 * contains a token: only the OAuth error code and a plain-language reason.
 */
export function describeOAuthFailure(error) {
  const data = error?.response?.data || {};
  const reason = String(data.error || error?.code || 'unknown');
  const detail = String(data.error_description || error?.message || '').slice(0, 200);
  if (reason === 'invalid_grant' || /invalid_grant/.test(detail)) {
    return 'refresh token sudah tidak berlaku. Jalankan /drive login untuk menghubungkan ulang.';
  }
  if (reason === 'invalid_client' || /invalid_client/.test(detail)) {
    return 'backend OAuth menolak kredensial Google. Hubungi admin layanan API.';
  }
  if (reason === 'access_denied') return 'akses ditolak oleh pengguna di halaman persetujuan Google.';
  if (reason === 'invalid_request') return `permintaan OAuth tidak valid${detail ? ` (${detail})` : ''}.`;
  if (/backend OAuth/i.test(detail)) return detail;
  if (error?.code === 'ENOTFOUND' || error?.code === 'ECONNREFUSED' || error?.code === 'ETIMEDOUT') {
    return 'tidak dapat menghubungi backend OAuth (masalah jaringan).';
  }
  return detail || reason;
}
