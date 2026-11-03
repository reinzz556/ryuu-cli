# Integrasi GitHub — Ryuu CLI

Dokumen ini menjelaskan cara memasang, mengonfigurasi, memakai, dan menguji
integrasi GitHub pada Ryuu CLI. Integrasi terdiri dari dua bagian:

1. **Backend** (`/root/website/api`, modul `lib/github/`) — Integration Gateway
   yang memegang seluruh kredensial GitHub App dan token pengguna.
2. **Plugin CLI** (`/root/agents/ryuu/plugins/github/`) — command `/github` dan
   35 tool AI yang memanggil GitHub melalui gateway.

Tidak ada Client Secret, Private Key, Webhook Secret, access token, atau refresh
token di sisi CLI. CLI hanya memegang `cliToken` per akun yang disimpan
terenkripsi.

---

## 1. Arsitektur

```
┌──────────────────────────┐        ┌─────────────────────────────────┐
│ Ryuu CLI                 │        │ Backend Ryuu (lib/github)       │
│ plugins/github           │        │                                 │
│  /github login ──────────┼───────▶│ POST /integrations/github/connect│
│  browser / device flow   │        │  state + PKCE + URL otorisasi   │
│  polling sesi ───────────┼───────▶│ GET  /integrations/github/session│
│  cliToken (terenkripsi)  │◀───────┤  cliToken (sekali ambil)        │
│                          │        │                                 │
│  tools GitHub ───────────┼───────▶│ ALL  /integrations/github/api/* │
│                          │        │   token pengguna + safelist     │
└──────────────────────────┘        └───────────────┬─────────────────┘
                                                    │ HTTPS
                                     ┌──────────────▼──────────────┐
                                     │ github.com / api.github.com │
                                     │ GitHub App + instalasi      │
                                     └─────────────────────────────┘

GitHub ── webhook ──▶ POST /webhooks/github (signature HMAC SHA-256)
```

Prinsip:

- **Satu akun GitHub = satu record token** di backend. Tidak ada token global.
- Backend memakai penyimpanan JSON yang sudah menjadi pola proyek
  (`~/.config/ryuu/github/data/tokens.json`) dengan atomic write + lock; bukan
  database baru.
- Token disimpan dengan AES-256-GCM; kunci enkripsi terpisah dari data.
- CLI memanggil GitHub hanya lewat proxy backend, sehingga token tidak pernah
  meninggalkan server.

---

## 2. Prasyarat

- Node.js ≥ 22 di mesin CLI dan server backend.
- GitHub App sudah dibuat dan diinstal ke akun/organisasi.
- Backend dapat diakses publik pada domain yang terdaftar di GitHub App.
- `express` (sudah menjadi dependensi backend).

---

## 3. Membuat GitHub App

Buka **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**.

| Field | Nilai |
| --- | --- |
| App name | `Ryuu CLI` |
| Homepage URL | `https://restapi.ryuu-dev.my.id/site` |
| Callback URL | `https://restapi.ryuu-dev.my.id/integrations/github/callback` |
| Webhook URL | `https://restapi.ryuu-dev.my.id/webhooks/github` |
| Webhook secret | string acak panjang; simpan di konfigurasi backend |
| Expire user authorization tokens | **aktifkan** agar refresh token diterbitkan |
| Device flow | aktifkan bila ingin `login --device` |
| Request user authorization during installation | opsional |

Catat **App ID**, **Client ID**, dan buat **Client Secret** + **Private Key**
(`.pem`). Client ID bukan rahasia; Client Secret dan Private Key hanya boleh ada
di server.

### Permission minimum

| Permission | Level | Dipakai untuk |
| --- | --- | --- |
| Metadata | Read | Wajib untuk semua akses repository |
| Contents | Read | File, branch, commit, release |
| Contents | Write | Buat/ubah/hapus file, buat release |
| Issues | Read & Write | Issue dan komentar |
| Pull requests | Read & Write | PR, review, merge |
| Actions | Read | Workflow dan workflow run |
| Actions | Write | Menjalankan ulang workflow |
| Administration | Write | Membuat/mengubah repository |

Tidak meminta permission yang tidak dipakai (Secrets, Checks, Statuses,
Workflows, Packages, dll). Tidak ada tool penghapusan repository.

### Event webhook

Pilih minimal: **Push**, **Issues**, **Issue comment**, **Pull request**,
**Pull request review**, **Release**, **Installation**,
**Installation repositories**, **GitHub App authorization**.

### Instalasi

Setelah App dibuat, klik **Install App** dan pilih akun/organisasi serta
repository yang boleh diakses. Login saja tidak memberi akses ke seluruh
repository: akses adalah irisan antara permission App, persetujuan pengguna,
dan repository yang tercakup instalasi.

---

## 4. Konfigurasi backend

Default file: `~/.config/ryuu/github/server.json` (Linux:
`$XDG_CONFIG_HOME`/`~/.config`; macOS: `~/Library/Application Support`;
Windows: `%APPDATA%`). Override: `RYUU_GITHUB_CONFIG=/path/server.json`.

```json
{
  "appId": "<App ID>",
  "clientId": "<Client ID>",
  "clientSecret": "<Client Secret>",
  "privateKeyPath": "/path/ryuu-cli.private-key.pem",
  "webhookSecret": "<Webhook Secret>",
  "redirectUri": "https://<domain>/integrations/github/callback",
  "webhookUrl": "https://<domain>/webhooks/github",
  "apiVersion": "2022-11-28"
}
```

Field wajib: `appId`, `clientId`, `clientSecret`, `privateKeyPath`,
`webhookSecret`, `redirectUri`, `webhookUrl`. `apiVersion` default
`2022-11-28` (versi REST GitHub yang didukung implementasi ini).

Permission yang disarankan:

```bash
chmod 700 ~/.config/ryuu/github
chmod 600 ~/.config/ryuu/github/server.json
chmod 600 /path/ryuu-cli.private-key.pem
```

Kunci enkripsi token berada di `~/.config/ryuu/github/.keys/tokens.key` (0600)
atau dari `RYUU_GITHUB_TOKEN_KEY` (hex 64 karakter / base64 32 byte). Kunci tidak
boleh disimpan bersama file data token.

Backend membaca ulang konfigurasi saat mtime berubah; rotasi credential tidak
memerlukan restart. Jika field belum lengkap, endpoint menjawab HTTP 503 dengan
**nama field** yang belum diisi — bukan nilainya.

---

## 5. Konfigurasi CLI

CLI hanya menyimpan pengaturan non-rahasia:

```
<config>/integrations/github/config.json      (0600)
<config>/integrations/github/state.json       (0600)
<config>/integrations/github/credentials.enc  (0600, cliToken terenkripsi)
<config>/.keys/github.key                     (0600)
```

Key yang dapat diubah:

```bash
ryuu /github config set enabled true
ryuu /github config set confirmDestructive false
ryuu /github config set defaultRepo ryuu-reinzz/ryuu-cli
```

`clientId` boleh tampil (publik). `clientSecret`, `privateKeyPath`,
`webhookSecret`, `accessToken`, `refreshToken`, dan `cliToken` tidak dapat
diubah dari CLI.

---

## 6. Login

### Browser (utama)

```bash
ryuu /github login
```

Alur:

1. CLI meminta backend membuat sesi sementara (`sessionId`, `pairingSecret`,
   `state`, PKCE challenge, URL otorisasi).
2. Browser dibuka. Jika tidak ada browser, URL dicetak untuk dibuka manual.
3. Pengguna menyetujui akses di GitHub.
4. GitHub mengarahkan ke `/integrations/github/callback`.
5. Backend memvalidasi `state`, menukar `code` (client secret + PKCE verifier),
   mengambil `GET /user`, dan menyimpan token terenkripsi.
6. Backend menerbitkan `cliToken` per akun dan menandai sesi `authorized`.
7. CLI polling dengan `pairingSecret`, menerima hasil **sekali**, lalu sesi
   dihapus. Sesi kedaluwarsa setelah 10 menit.

Login otomatis mengaktifkan integrasi dan mendaftarkan tool pada sesi berjalan.

### Device flow (headless)

```bash
ryuu /github login --device
```

CLI menampilkan `verification_uri` dan `user_code`, lalu benar-benar melakukan
polling sampai GitHub menyelesaikan otorisasi (bukan hanya menampilkan kode).
Device flow harus diaktifkan pada pengaturan GitHub App.

Catatan PKCE: challenge dan verifier dikirim pada flow browser. GitHub belum
mendokumentasikan dukungan PKCE untuk OAuth App, sehingga jaminan utama adalah
`state` acak sekali pakai + Client Secret yang hanya ada di server. Dokumentasi
ini tidak mengklaim PKCE diverifikasi oleh GitHub.

---

## 7. Status, akun, dan test

```bash
ryuu /github status
ryuu /github account
ryuu /github test
```

`status` menampilkan status integrasi, login, enable/disable, respons backend,
masa berlaku access token, ketersediaan refresh token, jumlah instalasi, dan
lokasi file konfigurasi. Tidak ada token yang dicetak.

`account` menampilkan username, nama, tipe akun, URL profil, avatar, scope, dan
status autentikasi.

`test` memeriksa konfigurasi, sesi CLI, respons backend, `GET /user`, instalasi,
rate limit, App JWT/private key, dan status token. **Tidak** membuat, mengubah,
atau menghapus repository.

---

## 8. Enable dan disable

```bash
ryuu /github enable
ryuu /github disable
```

- `enable` mendaftarkan tool ke registry agent. Konfigurasi dan sesi harus valid.
- `disable` hanya melepas tool. Akun, token, dan instalasi GitHub App tetap ada.
- Tool memeriksa ulang status saat eksekusi, jadi model yang memegang daftar tool
  lama tidak bisa bertindak setelah disable.

---

## 9. Logout dan disconnect

```bash
ryuu /github logout
```

Logout:

1. Meminta backend mencabut token (`DELETE /applications/{client_id}/token`).
2. Menghapus `cliToken` lokal dan kunci enkripsi CLI.
3. Menonaktifkan integrasi.
4. Tidak menghapus repository, issue, release, atau instalasi GitHub App.

Jika backend tidak dapat dihubungi, kredensial lokal tetap dihapus dan CLI
memberi tahu bahwa token di server mungkin masih tersimpan. Untuk memutus
instalasi sepenuhnya, lakukan dari **GitHub → Settings → Applications** atau
halaman instalasi App.

---

## 10. Tools

| Kelompok | Tool |
| --- | --- |
| Akun | `github_get_me`, `github_get_user`, `github_get_rate_limit` |
| Repository | `github_list_repositories`, `github_get_repository`, `github_create_repository`, `github_update_repository`, `github_list_branches`, `github_get_branch`, `github_list_commits`, `github_get_commit`, `github_get_file_contents`, `github_create_or_update_file`, `github_delete_file`, `github_compare_commits` |
| Issue | `github_list_issues`, `github_get_issue`, `github_create_issue`, `github_update_issue`, `github_comment_issue`, `github_list_issue_comments` |
| Pull request | `github_list_pull_requests`, `github_get_pull_request`, `github_create_pull_request`, `github_update_pull_request`, `github_merge_pull_request`, `github_list_pull_request_files`, `github_review_pull_request` |
| Release | `github_list_releases`, `github_get_release`, `github_create_release` |
| Actions | `github_list_workflows`, `github_list_workflow_runs`, `github_get_workflow_run`, `github_rerun_workflow` |

Setiap tool memiliki schema input yang divalidasi registry, pemeriksaan
autentikasi, pembatasan output, dan deskripsi permission yang dibutuhkan.

Operasi yang mengubah data selalu melewati approval Ryuu:

- membuat/mengubah repository;
- membuat/mengubah/menghapus file;
- membuat/mengubah issue dan komentar;
- membuat/mengubah/merge pull request dan review;
- membuat release;
- menjalankan ulang workflow.

`github_delete_file` dan `github_merge_pull_request` berisiko `destructive`.
`confirmDestructive: false` memblokirnya sepenuhnya.

---

## 11. Token kedaluwarsa dan refresh

GitHub App dapat menerbitkan access token yang kedaluwarsa (default 8 jam) dan
refresh token (default 6 bulan) bila opsi expire user authorization tokens
aktif. Jangan mengasumsikan durasi: backend memakai `expires_in` dan
`refresh_token_expires_in` dari respons aktual.

- Backend me-refresh otomatis bila access token tinggal ≤ 5 menit.
- Refresh memakai single-flight per akun, sehingga request paralel tidak
  melakukan dua rotasi refresh token.
- Refresh token yang dirotasi disimpan; jika GitHub tidak mengirim yang baru,
  token lama dipertahankan.
- `invalid_grant`/`bad_refresh_token` menandai akun `needsReconnect`; pengguna
  diminta `/github login` lagi.
- Bila token tidak punya expiry (opsi expire dimatikan), token dipakai tanpa
  refresh dan status menampilkan “tanpa masa berlaku”.

Perintah manual:

```bash
ryuu /github test
ryuu /github status
```

`/github test` melakukan pemeriksaan; refresh paksa tersedia di endpoint backend
`POST /integrations/github/refresh` (dipakai untuk diagnostik).

---

## 12. Mengganti credential

1. **Client Secret baru**: buat di GitHub App settings, lalu perbarui
   `clientSecret` di `server.json`. File dibaca ulang otomatis (mtime).
2. **Private Key baru**: generate, simpan dengan mode 0600, perbarui
   `privateKeyPath`, lalu hapus key lama.
3. **Webhook Secret baru**: perbarui di GitHub dan `server.json`; delivery lama
   yang belum diproses akan ditolak jika signature-nya memakai secret lama.
4. **Client ID/App ID berubah**: perbarui `clientId`/`appId`, lalu login ulang.
5. **Mengganti akun pengguna**: `/github logout`, lalu `/github login`.

Tidak ada perubahan source code yang diperlukan. Jangan menaruh nilai rahasia di
dokumentasi, issue, commit, atau log.

---

## 13. Webhook

Endpoint: `POST /webhooks/github` (dipasang sebelum parser JSON global).

- Signature `X-Hub-Signature-256` (HMAC SHA-256, constant-time) wajib valid.
- `X-GitHub-Event` dan `X-GitHub-Delivery` divalidasi.
- Delivery duplikat diabaikan (`202 { duplicate: true }`).
- Event diproses asynchronous; respons `202` dikirim lebih dulu.
- Event yang didukung: `push`, `issues`, `issue_comment`, `pull_request`,
  `pull_request_review`, `release`, `installation`,
  `installation_repositories`, `github_app_authorization`.
- Handler hanya mencatat dan memperbarui data instalasi. Tidak ada aksi otomatis
  yang mengubah repository.
- Payload dicatat dalam bentuk ter-redaksi.

---

## 14. Batasan akses

- Login GitHub **tidak** berarti akses ke seluruh repository. Akses adalah
  irisan permission App, persetujuan pengguna, dan repository yang tercakup
  instalasi.
- Repository privat hanya terlihat bila instalasi mencakupnya.
- Organisasi dapat membatasi atau meninjau instalasi; administrator organisasi
  mungkin perlu menyetujui.
- Endpoint tertentu memerlukan permission tambahan (mis. Administration write
  untuk membuat repository).
- GitHub REST rate limit tetap berlaku; gunakan `github_get_rate_limit`.

---

## 15. Catatan keamanan

- Client Secret, Private Key, dan Webhook Secret hanya ada di backend.
- Token pengguna disimpan terenkripsi (AES-256-GCM); kunci terpisah dari data.
- `cliToken` disimpan sebagai hash SHA-256, maksimal 5 per akun, dan memiliki
  masa berlaku (default 30 hari).
- `pairingSecret` hanya dikembalikan ke CLI pembuat sesi dan dibandingkan
  constant-time; sesi berumur 10 menit dan hasil login hanya bisa diambil sekali.
- Proxy API memakai safelist method+path; CLI tidak bisa memanggil endpoint
  sembarang.
- Log tidak memuat Authorization header, token, atau secret.
- Approval Ryuu tidak bisa dilewati oleh tool; `confirmDestructive=false`
  menambahkan lapisan blokir di handler.
- File rahasia dan data runtime tidak masuk Git (`lib/github/data/`, `.pem`,
  `.env`, kunci).

---

## 16. Testing lokal

Backend:

```bash
cd /root/website/api
npm test
```

CLI:

```bash
cd /root/agents/ryuu
node --test tests/unit/github.test.js tests/integration/github.test.js
npm run check
```

Test memakai mock `fetch`/server lokal. **Jangan** menguji konektivitas domain
`restapi.ryuu-dev.my.id` dari VPS LXC: domain dan jaringan dikelola VPS induk.
Pengujian callback/webhook dari perangkat eksternal dapat dilakukan dengan:

```bash
curl -i "https://restapi.ryuu-dev.my.id/integrations/github/callback?state=invalid"
# harapan: 404 + halaman HTML "sesi tidak ditemukan", bukan error 500
```

---

## 17. Troubleshooting

| Gejala | Penyebab umum | Tindakan |
| --- | --- | --- |
| 503 konfigurasi belum lengkap | `server.json` belum diisi | Isi field yang disebut pada pesan |
| `invalid_client` saat callback | Client Secret salah/berputar | Perbarui `clientSecret`, login ulang |
| `redirect_uri` mismatch | Callback URL di GitHub berbeda | Samakan `redirectUri` di App dan `server.json` |
| 401 signature webhook | Webhook Secret berbeda | Samakan secret di GitHub dan backend |
| 403 akses repository | Instalasi tidak mencakup repo | Instal/ubah akses App |
| Tool tidak muncul | Belum login atau disable | `/github login`, `/github enable` |
| Token perlu login ulang | Refresh token dicabut/kedaluwarsa | `/github login` |
| Rate limit | Kuota GitHub habis | Tunggu reset, cek `/github test` |

---

## 18. Struktur file

```
/root/website/api/
├── index.js                         # memasang webhook + router
├── lib/github/
│   ├── index.js                     # factory integrasi
│   ├── config.js                    # konfigurasi server + validasi
│   ├── data/                        # hanya jika diarahkan ke repo (di-ignore)
│   ├── encryption.js                # AES-256-GCM + kunci terpisah
│   ├── store.js                     # atomic write + lock
│   ├── token-storage.js             # record per akun + cliToken hash
│   ├── session.js                   # sesi login sementara
│   ├── oauth.js                     # PKCE, exchange, refresh, device flow
│   ├── app-token.js                 # App JWT + installation token
│   ├── token-manager.js             # auto-refresh single-flight
│   ├── api.js                       # GitHub REST client
│   ├── signature.js                 # verifikasi webhook
│   ├── webhook.js                   # handler + dedupe + antrean
│   ├── router.js                    # endpoint + proxy
│   └── README.md
└── tests/github/                    # 48 test lokal

/root/agents/ryuu/
├── plugins/github/                  # plugin CLI
├── docs/github.md                   # dokumen ini
└── tests/{unit,integration}/github.test.js
```
