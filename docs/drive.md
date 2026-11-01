# Google Drive Integration (plugin)

Integrasi Google Drive untuk Ryuu CLI. Plugin ini tinggal di `agents/ryuu/plugins/google-drive/`
dan terhubung ke arsitektur yang sudah ada: tool registry (`src/tools/registry.js`),
command parser (`src/cli/commands.js`), dan approval manager (`src/agent/approvals.js`).

Tidak ada sistem plugin, command parser, atau registry baru. Tidak ada backend OAuth eksternal.

---

## 1. Pengenalan

Setelah `/drive login` dan `/drive enable`, AI Agent dapat mencari file, upload, download,
mengelola folder, membuat backup ZIP project, dan melakukan restore — semuanya lewat
function tools yang sudah dikenal provider AI Ryuu.

Nama internal: `google-drive` · Command: `/drive` · Dependency: `googleapis`

---

## 2. Fitur

| Kelompok | Fitur |
| --- | --- |
| Autentikasi | OAuth 2.0 Web Application lewat backend API, PKCE S256 di server, logout + revocation |
| File | search, list, metadata, download, upload streaming, create folder, move, rename, copy, delete |
| Backup | ZIP streaming, exclusion pattern, upload streaming, structured result |
| Restore | download, validasi ZIP, ekstraksi anti Zip Slip, overwrite opt-in |
| Info | storage quota, akun terhubung |
| Lainnya | enable/disable, status, diagnostik, config manager |

---

## 3. Arsitektur

```
plugins/
├── index.js                  host: loadPlugins, syncPluginTools, unregisterPluginTools
└── google-drive/
    ├── index.js              deskriptor plugin + factory
    ├── manager.js            lifecycle (GoogleDrivePlugin), login/logout, status, diagnose
    ├── config.js             konfigurasi + validasi key (Client ID dikunci)
    ├── credentials.js        penyimpanan token terenkripsi AES-256-GCM
    ├── auth.js               PKCE, callback server, authorization URL, revocation
    ├── drive-api.js          client Drive API v3 (streaming, error mapping)
    ├── backup.js             engine backup/restore, exclusion, temp cleanup
    ├── zip-writer.js         penulis ZIP streaming (CRC32, data descriptor)
    ├── zip-reader.js         pembaca ZIP streaming + proteksi Zip Slip
    ├── tools.js              gabungan seluruh tool
    ├── tools-files.js        tool file & folder
    ├── tools-backup.js       tool backup/restore/info
    ├── tool-helpers.js       helper path lokal & format ukuran
    └── command.js            handler `/drive`
```

Alur registrasi tool:

1. `src/cli/app.js` memanggil `loadPlugins()` setelah registry dibangun.
2. `syncPluginTools()` mendaftarkan tool **hanya bila** `enabled === true` **dan** sudah login.
3. `/drive disable` dan `/drive logout` memanggil `unregisterPluginTools()`.
4. Setiap handler tool memanggil `plugin.requireClient()`, yang memeriksa ulang status
   dari disk — model yang masih memegang daftar tool lama tidak bisa mengeksekusi apa pun.

---

## 4. Persyaratan

- Node.js 18+ (proyek memakai ESM dan `node:test`).
- `googleapis` (sudah ditambahkan ke `package.json`).
- Project Google Cloud dengan **Google Drive API** aktif.
- OAuth Client bertipe **Web application** (redirect URI dikelola proyek API).

---

## 5. OAuth lewat backend API (credential bukan milik CLI)

Ryuu CLI **tidak memegang Client ID maupun Client Secret Google**. Keduanya hanya
ada di proyek root `website/api` (`lib/config.js`), dan seluruh langkah OAuth
dikerjakan di sana:

| Langkah | Dikerjakan oleh |
| --- | --- |
| `state` + PKCE verifier (S256) | backend API |
| authorization URL | backend API |
| penukaran `code` → token (memakai client secret) | backend API |
| refresh token & revocation | backend API (lewat `grantId`) |
| menyimpan token terenkripsi + memanggil Drive API | CLI |

Kontraknya: `POST /admin/tools/drive-cli` untuk
start/poll/refresh/revoke, dan `GET /admin/tools/drive-callback` untuk redirect
Google. Keduanya berada di folder `api/admin/tools/` proyek API.

```
start   { action: 'start' }             → { state, url, redirectUri }   [kunci login]
poll    { action: 'poll', state }       → { found, accessToken, grantId, … } [kunci login]
refresh { action: 'refresh', grantId }  → { accessToken baru, grantId }  [grant]
revoke  { action: 'revoke', grantId }   → { revoked }                   [grant]
```

Refresh dan revoke tidak lagi mengirim refresh token maupun kunci aplikasi:
CLI memegang `grantId` (terbit sekali saat login, berlaku 90 hari, terikat satu
akun) dan backend menyimpan refresh token untuk grant tersebut.

Alur `/drive login`:

1. CLI meminta `start`; backend membuat `state`, verifier PKCE, dan URL Google.
2. CLI mencetak URL itu (dan membuka browser bila tersedia).
3. Setelah pengguna setuju, Google mengarahkan ke
   `https://restapi.ryuu-dev.my.id/admin/tools/drive-callback`.
4. Backend menukar `code` + verifier + client secret menjadi token, lalu
   menyimpannya maksimal 10 menit untuk diambil **sekali**.
5. CLI mem-poll tiap 2 detik, menerima token, menyimpannya terenkripsi.

Endpoint backend dan redirect URI bersifat **hardcode**: tidak ada command,
config, maupun environment variable yang dapat mengubahnya.

### Kunci login Drive (bukan root key)

Route CLI dilindungi kunci **khusus login Drive**: header `x-ryuu-drive-auth`,
nilai turunan HMAC-SHA256 dari 32 byte yang tertanam di
`website/api/lib/drive-login-key.js` (server) dan
`plugins/google-drive/secret.js` (CLI). Bahan disimpan sebagai empat potongan
ter-XOR, dan yang dikirim ke jaringan adalah turunannya — bukan bahan itu.

Tidak ada yang perlu diisi pengguna dan tidak ada command untuk mengubahnya.
Root key admin tidak dipakai di sini dan tidak pernah dikirim ke CLI, jadi
kebocoran sisi CLI tidak membuka endpoint admin lain. Kunci hanya terpakai pada
`start` dan `poll`; setelah login selesai CLI memakai `grantId` untuk
refresh/revoke, sehingga kunci aplikasi tidak tersimpan di mesin pengguna.

---

## 6. Yang tidak bisa diubah dari command

`validateConfigEntry` menolak key `clientId`, `clientSecret`, `scopes`,
`oauthBackend`, `oauthCliPath`, `rootKey`, `driveKey`, dan `secret`. Berkas
config yang ditulis tangan pun dibersihkan: hanya key yang dikenal plugin yang
dipertahankan, jadi kunci login Drive tidak bisa ditanamkan lewat berkas.

---

## 7. Google Cloud setup

1. Buka Google Cloud Console → buat project.
2. **APIs & Services → Library** → aktifkan **Google Drive API**.
3. **OAuth consent screen** → tipe *External*, tambahkan scope `.../auth/drive.file`,
   tambahkan akun Anda sebagai *test user* selama aplikasi belum dipublikasikan.
4. **Credentials → Create credentials → OAuth client ID → Web application**.
5. Tambahkan **Authorized redirect URI**:
   `https://restapi.ryuu-dev.my.id/admin/tools/drive-callback`.
6. Simpan Client ID + Client Secret di `website/api/lib/config.js`
   (`global.driveOAuthClientId` / `global.driveOAuthClientSecret`). Tidak ada
   tempat lain yang boleh menyimpannya.

---

## 8. Aktivasi Google Drive API

Tanpa langkah 7.2, login berhasil tetapi setiap panggilan API gagal dengan 403/`accessNotConfigured`.
Pesan error plugin akan menyebut scope `drive.file` dan menyarankan pemeriksaan ini.

---

## 9. Cara login

```
/drive login
```

Alur: minta URL otorisasi ke backend API (membawa kunci login Drive) → buka browser →
tunggu persetujuan → backend menukar code + PKCE verifier dengan client secret →
CLI mem-poll dan menerima token → simpan token terenkripsi → verifikasi akses dengan
`about.get` → aktifkan integrasi.

Contoh output:

```
Google Drive Authentication

Browser tidak tersedia di mesin ini — buka tautan di bawah secara manual.
Login dengan akun Google lewat tautan berikut; blok di bawah bisa diklik untuk menyalin.

╭─ login-url ────────────────────────────────────────────── ⧉ copy ╮
│ https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&… │
╰──────────────────────────────────────────────────────────────────╯

Callback  : https://restapi.ryuu-dev.my.id/admin/tools/drive-callback
Otorisasi : backend API https://restapi.ryuu-dev.my.id
Kredensial Google (client id/secret) tidak disimpan di CLI.

Menunggu persetujuan pengguna…
[✓] Autentikasi berhasil!

Akun       : user@gmail.com
Permission : https://www.googleapis.com/auth/drive.file
Status     : Connected

Google Drive aktif. Tools Drive sekarang tersedia untuk AI Agent.
```

URL selalu dicetak sebagai blok berbingkai dengan tombol `⧉ copy`: di `--tui`
blok itu bisa diklik (dan menyalin URL utuh, bukan potongan baris hasil wrap),
sedangkan pada mode baris perintah peramban terminal sudah menyalinnya.

> Satu blok per perintah. Semua baris yang dicetak satu perintah tetap satu
> blok di `--tui`, jadi tidak ada garis pemisah yang menyelip di tengah
> notifikasi autentikasi.

Jika akun sudah terhubung, CLI menanyakan konfirmasi sebelum menimpa kredensial lama.

---

## 10. Login dari container, VPS, atau laptop

Tidak ada callback server lokal: port dalam container bukan lagi masalah, dan SSH
port forwarding tidak diperlukan.

1. Jalankan `/drive login`. URL Google selalu dicetak lengkap.
2. Buka URL itu di browser perangkat mana pun (boleh mesin berbeda) dan setujui.
3. Google mengarahkan ke `https://restapi.ryuu-dev.my.id/admin/tools/drive-callback`.
4. Backend menyimpan token sebentar; CLI mengambilnya lewat polling (2 detik) dan
   langsung menyimpannya terenkripsi.

Batas waktu 5 menit; setelah itu jalankan `/drive login` lagi. Token di backend
dihapus setelah diambil atau setelah 10 menit.

Verifikasi backend tanpa menyentuh Google (fetch Google distub):

```
cd website/api && node tools/test-drive-oauth.mjs
```

---

## 11. Cara logout

```
/drive logout
```

Tool dilepas, token di memori dan di disk dihapus, encryption key ikut dihapus
(kecuali berasal dari `RYUU_DRIVE_KEY`), revocation OAuth dicoba. Konfigurasi
non-sensitif dan file pengguna di Google Drive **tidak** dihapus.

---

## 12. Enable / disable

| Perintah | Efek |
| --- | --- |
| `/drive enable` | Butuh login. Menulis `enabled=true` dan mendaftarkan seluruh tool. |
| `/drive disable` | Melepas tool dari registry, memblokir eksekusi, token & config tetap. |

Matriks lifecycle:

| enabled | authenticated | Tool tersedia |
| --- | --- | --- |
| ya | ya | ya |
| ya | tidak | tidak (arahkan `/drive login`) |
| tidak | ya | tidak |
| tidak | tidak | tidak |

---

## 13. Status

```
/drive status
```

Menampilkan status integrasi, autentikasi, akun, scope, status token, jumlah tool aktif,
folder backup, dan waktu pemeriksaan koneksi terakhir. Token tidak pernah ditampilkan.

---

## 14. Seluruh command

```
/drive                    bantuan
/drive login              mulai OAuth
/drive logout             putuskan koneksi
/drive account            akun + quota
/drive enable             aktifkan integrasi
/drive disable            nonaktifkan integrasi
/drive status             ringkasan status
/drive config             sama dengan config show
/drive config show        tampilkan konfigurasi
/drive config set <k> <v> ubah satu konfigurasi
/drive test               diagnostik lengkap
/drive tools              daftar tool yang terdaftar
```

Key konfigurasi: `enabled`, `defaultBackupFolder`, `backupDirectory`, `excludePatterns`,
`maxUploadSize`, `confirmDestructive`, `autoRefresh`.

---

## 15. Seluruh tool AI

| Tool | Risk | Keterangan |
| --- | --- | --- |
| `drive_search` | read | Cari by nama, MIME, folder, query mentah, pagination |
| `drive_list` | read | Isi folder |
| `drive_get_metadata` | read | Metadata lengkap satu item |
| `drive_download` | write | Unduh ke path lokal workspace, tidak menimpa tanpa izin |
| `drive_upload` | write | Upload streaming, dibatasi `maxUploadSize` |
| `drive_create_folder` | write | Buat folder |
| `drive_move` | write | Pindahkan item |
| `drive_rename` | write | Ubah nama |
| `drive_copy` | write | Salin file |
| `drive_delete` | destructive | Hapus permanen + approval |
| `drive_backup` | write | ZIP streaming + upload |
| `drive_restore` | write | Unduh + validasi + ekstraksi |
| `drive_list_backups` | read | Daftar arsip ZIP |
| `drive_delete_backup` | destructive | Hapus arsip backup hanya untuk `.zip` |
| `drive_storage_info` | read | Kuota penyimpanan |
| `drive_get_account` | read | Akun terhubung |

Operasi `destructive` melewati `ApprovalManager` yang sudah ada, sehingga
`--auto-approve` dan policy `read-only` tetap berlaku seperti tool bawaan.

---

## 16. Contoh backup

Perintah ke AI:

```
Backup seluruh project ini ke Google Drive, kecuali node_modules, .git, .env dan cache.
```

AI memanggil `drive_backup` dengan `sourcePath: "."` dan `excludePatterns` tambahan.
Default `excludePatterns` sudah memuat `node_modules`, `.git`, `.env`, `*.pem`, `*.key`,
`credentials.json`, `cache`, `tmp`, `temp`, `*.log`. Secret (`HARD_EXCLUDES`) tidak pernah
ikut meskipun pengguna memintanya.

Contoh hasil:

```
Backup berhasil!
Project    : Lyoraa
Arsip      : lyoraa-backup-20261101-101500.zip
Ukuran     : 42.8 MB
Lokasi     : Google Drive / Backups
Dikecualikan: node_modules, .git, .env, cache, …
Status     : berhasil
```

---

## 17. Contoh restore

```
Pulihkan backup Lyoraa terakhir ke folder ./restore.
```

AI memanggil `drive_list_backups`, memilih arsip, lalu `drive_restore` dengan
`fileId` dan `destinationPath: "restore"`. Tanpa `overwrite=true`, restore berhenti
dan melaporkan file yang sudah ada.

---

## 18. Personal Drive

`folderId` yang dihilangkan berarti My Drive root (`root`). Semua panggilan memakai
`supportsAllDrives` dan `includeItemsFromAllDrives` agar item Shared Drive yang
terlihat oleh akun tetap terbaca.

---

## 19. Shared Folder

Gunakan folder ID sebagai identitas:

```
/drive config set defaultBackupFolder <folder-id>
```

Folder divalidasi lewat `assertFolder()` sebelum dipakai (harus ada dan bertipe folder).
Perlu dicatat: scope `drive.file` hanya memberi akses ke file yang dibuat atau dibuka
oleh aplikasi ini, jadi folder Shared Drive yang tidak pernah dibuka Ryuu akan ditolak
Google dengan 403. Pesan error menyebutkan hal ini, bukan menampilkan stack trace.

---

## 20. Lokasi credential per OS

| OS | Direktori |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/ryuu` atau `~/.config/ryuu` |
| macOS | `~/Library/Application Support/ryuu` |
| Windows | `%APPDATA%\ryuu` |

```
.config/ryuu/
├── config.json
├── .keys/google-drive.key        ← 0600, terpisah dari ciphertext
└── integrations/google-drive/
    ├── config.json
    └── credentials.enc           ← AES-256-GCM
```

`RYUU_CONFIG_DIR` (override yang sudah dipakai Ryuu) tetap berlaku.

---

## 21. Keamanan

- Token tidak pernah masuk ke context AI, log, atau output tool; `describeCredentials()`
  hanya mengembalikan metadata.
- Ciphertext dan encryption key berada di direktori berbeda; file 0600, direktori 0700.
- `RYUU_DRIVE_KEY` (hex 64 karakter atau base64 32 byte) dapat menggantikan file kunci,
  cocok untuk secret manager/VPS.
- Path lokal dari model divalidasi `Workspace.resolve()`: path absolut ditolak,
  traversal dan symlink escape ditolak, file secret diblokir.
- ZIP: nama entri absolut dan `..` ditolak, symlink tujuan ditolak, CRC32 diverifikasi,
  total ekstraksi dibatasi 8 GB.
- Backup tidak pernah menyertakan secret secara diam-diam, dan symlink tidak diikuti.

---

## 22. Error handling

Semua pesan berbahasa Indonesia dan tanpa stack trace secara default:

| Kondisi | Pesan |
| --- | --- |
| Belum login | `Jalankan /drive login terlebih dahulu` |
| Integrasi nonaktif | `Integrasi Google Drive sedang nonaktif. Jalankan /drive enable` |
| Refresh token invalid | `refresh token sudah tidak berlaku. Jalankan /drive login` |
| 403 permission | Menyebut scope `drive.file` |
| 403/429 kuota | `Kuota Google Drive habis atau rate limit API tercapai` |
| 404 | `File atau folder Google Drive tidak ditemukan` |
| Network | `Tidak dapat menghubungi Google Drive (masalah jaringan)` |
| Disk penuh | `Disk penuh: tidak ada ruang untuk menulis file` |
| ZIP rusak | `CRC arsip tidak cocok …` / `Arsip bukan ZIP yang valid` |
| Zip Slip | `Arsip berisi path traversal dan ditolak` |

---

## 23. Troubleshooting

| Gejala | Penyebab | Tindakan |
| --- | --- | --- |
| `redirect_uri_mismatch` | Redirect URI belum terdaftar | Tambahkan `https://restapi.ryuu-dev.my.id/admin/tools/drive-callback` di OAuth client Web application |
| Login sukses, tool tidak muncul | `enabled=false` | `/drive enable` |
| Tool hilang setelah restart | Belum pernah `/drive enable` | Jalankan sekali, nilainya tersimpan |
| `accessNotConfigured` | Drive API belum aktif | Aktifkan di Cloud Console |
| 403 pada file tertentu | Di luar scope `drive.file` | Buka file lewat Ryuu setelah upload |
| `Kredensial tidak dapat didekripsi` | Key berbeda/rusak | `/drive login` ulang |
| Restore berhenti | File tujuan sudah ada | Kirim `overwrite=true` |
| Backup melebihi batas | `maxUploadSize` | Naikkan atau tambah exclusion |

---

## 24. Batasan OAuth scope

Scope default `https://www.googleapis.com/auth/drive.file` hanya memberi akses ke file
yang dibuat atau dibuka oleh aplikasi ini. Konsekuensinya:

- File pribadi lain di Drive tidak terlihat oleh `drive_search`/`drive_list`.
- Shared Drive yang belum pernah dibuka Ryuu akan ditolak.
- `drive.file` **tidak** dapat dinaikkan menjadi `drive` dari command; itu keputusan
  keamanan, bukan bug. Untuk akses penuh, ubah `DEFAULT_GOOGLE_DRIVE_CONFIG.scopes`
  di source setelah meninjau risikonya.
- Google Picker tidak diimplementasikan, sehingga "membuka" file untuk aplikasi harus
  dilakukan lewat upload Ryuu sendiri.

---

## Testing

`tests/unit/google-drive.test.js` (7 test, seluruhnya lulus):

- default config, Client ID terkunci, validasi key
- penyimpanan kredensial terenkripsi + tidak ada token di metadata
- PKCE S256, state acak, URL otorisasi tanpa client secret
- roundtrip ZIP streaming, penolakan overwrite, penolakan Zip Slip
- exclusion pattern + secret hard-exclude
- lifecycle: disabled/unauthenticated tidak pernah mendaftarkan tool, risk level benar
- schema seluruh tool valid dan unik

Tidak ada klaim autentikasi sungguhan: belum ada kredensial OAuth nyata yang dipakai
saat pengujian, jadi alur login hanya diverifikasi secara struktural (URL, PKCE, state).
