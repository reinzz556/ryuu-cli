import { spawn } from 'node:child_process';

/** Pembantu autentikasi CLI Vercel. Tidak ada kredensial Vercel di file ini. */

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

/** Pesan kegagalan login yang jelas tanpa membocorkan apa pun. */
export function describeLoginFailure(error) {
  const status = Number(error?.status || 0);
  if (status === 404) return 'Sesi login Vercel tidak ditemukan atau kedaluwarsa. Jalankan /vercel login lagi.';
  if (status === 409) return 'Sesi login ini sudah dipakai. Jalankan /vercel login lagi.';
  if (status === 429) return 'Terlalu banyak percobaan login. Tunggu sebentar lalu coba lagi.';
  if (status >= 500) return 'Backend integrasi Vercel sedang bermasalah. Coba lagi nanti.';
  if (status === 0) return 'Tidak dapat menghubungi backend integrasi Vercel. Periksa koneksi internet.';
  return error?.message || 'Login Vercel gagal.';
}
