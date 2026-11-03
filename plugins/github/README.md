# Plugin GitHub — Ryuu CLI

Integrasi GitHub untuk agent Ryuu: akun, repository, file, issue, pull request,
release, dan GitHub Actions. Plugin ini mengikuti pola `plugins/google-drive/`
dan **tidak memegang kredensial GitHub rahasia apa pun**.

## Arsitektur singkat

```
ryuu /github login
        │  POST /integrations/github/connect (sesi + URL)
        ▼
Backend Ryuu (Integration Gateway) ──HTTPS──▶ github.com / api.github.com
        │  Client Secret, Private Key, Webhook Secret, token pengguna
        │
        └─ menerbitkan cliToken per akun
CLI menyimpan cliToken terenkripsi, lalu semua tools lewat backend.
```

- **Backend** memiliki Client Secret, Private Key, Webhook Secret, access token,
  dan refresh token.
- **CLI** hanya memiliki Client ID publik (boleh tampil), `cliToken` per akun
  (AES-256-GCM di disk), dan cache identitas akun.
- Tools tidak pernah menerima access token GitHub; backend memasangnya saat
  meneruskan request ke `api.github.com`.

## Struktur modul

| File | Tanggung jawab |
| --- | --- |
| `index.js` | Deskriptor plugin untuk host |
| `manager.js` | Lifecycle: login, logout, status, enable/disable, test |
| `config.js` | Konfigurasi non-rahasia + path OS + state cache |
| `credentials.js` | Penyimpanan `cliToken` terenkripsi |
| `auth.js` | Membuka browser + pesan kegagalan login |
| `backend.js` | HTTP client ke backend (connect, session, status, proxy) |
| `api.js` | Klien GitHub REST melalui gateway + pagination |
| `tools*.js` | 35 tool AI, dikelompokkan per domain |
| `tool-helpers.js` | Validasi owner/repo/ref/path + pembatasan output |
| `errors.js` | Error plugin + kode yang stabil |
| `command.js` | Handler `/github` |

## Konfigurasi lokal

Mengikuti direktori konfigurasi OS lewat `settingsDir()`:

```
<config>/integrations/github/config.json      (0600, non-rahasia)
<config>/integrations/github/state.json       (0600, cache status)
<config>/integrations/github/credentials.enc  (0600, cliToken terenkripsi)
<config>/.keys/github.key                     (0600, kunci enkripsi CLI)
```

Linux memakai `$XDG_CONFIG_HOME` atau `~/.config`, macOS memakai
`~/Library/Application Support`, Windows memakai `%APPDATA%`.

Key yang dapat diubah:

```
/github config set enabled true|false
/github config set autoRefresh true|false
/github config set confirmDestructive true|false
/github config set defaultRepo owner/repo
```

Client Secret, Private Key, Webhook Secret, endpoint backend, dan token tidak
dapat diubah dari CLI dan tidak pernah ditulis ke file konfigurasi.

## Command

```
/github login              login lewat browser (utama)
/github login --device     device flow untuk mesin headless
/github logout             putuskan akun + hapus kredensial lokal
/github status             status integrasi, akun, token, backend
/github account            identitas akun GitHub terhubung
/github test               diagnostik aman (tanpa mengubah repository)
/github enable             daftarkan tool ke agent
/github disable            lepas tool (akun/token tetap)
/github config             tampilkan konfigurasi non-rahasia
/github config set ...     ubah satu key
```

`/github status`, `/github account`, dan `/github config` tidak pernah
menampilkan Client Secret, Private Key, Webhook Secret, access token, refresh
token, atau `cliToken`.

## Tool yang tersedia (35)

**Akun (3)** — `github_get_me`, `github_get_user`, `github_get_rate_limit`

**Repository (12)** — `github_list_repositories`, `github_get_repository`,
`github_create_repository`, `github_update_repository`, `github_list_branches`,
`github_get_branch`, `github_list_commits`, `github_get_commit`,
`github_get_file_contents`, `github_create_or_update_file`,
`github_delete_file`, `github_compare_commits`

**Issue (6)** — `github_list_issues`, `github_get_issue`,
`github_create_issue`, `github_update_issue`, `github_comment_issue`,
`github_list_issue_comments`

**Pull request (7)** — `github_list_pull_requests`, `github_get_pull_request`,
`github_create_pull_request`, `github_update_pull_request`,
`github_merge_pull_request`, `github_list_pull_request_files`,
`github_review_pull_request`

**Release (3)** — `github_list_releases`, `github_get_release`,
`github_create_release`

**GitHub Actions (4)** — `github_list_workflows`,
`github_list_workflow_runs`, `github_get_workflow_run`,
`github_rerun_workflow`

Tidak ada tool penghapusan repository. Penghapusan file dan merge pull request
berisiko `destructive` dan selalu melewati approval Ryuu.

## Approval & keamanan

- `risk: read` berjalan tanpa prompt.
- Semua tool `write` memakai `requiresApproval: true`.
- `github_delete_file` dan `github_merge_pull_request` memakai
  `risk: destructive` (approval wajib).
- `confirmDestructive: false` memblokir operasi destruktif di handler, bukan
  hanya mengandalkan prompt.
- Tool memanggil `plugin.requireClient()` setiap kali, sehingga model yang
  memegang daftar tool lama tidak bisa bertindak setelah `/github disable`.
- Output dibatasi: list dipotong, body panjang diringkas, isi file > 200 KB
  hanya metadata.

## Testing

```bash
cd /root/agents/ryuu
node --test tests/unit/github.test.js tests/integration/github.test.js
```

Test memakai mock backend lokal. Tidak ada koneksi ke domain produksi dan tidak
ada perubahan data GitHub nyata.

## Troubleshooting

| Gejala | Tindakan |
| --- | --- |
| `Belum ada akun GitHub yang terhubung` | `/github login` |
| `Integrasi GitHub sedang nonaktif` | `/github enable` |
| `Sesi CLI sudah berakhir` | `/github login` lagi |
| `Akses ditolak` pada repository privat | Pastikan GitHub App diinstal ke akun/organisasi dan repository itu dipilih |
| `Rate limit` | Tunggu reset; cek `/github test` |
| `confirmDestructive=false` | `/github config set confirmDestructive true` |

Dokumentasi lengkap: [`../../docs/github.md`](../../docs/github.md).
