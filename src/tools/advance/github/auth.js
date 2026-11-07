import { spawn } from 'node:child_process';

/**
 * Pembantu autentikasi sisi CLI. Tidak ada kredensial di sini: OAuth,
 * penukaran kode, refresh, dan revoke seluruhnya dikerjakan backend.
 */

/** Buka browser default; `false` bila tidak ada opener yang tersedia. */
export function openBrowser(url) {
  const target = String(url);
  const attempts =
    process.platform === 'darwin'
      ? [['open', [target]]]
      : process.platform === 'win32'
        ? [['cmd', ['/c', 'start', '', target]]]
        : [
            ['xdg-open', [target]],
            ['sensible-browser', [target]],
            ['gio', ['open', target]],
          ];
  for (const [command, args] of attempts) {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true });
      child.on('error', () => {});
      child.unref();
      return true;
    } catch {
      // Coba opener berikutnya.
    }
  }
  return false;
}

/** Pesan kegagalan login yang ramah dan tidak membocorkan apa pun. */
export function describeLoginFailure(error) {
  const status = Number(error?.status || 0);
  const code = String(error?.code || '');
  if (code === 'GITHUB_LOGIN_TIMEOUT' || code === 'GITHUB_SESSION') return error.message;
  if (status === 401) return 'Backend menolak sesi login. Jalankan /github login lagi.';
  if (status === 403) return 'Otorisasi ditolak atau dibatasi oleh GitHub.';
  if (status === 410 || code === 'GITHUB_SESSION') return 'Sesi login sudah kedaluwarsa. Jalankan /github login lagi.';
  if (status >= 500) return 'Backend integrasi GitHub sedang bermasalah. Coba lagi nanti.';
  if (status === 0) return 'Tidak dapat menghubungi backend integrasi GitHub. Periksa koneksi internet.';
  return error?.message || 'Login GitHub gagal.';
}
