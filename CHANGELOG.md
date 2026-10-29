# Changelog

Semua perubahan penting pada Ryuu Agent CLI didokumentasikan di sini.
Project ini mengikuti [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Ditambahkan

- **`config.json` dibuat otomatis pada run pertama.** Bila file pengaturan belum
  ada, `ensureSettingsFile` menulis scaffold-nya secara atomik dengan izin
  `0600`: `version`, `provider`, `providers.<id>.apiKey`/`baseURL`,
  `providerModel.<id>`, `extraProviders`, `agent.*`, dan `webSearch.*`, semuanya
  bernilai kosong. Nilai kosong diperlakukan sebagai "pakai bawaan", jadi file
  baru tidak mengubah perilaku; file yang sudah ada atau JSON yang rusak tidak
  pernah ditimpa. `--settings` memakai scaffold yang sama saat membuat file.

### Dihapus

- **File `.env` dan seluruh variabel environment tidak lagi dibaca.** Satu-satunya
  sumber konfigurasi kini `config.json` (`ryuu --settings`): kredensial
  (`providers.<id>.apiKey`), base URL (`providers.<id>.baseURL`), model
  (`providerModel.<id>`), batas agent (`agent.*`), pencarian web (`webSearch.*`),
  dan provider tambahan (`extraProviders`). `.env.example` ikut dihapus dari repo
  dan dari daftar file paket. Presedensi: flag CLI > `.ryuu/preferences.json`
  workspace > `config.json` > bawaan katalog; hanya `RYUU_CONFIG_DIR` yang masih
  dibaca untuk menentukan letak `config.json`. Pesan galat, petunjuk pemulihan,
  dan `/web providers` sekarang menyebut path kunci di `config.json`, bukan nama
  variabel yang tidak lagi berpengaruh.

### Diubah

- **Model bawaan provider `nvidia` kini `minimaxai/minimax-m3.1-flash`.** Model
  itu masuk katalog sebagai entri ke-6, jadi `/model 6` memilihnya dan startup
  tanpa `--model`/`NVIDIA_MODEL` memakainya. Lima model sebelumnya
  (`nvidia/nemotron-3.5-super-vl-120b-a12b`, `z-ai/glm-5.3-flash`,
  `google/diffusiongemma-26b-a4b-it`, `poolside/laguna-xs-2.1`,
  `stepfun-ai/step-5-preview`) tetap ada dan nomornya tidak bergeser.

## [0.3.0] - 2026-10-29

### Ditambahkan

- **Pengaturan global `ryuu --settings` dan `ryuu --settings --tui`.** Nilai
  pengguna kini tinggal di satu file milik pengguna — Linux/BSD
  `$XDG_CONFIG_HOME/ryuu/config.json` (bawaan `~/.config/ryuu/config.json`),
  macOS `~/Library/Application Support/ryuu/config.json`, Windows
  `%APPDATA%\ryuu\config.json` — dan bisa dialihkan dengan `RYUU_CONFIG_DIR`,
  sehingga terbaca dari direktori kerja mana pun. `--settings` membuka editor
  baris bernomor (`<nomor> <nilai>`, `/list`, `/show`, `/reset`, `/help`,
  `/exit`); `--settings --tui` membuka layar penuh dengan panel deskripsi,
  navigasi panah, pengubahan pilihan provider/model, serta simpan/batal; dan
  `--settings --list` mencetak daftar tanpa masuk mode edit. Setiap perubahan
  tervalidasi lalu langsung disimpan secara atomik (fsync + rename) dengan izin
  `0600`; satu kunci tidak pernah menghapus kunci lain, API key selalu
  disamarkan, dan JSON yang rusak dilaporkan tanpa pernah ditimpa. Presedensi:
  flag CLI > environment/`.env` > `.ryuu/preferences.json` workspace > file
  pengaturan global > bawaan katalog. Kredensial provider, base URL, model,
  batas agent, dan kunci web search semuanya bisa diatur dari sini; provider
  tambahan dari `RYUU_PROVIDERS` otomatis mendapat barisnya sendiri. Mode
  pengaturan tidak pernah membangun agent, tool, atau permintaan model.
- **Tombol `⧉ copy` pada blok kode.** Code fence di jawaban kini membawa chip
  `⧉ copy` di header-nya, dan seluruh blok menjadi area klik: mengekliknya
  menyalin isi kode (tanpa penanda fence) ke clipboard terminal lewat OSC 52,
  sama seperti blok prompt. Berlaku di kedua antarmuka — `--tui` lewat peta klik
  per-baris, antarmuka baris lewat `Renderer.copies` — dengan teks yang disalin
  dibatasi 100k karakter seperti payload OSC 52.

### Diubah

- **Prompt internal dirapikan dan dioptimalkan untuk waktu.** `buildSystemPrompt`
  kini menaruh aturan efisiensi dan pemulihan di bagian tersendiri: jangan
  menganalisis ulang fakta dari worklog/tool result, berpikir sekali lalu
  bertindak, dan — terutama — **heartbeat** (reconnect, giliran kosong,
  argumen yang diperbaiki/dipotong) diperlakukan sebagai transport, bukan reset
  tugas: lanjutkan aksi yang terputus tanpa mengulang read/search/command yang
  sudah berhasil. Nudge giliran kosong dan peringatan anggaran 70% ikut
  menegaskan hal yang sama.
- **Notifikasi heartbeat kini biru langit tebal.** Pesan heartbeat pada UI baris
  dan `--tui` (reconnect, giliran kosong, argumen diperbaiki, tautan pulih)
  dicetak dengan warna biru langit (`#38bdf8`) dan tebal, menggantikan kuning/
  hijau, agar terbaca sebagai kabar transport, bukan galat.

## [0.2.1] - 2026-10-25

### Ditambahkan

- **Dukungan multi-provider AI dengan registry dinamis.** Provider dan model kini
  dideklarasikan di `src/providers/catalog.js` (`nvidia` dan `tokenharbor` bawaan,
  plus entri `RYUU_PROVIDERS` dari `.env`), sehingga agent core tidak menyebut
  provider mana pun. `ProviderRegistry` (`src/providers/registry.js`) membuat
  instance per provider dari satu factory, dan `src/providers/index.js` meresolusi
  pilihan, memvalidasi id/kunci/model, serta menyediakan `updateSelection()` untuk
  berpindah provider tanpa membangun ulang agent.
- **Provider Token Harbor** (`tokenharbor`) dengan model bawaan
  `deepseek-v4.1-flash:free` (DeepSeek V4.1 Flash Free), base URL
  `https://tokenharbor.ai/v1`, kunci `TOKENHARBOR_API_KEY`, dan override
  `TOKENHARBOR_BASE_URL` / `TOKENHARBOR_MODEL`. Protokolnya Chat Completions yang
  kompatibel OpenAI, jadi klien SDK yang sama dipakai ulang; streaming, tool
  calling, reasoning yang dikirim provider, serta pemetaan galat HTTP tetap sama.
- **Pemilihan provider dan model.** Flag `--provider <id>`, variabel
  `RYUU_PROVIDER`/`RYUU_MODEL`, dan slash command `/provider [id]` (daftar status
  kunci tanpa membocorkan nilainya). `/model`, `/addmodel`, dan `/delmodel` kini
  bekerja per provider dan disimpan per provider di `.ryuu/preferences.json`;
  berpindah provider mempertahankan riwayat percakapan dan worklog.
- **Kapabilitas per provider** (`streaming`, `tools`, `reasoning`, `multimodal`)
  menggantikan asumsi bahwa semua endpoint identik. Agent hanya mengirim tools
  atau meminta stream bila provider mengumumkannya, dan menampilkan keterbatasan
  yang diumumkan di banner. Tidak ada fallback otomatis ke provider AI lain.
- **Validasi sebelum request**: provider harus dikenal, kuncinya harus ada (tidak
  pernah memakai kunci kosong/hardcoded), dan id model harus valid. Model yang
  tidak ada di daftar tetap diizinkan dengan peringatan, karena daftar itu adalah
  id yang ditawarkan CLI, bukan jaminan ketersediaan di server.
- Uji offline untuk katalog, pemilihan provider/model, request Token Harbor
  (base URL, model, header otorisasi, streaming, tool call), kunci yang hilang,
  galat HTTP/timeout, preferensi per provider, dan redaksi kunci.

### Diubah

- Pesan galat provider tidak lagi menyebut NVIDIA secara hard-coded: nama provider
  dan variabel kunci yang benar dipakai, sehingga `401`/`403`/`404`/`429`/`5xx`
  untuk Token Harbor menunjuk `TOKENHARBOR_API_KEY` dan model yang dipilih.
- `.env.example` dan README mendokumentasikan Token Harbor, `RYUU_PROVIDER`,
  `RYUU_MODEL`, `RYUU_PROVIDERS`, kapabilitas per provider, dan batasan kuota
  (tidak ada klaim gratis tanpa batas).

## [0.2.0] - 2026-10-25

### Ditambahkan

- **Pembaruan visual menyeluruh UI layar penuh.** Setiap blok kini dibuka dengan
  header kecil (`▸ TASK`, `◆ response`, `⚙ Using tools`, `◈ reasoning`, `◆ PLAN`)
  dan blok dipisahkan baris kosong plus **garis gradien pink → violet → biru
  langit**. Tool call berurutan berbagi satu blok, satu header
  `⚙ Using tools · N calls` dan tanpa pembatas di antaranya. Setiap jenis baris
  punya warnanya sendiri alih-alih satu abu-abu redup: prosa assistant berwarna
  putih, Markdown (heading, penanda daftar, inline code, link, code fence) dan
  tabel berwarna biru langit, nama tool kuning, teks reasoning hijau dengan baris
  status putih, tool yang gagal berupa nama merah tebal di atas output merah
  redup, header command dan baris `$` berwarna biru langit, serta galat runtime
  berwarna merah. Layar pembuka adalah frame yang sama dengan antarmuka baris —
  wordmark ASCII berbingkai, tagline, dan blok telemetri (model, workspace,
  runtime, access, log) dengan versinya — dan composer adalah `ryuu > ` dengan
  `ryuu` pada gradien pink → blue, teks input kelabu, baris pertanyaan di atasnya,
  serta word wrap lunak, sehingga tugas panjang tidak pernah terpotong. Status bar
  mewarnai setiap segmen secara terpisah (fase, langkah, tool, token, gulir).
  Setiap baris membungkus sesuai lebar terminal, termasuk telemetri banner, output
  command, diff, dan pemberitahuan; palet naik ke truecolor ketika terminal
  melaporkannya.

- **Menyalin prompt yang sudah Anda kirim.** Melipat jawaban 200 baris itu mudah,
  tetapi menyalin tugas yang menghasilkannya tidak: memilih output berwarna dan
  berbungkus dengan mouse rawan galat. Setiap blok prompt kini membawa chip
  `⧉ copy` (mengklik bloknya menyalinnya), `Ctrl+Y` menyalin prompt terakhir dan
  `/copy [n]` menyalin yang lebih lama di kedua antarmuka. Teksnya masuk ke
  clipboard terminal dengan **OSC 52** (`src/services/clipboard.js`): tanpa proses
  anak `pbcopy`/`xclip`/`clip.exe`, bekerja lewat SSH, dibatasi 100k karakter, dan
  status bar melaporkan jumlahnya (`⧉ copied prompt #4 · 42 chars`). Terminal yang
  mengabaikan OSC 52 membiarkan clipboard tidak tersentuh; sesi tidak pernah rusak.
  Antarmuka baris menyimpan 25 prompt terakhir agar `/copy` juga bekerja di sana.

- **Satu versi, dibaca dari `package.json`.** `src/utils/version.js` kini menjadi
  satu-satunya sumber string versi: banner, `--version`, header TUI, dan handshake
  klien MCP semuanya meresolusinya saat runtime, sehingga sebuah rilis hanya
  menyunting `package.json`. Literal bawaan `0.1.0` di `createApp` dan `Tui` sudah
  dihapus.

- **UI layar penuh opsional (`--tui`).** Antarmuka bertipe retained-mode yang
  menyimpan percakapan sebagai data (id stabil, tanda terbuka/tertutup per blok,
  teks lengkap) dan menggambar ulang sebuah frame darinya, alih-alih menambahkan
  baris ke scrollback dan melupakannya. Setiap reasoning, output `run_command`, dan
  jawaban (dan kini blok shell) bisa dibuka secara independen, beberapa sekaligus,
  dan blok lama tetap bisa dibuka sepanjang sesi; transkrip menggul di dalam
  aplikasi (`PgUp`/`PgDn`, roda, klik untuk melipat) dan composer digambar dalam
  frame yang sama. Tanpa `--tui` antarmuka sebelumnya dipakai tanpa perubahan;
  flag diabaikan dengan peringatan ketika tidak ada TTY atau saat `--plain`. File
  baru `src/cli/tui.js`.

- **`/bash <command>` dan `!command`.** Menjalankan sendiri command shell, di
  workspace, tanpa melibatkan model: tanpa prompt persetujuan (Anda yang
  mengetiknya), tetapi `--read-only` tetap menolaknya. Output dicetak lengkap
  alih-alih pratinjau 5 baris, tangkapannya dibatasi (ekor disimpan, ditandai
  terpotong), dan command, exit code, durasi, serta output dicatat sebagai giliran
  pengguna dalam percakapan sesi dan worklog, sehingga model tugas berikutnya
  sudah tahu apa yang dijalankan. `Ctrl+C` membatalkannya dengan menyinyalkan
  seluruh grup proses, sehingga anak-anak dari pembungkus `sh -c` tidak selamat.
  Variabel environment yang tampak seperti kredensial dibuang dari proses anak
  (`sanitizedEnv`). `src/services/ushell.js` dan `Agent.recordUserShell()` baru.
- **Pencarian web multi-provider MCP dengan fallback otomatis.** `web_search` kini
  adalah satu tool yang didukung `WebSearchManager`, yang terhubung secara malas ke
  You.com (profil gratis tanpa kunci), Firecrawl (tingkat tanpa kunci), server stdio
  DuckDuckGo lokal opsional, Tavily (butuh kunci API), dan backend REST Serper yang
  sudah ada. Provider dicoba menurut urutan yang bisa dikonfigurasi; timeout,
  galat DNS/jaringan, HTTP 401/403/429/5xx, kegagalan handshake/penemuan, tool yang
  hilang, ketidaksesuaian skema, dan payload tidak valid semuanya pindah ke provider
  berikutnya. Retry dibatasi (hanya kegagalan pemanggilan sesaat, backoff
  eksponensial dengan jitter), `429` langsung diteruskan, dan dua kegagalan
  berturut-turut membuka circuit breaker 60 detik. Penemuan tool memetakan tool
  ke pencarian/ekstraksi menurut nama, deskripsi, dan skema input, dan semua hasil
  dinormalkan (URL hanya http(s), dedupe menurut URL kanonik, judul/snippet/teks
  terbatas, atribusi provider). Jika semua provider gagal, agent menerima satu galat
  bertipe dan melanjutkan tanpa mengarang hasil. Terminal mencetak satu pohon
  ringkas dengan status dan durasi tiap provider; kunci dan header tidak pernah
  dicatat. `read_url` kini jatuh kembali ke provider MCP berkemampuan ekstraksi
  saat pengambilan lokal gagal atau tidak mengekstrak teks. Konfigurasinya memakai
  `WEB_SEARCH_ENABLED`, `WEB_SEARCH_FALLBACK`, `WEB_SEARCH_PROVIDERS`,
  `WEB_SEARCH_DISABLED`, `WEB_MCP_TIMEOUT_MS`, `WEB_MCP_MAX_RETRIES`, `YDC_API_KEY`,
  `FIRECRAWL_API_KEY`, `TAVILY_API_KEY`, dan `DUCKDUCKGO_MCP_ENABLED`; periksa
  dengan `/web status|providers|test|enable|disable`. Pencarian You.com, pencarian
  Firecrawl, dan ekstraksi Firecrawl sudah diverifikasi terhadap server MCP live;
  Tavily tidak bisa diverifikasi tanpa kunci, dan server stdio DuckDuckGo opsional
  tidak dijalankan karena `uvx` tidak terpasang.

- **Tool `read_url`.** Mengambil satu URL http(s) publik dan mengembalikan teks
  hasil ekstraksi, judul, serta meta deskripsinya, sehingga model bisa
  memverifikasi snippet pencarian terhadap halaman sumbernya alih-alih
  memercayainya. Ia selalu terdaftar (tanpa kunci), read-only, dan bebas
  persetujuan, mengikuti maksimal 5 redirect sambil memeriksa ulang setiap hop
  (https→http ditolak), menolak URL dengan kredensial tertanam, hanya membaca jenis
  konten tekstual, membatasi badan hingga 2 MB dan teks hingga 1.000–50.000
  karakter (bawaan 20.000), serta memetakan kegagalan ke `READ_URL_INVALID`,
  `READ_URL_REDIRECT`, `READ_URL_AUTH`, `READ_URL_NOT_FOUND`,
  `READ_URL_RATE_LIMIT`, `READ_URL_UPSTREAM`, `READ_URL_TIMEOUT`,
  `READ_URL_NETWORK`, `READ_URL_UNSUPPORTED`, dan `READ_URL_FAILED`. Alamat lokal,
  privat, link-local, CGNAT, dan metadata cloud ditolak dengan `READ_URL_BLOCKED`
  (nama, literal IP, dan pemeriksaan DNS pra-fetch, diperiksa ulang pada setiap
  redirect); DNS rebinding dikendalikan tetapi tidak dihilangkan sepenuhnya.
  Halaman yang dirender JavaScript mengembalikan tanpa teks alih-alih gagal. System
  prompt memperlakukan teks halaman yang diambil sebagai data tak terpercaya dan
  mencatat setiap pengambilan ke worklog. `web_search` kini menunjuk ke tool ini
  saat sebuah snippet perlu dikonfirmasi.

- **Tool `web_search`.** Hasil Google dari SERP API Serper-kompatibel, dimodelkan
  dari pencarian web Freebuff: `title`/`url`/`snippet` plus kotak jawaban, "people
  also ask", dan pencarian terkait, dengan `depth: \"standard\" | \"deep\"`. Ia
  opt-in (`SEARCH_API_KEY`), tidak pernah terdaftar tanpa kunci, men-cache kueri
  identik per sesi, mencatat setiap pencarian ke worklog, dan memetakan kegagalan
  ke `SEARCH_AUTH`, `SEARCH_RATE_LIMIT`, `SEARCH_UPSTREAM`, `SEARCH_TIMEOUT`,
  `SEARCH_NETWORK`, `SEARCH_BAD_RESPONSE` alih-alih mengembalikan hasil kosong.
  System prompt kini mewajibkan mengutip URL sumber dan menandai apa pun yang tidak
  dibuktikan snippet sebagai belum terverifikasi.

- **Session worklog.** Fakta terverifikasi — file yang dibaca beserta rentang
  barisnya, file yang diubah, command dengan exit code, temuan, rencana, dan tugas
  lebih awal — disimpan sepanjang sesi dan diteruskan ke tugas berikutnya dalam satu
  pesan `TASK BRIEF`. Tindak lanjut (`lanjutkan`, `continue`, `sudah?`) kini
  melanjutkan pekerjaan alih-alih memulai ulang analisis. Periksa dengan
  `/worklog`; ia disimpan bersama sesi dan dipulihkan oleh `/resume`.
- **Pembacaan berulang diblokir.** `read_file` pada path yang sudah ada di
  worklog dan punya mtime sama mengembalikan balasan `cached: true` (ditampilkan
  sebagai `↺` di feed aktivitas) alih-alih membaca dan menganalisis ulang file.
  Membaca file yang berubah, rentang berbeda, atau memverifikasi file yang baru
  disunting agent tetap bekerja.
- **Baris aktivitas kaya telemetri dan detail per-pemanggilan.** Baris live kini
  menampilkan fase, waktu fase, total waktu run, langkah, tool yang sedang berjalan
  beserta posisi antriannya (`writing edit_file src/x.js (2/5)`), token
  prompt/completion live, dan latensi token pertama. Setiap pemanggilan model
  mencetak `◇ model 9.4s · 21.3k↑ 388↓ tok · first token 1.8s`, dan respons yang
  terpotong menyatakannya.
- **Output command live.** stdout/stderr dari command yang berjalan mengalir ke
  wilayah live (ekor terbatas) alih-alih hanya muncul setelah proses keluar.
- **Diff perubahan file di UI.** Setiap create/write/edit mencetak baris `-`/`+`
  yang benar-benar berubah (`• Edit src/agent/agent.js (+12 −3)`), dibatasi 24
  baris, sehingga pengguna bisa mengaudit perubahan dan membatalkan + menugaskan
  ulang bila salah.
- **Watchdog aliran mandek** (`AGENT_STREAM_IDLE_TIMEOUT_MS`, bawaan 45s): aliran
  respons yang berhenti mengirim byte dibatalkan dan dilaporkan sebagai
  `STREAM_STALLED` alih-alih menahan satu langkah terbuka tanpa batas. Permintaan
  juga tidak lagi bisa hidup melampaui tenggat tugas.
- Command `/worklog`; `/status`, `/history`, dan `/sessions show` kini melaporkan
  durasi, jumlah pemanggilan model, dan bacaan yang dipakai ulang.

- Flag CLI `--auto-approve`: melewati prompt persetujuan untuk setiap aksi tool
  (command, penulisan, penghapusan) agar agent bisa bekerja tanpa pengawasan.
  Bisa dikombinasikan dengan `-y` (yang hanya menyetujui penulisan);
  `--auto-approve` mencakup semuanya. Sintaks shell mentah tetap butuh
  `AGENT_ALLOW_SHELL=true`.
- Binary global `ryuu` (lewat `npm link`); nama `ryuu` sebelumnya tetap menjadi
  alias. Dijalankan dari folder mana pun, folder itu tetap menjadi workspace dan
  jatuh kembali ke `.env` CLI terpasang untuk `NVIDIA_API_KEY` ketika folder saat
  ini tidak punya.
- HUD terminal futuristik: banner gradien `RYUU // AGENT OS`, panel telemetri,
  feed aktivitas berbasis rail, panel reasoning live, kartu gerbang persetujuan,
  dan dasbor ringkasan run.
- Pesan assistant sadar-Markdown: heading, bold/italic, inline code, link, daftar,
  kutipan, blok kode bersal dengan penyorotan ringan, dan tabel sadar-lebar yang
  mengecil, membungkus, atau jatuh ke tata letak vertikal ketika terminal terlalu
  sempit. Markdown dirender di HUD maupun mode plain.
- Memori percakapan lintas tugas: permintaan dan jawaban setiap tugas yang selesai
  disimpan dan dikirim sebagai konteks untuk tugas berikutnya dalam sesi yang sama,
  sehingga agent mengingat apa yang diminta sebelumnya. Periksa dengan `/memory`,
  pulihkan memori sesi tersimpan dengan `/resume <session-id>`, lupakan dengan
  `/clear`. Giliran disunting, disimpan sebagai teks user/assistant saja (tidak
  pernah pesan tool mentah) dan dibatasi `AGENT_MAX_CONTEXT_CHARS`.
- Jawaban akhir dialirkan langsung sebagai teks biasa sementara provider masih
  menulisnya, alih-alih hanya muncul setelah langkah selesai. Kotak khusus untuk
  aliran reasoning; jawaban yang dialirkan tidak pernah dibungkus kotak maupun
  dicetak dua kali (ringkasan tidak merendernya ulang).
- CLI membersihkan terminal saat start (`console.clear()` di awal `main`), sehingga
  banner selalu dimulai pada layar bersih. Ini tidak berpengaruh ketika stdout
  bukan TTY (pipe, CI, tes).
- Katalog model bernomor untuk `/model`: `z-ai/glm-5.3-flash`,
  `nvidia/nemotron-3.5-super-vl-120b-a12b`, `google/diffusiongemma-26b-a4b-it`,
  `poolside/laguna-xs-2.1`, dan `stepfun-ai/step-5-preview` bergabung dengan model
  DeepSeek bawaan, sehingga berpindah tidak perlu mengetik ulang id
  `provider/model` yang panjang.
### Diperbaiki

- **Jawaban yang dialirkan tidak lagi tumbuh melewati blok-blok yang mengikutinya.**
  TUI menambahkan setiap `contentDelta` sebuah tugas ke blok jawaban terbuka
  pertama, sehingga teks dari langkah berikutnya terus memperpanjang blok awal itu —
  jawaban tampak menggul ke belakang dan terkubur di bawah blok reasoning dan tool.
  Delta kini memulai blok baru setiap kali blok lain ditambahkan setelah blok yang
  terbuka, dan `streamedResponse()` mengingat bahwa teks benar-benar dialirkan,
  sehingga ringkasan akhir tidak digandakan. Dicakup oleh sebuah tes yang
  mengalirkan teks, menjalankan tool, mengalirkan lagi, dan menegaskan urutan blok
  serta barisnya.

- **`/exit` kini benar-benar keluar.** Menutup UI melepas listener-nya tetapi
  meninggalkan stdin dalam mode flowing, sehingga event loop tetap hidup setelah
  layar dibersihkan: proses tampak menggantung pada layar kosong sampai `Ctrl+C`
  kedua. `ComposerInput.dispose()`, `PromptSession.close()`, `Tui.close()`, dan
  kembalian interaktif di `main()` kini menjeda stdin, dan pemeriksaan PTY
  end-to-end (stdin dibiarkan terbuka) menunjukkan proses kembali ke shell segera
  setelah `/exit` di kedua antarmuka.

- **Payload tool-call yang rusak tidak lagi membunuh run.** Provider memvalidasi
  setiap string `function.arguments` di percakapan pada *setiap* permintaan, jadi
  dulu satu payload terpotong menggagalkan permintaan *berikutnya* dengan
  `messages[n].tool_calls[i].function.arguments must be a valid JSON object string`
  dan membatalkan seluruh tugas. Payload terpotong kini diperbaiki (string/array/
  objek terbuka ditutup), pemanggilan yang diperbaiki dieksekusi, dan payload yang
  tidak bisa diperbaiki diganti dengan `{}` dalam sejarah tersimpan sementara model
  diberi tahu untuk mengirimnya ulang. Provider menyederhanakan permintaan sekali
  lagi, sehingga payload rusak tidak lagi bisa sampai ke API.
- Tool call dengan argumen yang rusak bukan lagi jalan buntu: agent melaporkan galat
  parse persisnya kembali ke model, tetap bekerja, dan melanjutkan tugas alih-alih
  menggagalkan run.
- Pemanggilan gagal yang identik diblokir setelah dua kali (command yang keluar
  dengan `1` juga dihitung), sehingga agent berhenti membakar langkah pada galat
  yang sama dan diberi tahu untuk mengganti tool, argumen, atau melaporkan
  temuannya.
- Penolakan provider yang hanya disebabkan oleh payload tool yang teracuni
  (`INVALID_TOOL_ARGUMENTS`) kini dikenali sebagai bisa dipulihkan alih-alih
  dilaporkan sebagai `BAD_REQUEST` yang tidak bisa dipulihkan.

### Diubah

- **Sambung ulang dan giliran model kosong tidak lagi mengakhiri tugas.**
  `AGENT_MAX_RECOVERY_ATTEMPTS` kini berbawaan `0`, yang berarti *tanpa batas*:
  tautan provider yang putus terus menampilkan heartbeat dan mencoba ulang dengan
  backoff eksponensial (maksimal 30s) sampai provider menjawab, tenggat tugas lewat,
  atau pengguna membatalkan. Nilai positif (1–1000) tetap memaksakan batas keras.
  Giliran model kosong juga diperlakukan sebagai percobaan ulang, bukan galat: agent
  mendorong model, melakukan beat `empty response · attempt N (unlimited)`, menunggu
  dengan backoff berbasis `AGENT_RECOVERY_BACKOFF_MS` (maksimal 15s), dan bertanya
  ulang di bawah nomor langkah yang sama, sehingga percobaan ulang tidak
  mengonsumsi anggaran `AGENT_MAX_STEPS` maupun memunculkan galat runtime
  `EMPTY_RESPONSE`. Diverifikasi oleh uji unit yang menjalankan pemulihan melewati
  batas lima-percobaan lama dan empat giliran kosong berturut-turut.
- **System prompt dirakit sekali per sesi dan dipakai ulang byte-per-byte.** Ia kini
  menjadi kontrak menetap (aturan pengoperasian, katalog tool, fakta project)
  alih-alih instruksi per-tugas, sehingga identik pada setiap langkah, tidak pernah
  tumbuh, dan ramah cache. Setiap tugas hanya menambah badan lewat `TASK BRIEF`.
- **Prompt mengoptimalkan untuk waktu.** Ia menyatakan aturan lanjutan, meminta
  maksimal enam pemanggilan tool independen dalam satu respons, melarang membaca
  ulang file worklog, mewajibkan satu verifikasi sempit alih-alih loop eksploratif,
  dan memberi tahu model untuk menyatu pada 70% anggaran.
- `finish_reason: \"length\"` kini ditangani: pemanggilan tool yang terpotong dibuang
  dan dilaporkan ke model (`TRUNCATED_RESPONSE`), tidak pernah dieksekusi. Ini
  menghilangkan mode gagal ketika payload terpotong yang sudah diperbaiki menulis
  setengah file ke disk.
- Sesi menyimpan `durationMs`, `modelCalls`, `requestMs`, `firstTokenMs`,
  `cachedReads`, dan worklog terbatas, sehingga riwayat run bisa diaudit setelahnya.
- Satu baris aktivitas yang selalu menyala kini berada di bagian bawah UI percakapan,
  dianimasikan 10 fps dengan spinner dan jam berjalan, berpindah fase bersama run:
  `thinking` saat model bekerja di latar, `reasoning` saat aliran reasoning-nya
  ditampilkan, dan `working` sebagai cadangan (merakit tool call, menjalankan
  command, persetujuan, mengalirkan jawaban). Ia dibersihkan saat run berakhir,
  tidak pernah meninggalkan frame liar, dan hanya barisnya sendiri yang dicetak ulang
  per tick, sehingga model lambat tidak pernah terlihat membeku dan terminal tidak
  dibanjiri.
- Tugas dikirim dengan satu Enter. Kontrak sebelumnya menunggu Enter kedua yang
  kosong, yang membuat CLI duduk di prompt `>` telanjang tanpa uplink tugas dan
  tanpa baris aktivitas, tampak mati. Tugas multi-baris tetap tersedia dengan
  mengakhiri baris menggunakan `\\`; prompt kelanjutan adalah `↳` dan menampilkan
  petunjuk.
- Kotak reasoning dan baris aktivitas kini berbagi satu wilayah live yang ditambatkan
  pada baris pertamanya, sehingga output yang diselang-seling (rencana, peringatan,
  hasil tool, jawaban yang dialirkan) selalu membersihkan dan menggambar ulang di
  tempat. Header kotak tidak lagi menampilkan waktu berjalan yang hanya disegarkan
  saat reasoning baru tiba.
- Banner kini memakai wordmark blok `RYUU` enam baris yang jelas alih-alih glif
  ringkas, dipusatkan di atas tagline dan panel telemetri.
- Loop agent tidak lagi berhenti pada jumlah langkah tetap. `AGENT_MAX_STEPS` kini
  berbawaan `0` (tanpa batas) dan hanya berperan sebagai batas opsional;
  `--max-steps 0` melakukan hal yang sama. `AGENT_MAX_TASK_DURATION_MS` dan `Ctrl+C`
  tetap menjadi penjaga tugas yang lari sendiri.
- Renderer menampilkan `step n` dan `unlimited steps` ketika tidak ada batas yang
  dikonfigurasi.
- Panel reasoning live kini menjadi kotak tertutup yang lebarnya sesuai: header,
  lima baris pratinjau (sebelumnya dua), dan batas bawah. Ia tetap berada di layar
  saat reasoning berakhir — ringkasan `reasoning n chars` ditambahkan di bawahnya
  alih-alih menghapus pratinjaunya, dan path log reasoning tidak lagi dicetak.
- Tampilan penuh `Tab` kini menjadi viewport berbatas dengan gaya header tertutup
  simetris yang sama dengan pratinjau (`last n/m · Tab: preview`), direbut kembali
  di tempat, sehingga berpindah kembali ke pratinjau tidak lagi meninggalkan teks
  liar.
- `/model` bekerja menurut nomor: ia mendaftarkan katalog dengan model terpilih
  ditandai, dan `/model <n>` berpindah. Argumen `provider/model` mentah ditolak
  dengan penunjuk ke daftar. Pilihan disimpan ke `.ryuu/preferences.json` dan tetap
  ada setelah CLI restart (`--model` eksplisit tetap menang untuk satu run).
- Penggambaran ulang kotak reasoning tidak lagi bergeser satu kolom ke kanan:
  penghapusan di tempat kini mereset kursor dengan carriage return sebelum dan
  sesudah melangkah, sehingga header tetap simetris dengan batas bawah pada setiap
  penggambaran ulang.
- Jawaban yang dialirkan kini merender Markdown inline saat tiba (bold, italic,
  code, link), sehingga penanda `**bold**` tidak lagi bocor ke terminal. Baris
  panjang membungkus pada batas kata sehingga token Markdown tidak pernah terpotong
  setengah, dan baris parsial yang dibuffer selalu dikosongkan sebelum output lain —
  sebuah PLAN atau baris tool tidak lagi bisa membelah jawaban di tengah kalimat.
- Token kontrol chat-template model yang bocor (`<|channel>`, `<channel|>`,
  `<start_of_turn>`, `</tool_call>`, `<|repo_name|>`, …) dibuang dari jawaban yang
  dialirkan, teks reasoning, rencana, catatan, dan respons akhir.
- Jawaban yang dialirkan merender lebih banyak Markdown secara langsung: header ATX
  (`### title`) kehilangan tanda pagarnya dan dirender tebal, tabel pipe dan blok
  kode bersal dit buffer dan dirender sebagai blok begitu selesai dialirkan
  (tidak pernah sebagai baris `|` mentah atau pagar ```), dan pembungkusan baris
  panjang kini menjaga rentang `**bold**`/`code` tetap seimbang sehingga penanda
  tidak lagi bisa bocor sebagai asterisk nyasar.
- Rencana kini memimpin langkah: ia diekstrak hanya dari respons pertengahan tugas
  (yang dilanjutkan dengan tool call) dan dikeluarkan sebelum ringkasan reasoning.
  Jawaban akhir dengan daftar penjelasan bernomor tidak lagi dikira sebagai rencana.
- Baris tabel yang dialirkan tidak lagi terfragmentasi: deteksi blok kini berjalan
  pada baris logis (dibatasi newline), sehingga baris tabel pipe yang lebih lebar
  dari layar tidak pernah dibungkus di tengah sel — ia dibuffer utuh dan dirender
  oleh perender tabel sadar-lebar ketika tabel berakhir. Garis horizontal (`---`)
  dirender sebagai pembatas redup dan kutipan blok (`>`) kehilangan penandanya dan
  dirender sebagai kutipan, alih-alih bocor mentah.
- Pengerasan system prompt dari bukti lapangan: periksa `file_info` sebelum membaca
  file yang mungkin besar, jangan pernah mencoba ulang bacaan "too large" (pakai
  `search_files` atau rentang baris sempit), dan jaga sel tabel Markdown tetap
  pendek untuk output terminal.
- System prompt kini membawa katalog tool langsung (setiap tool terdaftar beserta
  argumen dan gerbang persetujuannya), skrip `package.json` milik project itu
  sendiri dan tata letak modul workspace, sehingga model memilih tool yang benar
  alih-alih keluar ke `grep`/`rg`, dan tahu command apa saja yang benar-benar
  disediakan project tersebut.
- System prompt mendapat aturan argumen eksplisit (satu objek JSON, tanpa pagar,
  tanpa pemotongan, kutip yang di-escape) dan aturan pemulihan (pemanggilan yang
  gagal adalah bukti, exit code `1` biasanya berarti "tidak ada yang cocok", jangan
  pernah menjalankan ulang command identik).
- Kegagalan provider yang bisa dipulihkan (jaringan, timeout, `5xx`, `429`) dicoba
  ulang oleh agent dengan backoff eksponensial alih-alih membatalkan tugas, dibatasi
  oleh `AGENT_MAX_RECOVERY_ATTEMPTS` (bawaan 5) dan `AGENT_RECOVERY_BACKOFF_MS`
  (bawaan 1000).
- **Heartbeat** kini membuktikan agent masih hidup saat memulihkan diri:
  `♥ heartbeat · reconnecting · attempt 2/5 in 1.0s`, diikuti
  `♥ heartbeat · link restored after 2 attempt(s)` ketika provider menjawab lagi.
  Payload rusak menampilkan `♥ heartbeat · INVALID_ARGUMENTS · …` selama pemanggilan
  diperbaiki. Baris aktivitas tetap berputar selama penantian, sehingga terminal
  tidak pernah terlihat membeku.
- Pemisahan warna: teks respons (jawaban akhir dan catatan yang dialirkan) memakai
  palet putih, sementara baris tugas, nama tool/command, dan baris command di panel
  bukti memakai biru.
### Dokumentasi

- Mendokumentasikan aliran reasoning langsung (`reasoning_content`, pratinjau lima
  baris dalam kotak tertutup, `Tab` untuk tampilan penuh, log di
  `.ryuu/logs/reasoning/`), memori percakapan (`/memory`, `/resume`), dan aliran
  langsung jawaban akhir.
- Bagian pemecahan masalah README yang baru: "Tautan terputus di tengah run
  (heartbeat)", "must be a valid JSON object string (HTTP 400)", dan "Sebuah tool
  terus gagal", plus dua variabel environment pemulihan yang baru.
- Memperbaiki keterbatasan README yang masih mengklaim respons tidak dialirkan, dan
  membuat petunjuk toggle reasoning penuh konsisten berbahasa Inggris.

## [0.1.0] - 2026-10-20

Rilis pertama yang bisa dipakai: agen coding otonom yang bergerbang persetujuan
untuk terminal.

### Ditambahkan

- UI terminal interaktif dengan banner bermerek, info model/provider/workspace/
  runtime, pesan status berwarna, rencana tugas, langkah bernomor, aktivitas tool
  live, durasi, permintaan persetujuan, penolakan, ringkasan bukti akhir, serta mode
  plain untuk penggunaan non-TTY.
- Loop agent eksplisit di atas Chat Completions API NVIDIA yang kompatibel dengan
  OpenAI (`https://integrate.api.nvidia.com/v1`, bawaan
  `deepseek-ai/deepseek-v4.1-flash`): tool call tervalidasi skema, penegakan
  persetujuan, bolak-balik hasil tool, deteksi pemanggilan duplikat, penanganan
  argumen rusak, penolakan tool tak dikenal, pemadatan konteks berbatas, batas
  langkah/durasi/output, dan pembatalan.
- Tool workspace: `list_files`, `tree`, `read_file`, `search_files`, `file_info`,
  `create_file`, `edit_file`, `write_file`, `move_file`, `delete_file`, `diff_file`,
  `inspect_git`, dan `project_summary`.
- Tool proses: `run_command`, `start_process`, `list_processes`,
  `get_process_output`, dan `stop_process`, dengan stdout/stderr asli, exit code,
  sinyal, durasi, timeout, buffer terbatas, serta penghentian bersih lalu paksa.
- Klien provider dengan retry terbatas dan jitter untuk kegagalan sesaat, dukungan
  `Retry-After`, serta pemetaan yang bisa ditindaklanjuti untuk 401/403/404/429/5xx,
  galat koneksi, timeout, galat panjang konteks, dan tool calling yang tidak
  didukung.
- Slash command: `/help`, `/exit`, `/clear`, `/status`, `/model`, `/workspace`,
  `/files`, `/tree`, `/tools`, `/processes`, `/logs`, `/cancel`, `/history`,
  `/sessions`, `/diff`, `/undo`, `/config`, dan `/doctor`.
- Riwayat sesi lokal, caching ringkasan project dengan invalidasi, pemadatan
  konteks, log yang disunting (redacted) dengan rotasi, serta undo stack terbatas
  sesi dengan pemeriksaan file basi.
- Registry tool dengan skema JSON, tingkat risiko, metadata persetujuan, validasi
  plugin, dan deteksi tabrakan.

### Keamanan

- Penolakan escape path workspace dan symlink; path absolut di luar workspace
  ditolak.
- Pemblokiran file rahasia untuk `.env*`, kunci, sertifikat, dan direktori
  kredensial.
- Direktori hasil-generate (`node_modules`, `.git`, `dist`, output build, ...)
  dikecualikan secara bawaan.
- Command dijalankan dengan array argumen dan `shell: false`; shell mentah butuh
  `AGENT_ALLOW_SHELL=true` plus persetujuan eksplisit. Didokumentasikan sebagai
  **bukan sandbox**.
- Variabel environment yang tampak seperti kredensial dibuang dari proses anak.
- Kunci API dan pola token disunting dari log, sesi, galat, dan output command.
- Penulisan atomik yang mempertahankan akhir baris, dengan perlindungan mtime basi
  opsional.
- `.env` dan seluruh state lokal di bawah `.ryuu/` dikecualikan dari Git.

### Pengujian

- 109 uji unit dan integrasi offline memakai runner tes bawaan Node, workspace
  sementara, provider terskrip, dan `fetch` yang disuntikkan.
- Cakupannya meliputi penolakan traversal/symlink, pengecualian rahasia, batas
  ukuran, baca/daftar/cari, diff, sunting aman, penolakan persetujuan, validasi
  argumen, tool tak dikenal, normalisasi/pemetaan galat/retry provider, keluar/
  timeout/truncasi proses, redaksi log dan izin log khusus pemilik, sesi/pemadatan,
  eksekusi command yang disetujui dengan stdout/stderr/exit code/durasi asli, serta
  perilaku start/doctor CLI.

### Keterbatasan yang diketahui

- Validasi API NVIDIA langsung pada 2026-10-20 berhasil dengan `z-ai/glm-5.3`
  (tool call plus jawaban akhir). Endpoint `deepseek-ai/deepseek-v4.1-flash` bawaan
  saat itu habis waktu di sisi provider; pakai `--model` atau `NVIDIA_MODEL` sebagai
  solusi dan jalankan ulang `npm run doctor -- --live`.
- Respons dialirkan dan dikumpulkan sisi-klien; tool call hanya berjalan berurutan.
- `/undo` terbatas pada tugas saat ini dan menolak saat file berubah di bawahnya.
- Tidak ada sandbox atau isolasi kontainer tingkat OS.
- Pembersihan pohon proses di Windows bersifat best-effort.

