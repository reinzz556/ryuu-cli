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
agents/ryuu-build/dist/monetization/
├── engine.node                                  # artifact host (legacy)
├── manifest.json                                # versi, daftar prebuild, sha256, source hash
└── prebuilds/
    ├── linux-x64/engine.node
    ├── linux-arm64/engine.node
    ├── linux-x64-musl/engine.node
    ├── darwin-x64/engine.node
    ├── darwin-arm64/engine.node
    ├── win32-x64/engine.node
    └── win32-arm64/engine.node
```

Artifact yang dikirim ke pengguna adalah **addon native hasil kompilasi**
(`native/engine.cc` → `engine.node`), bukan JavaScript. Tidak ada source atau
bytecode JS di dalam artifact; logika engine hanya ada sebagai kode mesin.
Addon memakai N-API (ABI stabil), jadi satu binary berlaku untuk banyak versi
Node pada platform/arsitektur yang sama.

**Prebuild multi-platform.** Pengguna tidak perlu compiler saat instalasi:
tarball membawa binary untuk platform/arsitektur yang didukung, dan loader
memilih yang cocok (`prebuilds/<platform>-<arch>[-musl]/engine.node`, kecocokan
`libc` untuk Linux). `manifest.prebuilds` mencatat path, SHA-256, dan ukuran
tiap binary; daftar itu ikut ditandatangani bila signing aktif. Build per
platform dilakukan oleh `.github/workflows/prebuilds.yml` (ubuntu x64/arm64,
Alpine musl, macOS x64/arm64, Windows x64/arm64), lalu job `assemble`
menjalankan:

```bash
node scripts/assemble-prebuilds.js --dir dist/monetization
```

Script itu memindai `prebuilds/*/engine.node`, menghitung hash, menulis
manifest gabungan, dan menyalin binary host menjadi `engine.node` legacy.

Setiap job matriks juga menjalankan smoke test di platform aslinya sebelum
mengunggah artifact:

```bash
node scripts/smoke-prebuild.js          # prebuild host
node scripts/smoke-prebuild.js --file … # prebuild tertentu
```

Smoke test memuat addon dengan `require` dan memeriksa normalisasi payload,
pemilihan iklan, `nextDelay`, `buildClickUrl`, renderer (OSC 8, lebar baris,
lebar karakter CJK), serta format session id. Binary yang gagal dimuat atau
crash membuat job gagal, jadi artifact rusak tidak pernah diunggah.

Build memerlukan `node-gyp` 12 + compiler C++ (dan unduhan header Node saat
pertama kali). Script memakai `node-gyp@12` lewat `npx` supaya header cocok
dengan Node yang menjalankan build dan tidak menautkan `libnode` sistem (itu
membuat addon crash saat exit). Set `NODE_GYP=/path/node-gyp` untuk toolchain
offline.

Source development berada di `agents/ryuu-build/monetization-src/engine.cjs`
(fallback dev, bukan artifact) dan implementasi native di
`agents/ryuu-build/native/engine.cc`; build script di
`agents/ryuu-build/scripts/build-monetization.js`. Semuanya tidak masuk package
CLI. Saat `npm pack`/`npm publish`, hook `prepack`
membangun artifact ke `dist/monetization` di dalam package agar tarball membawa
engine terkompilasi, lalu `postpack` menghapus `dist/` lagi sehingga working
tree CLI tetap bersih. Loader `src/monetization/index.js` memakai artifact lokal
bila ada; saat development ia membaca folder build sibling.

**Pemilihan binary dari backend.** Bila package tidak membawa prebuild untuk
platform ini (mis. hanya sebagian platform yang dipaketkan), Ryuu memilih
binary dari `https://restapi.ryuu-dev.my.id`:

1. saat start, platform/arsitektur/libc runtime dicek dan engine lokal dimuat;
   hanya jika belum ada, prefetch manifest dijalankan di latar belakang;
2. `GET /api/v1/engine/prebuilds?platform=…&arch=…&libc=…` mengembalikan
   prebuild yang cocok beserta SHA-256, ukuran, dan URL;
3. binary diunduh (maksimal 8 MB), diverifikasi hash + ukurannya, lalu ditulis
   atomik ke `<config>/engine/<target>/current/engine.node`;
4. cache dipakai ulang tanpa jaringan selama 6 jam; bila backend mati, cache
   lama yang masih utuh tetap dipakai;
5. hanya URL dengan origin dan path `/api/v1/engine/prebuilds/*` yang sama
   dengan base URL yang diterima.

Scheduler mengulang langkah ini saat task dimulai bila prefetch belum selesai,
sehingga kegagalan jaringan hanya melewati iklan untuk sesi itu. Override
backend dengan `RYUU_ENGINE_API_BASE`, cache dengan `RYUU_ENGINE_CACHE`, dan
matikan prefetch dengan `RYUU_NO_ENGINE_PREFETCH=1`.

Loader (`src/monetization/index.js`):

1. membaca manifest artifact yang dibundel;
2. bila manifest bertanda tangan, memverifikasi Ed25519 dengan public key
   tepercaya (`src/monetization/trusted-key.pub` atau
   `RYUU_ADS_PUBLIC_KEY`);
3. memilih prebuild yang cocok dengan `platform`/`arch` (dan `libc` di Linux);
   manifest lama tanpa `prebuilds` memakai `engine.node` tunggal dengan cek
   platform/arch;
4. menolak path prebuild yang keluar dari folder artifact;
5. menghitung SHA-256 dan ukuran binary pilihan, membandingkannya dengan
   manifest;
6. bila tidak ada prebuild yang cocok, memakai binary cache hasil unduhan
   backend (hash + ukuran diperiksa ulang dengan aturan yang sama);
7. memuat addon; artifact yang rusak, tidak cocok, atau gagal dimuat **tidak**
   di-fallback ke source (fail closed).

I/O jaringan (`fetchAds`, `sendImpression`) tetap di JS
(`src/monetization/network.js`) karena N-API tidak bisa menunggu `fetch`;
wrapper itu hanya transport dan memanggil normalisasi/engine native.

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
| `RYUU_ENGINE_API_BASE` | CLI | Override base URL pemilihan binary engine (default `https://restapi.ryuu-dev.my.id`) |
| `RYUU_ENGINE_CACHE` | CLI | Folder cache binary engine (default `<config>/engine`) |
| `RYUU_NO_ENGINE_PREFETCH=1` | CLI | Matikan prefetch binary saat start |
| `RYUU_ENGINE_DIR` | backend | Folder manifest + prebuild di server (default `website/api/public/engine`) |

Tidak ada secret backend yang dibutuhkan CLI.

---

## 10. Deployment backend

1. Deploy `website/api` seperti biasa (PM2 `ecosystem.config.cjs`, port 25565).
2. Pastikan direktori `lib/` dapat ditulis oleh proses server.
3. Boot pertama akan membuat `lib/ads.json` dari `lib/ads/seed.json`.
4. Pastikan HTTPS aktif dan domain `restapi.ryuu-dev.my.id` mengarah ke server.
5. Tidak perlu migrasi SQL; tidak ada dependensi baru.
6. Salin hasil `agents/ryuu-build/dist/monetization` ke `public/engine`
   (`manifest.json` + `prebuilds/`), atau arahkan `RYUU_ENGINE_DIR` ke lokasi
   hasil assemble. Endpoint: `/api/v1/engine/prebuilds` dan
   `/api/v1/engine/prebuilds/<target>/engine.node`.
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
