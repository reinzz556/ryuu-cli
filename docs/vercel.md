# Integrasi Vercel

Ryuu CLI dapat mengelola akun, team, project, deployment, environment variable,
domain, DNS, Edge Config, dan monitoring Vercel lewat **Vercel OAuth Integration**.
Tidak ada Personal Access Token dan tidak ada Client Secret di mesin pengguna.

```
CLI (/vercel login)
  → backend membuat sesi + state
  → browser: halaman instalasi Vercel
  → callback backend (code ditukar server-side)
  → token Vercel disimpan terenkripsi, per akun/instalasi
  → CLI menerima token CLI (vcli_…) lewat polling ber-pairing
  → AI Agent memanggil tool → backend → Vercel REST API
```

## 1. Membuat integrasi di Vercel

1. Buka **Vercel Dashboard → Integrations → Create Integration**.
2. Isi **Redirect URL**:
   `https://restapi.ryuu-dev.my.id/integrations/vercel/callback`
3. Isi **Webhook URL**:
   `https://restapi.ryuu-dev.my.id/webhooks/vercel`
4. Pilih scope sesuai tabel di bagian 6. Scope minimal yang disarankan:
   `user`, `team`, `project`, `deployment`, `project-env-vars`, `domain`,
   `edge-config`, `deployment-check`.
5. Simpan **Client ID** dan **Client Secret**. Client ID boleh dibagikan;
   Client Secret **hanya** masuk ke konfigurasi backend.
6. Isi **Configuration URL**:
   `https://restapi.ryuu-dev.my.id/integrations/vercel/configure`
   dan **Import Resource URL**:
   `https://restapi.ryuu-dev.my.id/integrations/vercel/import`.

### Client Secret

Tidak ada field Webhook Secret terpisah pada konfigurasi Vercel. Sesuai
dokumentasi resmi, webhook integrasi ditandatangani dengan **Integration Secret
(Client Secret)** memakai HMAC-SHA1 atas raw body di header
`x-vercel-signature`. Backend dapat memakai `webhookSecret` terpisah bila Anda
melakukan rotasi.

Simpan konfigurasi di server (mode `0600`, di luar Git):

`~/.config/ryuu/vercel/server.json` (Linux),
`~/Library/Application Support/ryuu/vercel/server.json` (macOS),
`%APPDATA%\ryuu\vercel\server.json` (Windows), atau file yang ditunjuk
`RYUU_VERCEL_CONFIG`.

```json
{
  "clientId": "oac_QIA7cjvSFkhNHbGKCxl2vkR9",
  "clientSecret": "<ISI_MANUAL_SETELAH_ROTASI>",
  "redirectUri": "https://restapi.ryuu-dev.my.id/integrations/vercel/callback",
  "webhookUrl": "https://restapi.ryuu-dev.my.id/webhooks/vercel",
  "slug": "ryuu-cli"
}
```

`slug` adalah nama integrasi pada URL Vercel
(`https://vercel.com/integrations/<slug>/new`). Tanpa slug, login tetap bisa
memakai endpoint authorize, tetapi status akan menandai instalasi belum lengkap.

## 2. Menghubungkan akun

```bash
ryuu /vercel login              # buka browser
ryuu /vercel login --no-browser # cetak URL saja (server/headless)
ryuu /vercel status
ryuu /vercel account
```

Login membuka halaman instalasi Vercel. Setelah disetujui, CLI menerima token
CLI yang terikat pada satu akun dan satu configuration. Token Vercel tetap di
server dan disimpan terenkripsi per configuration, sehingga beberapa pengguna
dan beberapa team tidak saling menimpa.

Instalasi pada team/project berbeda: jalankan `/vercel login` lagi dan pilih
team tersebut. `/vercel status` menampilkan configuration dan team yang aktif.

## 3. Command

```bash
# Autentikasi & status
/vercel login [--no-browser] | logout | status | account
/vercel enable | disable | test | configure [--open]
/vercel config [show] | config set <key> <value>

# Team
/vercel teams | team <team_id>

# Project
/vercel projects [--search nama] [--limit n]
/vercel project <nama>
/vercel project create <nama> [--framework nextjs] [--git owner/repo] [--type github]
/vercel project delete <id> [--yes]

# Deployment
/vercel deployments [project] [--target production] [--limit n]
/vercel deployment <id>
/vercel deploy <project> --git owner/repo --ref main [--target production]
/vercel deploy <project> --file ./index.html --file ./app.js
/vercel cancel <id>
/vercel promote <id> [--project p] [--yes]
/vercel rollback <id> [--project p] [--yes]

# Environment variable
/vercel env list <project>
/vercel env add <project> <KEY> <value> [--target production,preview]
/vercel env update <project> <env_id> [--value baru] [--target production]
/vercel env remove <project> <env_id|KEY> [--yes]

# Domain & DNS
/vercel domains
/vercel domain add|remove|verify <project> <domain>
/vercel dns list <domain>
/vercel dns add <domain> <TYPE> <name> <value> [--ttl 3600]
/vercel dns update <record_id> [--value v] [--ttl n]
/vercel dns remove <record_id> [--yes]

# Edge Config
/vercel edge list | get <id> | create <slug> | update <id> <slug> | delete <id>
/vercel edge items <id>
/vercel edge set <id> <key> <value>

# Monitoring
/vercel logs <deployment_id> [--problems] [--limit n]
/vercel events <deployment_id>
/vercel checks <deployment_id>
```

Pembuatan deployment **wajib** menyebut sumber yang valid (Git atau file);
nama project saja tidak cukup menurut API Vercel. Nilai environment variable
tidak pernah ditampilkan setelah dikirim.

## 4. AI Agent Tools (46)

Semua tool terdaftar hanya saat integrasi `enabled` dan pengguna sudah login.
Operasi `write`/`destructive` melewati approval Ryuu yang sudah ada.

| Tool | Risk | Scope Vercel |
| --- | --- | --- |
| `vercel_get_user` | read | `user` |
| `vercel_list_teams`, `vercel_get_team`, `vercel_list_team_members` | read | `team` |
| `vercel_list_projects`, `vercel_get_project` | read | `project` |
| `vercel_create_project`, `vercel_update_project`, `vercel_delete_project` | write/destructive | `project` |
| `vercel_pause_project`, `vercel_unpause_project` | write | `project` |
| `vercel_list_deployments`, `vercel_get_deployment` | read | `deployment` |
| `vercel_create_deployment`, `vercel_cancel_deployment`, `vercel_promote_deployment`, `vercel_rollback_deployment` | write | `deployment` |
| `vercel_delete_deployment` | destructive | `deployment` |
| `vercel_get_deployment_events`, `vercel_get_deployment_logs` | read | `deployment` |
| `vercel_list_env`, `vercel_get_env_targets` | read | `project` |
| `vercel_create_env`, `vercel_update_env` | write | `project-env-vars` |
| `vercel_delete_env` | destructive | `project-env-vars` |
| `vercel_list_domains`, `vercel_get_domain` | read | `domain` |
| `vercel_add_domain`, `vercel_verify_domain` | write | `domain` + `project` |
| `vercel_remove_domain` | destructive | `domain` + `project` |
| `vercel_list_dns_records`, `vercel_create_dns_record`, `vercel_update_dns_record` | read/write | `domain` |
| `vercel_delete_dns_record` | destructive | `domain` |
| `vercel_list_edge_configs`, `vercel_get_edge_config`, `vercel_get_edge_config_items` | read | `edge-config` |
| `vercel_create_edge_config`, `vercel_update_edge_config`, `vercel_update_edge_config_items` | write | `edge-config` |
| `vercel_delete_edge_config` | destructive | `edge-config` |
| `vercel_list_deployment_checks` | read | `deployment-check` |
| `vercel_create_deployment_check`, `vercel_update_deployment_check` | write | `deployment-check` |
| `vercel_list_webhooks` | read | `project`/team |
| `vercel_get_billing` | read | `billing` |

### Approval

Ryuu meminta approval sebelum: menghapus project/deployment/environment
variable/domain/DNS record/Edge Config, membatalkan deployment, promote,
rollback, serta perubahan environment variable, DNS, domain, dan Edge Config.
Operasi baca tidak meminta approval tambahan.

### Contoh permintaan natural language

- “Cek semua project Vercel-ku.”
- “Project mana yang deployment terakhirnya gagal?”
- “Kenapa deployment API gagal? Periksa log-nya.”
- “Deploy project website ke production.”
- “Tambahkan environment variable API_URL ke project dashboard.”
- “Domain apa saja yang terhubung ke project website?”
- “Rollback website ke deployment sebelumnya.”

## 5. Konfigurasi CLI

Lokasi mengikuti OS:

| OS | Path |
| --- | --- |
| Linux | `~/.config/ryuu/integrations/vercel/` |
| macOS | `~/Library/Application Support/ryuu/integrations/vercel/` |
| Windows | `%APPDATA%\ryuu\integrations\vercel\` |

```
integrations/vercel/
├── config.json        # non-rahasia, 0600
├── credentials.enc    # cliToken terenkripsi AES-256-GCM, 0600
└── state.json         # cache status, 0600
.keys/vercel.key       # kunci 32 byte, 0600
```

`RYUU_CONFIG_DIR` memindahkan seluruh direktori konfigurasi (dipakai test).
`RYUU_VERCEL_KEY` (hex 64 karakter/base64) dapat menggantikan file kunci.

`config.json` dibuat **otomatis** dengan nilai default (mode `0600`) saat belum
ada — cukup ketik `/vercel …`, tidak perlu menulis file sendiri. File yang ada
tetapi tidak valid **tidak** ditimpa: `/vercel …` menampilkan blok
`KONFIGURASI VERCEL TIDAK VALID` berisi path, penyebab, dan contoh JSON yang
benar, lalu berhenti tanpa menjalankan subcommand. Hapus file tersebut dan Ryuu
membuatnya ulang pada `/vercel` berikutnya.

CLI **tidak** menyimpan Client Secret, access token Vercel, atau refresh token.
`/vercel config set clientSecret …` ditolak.

Key yang dapat diubah: `enabled`, `autoRefresh`, `confirmDestructive`,
`defaultTeam`, `defaultProject`.

## 6. Troubleshooting

| Gejala | Penyebab & solusi |
| --- | --- |
| `Konfigurasi integrasi Vercel belum tersedia` | `server.json` belum ada. Isi `clientId`, `clientSecret`, `redirectUri`, `webhookUrl`; restart tidak perlu (dibaca lazy). |
| `field belum diisi: clientSecret` | Rotasi belum diselesaikan. Isi Integration Secret di `server.json`. |
| Callback: `state OAuth` / `Sesi login tidak ditemukan` | Sesi kedaluwarsa (10 menit) atau state sudah dipakai. Jalankan `/vercel login` lagi. |
| Callback 404 setelah instalasi | `redirectUri` di Vercel harus sama persis dengan konfigurasi backend. |
| Status: instalasi belum lengkap | Login tanpa `configurationId`. Pasang integrasi pada team/project, lalu login lagi. |
| HTTP 403 dari Vercel | Scope integrasi kurang, instalasi dinonaktifkan, atau `teamId` tidak sesuai. Periksa Integrations Console dan `/vercel status`. |
| HTTP 429 | Rate limit Vercel. CLI/backend melakukan retry singkat untuk GET; tunggu lalu ulangi. |
| `Sesi CLI sudah berakhir` | Token CLI kedaluwarsa/dicabut. `/vercel login` lagi. |
| Env var berubah tetapi aplikasi lama | Environment variable berlaku setelah deployment baru. |
| `confirmDestructive=false` memblokir operasi | `/vercel config set confirmDestructive true`. |

Webhook: signature salah/secret berbeda → 401, event tidak diproses. Event
`integration-configuration.removed` menghapus token instalasi tersebut.

## 7. Memutuskan koneksi

```bash
ryuu /vercel logout
```

Token Vercel di backend dihapus dari penyimpanan terenkripsi dan kredensial lokal
dihapus. Project/deployment/domain tidak diubah. Untuk mencabut instalasi
sepenuhnya, hapus integrasi dari Vercel Integrations Console (webhook
`integration-configuration.removed` akan membereskan sisa token).

## 8. Batasan yang jujur

- Vercel tidak mendokumentasikan refresh token maupun endpoint revoke token
  untuk integrasi; Ryuu tidak mengarang keduanya.
- `POST /v1/projects/{id}/pause|unpause`, `POST /v9/projects/{p}/rollback/{d}`,
  dan `PATCH /v1/edge-config/{id}` tidak tercantum pada daftar endpoint/scope
  integrasi publik; error Vercel diteruskan apa adanya.
- `import` tidak diperlukan karena integrasi ini tidak membuat integration
  resource; endpoint tetap menjawab dengan jelas.
- Test otomatis memakai mock dan loopback; pengujian live memerlukan
  konfigurasi server dan akun Vercel sungguhan.
