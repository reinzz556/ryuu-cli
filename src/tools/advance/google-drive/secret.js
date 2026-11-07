import crypto from 'node:crypto';

/**
 * Kunci khusus login Google Drive.
 *
 * Terpisah total dari root key proyek API (`ROOT_KEY_SECRET`): root key itu
 * membuka seluruh endpoint admin, sedangkan kunci ini hanya menerima satu
 * endpoint OAuth Drive dan tidak berlaku di tempat lain.
 *
 * Penyimpanan: 32 byte bahan dipecah menjadi empat potongan 8 byte, tiap
 * potongan di-XOR dengan mask sendiri, lalu ditulis sebagai hex supaya tidak
 * terlihat sebagai kunci saat file dibaca sekilas. Nilai yang dikirim ke
 * jaringan bukan bahan itu sendiri, melainkan turunan HMAC-SHA256-nya,
 * sehingga string di dalam file tidak bisa langsung dipakai sebagai header.
 *
 * Tidak ada command, config, atau environment variable yang dapat mengubah
 * kunci ini: nilainya bawaan aplikasi dan hanya dipakai saat `/drive login`
 * (serta refresh/revoke token, yang tetap bagian dari siklus login).
 */
export const DRIVE_LOGIN_HEADER = 'x-ryuu-drive-auth';

// 4 x 8 byte. `_m` = mask XOR tiap potongan.
const _p = [
  ['4fbd2524004ef3b6', 90],
  ['61d480876c0cfe13', 63],
  ['906bb071fff129ea', 199],
  ['d581636291c5b1f4', 145],
];
const _l = 'ryuu.drive.login.v1';

let _cached = null;

function material() {
  if (!_cached) {
    _cached = Buffer.concat(
      _p.map(([hex, mask]) => Buffer.from(hex, 'hex').map((byte) => byte ^ mask)),
    );
  }
  return _cached;
}

/** Token header turunan (base64url, 43 karakter). Tidak pernah dicetak. */
export function driveLoginToken() {
  return crypto.createHmac('sha256', material()).update(_l).digest('base64url');
}

/** Header siap pakai untuk backend API. */
export function driveLoginHeaders() {
  return { [DRIVE_LOGIN_HEADER]: driveLoginToken() };
}
