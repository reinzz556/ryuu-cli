# Monetisasi & Referral Advertisement — Ryuu CLI

Dokumen ini menjelaskan sistem iklan yang terintegrasi dari database backend,
admin dashboard, sampai renderer terminal Ryuu CLI.

Tujuan sistem:

- menampilkan satu advertisement secara acak **selama task AI berjalan**;
- mengambil daftar iklan dari database, bukan hardcode di CLI;
- mencatat impresi anonim dan klik yang benar-benar dapat dikonfirmasi;
- menjaga integritas modul monetisasi lewat compiled artifact + checksum
  (opsional tanda tangan Ed25519).

Sistem ini **tidak** mengklaim binary tidak bisa dibongkar. Yang disediakan
adalah deteksi perubahan tidak sah dan pemisahan source development dari
artifact distribusi.

---

## 1. Arsitektur

```
┌──────────────────────────┐        ┌──────────────────────────────────┐
│ Ryuu CLI                 │        │ Backend (website/api)            │
│ src/monetization/        │        │ lib/ads/                         │
│  scheduler ──────────────┼───────▶│ GET  /api/v1/ads                 │
│  engine (compiled)       │        │ POST /api/v1/ads/events          │
│  OSC 8 renderer          │        │ GET  /api/v1/ads/:id/click ──────┼──▶ referral URL
│  analytics (anonim)      │        │ admin CRUD /api/v1/admin/ads     │
└──────────────────────────┘        └───────────────┬──────────────────┘
                                                    │
                                          lib/ads.json (database)
                                          lib/ads-events.json
                                          lib/ads-audit.json
```

CLI tidak pernah memegang secret backend. Semua endpoint publik hanya
mengembalikan data iklan yang aktif.

---

## 2. Database dan seeding

Proyek backend memakai penyimpanan JSON lokal (pola yang sama dengan
`lib/database.json` dan `lib/stats.json`), bukan server SQL. Skema iklan:

```json
{
  "version": 1,
  "seeded": true,
  "config": {
    "enabled": true,
    "minInterval": 120000,
    "maxInterval": 300000,
    "updatedAt": "2026-01-01T00:00:00.000Z"
  },
  "ads": {
    "pterokudesu": {
      "id": "pterokudesu",
      "title": "Pterokudesu",
      "desc": "Dapatkan panel Pterodactyl dengan harga murah disini!!",
      "url": "https://my.pterokudesu.com/daftar?ref=CSGTF2GX",
      "referralUrl": "https://my.pterokudesu.com/daftar?ref=CSGTF2GX",
      "enabled": true,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  }
}
```

Data awal ada di `lib/ads/seed.json`. Seeder:

- dijalankan otomatis saat router dibuat;
- idempotent (flag `seeded` + pengecekan ID);
- tidak menimpa perubahan admin;
- tidak menambahkan kembali iklan yang sudah dihapus admin setelah seeding
  pertama.

File runtime (`lib/ads.json`, `lib/ads-events.json`, `lib/ads-audit.json`)
di-ignore Git dan ditulis atomik (tmp + rename).

---

## 3. Endpoint

Base: `https://restapi.ryuu-dev.my.id`

| Method | Path | Akses | Keterangan |
| --- | --- | --- | --- |
| GET | `/api/v1/ads` | publik | Iklan aktif + config interval |
| GET | `/api/v1/ads/:id` | publik | Satu iklan aktif |
| POST | `/api/v1/ads/events` | publik | Hanya `ad_impression` |
| GET | `/api/v1/ads/:id/click` | publik | Catat klik, lalu 302 ke referral URL |
| GET | `/api/v1/admin/ads` | admin | Semua iklan + config |
| POST | `/api/v1/admin/ads` | admin | Tambah iklan |
| PUT | `/api/v1/admin/ads/:id` | admin | Ubah iklan |
| DELETE | `/api/v1/admin/ads/:id` | admin | Hapus iklan |
| PATCH | `/api/v1/admin/ads/:id/status` | admin | Aktif/nonaktif |
| GET | `/api/v1/admin/ads/statistics` | admin | Statistik nyata |
| GET | `/api/v1/admin/ads/audit` | admin | Audit perubahan terakhir |
| PUT | `/api/v1/admin/ads/config` | admin | Interval/global enable |

Respons publik utama:

```json
{
  "success": true,
  "ads": {
    "pterokudesu": {
      "title": "Pterokudesu",
      "desc": "Dapatkan panel Pterodactyl dengan harga murah disini!!",
      "url": "https://my.pterokudesu.com/daftar?ref=CSGTF2GX",
      "destinationUrl": "https://my.pterokudesu.com/daftar?ref=CSGTF2GX",
      "referralUrl": "https://my.pterokudesu.com/daftar?ref=CSGTF2GX",
      "enabled": true,
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  },
  "config": {
    "enabled": true,
    "minInterval": 120000,
    "maxInterval": 300000
  }
}
```

Catatan keputusan: endpoint baru memakai `res.json` langsung (bukan envelope
`res.reply` lama) agar sesuai kontrak di atas. Endpoint lama tidak diubah.

### Otorisasi admin

Admin ditentukan server-side dari `global.adminEmail` lewat `lib/admin.js`.
Endpoint admin memakai `req.session.user` dan `isAdmin()`; email dari body atau
header tidak pernah dipercaya. CLI/SPA hanya menerima flag `isAdmin` dari
`/api/auth/me` untuk kebutuhan tampilan.

### Validasi

- ID: `^[a-z0-9][a-z0-9_-]{0,63}$`, unik.
- Title maksimal 80 karakter; Description maksimal 240 karakter.
- Teks dibersihkan dari ANSI/control sequence sebelum disimpan (mencegah
  terminal injection).
- URL hanya `http`/`https`, maksimal 2048 karakter, tanpa kredensial.
- Interval 30.000–3.600.000 ms dan `maxInterval >= minInterval`.
- Rate limit in-memory per IP untuk endpoint publik dan admin.
- Audit trail mencatat aktor, aksi, ID iklan, dan waktu.

---

## 4. Admin dashboard

Buka `https://restapi.ryuu-dev.my.id/admin/ads` setelah login dengan akun yang
email-nya sama dengan `global.adminEmail`.

Tombol **Admin dashboard** hanya dirender untuk `user.isAdmin`, tetapi halaman
dan seluruh endpoint tetap dilindungi server-side. Fitur halaman:

- daftar iklan, status, URL tujuan, impresi, klik, waktu update;
- tambah/ubah/hapus iklan;
- aktif/nonaktif per iklan;
- pratinjau box terminal sebelum disimpan;
- kartu statistik dari event nyata (tidak ada angka palsu);
- konfirmasi penghapusan, toast, loading/empty/error state, validasi form;
- seluruh teks UI berbahasa Indonesia.

---

## 5. Renderer terminal

Renderer memakai box yang lebarnya mengikuti terminal (maksimum 92 kolom pada
renderer utama) dan OSC 8:

```js
`\x1B]8;;${url}\x1B\\${label}\x1B]8;;\x1B\\`
```

- Hyperlink diarahkan ke redirect pelacakan `/api/v1/ads/:id/click` sehingga
  klik dapat dikonfirmasi di server, lalu dialihkan ke referral URL asli.
- Browser tidak dibuka lewat `xdg-open`/`termux-open-url`; CLI bisa berjalan
  lewat SSH.
- Bila terminal tidak mendukung ANSI/OSC 8, URL lengkap ditampilkan sebagai
  teks biasa.
- Domain tujuan selalu ditampilkan.
- Baris iklan ditulis lewat renderer yang memarkir prompt dan live region,
  jadi streaming AI, input, dan panel interaktif tidak terhapus.
- Teks dari database dibersihkan dan dipotong sesuai lebar box.

---

## 6. Scheduler dan lifecycle

- `start()` dipanggil di `runTask()` sebelum agent berjalan.
- `stop()` dipanggil di blok `finally` dan saat aplikasi ditutup.
- Iklan pertama muncul otomatis ±0,75 detik setelah task mulai, sehingga task
  pendek tetap menampilkan iklan. Iklan berikutnya memakai interval acak dari
  backend (default 2–5 menit).
- Iklan dipilih acak; iklan yang sama tidak dipilih berurutan bila ada opsi.
- Iklan nonaktif tidak pernah dirender.
- Scheduler tidak berjalan saat idle atau setelah task selesai.
- Timer di-`unref()` dan dibersihkan; hydrate dari task lama tidak bisa
  menjadwalkan timer untuk task baru (generation counter).
- Mode plain/pipe dan test tidak menampilkan iklan.
- Kegagalan backend tidak membuat task gagal.

Policy resmi ada di modul monetisasi. Iklan aktif secara default dan **tidak
bisa dimatikan oleh pengguna**: tidak ada environment variable atau setting CLI
untuk menonaktifkannya. Distribusi resmi versi gratis menyertakan iklan sebagai
bagian ketentuan penggunaan dengan label `SPONSORED` yang terlihat. Satu-satunya
pengecualian teknis adalah mode non-interaktif/`--plain` dan test otomatis,
karena menulis kotak iklan ke pipe akan merusak output terprogram.

---

## 7. Analytics & privasi

Event yang dicatat:

- `ad_impression` — saat CLI benar-benar merender iklan;
- `ad_click` — hanya lewat redirect yang dikunjungi pengguna.

Data per event: advertisement ID, tipe, timestamp, CLI version, dan session ID
anonim. Rate limiting memakai IP hanya di memori; event iklan tidak menyimpan
IP. Tidak ada prompt, isi file, source code, email, atau data pribadi lain yang
dikirim.

CLI tidak menganggap teks OSC 8 yang tampil sebagai klik. Jika terminal tidak
punya click event, klik tidak dikarang; statistik klik hanya berasal dari
redirect yang benar-benar dibuka.

---

## 8. Build compiled artifact

Pipeline build berada di project terpisah `agents/ryuu-build`, di luar folder
CLI:

```bash
cd agents/ryuu
npm run build:monetization
# atau langsung:
cd agents/ryuu-build
node scripts/build-monetization.js
```

Output:

```
agents/ryuu-build/dist/monetization/engine.cjs     # payload deflate+base64
agents/ryuu-build/dist/monetization/manifest.json  # versi, sha256, ukuran, source hash
```

Source development berada di `agents/ryuu-build/monetization-src/engine.cjs` dan
build script di `agents/ryuu-build/scripts/build-monetization.js`. Keduanya
tidak masuk package CLI. Saat `npm pack`/`npm publish`, hook `prepack`
membangun artifact ke `dist/monetization` di dalam package agar tarball membawa
engine terkompilasi, lalu `postpack` menghapus `dist/` lagi sehingga working
tree CLI tetap bersih. Loader `src/monetization/index.js` memakai artifact lokal
bila ada; saat development ia membaca folder build sibling.

Loader (`src/monetization/index.js`):

1. membaca manifest;
2. menghitung SHA-256 artifact dan membandingkannya;
3. memverifikasi ukuran;
4. bila manifest bertanda tangan, memverifikasi Ed25519 dengan public key
   tepercaya (`src/monetization/trusted-key.pub` atau
   `RYUU_ADS_PUBLIC_KEY`);
5. memuat artifact; artifact yang rusak **tidak** di-fallback ke source
   (fail closed).

Tanda tangan opsional:

```bash
# Bangun ke folder sementara untuk mengambil public key:
RYUU_ADS_SIGNING_KEY=./ads-signing-key.pem \
  node agents/ryuu-build/scripts/build-monetization.js --out /tmp/ryuu-ads
cp /tmp/ryuu-ads/public-key.pub agents/ryuu/src/monetization/trusted-key.pub

# Publikasikan dengan key yang sama agar artifact di tarball ikut ditandatangani:
RYUU_ADS_SIGNING_KEY=./ads-signing-key.pem npm publish
```

Private key hanya dibaca build script, tidak pernah ditulis ke artifact,
manifest, atau source. `prepack` menjalankan build otomatis saat publish.

Untuk distribusi yang mewajibkan artifact:

```bash
RYUU_ADS_REQUIRE_ARTIFACT=1 ryuu
```

---

## 9. Environment variables

| Variable | Sisi | Fungsi |
| --- | --- | --- |
| `RYUU_ADS_API_BASE` | CLI | Override base URL backend (default `https://restapi.ryuu-dev.my.id`) |
| `RYUU_ADS_REQUIRE_ARTIFACT=1` | CLI | Tolak berjalan tanpa artifact terverifikasi |
| `RYUU_ADS_PUBLIC_KEY` | CLI | Public key Ed25519 untuk verifikasi tanda tangan |
| `RYUU_ADS_SIGNING_KEY` | build | Private key Ed25519 saat build (jangan di-commit) |

Tidak ada secret backend yang dibutuhkan CLI.

---

## 10. Deployment backend

1. Deploy `website/api` seperti biasa (PM2 `ecosystem.config.cjs`, port 25565).
2. Pastikan direktori `lib/` dapat ditulis oleh proses server.
3. Boot pertama akan membuat `lib/ads.json` dari `lib/ads/seed.json`.
4. Pastikan HTTPS aktif dan domain `restapi.ryuu-dev.my.id` mengarah ke server.
5. Tidak perlu migrasi SQL; tidak ada dependensi baru.
6. Endpoint baru otomatis tersedia karena router dipasang di `index.js`
   sebelum auto-loader endpoint lama.

Verifikasi:

```bash
curl https://restapi.ryuu-dev.my.id/api/v1/ads
curl -o /dev/null -w '%{http_code}\n' https://restapi.ryuu-dev.my.id/api/v1/admin/ads
# 401 tanpa sesi admin
```

---

## 11. Test

```bash
cd website/api && npm test
cd agents/ryuu && npm run build:monetization && npm test
```

Test backend mencakup seeding idempotent, validasi URL, kontrak publik,
proteksi admin, CRUD, status, statistik, audit, dan redirect klik. Test CLI
mencakup normalisasi payload, pemilihan acak, interval, OSC 8/fallback,
timeout/retry, checksum artifact, dan lifecycle scheduler (termasuk memastikan
iklan pertama dijadwalkan segera tetapi tetap menghormati streaming).
