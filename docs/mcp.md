# MCP di Ryuu

MCP (**Model Context Protocol**) adalah cara standar memberi agent akses ke tool,
resource, dan prompt yang disediakan proses atau layanan lain. Di Ryuu, MCP adalah
integrasi **tambahan**: tool bawaan dan plugin native (GitHub, Google Drive, Vercel)
tetap berjalan seperti biasa, dan tool MCP didaftarkan ke registry yang sama sehingga
model dapat memilihnya tanpa perubahan format tool calling provider.

```
Ryuu Core
├── Built-in tools          (read_file, run_command, web_search, …)
├── Native plugins          (GitHub, Google Drive, Vercel)
├── MCP Client              (src/mcp/)
│   ├── server A (stdio)
│   ├── server B (Streamable HTTP + bearer)
│   └── server C (Streamable HTTP + OAuth)
└── Approval gate
```

Ditambahkan di versi ini:

- klien MCP resmi (`@modelcontextprotocol/sdk`) untuk **STDIO** dan **Streamable HTTP**;
- autentikasi **none**, **bearer token**, dan **OAuth** (discovery, dynamic client
  registration, PKCE, token exchange, refresh token);
- `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`,
  `prompts/get`, serta notifikasi `tools/list_changed`;
- command `/mcp` lengkap dengan wizard interaktif;
- tool MCP otomatis masuk ke agent loop, dengan namespace, risk level, approval gate,
  dan tampilan warna sendiri;
- penyimpanan konfigurasi di direktori konfigurasi Ryuu yang sudah ada, dengan
  pemisahan rahasia dan permission `0600`.

---

## 1. Di mana konfigurasi disimpan

Ryuu memakai direktori konfigurasi yang sama dengan `config.json` (Linux/BSD:
`~/.config/ryuu`, macOS: `~/Library/Application Support/ryuu`, Windows:
`%APPDATA%\ryuu`). Variabel `RYUU_CONFIG_DIR` tetap menimpa lokasi tersebut.

```
<config-dir>/ryuu/
├── config.json                 # provider, model, agent, web search
└── mcp/
    ├── servers.json            # definisi server — TANPA rahasia (0600)
    ├── credentials/
    │   └── <nama>.json         # token/header/env — 0600, tidak pernah dicetak
    └── logs/
        └── <nama>.log          # log koneksi & tool, sudah disunting (0600)
```

- `servers.json` aman untuk dibaca, dicadangkan, atau ditempel ke issue: nilainya
  tidak berisi token.
- Nilai `env`, nilai header, bearer token, dan state OAuth hanya ada di
  `credentials/<nama>.json`.
- Semua penulisan bersifat atomik (file sementara + rename) dan menolak symlink.
- Log ditulis dengan redaksi sebelum menyentuh disk: token, header, dan nilai env
  tidak pernah masuk log; hanya nama key yang dicatat.

## 2. Menambahkan server

### 2.1 Wizard interaktif

```text
/mcp add
/mcp add github
```

Wizard menanyakan:

1. nama server (huruf kecil, angka, `_`, `-`);
2. transport (`stdio` atau `http`);
3. untuk stdio: command, argumen, working directory opsional, dan environment
   variable `KEY=value`;
4. untuk http: URL, header tambahan, dan metode autentikasi;
5. ringkasan konfigurasi (nilai rahasia ditampilkan sebagai `(redacted)`);
6. konfirmasi simpan;
7. uji koneksi, lalu pendaftaran tool bila berhasil.

Bearer token **tidak diketik ke terminal** (terminal akan menggemakan input).
Wizard meminta *path file* yang berisi token, membacanya, lalu menyimpannya sebagai
`0600`. Token dapat diganti kapan saja:

```text
/mcp token github ~/.secrets/github-mcp-token   # file dibaca, tidak pernah dicetak
```

`/mcp add` membutuhkan terminal interaktif. Pada mode non-interaktif (mis. `ryuu
"tugas"`), sunting `servers.json`/credentials secara langsung seperti contoh di bawah.

### 2.2 Contoh STDIO

```json
{
  "version": 1,
  "servers": {
    "filesystem": {
      "name": "filesystem",
      "transport": "stdio",
      "command": "/usr/bin/node",
      "args": ["/opt/mcp/filesystem-server.js", "/home/user/projects"],
      "cwd": "/home/user/projects",
      "envKeys": [],
      "url": "",
      "headerNames": [],
      "auth": { "type": "none" },
      "enabled": true,
      "autoConnect": true,
      "allowPrivateNetwork": false,
      "connectTimeoutMs": 15000,
      "callTimeoutMs": 60000,
      "maxResultBytes": 262144,
      "toolRisk": {},
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z",
      "last": { "state": "disconnected" }
    }
  }
}
```

Catatan:

- `command` harus berupa path absolut atau nama yang ada di `PATH`. Server dijalankan
  **langsung** (tanpa shell), jadi `;`, `|`, `$()` di dalam argumen tidak
  ditafsirkan sebagai shell.
- Environment anak hanya berisi baseline aman (`PATH`, `HOME`, `TMPDIR`, `LANG`, …)
  plus key yang Anda tulis di `credentials/<nama>.json` (`env`). Variabel `RYUU_*`,
  `NVIDIA_*`, dan kredensial provider tidak diwariskan.
- `cwd` harus ada; default: direktori kerja Ryuu.

### 2.3 Contoh Streamable HTTP + bearer

`servers.json`:

```json
{
  "version": 1,
  "servers": {
    "vercel-mcp": {
      "name": "vercel-mcp",
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "headerNames": ["X-API-Key"],
      "auth": { "type": "bearer", "header": "X-API-Key" },
      "enabled": true,
      "autoConnect": true,
      "allowPrivateNetwork": false
    }
  }
}
```

`credentials/vercel-mcp.json` (buat dengan permission `0600`):

```json
{
  "headers": { "X-API-Key": "isi-token-di-sini" },
  "token": "isi-token-di-sini"
}
```

`auth.header` menentukan header yang dipakai. Untuk `Authorization`, Ryuu menambahkan
prefix `Bearer ` bila belum ada.

### 2.4 Contoh OAuth

```json
{
  "name": "remote-oauth",
  "transport": "http",
  "url": "https://mcp.example.com/mcp",
  "auth": { "type": "oauth" },
  "enabled": true,
  "autoConnect": false
}
```

Jalankan `/mcp connect remote-oauth` di sesi interaktif. Ryuu akan:

1. membaca metadata protected-resource dan authorization-server;
2. mendaftarkan client (dynamic client registration, bila didukung);
3. membuka browser (atau mencetak URL) untuk authorization code + PKCE;
4. menukar code menjadi token dan menyimpannya di `credentials/<nama>.json`;
5. menghubungkan transport dan mendaftarkan tool.

`autoConnect: false` disarankan untuk server OAuth: startup otomatis tidak boleh
membuka browser. Token yang tersimpan dipakai ulang (termasuk refresh token) pada
koneksi berikutnya tanpa interaksi.

> OAuth milik integrasi native Ryuu (GitHub/Drive/Vercel) dimediasi backend Ryuu
> untuk integrasi tersebut dan tidak dapat dipakai untuk server MCP sembarang.
> Karena itu klien ini memakai alur OAuth standar MCP di atas SDK resmi, bukan
> sistem OAuth baru yang terpisah dari protokol.

## 3. Command `/mcp`

Semua subcommand tersedia di antarmuka baris dan di `--tui`; command tetap bisa
dipakai saat tugas berjalan.

| Command | Fungsi |
| --- | --- |
| `/mcp` | Daftar server + status koneksi. |
| `/mcp help` | Bantuan lengkap. |
| `/mcp list` | Sama dengan `/mcp`. |
| `/mcp status [nama]` | Ringkasan `N connected · M configured`, atau info satu server. |
| `/mcp add [nama]` | Wizard interaktif. |
| `/mcp remove <nama>` | Hapus konfigurasi, credentials, dan log (minta konfirmasi). |
| `/mcp enable <nama>` | Aktifkan dan hubungkan. |
| `/mcp disable <nama>` | Putuskan dan unregistrasi tool; konfigurasi tetap. |
| `/mcp connect <nama>` | Hubungkan dan daftarkan tool (memicu OAuth bila perlu). |
| `/mcp disconnect <nama>` | Tutup koneksi dan unregistrasi tool. |
| `/mcp restart <nama>` | Putuskan lalu hubungkan ulang dari awal. |
| `/mcp reconnect <nama>` | Alias `restart`. |
| `/mcp refresh <nama>` | Baca ulang tools/resources/prompts dari server. |
| `/mcp test <nama>` | Koneksi sementara, laporkan capability; tidak memanggil tool. |
| `/mcp info <nama>` | Konfigurasi publik, capability, jumlah tool, path; tanpa rahasia. |
| `/mcp tools <nama>` | Tool, risk, dan status approval. |
| `/mcp resources <nama> [uri]` | Daftar resource, atau baca satu. |
| `/mcp prompts <nama> [prompt] [k=v]` | Daftar prompt, atau render satu. |
| `/mcp logs <nama> [n]` | Baris log terakhir (default 80). |
| `/mcp config` | Path, default timeout, dan permission file. |
| `/mcp token <nama> <file>` | Ganti bearer token dari file privat. |

Contoh:

```text
/mcp
# MCP Servers: 2 connected · 3 configured
#   github        ● Connected      12 tool(s)
#   google-drive  ● Connected      4 tool(s)
#   vercel        ⊘ Disabled

/mcp tools github
# Tools exposed by github (12):
#   mcp:github:search_repositories   read         auto    ...
#   mcp:github:create_issue          write        approval ...
#   mcp:github:delete_repository     destructive  approval ...

/mcp resources google-drive fixture://readme
/mcp prompts github triage issue=42
/mcp logs github 120
```

## 4. Bagaimana tool MCP masuk ke agent

1. Client terhubung dan memanggil `tools/list`.
2. Setiap tool dipetakan menjadi definisi tool Ryuu:
   - nama terdaftar: `mcp_<server>_<tool>` (huruf kecil, aman untuk format fungsi
     provider, maksimal 61 karakter; bentrok diberi akhiran `_2`, `_3`, …);
   - nama tampilan: `mcp:<server>:<tool>`;
   - JSON Schema input disanitasi ke subset yang benar-benar divalidasi Ryuu
     (`type`, `properties`, `required`, `enum`, `items`, batas angka/panjang,
     `pattern`, `additionalProperties`); keyword yang tidak didukung dibuang, bukan
     ditebak;
   - deskripsi diberi label `[MCP server "nama"]` dan dipotong agar prompt tetap
     kecil. Deskripsi tetap berasal dari server pihak ketiga dan tidak pernah
     dianggap sebagai instruksi sistem.
3. Tool digabung dengan tool bawaan dan plugin lain. Nama yang bentrok dengan tool
   yang sudah ada tidak pernah menimpa tool tersebut.
4. Model memilih tool; registry mengarahkan panggilan ke koneksi server yang benar.
5. Hasil dinormalisasi: teks, gambar (dilampirkan sebagai image ke provider yang
   mendukung), embedded resource, resource link, audio (keterangan saja), dan
   `structuredContent`. Ukuran dibatasi `maxResultBytes` sebelum mencapai model.
6. Hasil kembali ke agent loop sebagai tool message biasa.

Tampilan pemanggilan:

```text
[mcp:github:search_repositories]
[mcp:google-drive:search_files]
[mcp:vercel:list_deployments]
```

Hanya kata `mcp` berwarna **kuning**; `:<server>:<tool>` berwarna **biru langit**.
Tool plugin native tetap memakai warna plugin (biru langit penuh) dan tool bawaan
tetap biru; tidak ada warna yang diubah untuk keduanya. Format yang sama dipakai di
terminal interaktif, `--tui`, output streaming, dan pemanggilan berulang. Pada mode
`--plain` identitasnya tetap `mcp:server:tool` tanpa ANSI.

## 5. Risk dan approval gate

Risk ditentukan berurutan:

1. override pengguna di `toolRisk` (per server, per tool);
2. `destructiveHint: true` dari server → `destructive`;
3. nama tool mengandung kata destruktif (`delete`, `destroy`, `drop`, `purge`,
   `reset`, …) → `destructive`;
4. kata eksekusi (`run`, `exec`, `shell`, `command`, …) → `exec`;
5. kata perubahan (`create`, `update`, `write`, `send`, `deploy`, …) → `write`;
6. kata baca (`list`, `get`, `search`, `read`, `inspect`, …) → `read`;
7. selain itu → `write`.

`readOnlyHint: true` **sendiri tidak cukup** menurunkan risk: anotasi berasal dari
server yang sama dengan tool-nya. Tool yang tidak jelas read-only akan melewati
approval gate, dan tool destruktif ditandai `critical` (ditolak pada mode
non-interaktif kecuali `--auto-approve` diberikan secara eksplisit).

Contoh tampilan approval:

```text
mcp:github:create_issue

This action is performed by an external MCP server, not by Ryuu's built-in tools.

[Approve] [Reject]
```

- Tool `read` mengikuti kebijakan proyek: tidak meminta approval.
- Tool `write`, `exec`, dan `destructive` selalu melalui `ApprovalManager` yang sama
  dengan tool bawaan; memanggil MCP langsung tidak melewati gate.
- Argumen divalidasi terhadap schema sebelum eksekusi; tool yang tidak terdaftar
  ditolak (`UNKNOWN_TOOL`).
- Approval ditolak → model menerima `APPROVAL_DENIED` dan loop tetap berjalan.

## 6. Timeout, reconnect, dan shutdown

| Kejadian | Perilaku |
| --- | --- |
| Handshake lambat | Dibatasi `connectTimeoutMs` (default 15 dtk). |
| Tool lambat | Dibatasi `callTimeoutMs` (default 60 dtk). |
| Tugas dibatalkan (`/cancel`, Ctrl+C) | Panggilan MCP dibatalkan segera; koneksi tetap bisa dipakai. |
| Server menutup koneksi | Status menjadi `disconnected`; tool tetap terdaftar agar panggilan berikutnya memberi error yang jelas. |
| Tool dipanggil saat terputus | Satu percobaan reconnect otomatis; bila gagal, error menyebut server dan langkah pemulihan. |
| `notifications/tools/list_changed` | Tool, resource, dan prompt dibaca ulang otomatis. |
| Ryuu keluar / `app.close()` | Semua koneksi ditutup; proses anak STDIO dihentikan (SIGTERM, lalu SIGKILL bila perlu). |
| Server mati saat startup | Dicatat sebagai `error` di `servers.json` dan log; startup Ryuu tidak gagal. |

Koneksi yang di-autostart diberi waktu singkat saat startup; server yang belum selesai
tetap terhubung di latar belakang dan tool-nya muncul begitu siap.

## 7. Keamanan

- **Permission**: direktori `0700`, `servers.json` dan credentials `0600`; penulisan
  atomik dan menolak symlink.
- **Rahasia tidak pernah dicetak**: `/mcp info` hanya menampilkan nama env/header dan
  status `set (redacted)`; `/mcp config` hanya path dan mode; log disunting sebelum
  ditulis; token tidak masuk prompt model.
- **STDIO tanpa shell**: command di-resolve ke executable nyata, argumen divalidasi,
  spawn langsung (`shell: false`). Tidak ada evaluasi `sh -c` dari konfigurasi.
- **Environment minimal**: rahasia Ryuu dan key provider tidak diwariskan ke server
  pihak ketiga.
- **SSRF**: URL HTTP melewati guard yang sama dengan `read_url` (loopback, LAN,
  link-local, metadata cloud ditolak). Server lokal/private harus diizinkan eksplisit
  dengan `allowPrivateNetwork: true`; redirect dibatasi ke origin yang sama.
- **Header injection**: nama/CR-LF header divalidasi sebelum dikirim.
- **Batas respons**: `maxResultBytes` (default 256 KB) dan jumlah item list dibatasi;
  hasil lebih besar dipotong dengan penanda, bukan membanjiri konteks.
- **Tidak ada eksekusi otomatis**: default risk `write`, approval gate berlaku, dan
  anotasi server tidak bisa menurunkan risk.
- **Deskripsi tool tidak tepercaya**: diberi label asal dan dipotong; hasil tool juga
  diberi catatan bahwa isinya data, bukan instruksi kebijakan.

## 8. Referensi field `servers.json`

| Field | Arti |
| --- | --- |
| `name` | Nama unik server (2–32 karakter, huruf kecil/angka/`_`/`-`). |
| `transport` | `stdio` atau `http`. |
| `command`, `args`, `cwd` | Hanya STDIO. Path executable di-resolve saat connect. |
| `url` | Hanya HTTP; `http(s)://`, tanpa kredensial di URL. |
| `envKeys`, `headerNames` | Nama key saja; nilainya di credentials. |
| `auth` | `{ "type": "none" \| "bearer" \| "oauth", "header": "Authorization" }`. |
| `enabled` | Server nonaktif tidak pernah dihubungkan. |
| `autoConnect` | Hubungkan saat Ryuu mulai (default `true`). |
| `allowPrivateNetwork` | Izinkan URL loopback/LAN untuk server ini. |
| `connectTimeoutMs` | 1000–120000, default 15000. |
| `callTimeoutMs` | 1000–300000, default 60000. |
| `maxResultBytes` | 1 KB–4 MB, default 256 KB. |
| `toolRisk` | Override risk per tool, mis. `{ "search_files": "read" }`. |
| `last` | Status koneksi terakhir, capability, jumlah tool; tanpa rahasia. |

`credentials/<nama>.json`:

```json
{
  "env": { "API_KEY": "…" },
  "headers": { "X-API-Key": "…" },
  "token": "…",
  "oauth": {
    "clientInformation": { "…": "…" },
    "tokens": { "access_token": "…", "refresh_token": "…" },
    "codeVerifier": "…",
    "discoveryState": { "…": "…" }
  }
}
```

## 9. Menonaktifkan dan menghapus

```text
/mcp disable github     # putuskan + unregistrasi tool; config & token tetap
/mcp enable github      # hubungkan lagi
/mcp remove github      # hapus config, credentials/<nama>.json, dan log
```

Menonaktifkan tidak menghapus apa pun dan tidak memutus plugin native. Menghapus
server MCP juga tidak menyentuh `config.json`, sesi, atau integrasi native.

## 10. Troubleshooting

| Gejala | Penyebab & solusi |
| --- | --- |
| `MCP is not available in this session` | Integrasi dimatikan untuk run ini (`mcp: false` pada embed/test). Jalankan Ryuu normal. |
| `Unknown MCP server: x` | Nama tidak ada di `servers.json`. `/mcp list`. |
| `MCP command not found or not executable` | `command` bukan path absolut dan tidak ada di `PATH`. Gunakan path absolut. |
| `handshake failed` / `ECONNREFUSED` | Server belum siap, URL salah, atau proses gagal start. Cek `/mcp logs x`. |
| `rejected the credentials (HTTP 401/403)` | Token/header salah atau kedaluwarsa. `/mcp token x <file>`, lalu `/mcp reconnect x`. |
| `needs OAuth authorization` | Jalankan `/mcp connect x` di sesi interaktif (browser dibutuhkan). |
| `MCP_URL_BLOCKED` | URL mengarah ke loopback/LAN/metadata. Set `allowPrivateNetwork: true` hanya bila server memang lokal. |
| `timed out` | Naikkan `callTimeoutMs`/`connectTimeoutMs`; cek server atau `/mcp test x`. |
| Tool tidak muncul | `/mcp refresh x`; cek `/mcp tools x` dan `/mcp status x`. |
| Tool baru tidak terlihat | Server harus mengirim `notifications/tools/list_changed`, atau jalankan `/mcp refresh x`. |
| `MCP tool ... failed` | Server mengembalikan `isError`. Pesan server diteruskan (dipotong) ke model dan log. |
| Nama tool berakhiran `_2` | Nama bentrok dengan tool lain; Ryuu menambahkan akhiran alih-alih menimpa. |
| `MCP_STORE_INVALID` | `servers.json` bukan JSON valid. File tidak diubah; perbaiki manual. |
| Permission warning di `/mcp config` | File/direktori terbaca pengguna lain. `chmod 700 <dir>/mcp && chmod 600 <dir>/mcp/*.json`. |

Diagnostik cepat:

```text
/mcp config
/mcp status
/mcp test <nama>
/mcp logs <nama> 200
```

## 11. Batasan yang diketahui

- OAuth interaktif membutuhkan browser (atau URL yang bisa dibuka manual). Alur
  client-credentials non-interaktif belum diekspos sebagai konfigurasi; server yang
  mewajibkannya perlu disesuaikan.
- Client certificate (mTLS) belum didukung; gunakan bearer/OAuth di belakang proxy
  bila diperlukan.
- Resource dan prompt tersedia lewat `/mcp resources` dan `/mcp prompts`, serta API
  manajer. Keduanya tidak otomatis menjadi tool model (hanya `tools/list` yang
  didaftarkan), agar daftar tool model tidak membengkak.
- Anotasi tool dari server tidak dipercaya untuk menurunkan risk. Bila sebuah tool
  read-only bernama tidak lazim tetap meminta approval, tambahkan override
  `toolRisk` untuk server itu.
- Isi hasil tool MCP adalah data dari pihak ketiga. Ryuu memberi catatan eksplisit ke
  model, tetapi tidak dapat menjamin server tidak mengembalikan teks menyesatkan.
- Pengujian otomatis memakai server fixture lokal (STDIO, Streamable HTTP + bearer,
  dan OAuth lengkap). Server produksi pihak ketiga tetap memerlukan kredensial nyata;
  tidak ada klaim bahwa akun eksternal telah diuji.

## 12. Pengujian

Test MCP berjalan lokal tanpa akun atau jaringan internet:

```bash
npm test                                   # seluruh suite
node --test tests/integration/mcp*.test.js # hanya MCP
```

Yang dicakup:

- STDIO: handshake, `tools/list`, `tools/call`, resource, prompt, env, notifikasi,
  disconnect/reconnect, pembersihan proses anak;
- Streamable HTTP: bearer, 401, SSRF, reconnect;
- OAuth: discovery, dynamic registration, PKCE, token exchange, penyimpanan token,
  pemakaian ulang token;
- konversi schema, klasifikasi risk, normalisasi hasil (teks/gambar/resource/audio),
  error dan timeout, pembatalan;
- approval gate dan integrasi agent loop;
- seluruh subcommand `/mcp`, wizard, penyimpanan/permission, dan warna terminal/TUI;
- kompatibilitas dengan tool bawaan dan plugin native (registry bersama).
