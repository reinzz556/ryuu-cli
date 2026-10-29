# Ryuu Agent CLI

Agen coding AI otonom yang setiap aksi tulis/eksekusi harus disetujui dulu, untuk
terminal Anda. Ryuu memeriksa workspace, menyusun rencana, memanggil tool,
menunjukkan apa yang sedang dilakukannya, dan melaporkan apa yang berubah —
didukung oleh beberapa provider AI melalui antarmuka Chat Completions yang
kompatibel dengan OpenAI: NVIDIA Integrate API dan Token Harbor sudah tersedia,
dan provider lain bisa Anda daftarkan sendiri lewat konfigurasi.

```
  ╭─ ◢ RYUU // AGENT OS ──────────────────────────────────────────── v0.3.1 ─╮
  │                                                                          │
  │                   ██████╗ ██╗   ██╗██╗   ██╗██╗   ██╗                    │
  │                   ██╔══██╗╚██╗ ██╔╝██║   ██╗██║   ██╗                    │
  │                   ██████╔╝ ╚████╔╝ ██║   ██╗██║   ██╗                    │
  │                   ██╔══██╗  ╚██╔╝  ██║   ██╝██║   ██╗                    │
  │                   ██║  ██║   ██║   ╚██████╔╝╚██████╔╝                    │
  │                   ╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═════╝                     │
  │                                                                          │
  │                 autonomous coding intelligence · NVIDIA                  │
  │                                                                          │
  ├─ ◆ TELEMETRY ────────────────────────────────────────────────────────────┤
  │ model      minimaxai/minimax-m3.1-flash                                 │
  │ workspace  /path/to/your/project                                         │
  │ runtime    Node.js v25.x · linux                                         │
  │ access     ask · shell is not a sandbox                                  │
  │ log        /path/to/your/project/.ryuu/logs/agent.log                    │
  ╰──────────────────────────────────────────────────────────────────────────╯
  click a block or /expand N   !cmd shell   ⌃C cancel   /help commands   /exit quit
```

![Contoh UI mode normal Ryuu](https://cdn.zass.in/JLdbvD233M.jpg)

## Fitur

- **Loop agent yang eksplisit** — model → tool call tervalidasi → persetujuan →
  eksekusi nyata → hasil tool → model, sampai ada jawaban akhir, pembatalan, atau
  batas durasi tugas. Jumlah langkah tidak dibatasi secara bawaan;
  `agent.maxSteps` menambahkan batas opsional.
- **Tool workspace yang nyata** — list, tree, read, search, file info, diff,
  create, edit, write, move, delete, inspeksi Git, dan ringkasan project.
- **Manajer proses** — menjalankan command dengan stdout/stderr asli, exit code,
  sinyal, durasi, timeout, buffer terbatas, server background, dan penghentian
  yang bersih.
- **Gerbang persetujuan (approval gate)** — setiap aksi tulis, eksekusi, dan
  destruktif diperiksa sebelum dijalankan. Tool read-only tidak pernah meminta
  konfirmasi. Aksi yang ditolak dilaporkan kembali ke model.
- **HUD kaya telemetri** — banner gradien `RYUU // AGENT OS`, panel telemetri,
  feed aktivitas, panel reasoning live, kartu persetujuan, dan dasbor ringkasan
  run. Baris aktivitas yang selalu menyala melaporkan fase, waktu berjalan per
  fase, **total waktu run, nomor langkah, tool mana yang sedang berjalan dan
  berapa lagi mengantre (`writing edit_file src/x.js (2/5)`), jumlah token
  prompt/completion live, dan latensi token pertama**.
  Setiap pemanggilan model mencetak barisnya sendiri `◇ model 9.4s · 21.3k↑ 388↓ tok · first token 1.8s`,
  command yang berjalan mengalirkan stdout/stderr ke wilayah live, setiap command
  yang selesai mencetak kotak output `$ argv` bernomor (pratinjau lima baris;
  klik bloknya, atau jalankan `/expand <id>`, untuk log utuh yang disimpan beserta
  scrolling internal, dan `/logs <id>` sesudahnya), dan setiap perubahan file
  mencetak baris `-`/`+` yang benar-benar berubah. Blok reasoning dinomori dengan
  cara yang sama dan tetap bisa dibuka ulang selama sesi ini. Tempel panjang
  (1000+ karakter) diringkas menjadi placeholder `> [Pasted text #N X chars]` di
  composer, sementara model tetap menerima teks lengkapnya.
- **Tanpa batas retry buatan** — koneksi provider yang putus atau giliran model
  kosong akan dicoba ulang dengan heartbeat di layar dan backoff eksponensial
  sampai model menjawab, tenggat tugas lewat, atau Anda membatalkan. Giliran
  kosong tidak pernah mengakhiri tugas dengan galat; `agent.maxRecoveryAttempts`
  tetap bisa memasang batas keras.
- **Composer tetap bisa dipakai saat run** — prompt digambar di bawah wilayah
  aktivitas live dan dicetak ulang di setiap baris yang dialirkan, jadi slash
  command bisa diketik dan dijalankan sementara agent sedang berpikir,
  menjalankan tool, atau mengalirkan jawabannya (`/status`, `/expand 4`,
  `/model 2`, `/cancel`, …). Prompt tugas baru ditolak sampai run selesai,
  sehingga dua run tidak bisa tumpang tindih.
- **Session worklog** — fakta terverifikasi (file yang dibaca beserta rentang
  barisnya, file yang diubah, command dan exit code, temuan, rencana) disimpan
  sepanjang sesi dan diteruskan ke tugas berikutnya, sehingga tindak lanjut
  melanjutkan pekerjaan alih-alih mengulang analisis. File yang sudah dibaca dan
  tidak berubah di disk tidak dibaca lagi; agent diberi tahu bahwa isinya sudah
  diketahui.
- **Jawaban Markdown-native** — heading, bold/italic, inline code, link, list,
  kutipan, code fence dengan penyorotan sintaks, dan tabel yang mengecil,
  membungkus, atau berpindah ke tata letak vertikal agar sesuai lebar terminal.
- **Perlindungan workspace** — penolakan escape path/symlink, pemblokiran file
  rahasia, pengecualian direktori hasil-generate, batas ukuran, penulisan
  atomik, dan deteksi penulisan basi.
- **Memori lokal** — memori percakapan lintas tugas dalam satu sesi (lihat dengan
  `/memory`, pulihkan yang tersimpan dengan `/resume <id>`), ID sesi dan
  riwayat, transkrip yang disunting (redacted), cache ringkasan project,
  pemadatan konteks, dan undo stack yang terbatas pada sesi.
- **Mode gagal yang aman** — konfigurasi hilang, input tidak valid, galat
  provider, batas laju, dan tool calling yang tidak didukung menghasilkan pesan
  yang bisa ditindaklanjuti alih-alih stack trace (pakai `--debug` untuk stack).
- **Mode layar penuh (`--tui`)** — antarmuka opsional bertipe retained-mode yang
  menggambar ulang seluruh percakapan dari sebuah model, alih-alih menambahkan
  baris ke scrollback: setiap reasoning, output `run_command`, dan jawaban punya
  keadaan terbuka/tertutupnya sendiri, sehingga beberapa blok bisa dibuka
  sekaligus dan yang lama tetap bisa dibuka sepanjang sesi. Composer adalah bagian
  dari frame yang sama, dan transkrip menggul di dalam aplikasi
  (`PgUp`/`PgDn`, roda mouse, klik untuk melipat/membuka) alih-alih sejarah milik
  terminal. Blok dipisahkan baris kosong dan diberi warna (prosa putih, Markdown
  dan tabel biru langit, nama tool kuning, reasoning hijau, kegagalan merah),
  layar pembuka memakai banner ASCII yang sama dengan antarmuka baris, prompt
  berupa gradien pink → blue `ryuu > `, dan setiap baris membungkus sesuai lebar
  terminal. Tanpa flag ini tidak ada yang berubah.
- **Shell Anda sendiri (`/bash`, `!cmd`)** — jalankan sendiri sebuah command di
  workspace tanpa melibatkan model: output lengkap dicetak segera, dan command,
  exit code, serta outputnya disimpan sebagai giliran pengguna di sesi, sehingga
  tugas berikutnya tahu apa yang Anda jalankan dan apa yang terjadi.
- **Mode plain** — dipakai otomatis ketika stdout bukan TTY, atau dengan
  `--plain`.

## Persyaratan

| Persyaratan | Detail |
| --- | --- |
| Node.js | **25.x dianjurkan dan terverifikasi.** Minimum yang didukung: 22.x (versi mayor lebih tua tidak diuji). |
| npm | 10+ (sudah menyertai Node 25). |
| OS | Linux, macOS, atau Windows. Perilaku pensinyalan proses berbeda di Windows; lihat [Perilaku proses](#perilaku-proses). |
| Jaringan | Dibutuhkan untuk panggilan model langsung. Git opsional dan hanya dipakai untuk `/diff` dan `inspect_git`. |
| Kunci provider | Dibutuhkan untuk panggilan langsung. Kunci disimpan di `config.json` di bawah `providers.<id>.apiKey` (`nvidia`, `tokenharbor`), diisi lewat `ryuu --settings`. |

Instal Node 25 dengan [nvm](https://github.com/nvm-sh/nvm):

```bash
nvm install 25
nvm use 25
node --version    # v25.x
```

Di Windows, pakai nvm-windows atau installer resmi Node.js, lalu verifikasi dengan
`node --version` di PowerShell.

## Instalasi dan konfigurasi

```bash
# paket npm, versi terbaru
npm install -g @ryuu-reinzz/ryuu-cli@latest
ryuu --version

# atau tanpa instalasi global
npx @ryuu-reinzz/ryuu-cli@latest --version
```

Dari source (untuk pengembangan):

```bash
npm install
node src/index.js --version
```

Setelah terpasang, simpan kunci provider di `config.json` (owner-only, di luar
repo) — file itu dibuat otomatis pada run pertama:

```bash
ryuu --settings
# lalu isi baris providers.nvidia.apiKey dengan kunci asli
```

Tidak ada file `.env` dan tidak ada variabel environment: **semua konfigurasi
berasal dari `config.json`**. Saat pertama dijalankan tanpa file itu, Ryuu
membuatnya otomatis berisi semua kunci yang bisa diatur dengan nilai kosong —
nilai kosong berarti memakai bawaan katalog, jadi Anda hanya perlu mengisi kunci
provider. File dibuat mode `0600`, berada di luar repo, dan tidak pernah dicetak
balik oleh CLI (API key selalu `••••••••`).

Ambil kunci NVIDIA di <https://build.nvidia.com/> dan kunci Token Harbor di
<https://tokenharbor.ai/>. Jangan pernah meng-commit kunci asli, menempelkannya
ke issue, atau memasukkannya ke log. CLI tidak pernah mencetak kunci: `/config`
menampilkan `set (redacted)`, dan log/sesi sudah melewati proses penyingkatan
(redaction). Kunci satu provider tidak pernah dikirim ke provider lain.

Pilih provider aktif secara eksplisit (opsional):

```bash
# permanen: ubah baris provider / providerModel.<id> dengan --settings
ryuu --settings

# atau per run
ryuu --provider tokenharbor --model deepseek-v4.1-flash:free "tugas"
```

Tanpa pilihan eksplisit, Ryuu memakai `nvidia` bila kuncinya ada; jika tidak,
provider pertama yang punya kunci. Provider yang dipilih dengan `/provider`
disimpan di `.ryuu/preferences.json` workspace itu dan menimpa `config.json`
untuk workspace tersebut.

### Verifikasi instalasi

```bash
ryuu --doctor          # pemeriksaan offline, tanpa panggilan API
ryuu --doctor --live   # satu permintaan nyata yang kecil (memakai kuota)
```

Hasil offline yang diharapkan dengan kunci valid: runtime, config, endpoint,
workspace, direktori state, dan Git lolos; konektivitas berupa `SKIP` sampai Anda
memakai `--live`.

## Menjalankan

```bash
ryuu                      # antarmuka terminal interaktif (instalasi npm)
npm start                 # dari source
node src/index.js         # sama saja
```

Binary `ryuu` bisa dipakai dari direktori mana pun setelah instalasi global:

```bash
cd /path/to/another/project
ryuu
ryuu "Summarize this project"
```

Saat dijalankan di luar project ini, `ryuu` tetap memakai folder saat ini sebagai
workspace dan membaca `config.json` milik pengguna, sehingga kunci dan batasan
tidak perlu diulang di setiap direktori.

Di prompt interaktif, ketik tugas lalu tekan Enter sekali untuk mengirimnya. Untuk
tugas beberapa baris, akhiri baris dengan `\` lalu teruskan; baris berikutnya tanpa
`\` menyelesaikannya. Slash command (`/help`, `/model`, `/exit`, …) berjalan
segera.
Selama tugas berjalan, composer tetap aktif: slash command (beserta argumennya)
dieksekusi segera, dan hanya prompt tugas baru yang ditolak dengan
`A task is already running...` sampai run selesai atau dihentikan `/cancel`.
Berpikir, reasoning, tool call, persetujuan, dan jawaban yang dialirkan tetap
berjalan sementara output command dicetak di atas prompt.

Menjalankan satu tugas tanpa REPL:

```bash
ryuu "List the files in src and summarize the architecture"
ryuu "Fix the failing test in tests/util.test.js, then run npm test"
echo "Explain the error in build.log" | ryuu
```

Sesi non-interaktif tidak punya prompt untuk persetujuan, jadi penulisan dan
command **ditolak secara bawaan**. `--yes` menyetujui otomatis penulisan file
(command tetap butuh persetujuan interaktif). Pakai `--auto-approve` untuk
menyetujui otomatis **semua** aksi — termasuk command shell — agar agent bisa
menyelesaikan pekerjaan tanpa pengawasan:

```bash
ryuu --auto-approve "Fix the failing test, then run npm test"
```

Eksekusi shell tetap bukan sandbox; hanya pakai `--auto-approve` pada tugas yang
Anda percaya.

### Opsi CLI

| Opsi | Fungsi |
| --- | --- |
| `-h`, `--help` | Menampilkan penggunaan. |
| `-v`, `--version` | Menampilkan versi. |
| `--task "..."` | Tugas sekali jalan eksplisit (tugas posisional juga bisa). |
| `--workspace <path>` | Override workspace untuk run ini. |
| `--provider <id>` | Override provider untuk run ini, mis. `tokenharbor`. |
| `--model <id>` | Override model untuk run ini. |
| `--max-steps <n>` | Batas langkah agent opsional (`0` = tanpa batas, bawaan). |
| `-y`, `--yes` | Menyetujui otomatis penulisan file untuk sesi ini. |
| `--read-only` | Menolak setiap aksi tulis, eksekusi, dan destruksi. |
| `--doctor` | Diagnostik offline. |
| `--live` | Bersama `--doctor`: satu permintaan konektivitas nyata. |
| `--settings` | Editor pengaturan global baris bernomor (tanpa menjalankan agent). |
| `--settings --tui` | Editor pengaturan layar penuh (butuh TTY interaktif). |
| `--settings --list` | Mencetak pengaturan yang bisa diedit lalu keluar. |
| `--tui` | UI layar penuh retained-mode (butuh TTY interaktif; diabaikan dengan `--plain`). |
| `--plain` | Output plain, tanpa spinner atau gaya ANSI. |
| `--no-color` | Menonaktifkan warna. |
| `--debug` | Log debug dan stack trace. |

### Pengaturan global (`ryuu --settings`)

Semua pengaturan milik pengguna tinggal di satu file yang terbaca dari direktori
kerja mana pun — tidak ada `.env` dan tidak ada variabel environment:

```bash
ryuu --settings            # editor baris bernomor
ryuu --settings --tui      # editor layar penuh (butuh TTY)
ryuu --settings --list     # cetak daftar, tanpa masuk mode edit
ryuu --settings --help     # bantuan khusus pengaturan
```

Lokasi file mengikuti konvensi platform dan bisa dialihkan dengan
`RYUU_CONFIG_DIR` (berguna di mesin tanpa home tetap atau di test):

| Platform | Lokasi bawaan |
| --- | --- |
| Linux/BSD | `$XDG_CONFIG_HOME/ryuu/config.json` atau `~/.config/ryuu/config.json` |
| macOS | `~/Library/Application Support/ryuu/config.json` |
| Windows | `%APPDATA%\ryuu\config.json` |

**Editor baris.** Daftar bernomor menampilkan nilai saat ini, dengan API key
selalu disamarkan (`••••••••`). Perintahnya: `<nomor> <nilai baru>`, `/list`,
`/show <nomor>`, `/reset <nomor>` (meminta konfirmasi), `/help`, dan `/exit`.
Nilai boleh mengandung spasi; semuanya setelah nomor dipertahankan. Setiap
perubahan divalidasi lalu **langsung disimpan** (read-modify-write), jadi
terminal yang tertutup mendadak tidak menghilangkan perubahan yang sudah lolos.
Jika penulisan gagal, editor menyebut nilai itu `NOT saved` dan mempertahankan
nilai valid terakhir; satu kunci tidak pernah menghapus kunci lain atau properti
yang tidak dikenal. `/reset` adalah cara mengosongkan kunci rahasia — tidak
perlu memasukkan placeholder.

**Editor TUI.** `--settings --tui` membuka layar alternatif (bukan agent): daftar
di kiri/atas, panel deskripsi dan batasan di bawahnya, `↑↓`/`PgUp`/`PgDn` untuk
navigasi, `←/→` untuk memilih provider dan model katalog (mengetik tetap bisa
memasukkan id khusus), `Enter` membuka/menyimpan, `Esc` membatalkan edit (dan
`Esc` lagi keluar), `Ctrl+C` keluar. Raw mode, layar alternatif, dan listener
selalu dipulihkan saat keluar, termasuk setelah galat; tanpa TTY perintah gagal
dengan pesan jelas dan tidak pernah menjalankan agent.

**Presedensi** (terkuat lebih dulu): flag CLI (`--provider`, `--model`,
`--max-steps`) → `.ryuu/preferences.json` workspace → `config.json` → bawaan
katalog. Perubahan file berlaku pada run berikutnya. Satu-satunya variabel
environment yang masih dibaca adalah `RYUU_CONFIG_DIR`, yang menentukan letak
file ini.

**Dibuat otomatis.** Jika file belum ada, run pertama (termasuk `--doctor`)
langsung membuatnya berisi `version`, `provider`, `providers`,
`providerModel`, `extraProviders`, `agent`, dan `webSearch` dengan setiap kunci
bernilai kosong. Nilai kosong divalidasi sebagai bawaan, sehingga file yang baru
dibuat tidak mengubah perilaku apa pun; file yang sudah ada — termasuk yang JSON-
nya rusak — tidak pernah ditimpa.

**Provider dan model.** Baris kunci, base URL, dan model dibuat dari katalog
provider yang sama dengan runtime. Provider tambahan dari `extraProviders`
(lihat [Menambah provider sendiri](#menambah-provider-sendiri-extraproviders))
otomatis mendapat baris `providers.<id>.apiKey`, `providers.<id>.baseURL`, dan
`providerModel.<id>`.

**Keamanan, backup, dan pemulihan.** File ditulis atomik (file sementara di
direktori yang sama, fsync, lalu rename) dengan izin `0600` pada POSIX; path yang
berupa symlink ditolak. JSON yang rusak **tidak pernah ditimpa**: mode
`--settings` berhenti dengan pesan yang menyebut path-nya, sedangkan startup
normal hanya memberi peringatan lalu memakai bawaan. Untuk
memulihkan, perbaiki JSON-nya atau pindahkan file ke samping, lalu jalankan
`ryuu --settings` lagi. Hanya nilai yang Anda ubah yang ditulis; kunci yang
tidak ada memakai bawaan. Jangan meng-commit file ini — lokasinya di luar repo,
tetapi tetap berisi kredensial.

**Pemecahan masalah.** `Permission denied` berarti direktori tidak bisa ditulis:
arahkan `RYUU_CONFIG_DIR` ke lokasi yang bisa ditulis. Nilai yang ditolak
menyebut batasannya (mis. `agent.maxSteps must be between 0 and 100000`), dan
kesalahan format JSON menyebut path serta tidak mengubah file.

### UI layar penuh (`--tui`)

```bash
ryuu --tui
```

![Contoh UI mode TUI Ryuu](https://cdn.zass.in/5hjUEOV2xB.jpg)

Antarmuka bawaan menambahkan baris ke scrollback terminal dan melupakan setiap
barisnya. `--tui` justru menyimpan percakapan sebagai data: setiap item punya id
stabil, tanda terbuka/tertutup, dan teks lengkap di memori, dan setiap frame
digambar dari model tersebut. Di sinilah perilaku blok menjadi mungkin:

| Aksi | Hasil |
| --- | --- |
| Klik sebuah prompt (`▸ TASK … ⧉ copy`) | Menyalin prompt itu ke clipboard terminal. |
| Klik sebuah blok kode (header `js … ⧉ copy`) | Menyalin isi blok kode itu — hanya kodenya, tanpa penanda fence — ke clipboard terminal. Berlaku di UI baris maupun `--tui`. |
| Klik blok reasoning / `run_command` / shell | Menukar keadaan terbuka/tertutup di tempat; setiap blok menyimpan keadaan sendiri, sehingga beberapa bisa tetap terbuka. |
| `PgUp`, `PgDn`, roda mouse | Menggul transkrip di dalam aplikasi (scrollback terminal sendiri tidak dipakai). |
| `/expand <id>` | Membuka blok yang sudah tergulir keluar dari tampilan. `/expand` tanpa id mendaftarkannya. |
| `Esc` | Melipat setiap blok yang terbuka, atau melompat kembali ke bawah. |
| `Enter` | Mengirim baris; `↑`/`↓` memanggil riwayat, `←`/`→`, `Home`/`End` menyunting composer. |
| `Ctrl+Y` | Menyalin prompt yang terakhir Anda kirim. `/copy [n]` menyalin yang lebih lama (`n` = berapa prompt ke belakang). |
| `Ctrl+C` | Membatalkan tugas atau command shell yang berjalan; dua kali untuk keluar. |

#### Tampilan dan rasa

Setiap blok dibuka dengan header kecil (`▸ TASK`, `◆ response`, `⚙ Using tools`,
`◈ reasoning`, `◆ PLAN`, `▸ run_command`) dan blok dipisahkan baris kosong
serta garis pada gradien **pink → violet → biru langit**, sehingga perubahan jenis
terlihat sekilas. Tool call berurutan berbagi satu blok dan satu header
`⚙ Using tools` (dengan jumlah pemanggilan) tanpa pembatas di antaranya, karena
keduanya aktivitas sejenis. Warna membawa jenis baris:

| Baris | Warna |
| --- | --- |
| Header blok (`⚙ Using tools`, `◈ reasoning`, `◆ response`) | Gradien pink → blue (tool), putih tebal (response), glif hijau (reasoning) |
| Jawaban assistant dan prosa biasa | Putih |
| Heading, daftar, link, inline code, code fence, tabel Markdown | Biru langit |
| Header tugas, rencana, prompt persetujuan | Violet / amber |
| Isi reasoning (`◈ reasoning #N`) | Hijau, dengan baris status putih (`chars · live · partial`) |
| Nama tool (`✓ read_file`, `▸ run_command #N`) | Kuning |
| Nama tool yang gagal (`✕ run_command`) | Merah tebal, dengan outputnya merah-redup |
| Baris command `$` dan header shell | Biru langit |
| Galat runtime dan aksi yang ditolak | Merah / amber |
| Input composer | Kelabu, dengan `ryuu` pada gradien pink → blue dan ` > ` sesudahnya |

Pertanyaan (persetujuan, kelanjutan) dicetak di atas composer alih-alih
menggantikan prompt. Status bar mewarnai setiap segmen secara terpisah (fase,
langkah, tool, token, posisi gulir). Semuanya — telemetri banner, output command,
diff, pemberitahuan, dan composer — membungkus sesuai lebar terminal alih-alih
terpotong atau tergulir keluar dari tampilan. Palet naik ke truecolor ketika
terminal mendukungnya (`--no-color` tetap mematikannya).

Tombol salin (`⧉ copy` di setiap prompt dan blok kode, `Ctrl+Y`, atau `/copy [n]`) menulis teks
dengan **OSC 52**, sehingga terminal itulah yang memiliki clipboard: tanpa proses
anak `pbcopy`/`xclip`/`clip.exe`, dan bisa dipakai lewat SSH. Terminal yang tidak
menerapkan OSC 52 mengabaikan sekuensnya; status bar tetap melaporkan apa yang
dikirim beserta jumlah karakternya.

Versi yang tampil di banner, header TUI, dan `--version` dibaca dari
`package.json` saat runtime, sehingga sebuah rilis hanya perlu menaikkan file itu.

Ia butuh TTY sungguhan. Dengan `--plain`, output yang dipipe, atau sesi
non-interaktif, flag diabaikan dengan peringatan dan antarmuka baris normal
dipakai.

### Menjalankan shell Anda sendiri (`/bash`, `!cmd`)

Baris yang dimulai dengan `!` adalah command shell, bukan prompt:

```text
!git status
!npm test
/bash npm test              # hal yang sama, ditulis panjang
```

Command berjalan di workspace dengan izin Anda sendiri (tanpa prompt
persetujuan, tidak ada yang dikirim ke model), dan stdout/stderr yang tersimpan
dicetak lengkap — pratinjau `run_command` memang untuk tool call milik model,
bukan untuk shell Anda sendiri. Output yang sangat panjang menyimpan ekor
hasil tangkapan dan menyatakan bahwa ia terpotong.

Command, exit code, durasi, dan outputnya ditambahkan ke sesi sebagai giliran
pengguna, sehingga tugas berikutnya sudah tahu apa yang Anda jalankan, apa yang
dicataknya, dan apakah gagal. `/memory` menampilkan giliran itu; `/clear`
membuangnya.

`--read-only` menolak baris shell, dan `Ctrl+C` membatalkan command yang masih
berjalan (seluruh grup proses disinyalkan, sehingga `npm test` tidak selamat
darinya).

## Di dalam CLI

Apa pun yang tidak dimulai dengan `/` dikirim ke agent sebagai tugas; apa pun
yang dimulai dengan `!` dijalankan sebagai command shell Anda sendiri.

| Command | Keterangan | Catatan |
| --- | --- | --- |
| `/help [command]` | Mendaftarkan command atau menampilkan detail. | |
| `/exit` | Keluar dan menghentikan proses anak. | Juga `Ctrl+C` dua kali. |
| `/clear` | Melupakan memori percakapan agar tugas berikutnya mulai bersih. | Sesi tersimpan tidak disentuh. |
| `/memory [clear]` | Menampilkan apa yang diingat agent antar-tugas. | Dibatasi `agent.maxContextChars`. |
| `/worklog` | Menampilkan fakta terverifikasi (file dibaca/diubah, command, temuan) yang akan dipakai agent alih-alih membaca ulang. | Dihapus oleh `/clear`. |
| `/resume <session-id>` | Memulihkan memori percakapan sebuah sesi tersimpan. | Daftar id dengan `/history`. |
| `/status` | Provider, model, endpoint, status kunci, workspace, batas, jumlah proses/undo, tugas terakhir. | |
| `/provider [user <name> \| add <name> <url> [apiKey] \| del <name>]` | Mendaftarkan provider beserta status kunci, berpindah provider, atau menambah/menghapus provider sendiri. | Riwayat percakapan dan worklog tetap. Pilihan disimpan di `.ryuu/preferences.json`; `--provider` menimpa per run. Provider sendiri disimpan di `config.json`. |
| `/model [n]` | Mendaftarkan model milik provider aktif secara bernomor, atau berpindah model menurut nomor. | Disimpan per provider di `.ryuu/preferences.json`; tetap ada setelah restart. `--model` menimpa per run. |
| `/addmodel <provider> <model-id>` | Menambahkan id model ke daftar `/model` milik satu provider. | Provider sendiri menyimpannya di `config.json`; provider bawaan di `.ryuu/preferences.json`. Id tidak diperiksa ke server: id salah akan gagal saat dipakai, dan itu risiko pengguna. |
| `/delmodel <provider> <model-id>` | Membuang id yang ditambahkan lewat `/addmodel` dari satu provider. | Model bawaan katalog tidak bisa dibuang. Membuang model saat ini tetap menyimpannya untuk sesi ini. |
| `/cmodel <name>` | Mengeset id model apa pun langsung, tanpa menambahkannya ke daftar. | Alias: `/custommodel`. Aturan tanpa-pemeriksaan sama seperti `/addmodel`. |
| `/workspace` | Menampilkan satu workspace yang boleh disentuh sesi ini. | Berpindah di tengah sesi sengaja tidak didukung. |
| `/files [path]` | Mendaftarkan sebuah direktori. | File rahasia/direktori hasil-generate disembunyikan. |
| `/tree [path]` | Pohon direktori dengan batas. | |
| `/tools` | Tool terdaftar, risiko, kebutuhan persetujuan. | |
| `/copy [n]` | Menyalin prompt yang sudah Anda kirim ke clipboard terminal. | `n` menghitung mundur dari yang terbaru (bawaan: yang terakhir). Bekerja di kedua antarmuka; memakai OSC 52. |
| `/bash <command>` | Menjalankan sendiri command shell di workspace. | Output lengkap; command dan output masuk ke konteks sesi. Sama dengan baris yang dimulai `!`. |
| `/web [status\|providers\|test\|enable <id>\|disable <id>]` | Status pencarian web multi-provider, daftar kapabilitas, uji koneksi, dan aktif/nonaktif sesi. | `test` hanya memeriksa koneksi dan penemuan tool; tidak menjalankan kueri pencarian. |
| `/processes` | Proses yang berjalan dan terbaru. | |
| `/logs [id]` | Output proses, atau lokasi file log. | |
| `/expand [block-id]` | Mendaftarkan blok reasoning/`run_command`, atau membuka satu secara penuh. | Bisa juga dengan mengklik blok; `Esc` atau klik lain menutup panel. Blok tetap tersedia sepanjang sesi. |
| `/cancel [process-id]` | Membatalkan tugas aktif atau menghentikan proses. | Bekerja saat tugas berjalan; command tetap tersedia sepanjang waktu. |
| `/history` | Sesi tersimpan terbaru. | Disunting (redacted), lokal saja. |
| `/sessions [list\|show <id>\|delete <id>\|clear]` | Mengelola riwayat sesi. | `clear` meminta konfirmasi di mode interaktif. |
| `/diff` | Diff perubahan agent, atau `git diff` sebagai cadangan. | |
| `/undo [confirm]` | Mengembalikan perubahan file terakhir oleh agent. | Lihat [Undo](#undo). |
| `/config` | Konfigurasi efektif, kunci disunting. | |
| `/doctor [live]` | Diagnostik; `live` membuat satu permintaan API. | |

### Provider dan model (`/provider`, `/model`, `/addmodel`, `/delmodel`)

Provider adalah endpoint API beserta kuncinya; model adalah id yang dikirim ke
endpoint itu. Daftar keduanya dideklarasikan di katalog provider, bukan di loop
agent, sehingga menambah model atau provider tidak menyentuh agent core.

| Provider | Nama | Base URL | Kunci | Model bawaan | Kapabilitas yang diumumkan |
| --- | --- | --- | --- | --- | --- |
| `nvidia` | NVIDIA Integrate API | `https://integrate.api.nvidia.com/v1` | `providers.nvidia.apiKey` | `minimaxai/minimax-m3.1-flash` (ke-6 di `/model`) | streaming, tools, reasoning, multimodal |
| `tokenharbor` | Token Harbor | `https://tokenharbor.ai/v1` | `providers.tokenharbor.apiKey` | `deepseek-v4.1-flash:free` | streaming, tools, reasoning |

Memilih provider dan model:

```bash
ryuu --provider tokenharbor                            # default model provider itu
ryuu --provider tokenharbor --model deepseek-v4.1-flash:free
```

Di dalam sesi:

```text
/provider                                         # daftar provider, status kunci, model bawaan
/provider add river https://api.river.ai/v1 rv_…  # tambah provider OpenAI-compatible
/addmodel river deepseek-ai/DeepSeek-V4.1-Flash-1017  # tambah model untuk provider itu
/provider user river                              # pindah provider; riwayat & worklog tetap
/provider del river                               # hapus provider yang Anda tambahkan
/model                                            # daftar model provider aktif
/model 2                                          # pindah model menurut nomor
/addmodel nvidia model-baru                       # tambah id ke provider bawaan
/delmodel nvidia model-baru                       # buang id yang ditambahkan
```

- `/provider` hanya menampilkan `key set (redacted)` atau
  `no key (providers.<id>.apiKey)`; nilai kunci tidak pernah dicetak. Provider
  tanpa kunci tidak bisa dipilih dan pesannya menyebut baris `config.json` yang
  harus diisi.
- Berpindah provider tidak menghapus memori percakapan atau worklog. Pilihan
  provider dan model per provider disimpan di `.ryuu/preferences.json` milik
  workspace saat ini; `--provider`/`--model` hanya berlaku untuk satu run dan
  tidak menulis pilihan tersimpan.
- Hanya format id yang divalidasi (huruf, angka, `. _ : / -`, sampai 200 karakter,
  maksimal 100 id tambahan **per provider**). Ketersediaan, kuota, ukuran
  konteks, dan dukungan tool calling model **tidak** diperiksa. Daftar model
  adalah id yang ditawarkan CLI, bukan jaminan model itu aktif di server.
- `/provider add <name> <url> [apiKey]` menyimpan provider ke `extraProviders`
  di `config.json` dan kuncinya ke `providers.<name>.apiKey`. Argumen ketiga
  opsional; tanpa itu, isi kuncinya lewat `ryuu --settings`. Memanggil `add`
  lagi dengan nama yang sama dan kunci baru akan memperbarui kuncinya.
- `/provider del <name>` hanya menghapus provider yang Anda tambahkan, beserta
  kunci dan model tersimpannya. Provider bawaan (`nvidia`, `tokenharbor`) dan
  provider yang sedang aktif tidak bisa dihapus; pindah dulu dengan
  `/provider user <name>`.
- Provider baru boleh belum punya model. Tambahkan lewat
  `/addmodel <name> <model-id>`; model pertama menjadi default provider itu.
- Entri katalog bawaan tidak bisa dihapus, dan id yang sudah ada tidak
  ditambahkan dua kali.
- `/cmodel <name>` memilih id apa pun untuk provider aktif tanpa menambahkannya
  ke daftar; `/help addmodel` dan `/help delmodel` menampilkan tutorial yang sama
  di dalam CLI.

#### Menambah provider sendiri (`extraProviders`)

Provider tambahan didaftarkan sebagai array JSON di `config.json`. Semua provider
memakai protokol Chat Completions yang kompatibel OpenAI:

```json
{
  "extraProviders": [
    {
      "id": "myproxy",
      "name": "My Proxy",
      "baseURL": "https://proxy.example/v1",
      "defaultModel": "model-b",
      "models": ["model-a", { "id": "model-b", "name": "Model B" }],
      "capabilities": { "tools": true, "streaming": true, "reasoning": false }
    }
  ],
  "providers": { "myproxy": { "apiKey": "…" } }
}
```

Cara termudah adalah dari dalam sesi — perintahnya menulis bentuk yang sama:

```text
/provider add myproxy https://proxy.example/v1 sk-…
/addmodel myproxy model-a
/provider user myproxy
```

Kuncinya disimpan seperti provider lain, yaitu `providers.myproxy.apiKey`, dan
bisa diisi lewat `ryuu --settings` setelah provider terdaftar.

- `id`, `name`, dan `baseURL` wajib. `models` boleh kosong saat baru dibuat dan
  diisi lewat `/addmodel`; `id` tidak boleh menabrak provider bawaan.
- `capabilities` menentukan apakah agent mengirim tools (`tools`), meminta
  stream (`streaming`), dan menampilkan reasoning bila provider mengirimnya
  (`reasoning`). Jangan menyalakan `tools` untuk endpoint yang tidak mendukung
  `tool_calls`: agent akan menampilkan keterbatasan dan tetap bisa menjawab,
  tetapi tidak bisa membaca atau mengubah file.
- Setelah ditambahkan, provider muncul di `/provider` dan bisa dipilih dengan
  `/provider user myproxy` (alias lama `/provider myproxy`) atau
  `--provider myproxy`.
- Tidak ada fallback otomatis antar-provider AI. Kegagalan provider aktif
  dilaporkan apa adanya (dengan retry terbatas untuk kegagalan sesaat) agar
  kunci dan data tidak berpindah ke provider lain tanpa keputusan Anda.

## Tool yang tersedia untuk model

Model hanya bisa memanggil tool yang terdaftar di allowlist lokal. Setiap
pemanggilan divalidasi skemanya sebelum dieksekusi.

| Tool | Risiko | Persetujuan | Tujuan |
| --- | --- | --- | --- |
| `list_files` | read | tidak | Daftar direktori terfilter dan berpaginasi. |
| `tree` | read | tidak | Pohon direktori dengan batas. |
| `read_file` | read | tidak | Teks UTF-8; rentang baris yang diminta dialirkan, jadi juga bekerja untuk file di atas batas baca. |
| `file_info` | read | tidak | Ukuran, jenis, timestamp, jumlah baris. |
| `search_files` | read | tidak | Pencarian nama/isi dengan pengecualian. |
| `diff_file` | read | tidak | Diff terpadu tanpa menulis apa pun. |
| `inspect_git` | read | tidak | Status/diff Git bila tersedia. |
| `project_summary` | read | tidak | Manifes dan struktur dari file sungguhan. |
| `web_search` | read | tidak | Hasil web dari provider MCP/REST terkonfigurasi, dengan fallback otomatis. Terdaftar ketika setidaknya satu provider tersedia (You.com dan Firecrawl bisa dipakai tanpa kunci). |
| `read_url` | read | tidak | Mengambil halaman http(s) publik dan mengekstrak teks yang bisa dibaca. Selalu tersedia. |
| `create_file` | tulis | ya | File baru; menimpa file lama hanya dengan `overwrite`. |
| `write_file` | tulis | ya | Penulisan seluruh file dengan penjaga mtime opsional. |
| `edit_file` | tulis | ya | Penggantian terarah unik, mengembalikan diff. |
| `move_file` | destruktif | ya | Memindah/mengganti nama di dalam workspace. |
| `delete_file` | destruktif | ya | Menghapus file atau direktori kosong; `confirm: true` wajib. |
| `run_command` | exec | ya | Menjalankan argv, menunggu, menangkap output/exit/durasi. |
| `start_process` | exec | ya | Server/watcher di background. |
| `list_processes` | read | tidak | Daftar proses. |
| `get_process_output` | read | tidak | Output terbatas untuk sebuah proses. |
| `stop_process` | exec | ya | Penghentian bersih, lalu pemutusan paksa. |

Katalog tool juga ditulis ke dalam system prompt (nama, argumen, gerbang
persetujuan, tujuan satu baris), bersama skrip npm milik project itu sendiri dan
tata letak modulnya, sehingga model memilih tool yang benar alih-alih keluar ke
`grep` untuk sesuatu yang sudah dikerjakan `search_files`.

### Pencarian web (MCP multi-provider dengan fallback)

`web_search` tetap satu tool bagi model, tetapi didukung oleh `WebSearchManager`
yang memiliki beberapa provider dan mencobanya sesuai urutan yang bisa
dikonfigurasi. Setiap provider dinormalkan ke bentuk yang sama: `results`
(`title`, `url`, `snippet`, `date` opsional), `answer_box`, `people_also_ask`,
dan `related_searches`. `depth: \"deep\"` meminta dua kali lipat hasil (maksimal
10).

| Provider | Transport | Kunci | Kapabilitas | Catatan |
| --- | --- | --- | --- | --- |
| You.com MCP | Streamable HTTP | opsional (`webSearch.youApiKey`) | pencarian (tanpa kunci); ekstraksi/konten dengan kunci | Tanpa kunci memakai `?profile=free`; penemuan langsung mengembalikan `you-search`, `you-discover`. |
| Firecrawl MCP | Streamable HTTP | opsional (`webSearch.firecrawlApiKey`) | pencarian + scrape | Tingkat tanpa kunci punya batas kredit harian; penemuan langsung mengembalikan `firecrawl_search`, `firecrawl_scrape`, `firecrawl_parse`. |
| DuckDuckGo MCP | stdio | tidak ada | pencarian + ekstrak (sebagaimana diumumkan server) | Server komunitas opsional (`uvx free-search-mcp`, MIT). **Nonaktif secara bawaan** karena menjalankan kode pihak ketiga; butuh `uv` terpasang. |
| Tavily MCP | Streamable HTTP | wajib (`webSearch.tavilyApiKey`) | pencarian + ekstrak | Endpoint remote butuh kunci; tanpa itu provider dilewati, tidak pernah dihubungi. |
| Serper REST | HTTPS | wajib (`webSearch.serperApiKey`) | pencarian | Backend asli; ikut dalam rantai fallback yang sama. |

Bagaimana ia berperilaku:

- **Koneksi malas.** Tidak ada yang menghubungkan pada saat start. Sebuah
  provider dihubungkan saat pertama dipakai, tool-nya ditemukan dengan
  `tools/list`, dan koneksinya dipakai ulang selama sisa sesi. `/web test`
  hanya melakukan handshake + penemuan (tanpa kueri).
- **Pemetaan tool, bukan nama yang di-hard-code.** Tool pencarian/ekstraksi
  dipilih menurut nama, deskripsi, dan skema input, sehingga sebuah server bisa
  mengganti nama tool-nya tanpa membuat agent rusak. Argumen wajib diisi dari
  skema tool itu sendiri (`query`, `q`, `url`, `urls`, `limit`, `formats`,
  `objective`).
- **Fallback hanya untuk kegagalan sungguhan.** Timeout, jaringan/DNS, HTTP
  401/403/429/5xx, kegagalan handshake/penemuan, tool yang hilang, skema salah,
  dan payload tidak valid semuanya pindah ke provider berikutnya. Hasil kosong
  yang valid dicatat dan boleh juga mencoba provider berikutnya, tetapi tidak
  dilaporkan sebagai kegagalan. Pembatalan tidak pernah memicu fallback.
- **Retry terbatas.** Maksimal `webSearch.mcpMaxRetries` retry per provider untuk
  kegagalan *pemanggilan* sesaat (bukan handshake), dengan backoff eksponensial
  dan jitter. `429` langsung diteruskan ke provider berikutnya alih-alih
  membekukan agent. Dua kegagalan berturut-turut membuka circuit breaker 60
  detik untuk provider itu.
- **Satu kegagalan bertipe.** Jika semua provider gagal, tool melempar
  `SEARCH_ALL_PROVIDERS_FAILED` (atau `SEARCH_EXTRACT_FAILED`) dengan daftar
  alasan singkat per provider; agent tetap berjalan tanpa pencarian web alih-alih
  crash dan diberi tahu untuk tidak mengarang hasil.
- **Terminal menampilkan fallback**, bukan hanya pemenangnya: satu pohon `WEB
  SEARCH` ringkas per pencarian dengan `✓`/`✕`/`!`/`○`, durasi, dan alasan
  singkat. Stack trace tetap di log debug; kunci dan header otorisasi tidak
  pernah dicetak.
- **Fallback ekstraksi halaman.** `read_url` tetap mengambil secara lokal lebih
  dulu. Jika pengambilan lokal gagal (jaringan, timeout, 401/403, jenis tidak
  didukung) atau tidak mengekstrak teks dari halaman yang dirender JavaScript,
  sebuah provider berkemampuan ekstraksi (Firecrawl/Tavily) dicoba dan hasilnya
  menyebutkan provider mana yang menghasilkan teksnya.
- **Keamanan.** Kueri dan URL keluar dari mesin; file tidak. Teks halaman adalah
  data tak terpercaya, bukan instruksi. Server MCP stdio mendapat environment
  minimal (PATH/HOME/TMP), bukan kunci NVIDIA atau pencarian Anda. Server MCP
  tidak pernah diberi akses filesystem atau shell oleh agent ini.
- **Privasi dan kuota.** Firecrawl tanpa kunci punya batas kredit harian yang
  kecil; manajer tidak pernah menguji dengan kueri sungguhan saat start. `/web
  test` secara eksplisit menyatakan tidak ada kueri yang dijalankan. Nonaktifkan
  semuanya dengan `webSearch.enabled: false` atau `webSearch.providers: []`.
- **Worklog:** setiap pencarian dicatat (`web_search \"...\" -> N result(s) ·
  top: ...`), sehingga tugas lanjutan memakai temuan yang ada alih-alih membayar
  kueri yang sama.

### Membaca sebuah halaman (`read_url`)

`read_url` mengambil satu URL http(s) dan mengembalikan teks hasil ekstraksi,
judul, dan meta deskripsinya, sehingga model bisa memverifikasi snippet
pencarian terhadap halaman sumbernya.

- **Selalu tersedia.** Tidak butuh kunci, ia tool read-only, dan tidak pernah
  meminta konfirmasi.
- **Terbatas.** Batas badan 2 MB, `max_chars` 1.000–50.000 (bawaan 20.000),
  timeout 15 detik, dan maksimal 5 redirect.
- **Skema diperiksa.** Hanya http/https; URL dengan kredensial tertanam ditolak,
  setiap hop redirect diperiksa ulang, dan penurunan https→http ditolak.
- **Dijaga SSRF.** Alamat loopback, privat, link-local, CGNAT, multicast, dan
  metadata cloud ditolak, begitu pula `localhost`, `*.local`, `*.internal`, dan
  hostname ber-label tunggal. Pengambilan sungguhan melakukan resolusi DNS lebih
  dulu dan menolak bila ada alamat privat; setiap redirect diperiksa ulang. DNS
  rebinding dikendalikan tetapi tidak dihilangkan sepenuhnya tanpa agen HTTP
  ber-IP-pinned.
- **Teks saja.** `text/*`, HTML/XHTML, JSON, dan XML dibaca; gambar, PDF, dan
  biner lain mengembalikan `READ_URL_UNSUPPORTED`.
- **Fallback ekstraksi MCP.** Jika pengambilan lokal tidak bisa membaca halaman
  (galat jaringan, timeout, konten terblokir/tidak didukung) atau tidak
  mengekstrak teks dari halaman yang dirender JavaScript, sebuah provider
  pencarian web berkemampuan ekstraksi dicoba; hasilnya menyebutkan provider di
  `provider` dan menetapkan `extraction: \"mcp\"`.
- **Tidak ada JavaScript secara lokal.** Halaman yang dirender sisi-klien bisa
  saja tidak mengembalikan teks; hasilnya menyatakan hal itu alih-alih
  berpura-pura halaman itu kosong, dan fallback MCP di atas bisa memulihkannya.
- **Konten tak terpercaya.** Prompt memperlakukan teks yang diambil sebagai
  data, bukan instruksi, sehingga sebuah halaman tidak bisa mengalihkan
  perilaku agent.
- **Privasi:** URL diminta dari mesin Anda, jadi situs itu melihat IP Anda.
- **Worklog:** setiap pengambilan dicatat (`read_url <url> -> HTTP 200 · N chars`).

### Model prompt dan konteks

Protokol provider ini tidak punya keadaan (stateless): setiap permintaan
membawa seluruh percakapan. Ryuu membuat hal itu stabil dan murah alih-alih
berpura-pura sebaliknya.

- System prompt dirakit **sekali per sesi** dan dipakai ulang byte-per-byte. Ia
  identik pada setiap langkah (sehingga prefix caching provider bisa kena) dan
  tidak pernah tumbuh seiring berjalannya tugas.
- Setiap tugas menambahkan tepat satu pesan `TASK BRIEF`: tugas, sisa batas
  langkah dan waktu, serta worklog sesi. Itulah satu-satunya blok instruksi
  per-tugas; model tidak pernah diberi tahu ulang untuk \"mulai dengan rencana\".
- Hasil tool tetap berada di percakapan selama langkah-langkah yang
  membutuhkannya. Worklog membawa fakta terverifikasi (file yang dibaca beserta
  rentang baris, file yang diubah, command dan exit code, temuan, rencana) ke
  tugas-tugas berikutnya, sehingga tindak lanjut melanjutkan pekerjaan alih-alih
  memulai lagi. File yang sudah dibaca dan tidak berubah di disk tidak dibaca
  lagi: agent menerima balasan `cached: true` yang memberi tahu bahwa isinya
  sudah diketahui.
- `finish_reason: \"length\"` ditangani: pemanggilan tool yang terpotong pada
  batas token output dibuang dan dilaporkan, tidak pernah dieksekusi sebagai
  file yang tertulis setengah jalan.
- Pada 70% anggaran waktu, model diberi tahu untuk menyatu (konvergen), dan
  aliran respons yang tidak mengirim byte selama
  `agent.streamIdleTimeoutMs` dibatalkan dengan `STREAM_STALLED` alih-alih
  menahan langkah tetap terbuka.

## Model persetujuan dan izin

Kebijakannya diatur dengan `agent.approvalPolicy`:

| Risiko | `ask` (bawaan) | `auto` | `read-only` |
| --- | --- | --- | --- |
| read | izinkan | izinkan | izinkan |
| tulis | prompt | izinkan | tolak |
| exec | prompt | prompt | tolak |
| destruktif | prompt | prompt | tolak |

- `--yes` menyetujui otomatis **hanya penulisan**; eksekusi dan aksi destruktif
  tetap memakai prompt.
- Di sesi non-interaktif tidak ada prompt, jadi aksi yang butuh persetujuan
  ditolak dan penolakannya dilaporkan ke model.
- Persetujuan ditegakkan di loop agent, bukan di dalam tool masing-masing,
  sehingga model tidak bisa melewatinya dengan memanggil tool secara langsung.
- Prompt persetujuan menampilkan tool, tingkat risiko, argumen, dan pratinjau
  (diff atau command beserta direktori kerjanya) sebelum Anda menjawab.
- Penilaian risiko adalah sinyal UX best-effort, **bukan batas keamanan**.

### Undo

`/undo` memakai snapshot before/after yang tepat, direkam oleh proses agent ini
untuk `create_file`, `write_file`, `edit_file`, `move_file`, dan `delete_file`. Ia
menolak mengembalikan perubahan jika file berubah setelah suntingan agent,
alih-alih menimpa pekerjaan Anda. Cakupannya mencakup perubahan yang dibuat pada
tugas/sesi saat ini dan bukan pengganti kontrol versi. Pakai `git` untuk sejarah
yang tahan lama.

## Referensi konfigurasi

Semua pengaturan berasal dari satu file `config.json` (lihat
[Pengaturan global](#pengaturan-global-ryuu---settings)). Tidak ada `.env` dan
tidak ada variabel environment; flag CLI menimpa nilai file untuk satu run.
Workspace tetap ditentukan per run (cwd atau `--workspace`), bukan dari file
global ini. Nilai bawaan divalidasi saat start; nilai tidak valid membuat proses
gagal sebelum ada panggilan API.

| Kunci `config.json` | Bawaan | Makna |
| --- | --- | --- |
| *(kosong)* | bawaan katalog | Nilai kosong pada kunci mana pun berarti "pakai bawaan" di kolom Bawaan. |
| `provider` | — | Provider aktif (`nvidia`, `tokenharbor`, atau id dari `extraProviders`). Bila kosong: `nvidia` kalau kuncinya ada, jika tidak provider pertama yang punya kunci. |
| `providerModel.<id>` | model bawaan provider | Model untuk provider itu. Menang atas bawaan katalog. |
| `providers.<id>.apiKey` | — | Kunci provider. Tidak pernah dicetak, ditulis owner-only. |
| `providers.<id>.baseURL` | URL bawaan provider | Base URL kompatibel OpenAI. |
| `extraProviders` | — | Array provider tambahan yang kompatibel OpenAI (lihat [Menambah provider sendiri](#menambah-provider-sendiri-extraproviders)). |
| `agent.logLevel` | `info` | `debug`, `info`, `warn`, `error`, `silent`. |
| `agent.maxSteps` | `0` | Batas langkah agent opsional (0 = tanpa batas, 1–100000). |
| `agent.approvalPolicy` | `ask` | `ask`, `auto`, `read-only`. |
| `agent.maxOutputTokens` | `4096` | Batas token output (64–32768). Nilai tinggi bisa ditolak atau mahal. |
| `agent.requestTimeoutMs` | `120000` | Timeout per permintaan (1s–10menit). |
| `agent.streamIdleTimeoutMs` | `45000` | Membatalkan aliran respons yang tidak mengirim byte selama ini (0 menonaktifkan). |
| `agent.maxRetries` | `3` | Retry untuk kegagalan sesaat (0–10). |
| `agent.maxRecoveryAttempts` | `0` | Percobaan sambung ulang saat tautan provider putus. `0` = tanpa batas (coba sampai tenggat tugas atau `/cancel`); 1–1000 membatasinya. |
| `agent.recoveryBackoffMs` | `1000` | Jeda dasar antar-percobaan sambung ulang (100ms–60s). |
| `agent.maxFileBytes` | `262144` | Batas baca per file (1KB–5MB). |
| `agent.maxSearchResults` | `50` | Batas hasil pencarian (1–500). |
| `agent.maxToolOutputBytes` | `32768` | Batas hasil tool yang dikirim balik ke model. |
| `agent.maxTaskDurationMs` | `900000` | Batas waktu nyata tugas (10s–24jam). |
| `agent.maxContextChars` | `120000` | Ambang pemadatan konteks lokal. |
| `agent.allowShell` | `false` | Mengizinkan sintaks shell mentah (tetap bergerbang persetujuan). |
| `agent.debug` | `false` | Log debug dan stack trace. |
| `agent.historyDir` | `<workspace>/.ryuu/sessions` | Penyimpanan sesi, relatif ke workspace. |
| `agent.logDir` | `<workspace>/.ryuu/logs` | Penyimpanan log (`agent.log`, dirotasi pada 5MB), relatif ke workspace. |
| `webSearch.enabled` | `true` | Mendaftarkan `web_search` sama sekali. `false` membuangnya bersama fallback ekstraksi `read_url`. |
| `webSearch.fallback` | `true` | Mencoba provider berikutnya setelah kegagalan. `false` berhenti pada kandidat pertama. |
| `webSearch.providers` | `serper` (bila ada kunci) → `you` → `firecrawl` → `duckduckgo` → `tavily` | Urutan provider; `[]` atau `none` menonaktifkan semuanya. |
| `webSearch.disabled` | `[]` | Daftar id provider yang dilewati. `/web enable`/`disable` hanya mengubah sesi saat ini. |
| `webSearch.mcpTimeoutMs` | `6000` | Timeout handshake, penemuan, dan pemanggilan per percobaan (1s–30s). |
| `webSearch.mcpMaxRetries` | `1` | Retry per provider untuk kegagalan pemanggilan sesaat (0–5). |
| `webSearch.debug` | `false` | Diagnostik provider tambahan di log (tanpa kunci). |
| `webSearch.youApiKey` | — | Kunci You.com opsional; tanpa kunci memakai profil pencarian gratis. |
| `webSearch.firecrawlApiKey` | — | Kunci Firecrawl opsional; tanpa kunci memakai tingkat kredit gratis. |
| `webSearch.tavilyApiKey` | — | Wajib untuk Tavily; tanpa itu Tavily dilewati. |
| `webSearch.duckduckgoEnabled` | `false` | Menjalankan server stdio `uvx free-search-mcp` lokal saat pertama dipakai. |
| `webSearch.duckduckgoCommand` / `webSearch.duckduckgoArgs` | `uvx` / `free-search-mcp` | Command untuk provider stdio lokal. |
| `webSearch.serperApiKey` | — | Kunci Serper-kompatibel; menambahkan Serper ke rantai fallback. |
| `webSearch.endpoint` | `https://google.serper.dev/search` | Endpoint SERP (`http`/`https`). |
| `webSearch.authHeader` | `X-API-KEY` | `X-API-KEY` atau `Authorization` (Bearer). |
| `webSearch.results` | `5` | Hasil per kueri (1–10); `deep` menggandakan sampai batas. |
| `webSearch.timeoutMs` | `15000` | Timeout permintaan Serper (1s–60s). |

State lokal (`.ryuu/`) di-gitignore dan dikecualikan dari operasi file agent.

## Arsitektur

```
src/
  index.js              Entri CLI, penguraian argumen, validasi start
  cli/
    app.js              menghubungkan UI, agent, tool, provider, proses, storage
    commands.js         slash command
    renderer.js         banner, feed aktivitas, baris telemetri, diff, ringkasan
    tui.js              layar retained-mode --tui: model transkrip, tata letak, input
    markdown.js         Markdown terminal, tabel sadar-lebar, blok kode
    prompts.js          sesi prompt readline dan penanganan Ctrl+C
  agent/
    agent.js            loop pemanggilan-tool eksplisit dan ringkasan bukti
    approvals.js        penegakan kebijakan persetujuan
    context.js          pemadatan konteks dengan batas
    planner.js          prompt sesi, task brief, ekstraksi rencana, ringkasan
    worklog.js          fakta sesi terverifikasi yang dipakai ulang antar langkah dan tugas
  providers/
    catalog.js          katalog provider + model, kapabilitas, validasi id, extraProviders
    registry.js         registry provider dinamis (factory per id)
    index.js            pembuatan provider aktif dan resolusi pilihan provider/model
    nvidia.js           klien SDK OpenAI (dipakai semua provider), normalisasi, retry, pemetaan galat
  tools/
    registry.js         allowlist, skema, risiko, antarmuka plugin
    filesystem.js       baca/tulis/edit/pindah/hapus/diff file
    search.js           pencarian nama dan isi
    git.js              inspeksi git read-only
    project.js          ringkasan manifes/project
    shell.js            tool command dan proses background
    url.js              read_url: pengambilan halaman terbatas, ekstraksi teks, fallback MCP
    web.js              web_search: satu tool di atas manajer multi-provider
  services/
    websearch/
      manager.js        urutan provider, fallback, retry, circuit breaker, normalisasi
      mcp.js            klien MCP (Streamable HTTP + stdio), timeout, galat bertipe
      providers.js      preset provider dan deskriptor berbasis config
      normalize.js      normalisasi hasil pencarian/ekstraksi yang agnostik provider
      serper.js         provider REST Serper-kompatibel (backend yang sudah ada)
    workspace.js        keamanan path, penulisan atomik, pemblokiran rahasia
    ushell.js           /bash dan !cmd: tangkapan shell pengguna, group kill, env bersih
    processes.js        spawn, buffer streaming, timeout, stop, log
    sessions.js         penyimpanan sesi yang disunting dan cache ringkasan
    undo.js             snapshot before/after dengan pemeriksaan basi
    diff.js             diff terpadu dan statistik
    logger.js           log bertingkat, disunting, berotasi
    doctor.js           diagnostik tanpa rahasia
  config/               pemuatan dan validasi env
  utils/                galat, validasi skema, redaksi, penjaga jaringan (SSRF),
                        versi (dibaca dari package.json — satu-satunya sumber versi)
tests/
  unit/                 uji modul fokus
  integration/          uji proses CLI sungguhan + aplikasi terhubung
```

Tool call dieksekusi **secara berurutan**, sehingga dua pemanggilan tidak bisa
berlomba pada file yang sama. Setiap hasil tool ditambahkan ke percakapan dalam
format tool-call OpenAI dengan `tool_call_id`-nya yang sesuai.

## Model keamanan

Apa yang dilakukan implementasinya:

- Meresolusi setiap path terhadap realpath workspace dan menolak traversal
  serta escape symlink. Path absolut di luar workspace ditolak.
- Memblokir `.env`, `.env.local`, private key/sertifikat, penyimpan kredensial
  umum (`.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, `.npmrc`, `id_rsa*`, ...),
  serta `*.pem`/`*.key`/`*.p12`/`*.pfx`/`*.jks`/`*.keystore` secara bawaan.
  `.env.example`, `.env.sample`, `.env.template`, dan `.env.dist` tetap bisa
  dibaca sebagai dokumentasi.
- Mengecualikan `node_modules`, `.git`, `dist`, `build`, `coverage`, dan
  direktori hasil-generate sejenis dari daftar/pencarian secara bawaan; tool bisa
  memasukkannya secara eksplisit.
- `read_url` hanya menerima http/https, menolak URL dengan kredensial tertanam,
  memeriksa ulang setiap hop redirect (https→http ditolak), hanya membaca jenis
  konten tekstual, dan membatasi badan hingga 2 MB.
- Menegakkan batas file, hasil pencarian, output tool, konteks, langkah,
  serta durasi tugas.
- Memakai penulisan atomik file-temp + rename, mempertahankan CRLF vs LF, dan
  bisa membatalkan ketika mtime file berubah sejak pemeriksaan.
- Menjalankan command dengan `spawn(command, args, { shell: false })` dan array
  argumen. Sintaks shell mentah dinonaktifkan kecuali `agent.allowShell: true`,
  dan selalu bergerbang persetujuan dengan command serta direktori kerjanya
  ditampilkan persis.
- Membuang variabel yang tampak seperti kredensial (`*API_KEY*`, `*TOKEN*`,
  `*SECRET*`, `*PASSWORD*`, ...) dari environment proses anak.
- Menyunting (redact) kunci API yang dikonfigurasi dan pola token dari log,
  output command, file sesi, dan pesan galat.
- Membatasi isi sesi/transkrip yang dipersistensi dan menyimpannya di bawah
  `.ryuu/` dengan izin khusus pemilik bila didukung.

Apa yang **tidak** dilakukannya:

- **Eksekusi shell bukan sandbox.** Command yang disetujui berjalan dengan izin
  pengguna Anda dan bisa membaca atau mengubah apa pun yang bisa dilakukan
  pengguna itu.
- Label risiko persetujuan hanyalah heuristik. Periksa command persisnya sebelum
  menyetujui.
- Ia tidak memasang dependensi otomatis, mendorong commit, men-*deploy*, atau
  meningkatkan hak istimewa. Command yang disetujui tetap bisa melakukan hal-hal
  itu — itu keputusan Anda.
- Ia tidak mengindeks atau mengunggah seluruh workspace; hanya file yang dibaca
  model yang dikirim ke provider.
- Ia tidak mengarang atau merekonstruksi rantai-pikir privat. Saat provider
  mengalirkan delta `reasoning_content`, Ryuu menampilkan teks itu langsung di
  kotak tertutup yang lebarnya sesuai dengan pratinjau lima baris. Setiap
  giliran mendapat id stabil; klik sebuah blok (atau jalankan `/expand <id>`)
  untuk membuka ulang teks lengkapnya, dan Esc atau klik lain menutup panel.
  Teks lengkapnya juga ditulis ke `.ryuu/logs/reasoning/`. Satu baris aktivitas
  yang selalu menyala berada di bagian bawah UI percakapan dan membawa seluruh
  keadaan run: fase, waktu berjalan per fase, total waktu run, langkah, tool
  yang sedang berjalan beserta posisi antriannya, jumlah token live, dan latensi
  token pertama; output command yang berjalan mengalirkan ekornya tepat di atas
  baris itu. Jawaban akhir tidak dikotak: ia dicetak langsung sebagaimana
  provider menulisnya, dengan Markdown inline (bold, italic, code, link)
  dirender live, header ATX (`###`) dirender tebal tanpa tanda pagarnya, dan
  tabel pipe / blok kode bersal die render sebagai blok segera setelah
  selesai dialirkan. Token kontrol chat-template yang bocor dibuang; jawaban
  tidak dirender ulang setelahnya.

## Pengujian dan pengembangan

```bash
npm test               # 300+ uji unit + integrasi (tanpa jaringan, tanpa kunci asli)
npm run test:unit
npm run test:integration
npm run check          # pemeriksaan sintaks di seluruh src/, scripts/, tests/
npm run verify         # check + test
```

Uji memakai runner bawaan Node `node:test`, workspace sementara, provider palsu
terskrip, dan `fetch` yang disuntikkan untuk uji tingkat-SDK. Mereka tidak pernah
memanggil NVIDIA.

Pemeriksaan *smoke* paket opsional:

```bash
npm pack --dry-run
```

## Pemecahan masalah

### `Provider nvidia has no API key` / `Provider tokenharbor has no API key`

Pesan itu menyebut provider aktif dan path kunci yang diharapkan
(`providers.<id>.apiKey`). Isi lewat `ryuu --settings` (baris
`providers.nvidia.apiKey` atau `providers.tokenharbor.apiKey`). Jalankan
`ryuu --doctor` untuk melihat provider mana yang aktif dan path kunci mana yang
belum terisi. Provider tanpa kunci tidak bisa dipilih lewat `/provider`.

### 401 / 403

`401` berarti kunci hilang, tidak valid, atau sudah dicabut. `403` biasanya
berarti kunci tidak punya akses ke model terpilih. Periksa path kunci yang
disebut pesan galat (`providers.nvidia.apiKey` atau
`providers.tokenharbor.apiKey`), verifikasi
akses model di dashboard provider, lalu jalankan `ryuu --doctor --live`.
Ryuu tidak mencoba kunci provider lain sebagai pengganti.

### 404

Periksa model provider aktif (`--model`, `/model`, atau `providerModel.<id>`) dan
base URL-nya (`providers.<id>.baseURL`). Base URL harus berupa root yang
kompatibel dengan OpenAI, biasanya berakhiran `/v1`.

### Model tidak tersedia / tidak ditemukan

Daftar model adalah id yang ditawarkan CLI, bukan jaminan model itu aktif di
server. Untuk Token Harbor, model `deepseek-v4.1-flash:free` bisa berubah atau
dibatasi ketersediaannya. Cek `/provider` dan `/model`, lalu coba model lain atau
hubungi provider. Ryuu menolak id dengan karakter tidak valid sebelum mengirim
apa pun, tetapi tidak melakukan pemeriksaan ketersediaan ke server.

### 429 / batas laju

Kuota dan batas laju ditentukan provider dan tidak dijamin tanpa batas (termasuk
untuk model bertanda `:free`). Tunggu lalu coba lagi, perkecil ukuran
konteks/tugas, atau pindah model/provider. Ryuu mencoba ulang kegagalan sesaat
`429`/`5xx`/jaringan dengan backoff eksponensial terbatas beserta jitter, serta
menghormati `Retry-After` bila ada.

### Model bawaan sangat lambat atau habis waktu

Model bawaan sekarang `minimaxai/minimax-m3.1-flash` (entri ke-6 di `/model`).
Endpoint `deepseek-ai/deepseek-v4.1-flash` dihapus dari bawaan karena sering timeout di sisi provider. Forum NVIDIA punya laporan terbuka tentang
respons 3–5+ menit untuk model ini, jadi ini latensi sisi-provider, bukan
kegagalan autentikasi. `GET /v1/models` dan
`GET /v1/models/deepseek-ai/deepseek-v4.1-flash` tetap berhasil dengan kunci yang
valid.

Pakai model berkemampuan-tool yang cepat sebagai solusi, tanpa mengubah bawaan
project:

```bash
ryuu --model z-ai/glm-5.3 "your task"
# atau set "providerModel": { "nvidia": "z-ai/glm-5.3" } di config.json
```

Jika Anda tetap memakai model deepseek, naikkan `agent.requestTimeoutMs` dan
turunkan `agent.maxRetries` agar satu langkah lambat tidak berulang selama
banyak menit. Periksa status terkini di <https://build.nvidia.com/> sebelum
menganggap kunci rusak.

### "Model may not support tool calling"

Ryuu butuh dukungan `tool_calls` bergaya OpenAI pada endpoint terpilih. Coba
model berkemampuan-tool lewat `providerModel.nvidia` atau `/model`. Tanpa tool call,
agent tetap bisa menjawab secara percakapan, tetapi tidak bisa memeriksa atau
mengubah file.

### Galat jaringan / timeout

Periksa DNS, proxy, dan akses firewall ke base URL. Naikkan
`agent.requestTimeoutMs` untuk endpoint lambat. `--debug` menampilkan
diagnostik yang sudah disunting.

### Sebuah langkah menggantung tanpa output terlihat

Jika aliran berhenti mengirim byte, Ryuu membatalkannya setelah
`agent.streamIdleTimeoutMs` (bawaan 45s) dan melaporkan `STREAM_STALLED`;
langkah hanya dicoba ulang ketika belum ada apa pun yang dicetak. Baris aktivitas
selalu menunjukkan waktu berjalan, langkah, dan jumlah token, sehingga
penggantunganan terlihat berbeda dari respons lambat yang tetap berkembang.
Naikkan nilainya untuk endpoint yang memang lambat, set `0` untuk menonaktifkan
watchdog, lalu periksa `/status` untuk rata-rata per-pemanggilan.

### Tautan terputus di tengah run (heartbeat)

Saat permintaan provider gagal dengan galat yang bisa dipulihkan (jaringan,
timeout, `5xx`, `429`), agent tidak menyerah: ia menampilkan **heartbeat** di
feed aktivitas (`♥ heartbeat · reconnecting · attempt 2 (unlimited) in 1.0s`)
dan memutar ulang permintaan dengan backoff eksponensial (maksimal 30 detik
antar-percobaan). Baris `♥ link restored` menandai saat provider menjawab lagi,
dan run melanjutkan dari tempat ia berhenti. Baris aktivitas tetap berputar
selama penantian, sehingga terminal tidak terlihat membeku.

`agent.maxRecoveryAttempts: 0` (bawaan) berarti **tanpa batas percobaan**: agent
terus menyambung ulang sampai provider menjawab, tenggat tugas tercapai, atau
Anda menekan `Ctrl+C`/mengirim `/cancel`. Set nilai positif (1–1000) bila Anda
menginginkan penghentian keras. Hanya kegagalan yang tidak bisa dicoba ulang
(seperti kunci API tidak valid atau galat validasi permintaan `400`) yang
mengakhiri run seketika.

### Model terus menjawab tanpa isi

Giliran model kosong diperlakukan sebagai percobaan ulang, bukan galat. Agent
menambahkan dorongan ("your previous response was empty… call the next tool or
give the final answer"), menampilkan
`♥ heartbeat · empty response · attempt 3 (unlimited) in 2.0s`, menunggu dengan
backoff yang dimulai dari `agent.recoveryBackoffMs` dan tumbuh hingga 15s,
lalu bertanya lagi dengan nomor langkah yang sama — sehingga batas opsional
`agent.maxSteps` tidak dikonsumsi oleh percobaan ulang. Tidak ada kegagalan
`EMPTY_RESPONSE`: run hanya berakhir saat model menjawab, tenggat tugas lewat,
atau Anda membatalkan. Jika ini terjadi terus-menerus, kemungkinan endpoint
sedang mengembalikan aliran kosong (periksa `/status`, file log, atau coba model
lain dengan `/model`).

Setiap percobaan ulang dicatat (`empty model response; retrying`) dengan nomor
percobaan dan jedanya, dan jumlah percobaan hanya dibatasi oleh tenggat tugas.

### "must be a valid JSON object string" (HTTP 400)

Provider memvalidasi setiap tool call di percakapan pada setiap permintaan, jadi
dulu satu payload terpotong bisa menggagalkan permintaan *berikutnya* dan
membunuh seluruh run. Ryuu kini memperbaiki payload terpotong (menutup
string/array/objek yang masih terbuka) dan mengeksekusi pemanggilannya; jika
payload tidak bisa diperbaiki, pemanggilan yang rusak diganti dengan `{}` dalam
sejarah tersimpan dan model diberi tahu untuk mengirimnya ulang. Permintaan
disederhanakan sekali lagi di sisi provider, sehingga payload rusak tidak lagi
bisa sampai ke API.

### Sebuah tool terus gagal

Mengulang pemanggilan gagal yang sama tidak bisa menghasilkan informasi baru.
Setelah dua kegagalan identik, agent memblokir yang ketiga dan memberi tahu model
untuk mengganti tool, argumen, atau melaporkan temuannya. Command yang keluar
dengan `1` tanpa output juga dihitung kegagalan — itu biasanya berarti "tidak ada
yang cocok", bukan "coba lagi".

### Galat panjang konteks

Mulai sesi baru, persempit tugas, turunkan `agent.maxContextChars`, atau
kecilkan `agent.maxToolOutputBytes`. Pemadatan lokal mempertahankan tugas,
rencana, file yang berubah, command, dan masalah yang menggantung, tetapi tidak
bisa melampaui konteks provider.

### Ketidaksesuaian versi runtime

Node 25.x adalah target terverifikasi; Node 22+ diterima dengan peringatan di
doctor. Versi lebih lama gagal saat start. Tingkatkan dengan
`nvm install 25 && nvm use 25`.

### Di mana lognya?

`.ryuu/logs/agent.log` di dalam workspace (dirotasi pada 5MB). Jalankan dengan
`--debug` untuk stack trace dan metadata provider yang verbose. Log sudah
disingkat, tetapi tinjau dulu sebelum dibagikan.

### Perilaku proses

Di Linux/macOS, proses anak berjalan di grup prosesnya sendiri; menghentikannya
menyinyalkan grup itu, lalu meningkat ke `SIGKILL` setelah timeout. Di Windows,
grup proses dan semantik sinyal berbeda: Ryuu menghentikan PID anak dan
mengandalkan perilaku bawaan Node, sehingga cucu proses yatim masih mungkin.
Utamakan `start_process`/`stop_process` untuk dev server dan verifikasi pembersihan
secara manual di Windows.

## Keterbatasan yang diketahui

- **Pengujian API NVIDIA langsung membutuhkan kunci Anda.** Uji otomatis repositori
  ini sepenuhnya offline. Validasi langsung pada 2026-10-20 lolos dengan
  `z-ai/glm-5.3` (tool call sungguhan + jawaban akhir); model DeepSeek bawaan
  sedang habis waktu di sisi provider saat itu. Jalankan ulang
  `ryuu --doctor --live` untuk kunci dan region Anda.
- Perilaku model, ukuran konteks, kuota gratis, batas laju, dan dukungan tool
  calling bergantung pada provider/model dan bisa berubah. Kapabilitas provider
  (`streaming`, `tools`, `reasoning`) hanya dipakai untuk memutuskan apa yang
  dikirim; reasoning tetap hanya ditampilkan bila provider mengirimnya.
- Daftar model di katalog hanyalah id yang ditawarkan CLI. Ryuu tidak memeriksa
  ketersediaan model ke server, dan tidak melakukan fallback otomatis ke
  provider AI lain saat provider aktif gagal — itu mencegah kunci/data berpindah
  tanpa keputusan Anda, tetapi berarti Anda harus memilih provider lain dengan
  `/provider` atau `--provider`.
- Token Harbor menyediakan model `deepseek-v4.1-flash:free`; Ryuu tidak menjamin
  layanan itu gratis tanpa batas. Kuota, ketersediaan, dan harga mengikuti
  ketentuan Token Harbor.
- Respons dialirkan dan dikumpulkan sisi-klien: reasoning muncul langsung di
  kotaknya dan jawaban akhir dicetak langsung saat tiba (tanpa kotak, tanpa
  render ulang). Mode plain/non-TTY menyembunyikan aliran langsung dan hanya
  melaporkan jumlah karakter reasoning.
- Tool call berjalan berurutan, bukan paralel. Prompt meminta model untuk
  menggabungkan pemanggilan independen ke dalam satu respons (beberapa baca
  sekaligus) untuk memotong bolak-balik.
- Transport-nya stateless, jadi prompt dikirim ulang dengan setiap permintaan. Ia
  dirakit sekali dan identik byte-per-byte, tidak dibangun ulang; brief per-tugas
  adalah satu-satunya bagian yang bervariasi.
- Worklog adalah lembar fakta ringkas, bukan isi file. Ia menghentikan pembacaan
  ulang dan analisis ulang yang redundan, tetapi file besar tetap harus dibaca
  sekali.
- `--tui` menyimpan seluruh transkrip di memori karena setiap frame digambar ulang
  darinya. Tangkapan per-blok dibatasi, tetapi sesi yang sangat panjang tumbuh
  seiring jumlah blok; belum ada pencarian dalam aplikasi atau mode salin, dan
  pengubahan ukuran mengalirkan kembali frame dari model alih-alih mempertahankan
  tata letak piksel sebelumnya.
- Penyalinan clipboard memakai OSC 52. Sebagian terminal menonaktifkannya, dan
  tmux perlu `set -g set-clipboard on`; ketika sekuensnya diabaikan, clipboard
  mempertahankan isi lamanya, sementara `/copy` tetap melaporkan jumlah karakter
  yang dikirim.
- `/bash` dan `!cmd` sengaja melewati prompt persetujuan: Anda yang mengetik
  commandnya, jadi ia berjalan dengan izin Anda sendiri. `--read-only` adalah
  satu-satunya yang memblokirnya.
- `/undo` terbatas pada sesi/tugas dan menolak saat file berubah di bawahnya.
- Sesi disimpan lokal dan bukan log kejadian lengkap yang bisa diputar ulang.
- Tidak ada sandbox atau isolasi kontainer bawaan.
- Sintaks shell mentah harus diaktifkan secara eksplisit dan disetujui; penulisan
  atomik tidak melindungi dari proses eksternal yang crash di tengah penulisan.
- Render Markdown mencakup sintaks umum; gambar, tabel bersarang, dan HTML
  kompleks ditampilkan sebagai teks.
- `read_url` memakai ekstraktor HTML bawaan kecil: halaman yang dirender
  JavaScript, PDF, dan gambar tidak bisa dibaca, dan teks hasil ekstraksi adalah
  penyederhanaan dari halaman tersebut.
- Ini project 0.3.1: harapkannya masih berkekakuan. Tidak ada klaim bebas bug.

## Daftar periksa validasi API langsung

Dengan kunci asli yang dikonfigurasi:

1. `ryuu --doctor` → semua pemeriksaan non-konektivitas lolos, kunci tidak
   dicetak.
2. `ryuu --doctor --live` → `provider.connectivity` lolos dan melaporkan
   latensi untuk provider aktif. Jika model bawaan habis waktu, konfirmasi dengan
   `--model z-ai/glm-5.3` sebelum menganggap kunci buruk (lihat bagian
   pemecahan masalah latensi).
3. Token Harbor (dengan `providers.tokenharbor.apiKey`): `ryuu --doctor --provider
   tokenharbor --live` → `provider.catalog` menandai `tokenharbor*` dan
   konektivitas lolos bila endpoint-nya dapat dijangkau. Bila provider tidak
   dapat dijangkau, itu dilaporkan sebagai kegagalan, bukan dianggap berhasil.
4. `npm link && ryuu` → banner menampilkan model, provider, workspace, versi
   Node. `/provider` menampilkan status kunci tanpa nilainya.
5. Tanya: `List the files in this project and summarize what it does.` → amati
   pemanggilan `list_files`/`read_file` sungguhan dan ringkasan akhir.
6. Tanya: `Add a comment to the top of <file> and show me the diff.` → setujui
   diff → konfirmasi file berubah dan ringkasannya menyebutkannya.
7. Tanya: `Run npm test and report the result.` → setujui command persisnya →
   verifikasi exit code asli, durasi, dan outputnya.
8. `/undo` bekerja untuk perubahan file; `/status`, `/diff`, `/sessions`,
   `/logs` memperlihatkan bukti.

## Lisensi

MIT (lihat `package.json`).

