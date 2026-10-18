# update_agent.md — CoderRa: agent berjalan di VPS

Status: rancangan (belum ada kode). Disusun dari pembacaan kode repo ini dan diskusi dengan pemilik.
Bagian yang belum diverifikasi ditandai **[BELUM DIVERIFIKASI]** dan dikumpulkan di bagian 14.

## 1. Tujuan dan keputusan

Agent (host Node + pi) berjalan di VPS. APK tetap dipakai seperti biasa untuk chat, melihat dan
mengedit file, git, deploy, dan seterusnya. Bedanya, prosesnya hidup di VPS dan tetap bekerja saat HP tidur.

Keputusan yang sudah disepakati:

| Topik | Keputusan |
| --- | --- |
| Pengguna | Hanya pemilik (satu orang, satu VPS, satu klien aktif) |
| Sumber kebenaran | **VPS**. Workspace utama ada di VPS, bukan di HP |
| Sync | Bukan via git. UI membaca dan menulis file VPS lewat RPC. Git hanya untuk publish, deploy, dan PR |
| VPS | Ubuntu 26.x, x86_64, ada akses root (hanya untuk bootstrap) |
| User agent | `coderra`, non-root, tanpa sudo |
| Shell agent | Container **Podman rootless** (opsi C). `apt install` bebas di dalam container |
| Transport | SSH (key) ke daemon yang tetap hidup. Tidak ada port baru yang dibuka |
| Mode lokal | Tetap ada dan perilakunya tidak berubah (diputuskan: dipertahankan) |
| Sumber daya VPS | 4 GB RAM, 2 core, 50 GB disk (anggaran di bagian 15) |
| Terminal | Memakai `tmux` agar sesi bertahan saat koneksi putus (diputuskan) |
| Notifikasi | Aktif sejak awal lewat ntfy (bagian 10) |
| Tujuan operasi | Agent bekerja 24 jam sampai tugas selesai, tanpa HP (bagian 15) |

Di luar cakupan: multi-pengguna, iOS atau web, sync dua arah otomatis, manajemen VPS dari app.

## 2. Arsitektur

```
APK (Flutter) ──MethodChannel──> Kotlin AgentRuntime
                                   │  mode lokal : libnode.so host.mjs        (seperti sekarang)
                                   │  mode remote: ssh <alias> .coderra/bin/coderra-attach
                                   ▼
                              VPS (Ubuntu), user coderra
   sshd ──> coderra-attach ──unix socket──> coderra-hostd (systemd --user, Restart=always)
                                              ├─ host.mjs (pi SDK, Guard, Runner, Mcp, ...)
                                              ├─ fs.ts, preview server, ring buffer + seq
                                              └─ tool bash ──> `box` ──> Podman container (root di dalam)
```

Prinsip:
- `AgentClient` (Dart) tidak diubah secara protokol: tetap JSONL, tetap `call(type, args)`.
- Perbedaan mode ada di tiga tempat: transport (Kotlin), `AgentFs` (Dart), dan host (`--listen`).
- Setiap perubahan ditaruh di file baru bila mungkin, supaya merge dari upstream AndroPI tetap ringan.

## 3. Perubahan terhadap diskusi sebelumnya

1. **Unit systemd menjadi unit user** (`~/.config/systemd/user/`), bukan unit sistem. Podman rootless
   butuh `XDG_RUNTIME_DIR` milik user. Dengan `loginctl enable-linger coderra`, daemon tetap hidup tanpa login.
2. **Host dipasang di `~/.coderra/host`**, bukan `/opt`, supaya `rsync` dari app tidak butuh root.
3. **Profil server disimpan di sisi app**, bukan di host. Daftar host SSH sekarang ada di
   `integrations.json` milik host lokal (`integrations.ts`). Di mode remote host lokal tidak jalan,
   jadi app harus bisa membuat key dan menulis konfigurasi SSH sendiri (bagian 8.2).
4. **Layar Container Linux tidak disembunyikan**, tetapi dipakai ulang untuk mengelola box Podman.
5. **Update APK perlu penanganan khusus** karena APK diunduh oleh host (bagian 9.4).

## 4. Protokol

Dasar tidak berubah: perintah `{id,type,...}` masuk, `response` dan record lain keluar (lihat header `host.ts`).

### 4.1 Tambahan di protokol

- Respons gagal boleh membawa `code` (sekarang hanya string `error`):
  `{"type":"response","id":7,"ok":false,"error":"...","code":"conflict"}`.
  `AgentError` mendapat field `code`. Kode: `ENOENT`, `EEXIST`, `EACCES`, `outside_root`,
  `conflict`, `too_large`, `busy`.
- Record yang disiarkan ke klien mendapat nomor urut `seq` (integer naik, per proses daemon):
  `{"seq":1042,"type":"event",...}`. `response` tidak diberi `seq` karena terikat `id`.
- Perintah baru: `resume`, `host_info`, `fs_*`, `preview_serve`, `preview_stop`, `approvals_pending`,
  `host_restart`, `tasks_get` (bagian 16.1).
- Record baru: `hello_server` (setelah attach), `kicked`, `resume_gap`, `ping`.

### 4.2 Resume dan replay

Record yang disimpan di ring buffer dan diputar ulang: `event`, `approval`, `approval_dismiss`, `task`,
`runs`, `run_finished`, `agent_done`, `dev_server`, `tunnel`, `notice`, `state`, `error`, `mcp`, `tasks`.

Alur saat klien tersambung (sudah dibangun di `agent/src/transport.ts`):

1. Klien menerima `{"type":"hello_server","protocol":1,"mode":"vps","epoch":"a1b2c3","seq":N,"firstSeq":F,"hostVersion":"..."}`
   lalu `ready`. `epoch` mengenali proses daemon; `seq` adalah nomor record terakhir; `firstSeq` yang tertua di buffer.
2. **Tidak ada record langsung yang dikirim sebelum klien mengirim `resume`.** `resume` berfungsi sebagai "berlangganan":
   `{"id":1,"type":"resume","since":M,"epoch":"a1b2c3"}` (M = `seq` terakhir yang sudah diproses), atau `"since":null`
   untuk "mulai dari sekarang" tanpa replay (klien baru, riwayat diambil dengan `messages`).
3. Jika `M` masih ada di buffer dan `epoch` sama, host menulis record `M+1..N` berurutan, lalu responsnya
   `{replayed:n, gap:false, seq, epoch}`. Penggantian ke mode langsung terjadi dalam satu langkah yang sama, jadi
   tidak ada record yang terkirim dua kali atau terlewat.
4. Jika `M` sudah terbuang, `M` lebih besar dari `seq`, atau `epoch` berbeda (daemon dimulai ulang; penomoran mulai dari
   nol lagi), responsnya `{gap:true}` tanpa replay. Klien lalu memanggil `state`, `messages` (`loadHistory()` sudah ada)
   dan `approvals_pending`, dan tetap langsung berlangganan.
5. Deduplikasi `seq <= lastSeq` di klien tetap disarankan sebagai sabuk pengaman, tetapi tidak lagi dibutuhkan
   untuk kebenaran.

Mode stdio (host sebagai proses anak app di HP) tidak berubah sama sekali: tanpa `hello_server`, tanpa `seq`, tanpa buffer.

Ukuran buffer: 5.000 record atau 20 MB, mana yang lebih dulu tercapai. Dibatasi karena delta streaming
kecil tetapi hasil tool bisa besar.

Kebijakan koneksi: satu klien aktif. Koneksi baru mengirim `kicked` ke yang lama lalu menutupnya; apa pun yang masih
dikirim klien yang sudah ditendang diabaikan. Host mengirim `{"type":"ping"}` tiap 15 detik dan menutup klien yang
diam lebih dari 45 detik; klien membalas dengan `{"type":"ping","background":true|false}` (dijawab `pong`) sehingga
host tahu apakah app sedang di latar belakang (untuk keputusan mengirim notifikasi ntfy). Socket unix dibuat 0600 di
folder 0700; socket sisa dari proses yang mati diganti, socket yang masih dipakai atau file biasa ditolak.

Perintah yang sedang berjalan saat koneksi putus **tidak diulang otomatis** (misalnya `prompt` tidak
idempoten). Completer-nya gagal dengan "connection lost"; setelah resume, event menunjukkan apakah
perintah itu sempat berjalan.

### 4.3 Perintah filesystem (`agent/src/fs.ts`, file baru)

Root yang diizinkan:

| Root | Akses |
| --- | --- |
| `workspace` (`ANDROPI_WORKSPACE`) | baca dan tulis |
| `<agentDir>/skills` | hanya baca (untuk `skills_screen`) |
| `<agentDir>/updates` | hanya baca (APK hasil unduhan, bagian 9.4) |

Aturan wajib:
- Semua path di-`realpath`; hasilnya harus berada di bawah salah satu root. Symlink yang menunjuk keluar
  root ditolak (`outside_root`). Perintah ini tidak lewat `Guard`, jadi pengecekan ini satu-satunya pagar.
- Menolak operasi pada root itu sendiri (`fs_delete` dan `fs_rename` pada workspace).
- Batas baca `length` 256 KB per panggilan; batas editor 1,5 MB (`_maxEditableBytes`) dipaksakan di UI dan host.

Perintah:

```
fs_list   {path}                       -> [{name,type:"file"|"dir"|"link",size,mtime,git?:bool}]
fs_stat   {path}                       -> {exists,type,size,mtime}
fs_read   {path,offset,length}         -> {data:<base64>,size,mtime,eof}
fs_write  {path,data:<base64>,offset,final?,expectMtime?,uploadId?}
                                       -> {size,mtime}     (menulis ke file sementara; rename atomik saat final)
fs_mkdir  {path,recursive?}            -> {}
fs_rename {from,to}                    -> {}
fs_copy   {from,to}                    -> {}               (rekursif, di sisi host)
fs_delete {path,recursive?}            -> {}
```

- `expectMtime` dikirim saat menyimpan dari editor. Jika mtime file berbeda, host membalas `code:"conflict"`
  (agent atau proses lain mengubah file sejak dibuka).
- `git:true` pada `fs_list` ditentukan host (ada `.git`), supaya `folder_picker` tidak perlu satu panggilan per folder.

Yang akhirnya dibangun (`agent/src/fs.ts`), berbeda atau lebih rinci dari sketsa di atas:
- `fs_list {path, detectGit}` mengembalikan `{name,type,size,mtime,link,git}`. Tautan yang targetnya di luar root, atau putus, dilaporkan `type:"missing", link:true` tanpa menyebut targetnya.
- `fs_write {path,data,offset,final,uploadId,expectMtime}`: `final` bawaan `true`; satu panggilan cukup untuk file kecil. Chunk berikutnya wajib memakai `uploadId` yang sama dan `offset` yang tepat (`bad_offset` bila tidak). `{uploadId, abort:true}` membuang unggahan. File disusun di `.coderra-up-<uploadId>` di folder yang sama lalu di-rename; mode file lama dipertahankan (skrip tetap executable), file baru 0644. Menulis lewat tautan di dalam root mengubah targetnya dan mempertahankan tautannya. Unggahan yang menggantung disapu setelah 15 menit.
- `expectMtime` (ms) diperiksa di chunk pertama dan di chunk terakhir; file yang hilang juga dianggap `conflict`.
- `fs_rename` dan `fs_copy` menolak nama tujuan yang sudah ada (`EEXIST`), menolak memindah atau menyalin folder ke dalam dirinya (`EINVAL`), dan root tidak bisa dipindah atau dihapus (`EPERM`). `LocalFs` tidak seketat itu, jadi UI harus memeriksa `exists` lebih dulu.
- `fs_delete` pada tautan hanya menghapus tautannya, dan hapus rekursif tidak mengikuti tautan.
- Kode galat tambahan: `invalid_path`, `invalid_argument`, `not_a_file`, `unknown_command`, selain kode errno Node apa adanya.
- Penjaga disk, `fs_*` untuk `agentDir/updates` (root hanya-baca sudah terdaftar), dan batas `maxList` 20.000 entri sudah ada; batas tulis 256 MB.

### 4.4 Preview

```
preview_serve {dir}   -> {port}   // server statis Node, bind 127.0.0.1, port acak, terkunci ke dir
preview_stop  {port}  -> {}
```

Server berhenti otomatis setelah 30 menit tanpa permintaan. Permintaan dibatasi ke `dir` (realpath, tanpa symlink keluar).

**Hasil (Fase 7).** Respons `preview_serve` adalah `{port, token, dir}`; URL-nya
`http://127.0.0.1:<port>/<token>/<berkas>`. Token ditambahkan (tidak ada di rencana awal) karena loopback server
dipakai semua pengguna mesin itu dan loopback ponsel oleh semua app. Folder harus berada di dalam `workspace`;
`dir` yang sama memakai server yang sama.

### 4.5 Lain-lain

- `hello` ditambah `mode` (`"local"` | `"vps"`) dan `protocol`.
- `app_update_check` menerima `currentBuild` dan `currentVersion` dari app (bagian 9.4).
- `host_restart {whenIdle:true}`: host keluar (exit 0) setelah tidak ada run aktif; systemd menyalakannya lagi.
- `approvals_pending` mengembalikan approval yang belum dijawab (perlu method baru di `Guard` yang membaca map `pending`).

## 5. Host (`agent/src/`)

### 5.1 Transport dan daemon

- `host.ts` mendapat opsi `--listen <path>` (atau `ANDROPI_LISTEN`). Tanpa opsi itu, perilaku sekarang
  (stdin/stdout) tidak berubah, sehingga Android lokal tetap sama.
- `send()` sekarang menulis ke `process.stdout`. Diganti menjadi `emit(record)`:
  beri `seq`, simpan ke ring buffer bila termasuk daftar 4.2, lalu tulis ke klien yang tersambung.
  Mode stdin memakai satu "klien" dengan stdout.
- Pada `--listen`: handler `stdin end` yang sekarang memanggil `process.exit(0)` dan `session?.dispose()`
  tidak berlaku. Saat klien putus, proses dan run agent tetap berjalan. Proses hanya keluar saat SIGTERM
  atau `host_restart`.
- File baru: `agent/src/transport.ts` (pengiriman, ring buffer, resume) dan `agent/src/fs.ts`.
  Perubahan di `host.ts` dibatasi pada: `send` → `emit`, daftar `case`, dan `main()`.

### 5.2 Mode VPS (`ANDROPI_MODE=vps`)

- **`ensureAgentsFile`**: template yang sekarang berisi "shell mksh, tidak ada sudo, apt, pkg",
  "container proot", dan path Android. Di VPS itu menyesatkan. Perlu template kedua yang menyatakan:
  bash berjalan di container Ubuntu sebagai root, workspace di-mount di path yang sama, `apt` boleh dipakai,
  tool file langsung ke VPS, dev server bisa dibuka lewat port forward dari app.
  Marker `AGENTS_MARKER` dipertahankan agar file buatan pengguna tidak ditimpa.
- **Container**: `Container` (proot + Docker Hub) tidak dipakai. Diganti `PodmanBox` (bagian 7).
- **DNS**: default `system` (bukan `cloudflare` DoH) di VPS.
- **`NODE_OPTIONS`**: `--max-old-space-size=1024` (sama seperti Android). RAM VPS hanya 4 GB dan box
  perlu bagian terbesar, jadi heap host tidak dinaikkan. Diatur di unit systemd.
- **MCP stdio**: `mcp.ts` (baris 86) memakai `command: "/system/bin/sh"` untuk server MCP non-container.
  Path itu tidak ada di Ubuntu. Ganti menjadi `process.env.SHELL ?? "/bin/sh"` (atau cek platform).
  Satu-satunya path Android lain di `agent/src/` adalah `backupTarget` (`/storage/emulated/0/Download`,
  sudah aman karena ada pengecekan `existsSync` dan fallback ke workspace) dan teks `AGENTS.md`.
- **Cek update APK**: tidak lagi membaca `ANDROPI_APP_BUILD` dari env host (bagian 9.4).
- **Kebijakan run headless**: `buildSession(..., {interactive:false})` tidak memasang `Guard`.
  Tambahkan mode `deny_risky` untuk sesi background: pola `RISKY_BASH` ditolak (bukan ditanyakan).
  Dengan bash di Podman, kerusakan terbatas pada container dan workspace; `git push`, `ssh`, dan deploy tetap diblokir.
- **Notifikasi dorong (opsional, bawaan mati)**: lihat bagian 10.

## 6. Dart: `AgentFs`

```
abstract class AgentFs {
  Future<List<FsEntry>> list(String path);
  Future<FsStat> stat(String path);
  Future<Uint8List> read(String path, {int? maxBytes});
  Future<FsStat> write(String path, Uint8List data, {String? expectMtime});
  Future<void> mkdir(String path);
  Future<void> rename(String from, String to);
  Future<void> copy(String from, String to);
  Future<void> delete(String path);
  Future<bool> exists(String path);
}
```

- `LocalFs`: `dart:io`, perilaku sekarang.
- `RemoteFs`: memanggil perintah `fs_*` lewat `AgentClient.call`, dengan chunking dan callback progres untuk
  unggah dan unduh.
- Diakses lewat `agent.fs`, dipilih berdasarkan mode.

## 7. Box (Podman rootless)

Tool file pi (`read`, `write`, `edit`, `grep`, `find`) berjalan langsung di VPS. Hanya tool `bash` masuk container,
memakai mekanisme yang sudah ada: `settingsManager.setShellPath(container.shellPath)` dengan launcher `box`.

- Container persisten bernama `coderra-box`, image berbasis Ubuntu dengan alat dasar (`git`, `curl`,
  `ca-certificates`, `openssh-client`, `build-essential`, `python3`, `ripgrep`). Definisi di
  `server/box/Containerfile`. Tag image **[BELUM DIVERIFIKASI]**: pastikan tag Ubuntu yang dipakai tersedia.
- `server/box/box` (skrip bash di VPS): memastikan container berjalan (`podman start` bila berhenti),
  lalu `exec podman exec -i [-t jika tty] -w "$PWD" coderra-box /bin/bash "$@"`. Pemanggilan `box -c '<cmd>'`
  sama dengan `box.sh` di Android.
- Opsi `podman run`: `--name coderra-box --network=host --memory=2g --memory-swap=3g --cpus=1.5 --init`
  (angka untuk VPS 4 GB / 2 core; alasannya di bagian 15.1).
  Jaringan host dipakai agar `ssh -L` untuk preview dan dev server langsung menjangkau `localhost:<port>`.
- Mount:
  - `~/workspace` → path yang sama (rw), sehingga berkas dibagi dua arah.
  - `~/.coderra/box-home` → **di path home yang sama** dengan home asli (rw, 700). Alasannya: `~/.ssh/config` yang ditulis
    `integrations.ts` memuat jalur absolut (`IdentityFile /home/coderra/.ssh/id_ed25519`), yang harus valid di dalam.
  - `~/.gitconfig`, `~/.ssh/config`, `id_ed25519(.pub)` **disalin** ke box-home tiap `box` dipanggil (bukan bind mount
    berkas tunggal, karena `git config` menulis dengan rename sehingga bind mount menunjuk inode lama). `known_hosts`
    hanya disalin sekali agar host yang dipelajari box tidak hilang.
  - **Jangan** mount seluruh home dan **jangan pernah** menyalin `~/.ssh/authorized_keys` (diuji). Root di dalam
    container adalah `coderra` di host (rootless); kalau `authorized_keys` bisa ditulis dari situ, agent bisa menanamkan
    akses SSH permanen.
- Variabel `GITHUB_TOKEN`, `GH_TOKEN`, `VERCEL_TOKEN` diteruskan **hanya dengan nama** (`-e NAMA`, nilai diambil Podman dari
  lingkungan; tidak muncul di daftar proses). Host mengekspornya ke `process.env`
  lewat `Integrations.exportEnv`). Token GitHub dari device flow memakai scope `repo workflow read:org`;
  token ini bisa terbaca agent di dalam container, itu disengaja.
- Hak file: root di container dipetakan ke `coderra` di host, jadi file yang dibuat agent di workspace dimiliki
  `coderra` dan bisa dibaca `fs_*` tanpa `--userns=keep-id`.
- Layar Container Linux di app dipakai ulang: status, "Bangun ulang box" (hapus container dan buat lagi),
  tombol "bash berjalan di box" (setara `container_enable`). Teks menyesuaikan mode.
- Implementasi: antarmuka `ContainerBackend` dengan `ProotContainer` (kode `container.ts` sekarang) dan
  `PodmanBox`. Perintah `container_*` yang ada dipertahankan sehingga UI tidak perlu perintah baru.
- Perintah `apt install` dari dalam proyek yang butuh Docker (`docker compose`) tidak tersedia di dalam box.
  Jika kelak diperlukan, sediakan toggle terpisah (sudo/Docker) dengan peringatan.

## 8. Android (Kotlin) dan sisi app (Dart)

### 8.1 Kotlin `AgentRuntime`

- Tambah `startRemote(context, alias)`: `ProcessBuilder` ke `ssh` (path `nativeLibDir/libssh_cli.so`, atau
  `bin/ssh`) dengan argumen:
  `-F <home>/.ssh/config -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3
  -o StrictHostKeyChecking=yes <alias> .coderra/bin/coderra-attach`.
  Pompa stdin/stdout/stderr, `send()`, dan `onExit` dipakai ulang tanpa perubahan.
- `ANDROPI_STORE_KEY` **tidak** dikirim ke VPS (kunci Keystore HP bukan untuk host remote).
- `MethodChannel` `start` menerima argumen mode. Tambah method `appInfo` yang mengembalikan `versionName`
  dan nomor build (dibutuhkan untuk cek update, bagian 9.4).
- Port forward dikelola proses `ssh -N -L` terpisah, atau satu koneksi `ControlMaster` yang dipakai bersama
  attach, forward, dan terminal. `ControlPath` unix socket dibatasi sekitar 104 karakter; path `filesDir`
  Android panjang sehingga perlu direktori pendek di `cacheDir`. **[BELUM DIVERIFIKASI]**
  Pilih setelah prototipe: mulai dari proses terpisah (lebih sederhana).

### 8.2 `RemoteProfile` (Dart, file baru)

Karena host lokal tidak jalan di mode remote, hal-hal yang sekarang dikerjakan `integrations.ts`
(`sshKey`, `writeSshConfig`) harus bisa dilakukan Dart:

- Membuat key ed25519 dengan `ssh-keygen` bawaan (path dari `agent.client.environment()`, yang tidak
  membutuhkan agent berjalan), simpan di `~/.ssh/coderra_vps` (terpisah dari key host lokal).
- Menulis blok konfigurasi terkelola (marker sendiri) di `~/.ssh/config`: `Host`, `HostName`, `User coderra`,
  `Port`, `IdentityFile`, `UserKnownHostsFile`, `StrictHostKeyChecking yes`.
- **Memin host key**: `ssh-keyscan` tidak termasuk binary yang dibundel (`bundle_runtime.py`).
  Karena itu skrip bootstrap mencetak **setup code** (JSON base64: host, port, user, baris host key
  ed25519). Pengguna menempelkannya di app; app menulis `known_hosts` dari situ dan memakai
  `StrictHostKeyChecking yes`. Ini lebih ketat daripada `accept-new` yang dipakai `integrations.ts` sekarang.
- Menyimpan profil (alias, host, port, mode aktif) di `ui.json` bersama `Appearance` (`theme.dart`).
- Tombol "Tes koneksi" (`ssh -o BatchMode=yes <alias> true`) dan "Pasang/Perbarui agent" (bagian 9.6).

### 8.3 `AgentClient` dan `AgentController`

- `ConnectionState { connected, reconnecting, offline }` sebagai stream.
- Saat `exit` di mode remote: jangan langsung `BootStatus.failed`. Mulai loop sambung ulang dengan backoff
  1, 2, 4, 8, hingga 30 detik; tiap sukses kirim `resume {since: lastSeq}`.
- `lastSeq` disimpan di `AgentController`; deduplikasi di `_onRecord`.
- `BootStatus` mendapat `reconnecting` (ditangani di `main.dart` sehingga tidak memunculkan layar gagal penuh).
- Batas 60 detik di `AgentClient.start()` tetap, ditambah timeout SSH.
- Completer yang tertunda saat putus dikembalikan sebagai error `connection_lost`.


**Hasil (Fase 5), dan yang berbeda dari rencana.**

- `startRemote` menerima **perintah yang sudah dirakit Dart** (`argv` + `env`), bukan alias. Seluruh logika ssh
  (config, host key, argumen) ada di Dart dan diuji dengan ssh/sshd asli; Kotlin tinggal menjalankan proses dan
  membuang `ANDROPI_STORE_KEY` dari lingkungannya. Metode channel baru: `startRemote`, `appInfo`.
- Konfigurasi ssh ada di **berkas sendiri** (`~/.ssh/coderra_config`, dipakai dengan `-F`), bukan blok di
  `~/.ssh/config`, supaya tidak berebut dengan `integrations.ts` yang menulis berkas itu. Host key dipin di
  `~/.ssh/coderra_known_hosts`; `GlobalKnownHostsFile /dev/null`, `StrictHostKeyChecking yes`, `HostKeyAlgorithms`
  disesuaikan dengan jenis kunci di setup code. Alamat, user, dan kunci di setup code divalidasi ketat agar tidak
  bisa menyisipkan baris ke config (`-oProxyCommand=...`, baris baru, spasi ditolak).
- Pada koneksi pertama yang gagal, `start()` melempar (layar gagal dengan alasannya, seperti di ponsel). Sambung ulang
  otomatis baru berlaku setelah pernah tersambung. Layar gagal untuk mode server punya tombol "Gunakan agent di ponsel"
  agar server yang salah tidak mengunci pengguna.
- `bootstrap.sh` **tidak** membuat topik ntfy (rencana 10 menyebutnya); app membuat topik acak 128 bit di layar Server
  agent dan menyimpannya lewat `settings_set` (divalidasi host).
- `agent.fs` otomatis `RemoteFs` saat mode server aktif (kalau tidak, layar file menelusuri disk ponsel padahal agent
  bekerja di server). Layar-layar itu belum diperiksa satu per satu di mode server: itu Fase 6.
- Dari 4b: kartu kesehatan server, pengaturan ntfy, dan bar "Lanjutkan" untuk chat terputus sudah ada di app. Sheet
  "Tugas panjang" dan kartu progresnya belum.
- Belum ada: forward port `ssh -L` dan terminal SSH/tmux (Fase 7), pembaruan APK di mode server (9.4), kunci privat
  app disimpan tanpa passphrase di penyimpanan privat app (pertimbangkan Android Keystore).

## 9. UI/UX

### 9.1 Layar yang jalan apa adanya (perintah host)

Chat (streaming, thinking, kartu tool, approval, plan mode, edit dan resend, fork, slash command),
model sheet, git (`git_*`), perubahan dan undo (`checkpoint_*`), pencarian (`rg` di VPS), usage,
tugas background dan jadwal, MCP, template, deploy dan CI, akun GitHub dan Vercel, repos, daftar chat,
database (`db_screen`, path VPS), pengaturan jaringan.

Catatan: token dan API key tersimpan di VPS. Daftar host SSH di layar *Accounts & servers* adalah daftar
host **deploy** milik host aktif. Beri label berbeda dari **Server agent** (profil koneksi app ke VPS).

### 9.2 Perlu diadaptasi

| File | Masalah | Perubahan | Ukuran |
| --- | --- | --- | --- |
| `files_screen.dart` | ±22 pemakaian `dart:io`: list, stat, create, rename, copy rekursif, delete, `Image.file`, baca HTML, import | Semua lewat `agent.fs`. `_copyDir` → `fs_copy`. Gambar → `Image.memory`. Import → unggah. Share dan Save to Downloads → unduh ke cache dulu | L |
| `editor_screen.dart` | `File.readAsBytes`, `writeAsString` | `fs.read` / `fs.write` dengan `expectMtime`; dialog konflik ("File berubah di VPS: muat ulang / timpa / simpan sebagai salinan") | M |
| `folder_picker.dart` | `listSync`, `createSync`, `delete`, `.git`, segmen Phone storage, `storageAccess` | Async; hanya root VPS; buang segmen HP dan kartu izin file; `git` dari `fs_list` | M |
| `new_chat_sheet.dart` | `existsSync`, `listSync`, `createSync` | `fs.exists`, `fs.list`, `fs.mkdir` | S |
| `home_shell.dart` | Quick start: `Directory(...).createSync` | `fs.mkdir` | S |
| `chat_extras.dart` | `preparePrompt` menyalin lampiran non-gambar ke `$cwd/.attachments`; "Project memory" menulis `AGENTS.md` dengan `File` | Unggah ke `.attachments/` lewat `fs.write` dengan progres. Gambar sudah base64, tidak berubah. `AGENTS.md` lewat `fs.exists`/`fs.write` | M |
| `message_views.dart` | `_htmlSource` membaca file; `baseDir` dari `File(...).parent` | `fs.read` setelah selesai (saat streaming tetap memakai konten argumen tool); preview lewat server (9.3) | S |
| `preview_screen.dart` | `loadHtmlString` dengan `baseUrl` lokal | Preview HTML dari file memakai `preview_serve` + port forward → `openUrl` (9.3) | M |
| `terminal_screen.dart` | `ShellSession.start` menjalankan `/system/bin/sh` lokal dan menulis `.andropirc` | Mode remote: `ssh -tt <alias> 'cd <cwd> && exec bash -l'`. Tab `linux` → `ssh -tt <alias> box`. Memakai `tmux new -A -s coderra-<n>` (diputuskan) agar sesi bisa dilanjutkan setelah koneksi putus; `tmux` dipasang oleh bootstrap | M |
| `skills_screen.dart` | `File('${s.path}/SKILL.md').readAsString()` | `fs.read` dari root `agentDir/skills` (hanya baca) | S |
| `backup_screen.dart` | Zip dibuat di VPS; restore dari path teks atau `FilePicker` lokal | Tombol "Unduh ke HP" (via `fs.read` + `saveToDownloads`). Restore dari HP: unggah zip ke VPS dulu. Peringatan ukuran bila "Include workspace" | M |
| `settings_hub.dart` (update APK) | `installApk(path)` dengan path dari host | Bagian 9.4 | M |
| `container_screen.dart` | Teks dan alur khusus proot | Dipakai ulang untuk box Podman | S |

Tidak berubah (hanya memakai string path atau perintah host): `deploy_sheet`, `tasks_screen`, `sessions_drawer`,
`search_screen`, `diff_view`, `git_screen`, `changes_screen`, `db_screen`, `mcp_screen`, `usage_screen`,
`theme.dart` (preferensi UI lokal). Daftar ini berdasarkan grep dan pembacaan sebagian; verifikasi ulang saat
mengerjakan tiap file.

### 9.3 Preview dan dev server

- File HTML: `preview_serve {dir}` → port; app membuka `ssh -N -L 127.0.0.1:<lokal>:127.0.0.1:<port>`;
  `HtmlPreviewScreen.openUrl('http://127.0.0.1:<lokal>/<file>')`. Layar ini sudah mendukung `url`.
  Css, js, dan gambar relatif berjalan seperti di browser.
- Preview langsung saat file sedang ditulis agent (`live`) tetap memakai konten streaming dari argumen tool.
- `DevServerBanner`: `dev_server {port}` datang dari host (port VPS); saat "Preview" ditekan, app membuka
  forward lalu `openUrl`. "Bagikan link publik" (`tunnel_start`, localhost.run) tetap tersedia sebagai opsi.
- Mengakses `http://127.0.0.1` dari WebView rilis: mekanisme yang sama sudah dipakai untuk dev server
  lokal; konfirmasi bahwa cleartext ke loopback jalan di build rilis. **[BELUM DIVERIFIKASI]**

### 9.4 Update APK di mode remote

Masalah: `startAppUpdateDownload` mengunduh APK ke `<agentDir>/updates` **di host**, lalu app memanggil
`installApk(path)` dengan path itu. Di mode remote path tersebut ada di VPS, bukan di HP. Selain itu
`checkAppUpdate` membaca `ANDROPI_APP_BUILD` dari env host, yang di VPS tidak bermakna.

Perbaikan:
1. `app_update_check` menerima `currentBuild` dan `currentVersion` dari app (via method `appInfo`).
2. VPS mengunduh APK (token GitHub ada di VPS; repo privat).
3. App menarik berkas lewat `fs.read` dari root `agentDir/updates` (hanya baca) dengan progres, simpan ke
   cache HP, lalu `installApk(pathLokal)`.

### 9.5 UX baru

- **Indikator koneksi** di header chat: tersambung (hijau), menyambung ulang (kuning, dengan hitungan),
  offline (merah). Plus lencana mode "VPS" atau "Lokal" agar tidak salah sangka sedang mengedit di mana.
- Banner "Agent masih bekerja di VPS" saat app tersambung ulang dan ada run aktif.
- Kartu checklist di chat (dari tool `tasks`, bagian 16.1): progres N/M, item aktif, dapat dilipat.
- **Layar Server agent** (di Settings): alamat, port, user, tempel setup code, tampilkan public key app
  (salin), tombol Tes koneksi, status daemon (versi host, Node, uptime, run aktif), tombol Pasang/Perbarui
  agent, tombol Putuskan.
- **Pasang agent**: lihat 9.6.
- Dialog konflik di editor.
- Progres dan pembatalan untuk unggah dan unduh (lampiran, import, backup, APK).
- Info kesehatan VPS (disk bebas, memori, beban, uptime daemon) di layar Server agent, dengan peringatan
  saat disk menipis. Untuk operasi 24 jam ini bukan opsional (bagian 15).
- Chat dan sesi mode remote terpisah dari mode lokal (host lokal dan host VPS punya `agentDir` sendiri).
  Pindah memakai backup dan restore bila perlu.

### 9.6 Alur pemasangan dari app

1. Pengguna menjalankan skrip bootstrap di VPS sebagai root (bagian 11) dan menyalin setup code.
2. Di app: Settings → Server agent → tempel setup code → app membuat key dan menampilkan public key.
   (Catatan urutan: public key dibutuhkan bootstrap. Dua cara: app membuat key lebih dulu dan pengguna
   menempelkannya ke skrip lewat `--pubkey`, atau skrip membuat user dan pengguna menambahkan key sesudahnya
   lewat `ssh-copy-id`/panel penyedia. Pilih cara pertama: app menghasilkan perintah siap-salin berisi `--pubkey`.)
3. Tes koneksi → `rsync -az --delete <hostDir>/ coderra@vps:~/.coderra/host/`
   (hostDir = hasil ekstrak `agent.zip`, berisi `host.mjs`, `node_modules`, `skills`) →
   bandingkan `.stamp` → `host_restart {whenIdle:true}`.
4. App mengganti mode ke remote dan melakukan boot seperti biasa.

Catatan: `build.mjs` memangkas `node_modules` tanpa binary desktop, jadi isi `hostDir` kemungkinan netral
platform dan bisa jalan di Linux x86_64. **[BELUM DIVERIFIKASI]** (uji di VPS sebenarnya).

## 10. Notifikasi saat app tertutup

Notifikasi sekarang lokal (`agent_done`, approval) dan hanya muncul saat app hidup (`home_shell.dart`).
Di VPS, host bisa mendorong notifikasi saat tidak ada klien tersambung.

- **Aktif sejak awal** (diputuskan pemilik). Host memakai ntfy: `bootstrap.sh` membuat topik acak
  panjang (≥ 128 bit) dan menyimpannya di `~/.coderra/env` (`NTFY_URL`, `NTFY_TOPIC`). Server bawaan
  `https://ntfy.sh`; bisa diganti ke ntfy self-hosted.
- Pemilik memasang aplikasi ntfy di HP (terpisah dari CoderRa) dan berlangganan topik itu. Itu yang
  menerima notifikasi saat CoderRa tertutup. App CoderRa menampilkan topik di layar Server agent
  (salin atau QR) agar mudah berlangganan.
- Kirim hanya judul generik tanpa isi pesan, path, atau nama proyek: "Agent selesai",
  "Butuh persetujuan", "Tugas gagal", "Disk hampir penuh", "Daemon dimulai ulang".
  Alasan: di ntfy.sh siapa pun yang tahu topik bisa membaca dan mengirim ke topik itu, jadi topik adalah
  rahasia dan isinya tidak boleh sensitif.
- Hanya dikirim bila tidak ada klien tersambung (atau tersambung tapi app di latar belakang, ditandai
  klien lewat record `ping`). Dibatasi: maksimal 1 notifikasi per jenis per 60 detik.
- Pengiriman ke pihak ketiga ini disadari dan disetujui pemilik. Bisa dimatikan di pengaturan host
  (`notify.enabled`) dan dialihkan ke server sendiri.
- Alternatif yang tidak dipilih: bot Telegram (butuh token tambahan), FCM (butuh Firebase).

## 11. Server: `server/` di repo

```
server/bootstrap.sh              # dijalankan sebagai root, sekali (idempoten)
server/coderra-hostd.service     # unit user systemd
server/coderra-attach            # jembatan stdin/stdout <-> unix socket (skrip Node)
server/box/box                   # peluncur bash di dalam container Podman rootless
server/box/Containerfile         # image box (Ubuntu 24.04 + alat dasar)
server/test/bootstrap-in-container.sh   # menjalankan bootstrap.sh sungguhan di container Docker sekali pakai
```

Sudah dibangun dan diuji (bagian 13, Fase 4). Hal-hal yang berbeda dari sketsa awal:

### 11.1 `bootstrap.sh`

Pemakaian: `sudo ./bootstrap.sh --pubkey "ssh-ed25519 AAAA... coderra-app" --address agent.example.com`.
Opsi lain: `--user`, `--node-version`, `--no-box`, `--harden-ssh --admin-user NAME`, `--dry-run` (tanpa root, hanya
mencetak). Isi folder `server/` harus utuh di mesin itu (salin dengan `scp -r` atau `git clone`).

Langkah (semua idempoten):
1. Validasi argumen: `--pubkey` harus satu baris kunci publik tanpa opsi di depannya (mencegah penyisipan opsi atau baris
   kedua), `--address` hanya nama host atau IP, `--harden-ssh` wajib disertai `--admin-user`.
2. `apt-get install`: `git ripgrep fd-find rsync curl ca-certificates tmux openssh-client xz-utils` ditambah, kecuali
   `--no-box`, `podman uidmap slirp4netns passt catatonit dbus-user-session fuse-overlayfs`. **`socat` tidak lagi
   dipakai** (`coderra-attach` memakai Node). `catatonit` wajib untuk `podman run --init`.
3. Node dari tarball resmi `nodejs.org` (versi bawaan 24.22.0, diverifikasi dengan `SHASUMS256.txt`) ke
   `/opt/node-v…` dengan symlink `/usr/local/bin/{node,npm,npx}`; dilewati jika sudah ada Node ≥ 22.19.
4. User `coderra` tanpa sudo (peringatan keras jika ternyata ada di grup `sudo`, `docker`, `lxd`, `adm`), rentang
   sub-uid/gid, `loginctl enable-linger`.
5. Folder dan berkas: `~/.coderra` (700), `~/.pi/agent` (700), `~/workspace`, `coderra-attach` dan `box` di
   `~/.coderra/bin`, `Containerfile`, unit di `~/.config/systemd/user`. `~/.coderra/env` berisi
   `ANDROPI_STORE_KEY` acak (600), dibuat sekali dan **tidak pernah diganti** (kunci baru membuat token tersimpan
   tak terbaca).
6. `authorized_keys` dengan opsi (diverifikasi di sshd sungguhan):
   `restrict,pty,port-forwarding,permitopen="127.0.0.1:*",permitlisten="127.0.0.1:1"`. `permitopen` dengan port `*` memang
   sintaks yang sah dan hanya mengizinkan `-L` ke loopback server; `port-forwarding` saja masih mengizinkan `-R`, jadi
   `permitlisten` menutupnya; `restrict` mematikan agent forwarding.
7. Unit di-`enable` tetapi **tidak** di-start: `ConditionPathExists=%h/.coderra/host/host.mjs`. App menyalin host lalu
   menjalankan `systemctl --user restart coderra-hostd`.
8. Podman: cek `podman info`, `podman build -t localhost/coderra-box`, lalu `podman run --rm … true` sebagai uji asap.
   Jika `podman info` gagal, skrip memberi petunjuk AppArmor dan tidak membangun image.
9. `--harden-ssh --admin-user X`: menulis `/etc/ssh/sshd_config.d/10-coderra.conf` (`PasswordAuthentication no`,
   `PermitRootLogin no`, `AllowUsers coderra X`; diberi nama `10-` agar menang atas `50-cloud-init.conf` karena sshd
   memakai nilai pertama), menolak jika admin tak punya `authorized_keys`, memeriksa dengan `sshd -t` dan
   membatalkan jika ditolak, lalu `reload`.
10. Mencetak **setup code**: `coderra1:` + base64 dari
    `{"v":1,"host":…,"port":…,"user":"coderra","hostKey":"ssh-ed25519 AAAA…"}`. Tanpa host key (tidak ada openssh-server)
    skrip berhenti: kode tanpa kunci yang dipin tidak berguna. Skrip juga mengingatkan bahwa box berbagi jaringan server.

### 11.2 Unit user (`coderra-hostd.service`)

Isi akhir ada di berkasnya. Perbedaan penting dari sketsa:
- **Tanpa `NoNewPrivileges=yes`.** `newuidmap` dan `newgidmap` di Ubuntu 24.04 adalah setuid-root (diperiksa pada paket
  `uidmap`), dan Podman rootless membutuhkannya; `no_new_privs` akan mematikannya.
- Ada `ConditionPathExists`, `StartLimitIntervalSec=300`/`StartLimitBurst=5`, `TimeoutStopSec=15`, dan
  `EnvironmentFile` yang wajib ada (tanpa kunci, token akan tertulis polos).
- `MemoryMax=1280M` dan `CPUWeight=200` terbukti berlaku untuk unit user di Ubuntu 24.04 (cgroup didelegasikan).
- `PrivateTmp` berfungsi di sini, tetapi tidak dipakai; sandbox namespace tidak dibutuhkan.
- AppArmor 24.04 membatasi user namespace (`kernel.apparmor_restrict_unprivileged_userns=1`), namun paket `apparmor`
  memuat profil untuk `podman`, `crun`, `buildah`, dan `runc`, sehingga Podman rootless tetap bisa. Belum diuji di
  Ubuntu 26. **[BELUM DIVERIFIKASI]**

### 11.3 `coderra-attach`

Skrip Node (CommonJS, tanpa dependensi) yang menyambungkan stdin/stdout ke `~/.coderra/host.sock` (atau
`$CODERRA_SOCK`). App memanggilnya dengan `ssh <alias> .coderra/bin/coderra-attach` (jalur relatif terhadap home, jadi
tidak bergantung pada PATH sesi ssh non-login; `node` ada di `/usr/local/bin`). Kode keluar 0 normal, 1 putus di tengah,
3 daemon tidak berjalan (alasannya di stderr: "the host is not running"). Menutup stdin (ssh putus) menutup sisi
daemon; ditendang (`kicked`) menyelesaikan keluaran lalu keluar 0.

## 12. Keamanan

| Risiko | Mitigasi |
| --- | --- |
| Perintah `fs_*` dipakai membaca di luar workspace | `realpath` + root allowlist + tolak symlink keluar; test khusus |
| MITM saat pertama menyambung | Host key dipin lewat setup code, `StrictHostKeyChecking yes` (diuji dengan sshd sungguhan: host key yang berbeda ditolak, host yang tak dikenal tidak dipercaya pada pemakaian pertama) |
| Kunci app dipakai untuk lebih dari yang perlu | `authorized_keys` dengan `restrict,pty,port-forwarding,permitopen="127.0.0.1:*",permitlisten="127.0.0.1:1"`: tunnel `-L` hanya ke loopback server, tanpa `-R`, tanpa agent forwarding (diuji). Kunci tetap bisa menjalankan perintah apa pun sebagai `coderra`: itu yang membuat terminal berfungsi, jadi batasnya adalah akun `coderra` itu sendiri |
| Siapa pun yang mencapai socket mengendalikan agent | Socket 0600 di direktori 0700; akses hanya lewat SSH |
| Prompt injection dari halaman web atau repo | Bash di Podman rootless; tanpa sudo di host; `authorized_keys` tidak di-mount |
| Run background tanpa persetujuan | Mode `deny_risky` untuk sesi headless |
| Sub-agent `worker` mengubah file atau menjalankan perintah | Selalu `deny_risky`; anak tidak punya tool `subagent`; `worker` diblokir di plan mode; checkpoint sebelum perubahan pertama (bagian 16.2) |
| Token GitHub terbaca agent di dalam box | Disengaja (agent perlu `git push`); scope dibatasi; VPS khusus, tanpa rahasia lain |
| Kunci enkripsi `secure.ts` | `ANDROPI_STORE_KEY` dari `~/.coderra/env` (0600), bukan dari Keystore HP |
| API key provider kustom plaintext di `models.json` | `~/.pi/agent` mode 0700; catat sebagai batasan yang sudah ada |
| Kehabisan disk atau memori | `MemoryMax`, `--memory`/`--cpus` pada box, info kesehatan di UI |
| Terkunci dari VPS | User admin terpisah; sshd hardening dilakukan terakhir |
| Pengiriman data ke pihak ketiga | ntfy opsional, bawaan mati, payload minimal |

Snapshot VPS dari penyedia dianjurkan sebagai jaring pengaman terakhir.

## 13. Fase dan pengujian

Tiap fase berakhir dengan kondisi selesai yang bisa diperiksa.

| Fase | Isi | Selesai bila |
| --- | --- | --- |
| 0 | Infrastruktur uji: `node --test` untuk `agent/` (sekarang `npm test` hanya placeholder) dan test Dart | `npm test` dan `flutter test` berjalan di CI. **Status: selesai.** `cd agent && npm test` menjalankan 44 test (42 lulus, 2 `todo` untuk bug yang sudah ada: awalan path di `guard.ts` dan `<` di blok kode pada `htmlToText`). Workflow `.github/workflows/test.yml` menjalankan `npm test` dan `flutter test`; `flutter test` belum pernah dijalankan di lingkungan pengembangan ini (Flutter tidak terpasang) |
| 1 | `AgentFs` + `LocalFs`; semua pemanggilan `dart:io` di 9.2 dipindah | Mode lokal berperilaku sama (uji manual di HP); tidak ada `dart:io` file API tersisa di layar yang terdaftar. **Status: selesai di kode.** `lib/agent/agent_fs.dart` (antarmuka `AgentFs`, `LocalFs`, helper path) dan `agent.fs` di `AgentController`. Layar yang dipindah: files, editor, folder picker, new chat, quick start, lampiran dan project memory (`chat_extras`), preview HTML di chat (`message_views`), skills. `HtmlPreviewScreen.source` sekarang `FutureOr<String>`. `dart:io` yang tersisa sengaja: lampiran di HP (`chat_extras`), pengaturan UI (`theme.dart`), shell lokal (`terminal_screen`). Terverifikasi: `flutter analyze` (hanya 2 info lama), 49 test Dart (28 `LocalFs`, 16 widget test files/folder picker, 5 lampiran dan new chat). **Belum diuji di perangkat:** editor, preview WebView, preview HTML di chat, skills, quick start, project memory |
| 2 | Host: `fs.ts`, `code` pada error, `approvals_pending`; `RemoteFs` | Test Node: confinement, symlink keluar ditolak, chunk, `expectMtime`; test Dart `AgentFs`. **Status: selesai.** Host: `fs.ts` (+ `host.ts` memanggilnya untuk semua `fs_*`), `code` pada respons gagal, `Guard.pendingApprovals()` dan perintah `approvals_pending`. Dart: `RemoteFs` (`lib/agent/remote_fs.dart`), `AgentError.code`, `FsConflictException`, `expectModified` pada `write`/`writeString` (sekarang mengembalikan `FsStat`), `Features.refreshApprovals()`. Terverifikasi: 87 test Node (51 baru untuk `fs.ts` dan `Guard`) dan 92 test Dart, termasuk kontrak `AgentFs` yang dijalankan terhadap `LocalFs` **dan** `RemoteFs` yang berbicara dengan kode `fs.ts` asli lewat pipa JSONL (`agent/test/harness/fs_server.ts`). Belum dihubungkan ke UI atau transport; `agent.fs` masih selalu `LocalFs`. Test menemukan satu bug nyata: `fs_read` pada named pipe (FIFO) menggantung selamanya; diperbaiki dengan `O_NONBLOCK` dan pemeriksaan tipe pada handle terbuka |
| 3 | Host: `transport.ts`, `--listen`, ring buffer + `seq` + `resume`, `kicked`, `ping`, `host_restart` | Test Node dengan klien palsu: putus, resume tanpa duplikat, gap, kick. **Status: selesai.** `agent/src/transport.ts` (`Hub`, `LineBuffer`, `RestartGate`, `listenOnSocket`) dipakai `host.ts` untuk kedua mode. `--listen <path>` atau `ANDROPI_LISTEN` menjalankan daemon; tanpa itu host berperilaku seperti sebelumnya. Ditambah dibanding rencana awal: `epoch` (mengenali proses daemon), `resume` sebagai langganan, `since:null`, `firstSeq`, `pong`, dan `ping` dari klien membawa `background`. `hello` kini melaporkan `transport` dan `protocol`. `host_restart` hanya untuk daemon. Terverifikasi dengan 120 test Node (33 baru): klien palsu (putus dan sambung ulang tanpa duplikat, gap, kick, batas byte, ping dan klien diam, tulis yang gagal), socket unix sungguhan (izin, pesan besar dengan karakter multibyte, socket sisa), dan **host asli sebagai proses** dalam mode daemon (hello, perintah, `fs_*` dan pagar root, daemon bertahan setelah klien putus, `host_restart`, SIGTERM, daemon kedua ditolak) maupun mode stdio (perilaku lama utuh). Belum ada: sambung ulang di sisi Dart/Kotlin, penanda `running`, notifikasi (`coderra-attach` dan unit systemd dibuat di Fase 4) |
| 4 | `server/` (bootstrap, unit, attach, box) dan mode VPS (`AGENTS.md` VPS, DNS, deny_risky) | Dari laptop: `ssh coderra@vps coderra-attach` lalu kirim JSON manual, prompt berjalan, daemon bertahan setelah ssh diputus. **Status: selesai di sisi yang bisa diuji tanpa Ubuntu 26 dan tanpa root.** Dibangun: `server/` (bagian 11) dan mode VPS di host: `agents-file.ts` (catatan `AGENTS.md` untuk server; teks ponsel terbukti identik byte per byte dengan sebelumnya), DNS bawaan `system`, `mcp.ts` tidak lagi memakai `/system/bin/sh` di server, `ANDROPI_MODE`/`CODERRA_BOX`, bash diarahkan ke `box` bila ada, `container_*` di server diarahkan ke box Podman (Fase 9; semula ditolak), dan **mode `deny_risky`**: run background (juga di HP, yang sebelumnya tanpa Guard sama sekali) menolak perintah berisiko dan tulisan di luar proyek alih-alih bertanya; tool MCP tetap boleh; checkpoint tetap dibuat. Terverifikasi (161 test Node, 10 detik): `coderra-attach` (relay dua arah, megabyte, EOF, ditendang, daemon mati, `HOME` bawaan); `box` terhadap Podman palsu (membuat, start, exec, batas, cwd, token hanya nama, salinan git/ssh tanpa `authorized_keys`, perlombaan pembuatan, `--reset`); **sshd sungguhan** (privat, loopback, kunci sementara) dengan opsi kunci yang persis dibaca dari `bootstrap.sh`: relay, putus lalu replay, `-L` ke loopback jalan dan ke 127.0.0.2 ditolak, `-R` ditolak, kunci tak dikenal ditolak, host key yang tak cocok ditolak, tanpa TOFU; **systemd user sungguhan**: unit asli menyalakan daemon, `MemoryMax`, `host_restart` dan `kill -9` memunculkan proses baru, `stop` bersih, tanpa host tidak start dan tidak gagal; `bootstrap.sh` dijalankan sungguhan di container Debian (apt, useradd, install, `authorized_keys` tanpa duplikat, kunci enkripsi tetap, kode setup) dengan `shellcheck` bersih. **Belum teruji:** Ubuntu 26.x; Podman yang benar-benar berjalan (`podman build`/`run`, profil AppArmor, `--init`, `--network=host`, memory limit, proses yang tertinggal saat `bash` dibatalkan); `loginctl enable-linger` dan `systemctl --user` pada akun baru; jalur `--harden-ssh`; apakah `Containerfile` berhasil di-build (nama paket diperiksa ada di Ubuntu 24.04 lewat `apt-cache`, image belum dibangun). Perlu dijalankan di VPS sungguhan |
| 4a | Tool `tasks` + kartu checklist di chat (bagian 16.1); `buildSession` menerima opsi `tools`. Bisa dikerjakan dan diuji di mode lokal Android lebih dulu | Test Node: transisi status, batas, tulis atomik, record `tasks` ikut replay; di HP: agent membuat dan menandai checklist, kartu berubah langsung, plan mode mengizinkan `tasks`. **Status: selesai.** Dibangun sesuai bagian 16.1 dengan satu perubahan: daftar disimpan di `details` hasil tool (mengikuti percabangan percakapan), bukan di berkas. `buildSession` menerima opsi `tools`. Terverifikasi dengan pi asli dan model tiruan (5 test e2e), 187 test Node, 104 test Dart. **Belum teruji di perangkat:** tampilan kartu di layar sungguhan |
| 4b | Operasi 24 jam di host: bangkit-ulang run yang terputus, supervisor "lanjut sampai selesai", retry/fallback untuk run headless, penjaga disk dan memori, pengirim ntfy (bagian 10 dan 15) | **Status: selesai di sisi host; UI belum.** Dibangun: `longtask.ts` (supervisor), `runs.ts` ditulis ulang (tugas panjang, pulih setelah restart), `retry.ts`, `health.ts`, `notify.ts`, `interrupted.ts`, perintah `health` dan `continue_session`, `state.interrupted`, penanda `~/.coderra/running`, ntfy dari `host.ts`. Terverifikasi dengan pi asli dan model tiruan (265 test Node, tiga kali berturut-turut lulus): tugas panjang jalan sampai checklist selesai; berhenti `blocked` bila tak ada kemajuan; kriteria perintah (keluaran perintah dikirim ke agent); **`kill -9` di tengah tool call lalu run dilanjutkan dari sesinya sendiri dan hitungan iterasi berlanjut** (pi menutup tool call yang menggantung dengan hasil sintetis "No result provided"); rate limit 429 ditunggu lalu lanjut; menyerah setelah batas retry; pindah ke model cadangan; chat yang terputus ditandai dan bisa dilanjutkan; disk hampir penuh menolak `prompt` dan `run_enqueue` di server tetapi tidak di ponsel; ntfy hanya saat tidak ada klien di depan, judul generik, tidak membocorkan isi proyek, bisa dimatikan; restart tak bersih terdeteksi; detak 6 jam. Tiap pengaman diuji dengan mutasi (dihapus, test gagal). **Belum:** UI di app (sheet "Tugas panjang", kartu progres, tombol Lanjutkan di chat, layar kesehatan, pengaturan ntfy); soak 24 jam; memori nyata; kualitas kompaksi pada tugas puluhan jam; `podman` sungguhan untuk `runCommand` |
| 4c | Tool `subagent` v1 (bagian 16.2): sinkron, satu anak, role `explorer` dan `worker` | **Status: selesai di sisi host dan ikon/ringkasan di app.** Dibangun: `subagent.ts` (tool, `Slots`, `progressLine`), `isReadOnlyCall` di `guard.ts`, `createChild` dan opsi `child`/`mcp` pada `buildSession` di `host.ts`, ringkasan dan ikon `subagent` di Dart. Terverifikasi (286 test Node, 105 test Dart; 21 test sub-agent): unit dengan sesi palsu (laporan + footer, dipotong 8.000 karakter, batas waktu, abort dari parent bahkan sebelum mulai, error tanpa/dengan laporan parsial, sesi gagal dibuat mengembalikan slot, parameter salah, preflight disk/anggaran, hanya 2 sekaligus dan yang ketiga menunggu lalu menyerah dengan pesan jelas, keluar dari antrean saat di-abort) dan e2e dengan pi asli + model tiruan: explorer hanya punya tool baca dan tidak melihat percakapan parent, progres sampai ke app, sesi anak tersimpan bernama "↳ judul"; worker menulis file, perintah berisiko miliknya ditolak tanpa bertanya (`deny_risky`) dan ia tidak punya `subagent`/`tasks`; plan mode meloloskan explorer dan menahan worker; `model` bisa dipilih dan model tak dikenal jadi galat yang terbaca parent; abort parent menghentikan anak dan sub-agent berikutnya bisa mulai; run tugas panjang boleh mendelegasikan. Mutasi (explorer diberi semua tool, anak diberi `subagent`, guard menganggap semua sub-agent baca-saja) membuat test gagal. **Belum / berbeda dari rencana:** batas total sesi aktif (3) tidak ada, hanya anak maksimal 2 (`CODERRA_SUBAGENTS_MAX`); anak tidak punya `tasks`; tidak ada retry otomatis untuk anak (rate limit jadi galat tool yang dibaca parent); tombol "Buka sesi anak" di kartu tool belum dibuat; biaya anak masuk `cost()` run hanya selama proses hidup (setelah restart hanya lewat `dailyBudget` yang membaca berkas sesi, angka biaya tidak diuji dengan harga sungguhan); memori nyata dengan 2 anak di VPS 4 GB belum diukur |
| 5 | Kotlin `startRemote`, `appInfo`; Dart `RemoteProfile`, reconnect, indikator koneksi, layar Server agent | **Status: selesai di sisi Dart; Kotlin ditulis tetapi belum dikompilasi.** Dibangun: `agent_backend.dart` (`AgentBackend`, `PlatformBackend`, `ProcessBackend`, `LaunchSpec`), `AgentClient` ditulis ulang (sambung ulang dengan backoff 1/2/4/8/16/30 s, `resume` dari `seq` terakhir, dedup, `kicked`, jawaban `ping` dengan flag latar belakang, panggilan saat putus gagal `offline`/`connection_lost`, `ConnectionState`), `remote_profile.dart` (`SetupCode`, `RemoteProfile`, `RemoteSetup`: kunci ed25519, host key dipin, ssh config, tes koneksi terklasifikasi, install lewat rsync), `remote_mode.dart` (pindah ponsel/server), `server_screen.dart` (chip koneksi, banner, bar "Lanjutkan", layar Server agent dengan kesehatan server dan pengaturan ntfy), perubahan Kotlin (`startRemote`, `appInfo`). Terverifikasi (171 test Dart, 286 test Node): klien Dart melawan daemon Node asli lewat `coderra-attach` asli: balasan yang sedang mengalir saat koneksi diputus (berkali-kali) tiba utuh sekali dengan `seq` berurutan; approval yang muncul saat ponsel tidak ada menunggu saat kembali dan bisa dijawab; daemon dimulai ulang → `resync` dan transkrip dibaca ulang tanpa sisa; perangkat kedua menendang yang pertama dan tidak ada rebutan; **sshd sungguhan** (loopback, kunci sementara, opsi kunci dari `bootstrap.sh`): `check` membedakan belum dipasang / host belum ada / daemon mati / jalan / host key beda / kunci ditolak / tak terjangkau, rsync menyalin dan hanya mengirim yang berubah, rantai ssh → attach → daemon → klien Dart hidup kembali setelah ssh dibunuh, forward `-R` ditolak. Setup code dibaca dari keluaran asli `bootstrap.sh --dry-run`. Mutasi (dedup dibuang, `resume` selalu `null`, ping tanpa flag, `resync` diabaikan, `StrictHostKeyChecking accept-new`) membuat test gagal. **Belum teruji:** semua Kotlin (tidak ada Android SDK/kompiler di sini; CI akan mengompilasinya); `ssh`/`rsync` bawaan Termux di perangkat dengan opsi ini; tampilan di layar sungguhan; jaringan putus sungguhan (di test: proses ssh dibunuh); Android mematikan app di latar belakang; `systemctl --user restart` lewat ssh pada akun baru (`XDG_RUNTIME_DIR`); Ubuntu 26 |
| 6 | `RemoteFs` dipakai di layar 9.2 (files, editor, picker, new chat, quick start, skills) | **Status: selesai.** Layar file, editor, picker folder, sheet chat baru, `preparePrompt` (lampiran) dan layar skill dites **dua kali dengan test yang sama**: di disk ponsel (`LocalFs`) dan terhadap daemon Node asli lewat `RemoteFs` (`test/support/*_suite.dart`, dipanggil dari `files_ui_test.dart` dan `files_ui_remote_test.dart`). Varian server menghitung panggilan `fs_*` dan gagal bila layar tidak memakainya. Perubahan: **dialog konflik di editor** (sebelumnya tidak ada; `expectModified` dipakai: "Keep editing / Save as copy / Load theirs / Overwrite", dan untuk file yang dihapus "Recreate"; menyimpan berturut-turut tidak berkonflik dengan simpanan sendiri); picker folder di mode server tidak menawarkan penyimpanan ponsel atau kartu izin file; `AgentFs.isLocal` supaya preview HTML tidak memberi `baseDir` yang hanya ada di server; tombol Preview dev server dimatikan di mode server (localhost = ponsel) kecuali ada tautan publik. Bug ditemukan dan diperbaiki: `setState` saat build di editor setelah "Load theirs". Terverifikasi: 210 test Dart (dua kali), mutasi (konflik dimatikan, picker tanpa cabang server) membuat test gagal. **Belum:** preview HTML dengan aset relatif dan dev server di mode server (Fase 7: `preview_serve` + port forward), unggah dengan progres dan unduh (Fase 8), `Quick start` di `home_shell` dan "Project memory" tidak dites lewat UI (hanya lewat kontrak `RemoteFs`), perilaku di perangkat |
| 7 | Terminal SSH, `preview_serve`, port forward, `DevServerBanner` | **Status: selesai, kecuali yang tertulis "belum".** Host: `preview.ts` + perintah `preview_serve`/`preview_stop` (server statis di 127.0.0.1, port acak, **token acak di awal setiap URL**, hanya GET/HEAD, tanpa listing, berkas/folder berawalan titik tidak pernah disajikan, symlink yang keluar folder ditolak, berhenti sendiri setelah 30 menit sepi, maksimal 4). App: `PortForwards` (`ssh -N -L` per port server, dibuat saat diperlukan, dibuat ulang bila mati), `RemoteMode.previewUrl/devServerUrl`, `openFilePreview/openDevServer` (halaman HTML dari berkas di server dan dev server dibuka lewat forward; halaman yang masih ditulis agent tetap dari teks streaming), tab terminal di server (`ssh -tt` ke sesi **tmux** bernama `coderra-sh-N`/`coderra-box-N`; koneksi putus atau app ditutup tidak mematikan shell, tab dengan nama sama menyambung kembali; menutup tab mengakhiri sesi; tab Linux menjalankan `box`, shell kontainer yang sama dengan yang dipakai agent). Terverifikasi (297 test Node, 228 test Dart): server preview (token, `..`/`%2e%2e`/`\\`/NUL, symlink, dotfile, redirect folder, idle, batas, 6 MB utuh, lewat perintah host); forward lewat **sshd asli** dengan batasan kunci dari `bootstrap.sh` (`permitopen`: forward ke 127.0.0.2 ditolak; port server yang mati memberi koneksi tertutup, bukan hang; forward yang mati dibuat ulang; yang bersamaan jadi satu); rantai penuh app → ssh → attach → daemon → `preview_serve` → forward → halaman beserta `style.css` relatifnya terbuka, juga `../style.css` bila root = folder proyek; terminal dengan **tmux dan pty sungguhan** (`script`): shell login di folder proyek, shell tetap hidup setelah koneksi dibunuh dan variabel serta job masih ada saat tab baru menyambung, `kill-session`, tab `box`, folder dan nama sesi dengan spasi, kutip, `$( )` tidak dijalankan shell server. Mutasi (token dibuang, filter dotfile dibuang, cek symlink dibuang, `-A` dan kutip tmux dibuang) membuat test gagal. **Belum / batas:** WebView dan pty Flutter di perangkat (di test: fetch URL, dan `script` sebagai pty); dev server yang hanya mendengarkan `::1` (Vite pada Node 17+ bila `localhost` jadi IPv6) tidak terjangkau karena kunci hanya boleh meneruskan ke `127.0.0.1`: jalankan dengan `--host 127.0.0.1`; app lain di ponsel dapat menyambung ke port loopback forward (preview file dilindungi token, dev server tidak); tombol "Bagikan link publik" (`tunnel_start`) tidak diuji; `ControlMaster` tidak dipakai (satu proses ssh per forward); koneksi ssh baru untuk tiap forward dan tab (mahal di jaringan buruk) |
| 8 | Unggah lampiran, unduh berkas, backup, update APK di mode remote | **Status: selesai di sisi host dan Dart; Kotlin (`abi` pada `appInfo`) belum dikompilasi.** Transfer: `AgentFs.upload/toPhoneFile` kini punya `onProgress` dan `CancelToken`; `RemoteFs` melanjutkan transfer setelah koneksi putus (unduhan lanjut dari offset yang sama; unggahan bertanya ke host lewat `fs_write {status}` apa yang sudah sampai, tidak mengirim ganda dan tidak melewatkan satu potongan pun, dan mengulang dari awal bila host kehilangan unggahan, mis. restart), dan unduhan ke disk tidak dibatasi `maxRead`; `AgentClient.whenConnected`; dialog progres + Batal (`runTransfer`) dipakai impor/bagikan/simpan di layar file, lampiran chat (pesan dan lampiran dikembalikan ke kotak input bila gagal atau dibatalkan), backup dan update. Backup: `backup.ts` menulis dan membaca zip **per berkas, dalam potongan kecil** (sebelumnya semua di memori dengan `deflateRawSync`, yang membekukan host: pada server itu berarti ping terlewat dan klien diputus setelah 45 detik; juga membuat zip rusak diam-diam bila >65.535 berkas); batas dicek di awal (60.000 berkas, 3 GB, berkas >256 MB dikeluarkan dan *dilaporkan*), symlink tidak diikuti, restore menolak nama berbahaya (`..`, absolut, `\\`), menolak menulis lewat symlink di folder tujuan, memeriksa CRC dan ukuran, dan menghentikan entri yang berisi lebih dari yang diklaimnya (zip bomb); layar Backup menampilkan perkiraan ukuran, tombol "Download to this phone", dan di mode server memilih zip dari ponsel mengunggahnya dulu. Update APK: host menerima `currentBuild/currentVersion/abi` dari app (lingkungan server tidak berarti apa-apa bagi ponsel), cache hanya menyimpan rilis terbaru (verdict dihitung per penanya), APK dipilih sesuai CPU, nama berkas dari GitHub disanitasi, lalu app menarik APK dari server ke ponsel dengan progres sebelum `installApk`; Android hanya memasang pembaruan yang ditandatangani kunci yang sama. **Bug lama yang ditemukan dan diperbaiki:** polling progres update memakai argumen `id`, yang menimpa id permintaan, sehingga jawabannya tidak pernah sampai (progres unduhan tidak pernah bergerak); sekarang `downloadId`, dan `AgentClient.call` menaruh `id`/`type` terakhir agar argumen tidak bisa menimpanya. Terverifikasi (320 test Node, 265 test Dart): potongan yang tidak sampai / jawabannya yang hilang / potongan terakhir / host yang kehilangan unggahan / koneksi yang tak kembali, dengan host palsu yang menyuntikkan kesalahan; unggah dan unduh 12 MB dengan koneksi **dibunuh di tengah** lewat daemon asli (isi sama persis); batal tidak meninggalkan berkas atau staging; backup/restore bolak-balik, `unzip -t`, zip lama, zip berbahaya buatan Python, loop event tidak terblokir >250 ms saat backup 48 MB; layar Backup dan baris update dengan daemon+sshd+rsync asli. Mutasi (cabang `received == offset+length`, pengecekan stat, drop upload, cek symlink, batas ukuran entri) membuat test gagal. **Belum:** unggah/unduh berjalan serial, satu berkas sekaligus; ZIP64 (di atas 60.000 berkas atau 3 GB backup ditolak dengan pesan, bukan didukung); `_lastBackup` di layar Backup masih statis dan bisa menunjuk jalur mesin lain setelah pindah mode; perilaku di perangkat; APK dari rilis GitHub sungguhan (tes memakai GitHub palsu) |
| 9 | Layar box (Podman), `ContainerBackend` | **Status: selesai, tetapi hanya terhadap Podman palsu; Podman sungguhan belum pernah dijalankan.** Host: `podmanbox.ts` (`PodmanBox`: status, pemakaian, tes, hentikan, reset, bangun ulang image, kosongkan home) di balik perintah `container_*` yang sama (di server `container_install` = bangun ulang image, `container_remove` = buang container, `container_enable` = apakah perintah agent lewat box) ditambah `box_check`, `box_stop`, `box_wipe_home`; perintah di ponsel tidak berubah, dan sebelumnya di server `container_status` melaporkan container proot ponsel yang tidak ada. Perubahan tidak dilakukan selagi agent memakai box: host menolak dengan kode `busy` kecuali app mengirim `force`; dua perubahan sekaligus ditolak; mematikan box menulis ulang `AGENTS.md` agar agent tahu perintahnya kini jalan langsung di server; pengosongan home menolak jalur yang bukan `box-home` dan memakai `podman unshare` untuk berkas milik uid lain. App: `box_screen.dart` (status, lama hidup, memori dan jumlah proses yang menyegarkan diri, tombol tes, sakelar "jalankan perintah agent di box" dengan peringatan sebelum dimatikan, shell di box, hentikan/reset/bangun ulang dengan log/kosongkan home, dialog "agent sedang memakai box: tunggu atau paksa"); `ContainerScreen` dan baris Settings berubah sendiri di mode server. Terverifikasi (345 test Node, 277 test Dart): Podman pengganti berupa skrip yang menyimpan keadaan, dengan launcher `server/box/box` yang asli; tiap pertanyaan podman, batas dari `box.conf` (nilai berbahaya diabaikan), podman yang tidak ada/macet, penggunaan memori dari cgroup (`max`, v1, keluaran rusak), reset/stop/bangun ulang (build gagal mempertahankan container lama), pengosongan home, penjaga `busy` lewat host dan model tiruan yang sedang bekerja, dan layar dengan host skrip. Mutasi (penjaga busy, konfirmasi mematikan box, `force`, pemeriksaan jalur home, tulis ulang AGENTS.md) membuat test gagal. **Belum dan harus diuji di VPS sungguhan:** keluaran asli `podman container inspect --format '{{.State.Status}}|{{.State.StartedAt}}'`, `podman image exists`, `podman exec ... cat /sys/fs/cgroup/memory.current` di Ubuntu 26 (cgroup v2 diasumsikan), `podman unshare`, `podman build` sungguhan dan lamanya, AppArmor; satu kali uji coba tidak teramati: test "mematikan box" gagal sekali di antara ±25 putaran dan tidak bisa direproduksi lagi. Batas memori/CPU hanya ditampilkan (diubah lewat `~/.coderra/box.conf`) |
| 10 | Info kesehatan VPS di UI, dokumentasi (`server/README.md`), pembersihan | **Status: selesai untuk yang bisa dikerjakan tanpa VPS sungguhan; kriteria "lulus di Ubuntu 26 sebenarnya" belum.** Kesehatan di UI sudah ada sejak Fase 5 (disk, memori agent, run, uptime, peringatan disk) dan Fase 9 (memori dan proses box); `server/README.md` ditulis (pasang, apa yang dibuat skrip, keamanan, sehari-hari, masalah, hapus, batas); pembersihan: `writeZip`/`readZip`/`collectFiles` lama dibuang dari `workbench.ts` (tinggal pembantu uji `test/zip_helper.ts`), `_lastBackup` statis di layar Backup dihapus. **Yang belum, dan hanya bisa dibuktikan di VPS (mesin ini menjalankan layanan lain, jadi tidak dipakai):** `bootstrap.sh` dan `podman build` sungguhan, format keluaran Podman, AppArmor, `loginctl enable-linger` pada akun baru, `--harden-ssh`, Ubuntu 26. **Belum dibuat dari rencana:** UI "Tugas panjang" (sheet dan kartu progres, 4b), tombol "Hentikan semua" (15.4), ukuran box lewat `podman stats` (diganti baca cgroup), batas journald, ZIP64, transfer paralel, Android Keystore untuk kunci privat app |

Strategi uji:
- Node: `node:test` bawaan, tanpa dependensi baru. Fokus pada `fs.ts` (keamanan), `transport.ts` (replay), dan
  perilaku `Guard` mode `deny_risky`.
- Dart: test untuk `AgentFs` (keduanya), deduplikasi `seq`, dan logika reconnect (dengan transport palsu).
- Manual: skenario jaringan putus, dua perangkat berebut koneksi (kick), restart daemon saat idle dan saat sibuk
  (harus menunggu idle), file diubah bersamaan di editor dan oleh agent.

## 14. Belum diverifikasi, asumsi, dan pertanyaan terbuka

Belum diverifikasi (tidak ada yang dijalankan di VPS sampai dokumen ini ditulis):
- Versi Node minimum: README pi (`main`) menyebut 22.19+, dan `node:sqlite` dipakai `workbench.ts`.
  Belum dicek terhadap versi pi yang dipin, dan ketersediaan Node serta Podman di Ubuntu 26.
- Sintaks `permitopen` dengan port wildcard di OpenSSH Ubuntu 26.
- Bahwa `hostDir` (build Android) berjalan apa adanya di Linux x86_64.
- Perilaku `ControlMaster` dengan batas panjang path unix socket di Android.
- Cleartext ke `127.0.0.1` di WebView build rilis.
- Tag image Ubuntu untuk box.
- Isi lengkap `terminal_screen.dart`, `message_views.dart`, `git_screen.dart`, `changes_screen.dart`, `db_screen.dart`
  dan layar lain yang hanya diperiksa lewat grep.
- API SDK pi yang belum saya baca (paket belum terpasang di `agent/`): opsi `tools` pada `createAgentSession`,
  semantik `onUpdate` pada tool, apakah beberapa tool call dalam satu giliran dieksekusi paralel, dan apakah
  sesi anak yang dibuat dengan `SessionManager.create` tersimpan di `sessions/` sehingga `usageSummary`
  (dan `dailyBudget`) ikut menghitungnya (bagian 16).
- Ubuntu 26.x memakai `sudo-rs` dan `uutils` (dari ingatan). Tidak berpengaruh pada opsi C karena `coderra` tanpa
  sudo, tetapi `bootstrap.sh` perlu diuji.

Sudah diputuskan pemilik:
1. VPS: 4 GB RAM, 2 core, 50 GB disk (dasar angka di bagian 15.1).
2. `tmux` dipakai untuk terminal.
3. Notifikasi ntfy aktif sejak awal.
4. Mode lokal dipertahankan.

Masih terbuka:
1. Batas iterasi dan anggaran bawaan untuk supervisor "lanjut sampai selesai" (bagian 15.3). Nilai awal
   yang diusulkan tertera di sana; perlu dikonfirmasi.
2. Bagaimana kriteria "selesai" ditentukan untuk tiap tugas (bagian 15.3).

## 15. Operasi 24 jam (keputusan pemilik)

Tujuan: agent bekerja terus sampai tugasnya selesai, tanpa HP. Bagian ini muncul setelah pemilik
menyebut kebutuhan 24 jam; bagian 1 sampai 14 belum mencakupnya secara penuh.

### 15.1 Anggaran sumber daya (4 GB RAM, 2 core, 50 GB disk)

Angka di bawah adalah perkiraan awal, belum diukur.

| Komponen | RAM | CPU | Catatan |
| --- | --- | --- | --- |
| OS, sshd, podman, journald | ~0,7 GB | sisa | Perkiraan |
| Daemon (host Node + pi) | heap 1024 MB, `MemoryMax=1280M` | `CPUWeight=200` | Server MCP stdio (non-container) ikut di cgroup ini |
| Box (Podman) | `--memory=2g --memory-swap=3g` | `--cpus=1.5` | Compiler, `npm install`, tes, dev server berjalan di sini |
| Swap file host | 2 GB, `vm.swappiness=10` | | Dibuat `bootstrap.sh` bila belum ada swap; meredam lonjakan agar OOM-killer tidak mematikan daemon |

Total batas: 1,25 + 2 GB + OS ≈ 4 GB. Sengaja ketat. Jika box sering kena batas, kecilkan jumlah proses
paralel dulu (satu run background, `runs_concurrency` = 1) sebelum menaikkan memori.

Disk 50 GB (perkiraan): image dan container Podman 3-6 GB, sisanya workspace, sesi pi (JSONL), dan checkpoint
(`checkpoints.ts` menyimpan repo git bayangan per folder; tidak dipangkas sekarang).

Penjaga disk (di host, pemeriksaan tiap 5 menit dan sebelum tiap prompt):
- Sisa < 10 GB: peringatan di UI dan ntfy "Disk hampir penuh".
- Sisa < 5 GB: tolak prompt dan run baru (seperti `checkBudget`, galat `code:"disk_low"`), jeda run background,
  kirim ntfy.
- Perawatan terjadwal: `git gc` pada repo checkpoint, batasi checkpoint tersimpan (mis. 50 terakhir per proyek),
  batasi ukuran journald (`SystemMaxUse=500M`). `podman system prune` tidak dijalankan otomatis;
  tersedia sebagai tombol di layar Box.

### 15.2 Bertahan dari restart

Masalah di kode sekarang: konstruktor `Runner` (`runs.ts`) mengubah semua run berstatus `running` menjadi
`error` ("Runs interrupted by an app restart cannot resume"). Untuk tugas 24 jam, daemon yang restart
(crash, OOM, update host) berarti kehilangan seluruh progres. Perubahan:

- Status baru `interrupted`. Run yang terpotong disimpan beserta `sessionFile`-nya.
- `backgroundSession(cwd)` sekarang selalu `SessionManager.create(...)`. Tambah parameter `sessionFile`
  agar bisa `SessionManager.open(sessionFile)` dan melanjutkan percakapan yang sama.
- Setelah boot, run `interrupted` otomatis dilanjutkan dengan prompt "Proses dimulai ulang. Lanjutkan dari
  tempat terakhir." Maksimal 3 kali lanjut otomatis per run untuk mencegah loop crash; sesudahnya status
  `error` dan ntfy.
- Chat interaktif yang terputus: setelah boot host membuka sesi terakhir (`continueRecent`, sudah ada).
  Jika file sesi menunjukkan run belum selesai, kirim record `notice` "Dihentikan di tengah jalan" dan
  tampilkan tombol "Lanjutkan" di chat.
- Penanda shutdown tidak bersih: host menulis `~/.coderra/running` saat mulai dan menghapusnya saat SIGTERM.
  Jika file ada ketika boot, kirim ntfy "Daemon dimulai ulang".
- Unit systemd: `Restart=always`, `RestartSec=2`, `StartLimitIntervalSec=300`, `StartLimitBurst=5`
  (cegah thrash). Update host lewat `host_restart {whenIdle:true}` agar tidak memotong run.

**Hasil (4b).** Pelaksanaan menyimpang sedikit dari rencana: tidak ada status `interrupted`. Saat boot, run
berstatus `running` diantrekan kembali (`resumes` +1, maksimal 3, lalu `error`) dan dilanjutkan dari berkas
sesinya sendiri dengan `RESUME_PROMPT`. Chat interaktif: `state.interrupted` benar bila entri terakhir adalah
pesan pengguna, hasil tool, atau pesan asisten dengan `toolCall` yang belum dijalankan; host mengirim `notice`
dan perintah `continue_session` melanjutkannya (tombol di app belum dibuat). Penanda `~/.coderra/running` dan
ntfy "Host restarted unexpectedly" sudah jalan. Kekhawatiran tool call menggantung **terjawab**: pi menyisipkan
hasil sintetis "No result provided", terbukti di test `kill -9` dengan model tiruan yang memeriksa isi permintaan
sesudah restart. Belum dicoba terhadap penyedia asli (sebagian menolak riwayat tertentu).

### 15.3 Supervisor "lanjut sampai selesai" (baru, opsional per tugas)

Alasan: satu giliran agent berakhir ketika model berhenti memanggil tool. Itu bisa terjadi sebelum tugas benar-benar
selesai atau karena agent bertanya. Untuk 24 jam tanpa pengawasan perlu lapisan luar.

Jenis run baru "Tugas panjang" (di `runs.ts`, dibuat dari layar Tugas):

| Field | Arti | Nilai awal yang diusulkan |
| --- | --- | --- |
| `prompt`, `cwd` | Seperti run biasa | |
| `doneWhen` | Kriteria selesai (lihat bawah) | `checklist` |
| `maxIterations` | Maksimal putaran "lanjut" | 50 |
| `maxHours` | Batas waktu dinding | 24 |
| `maxCostUsd` | Batas biaya untuk tugas ini | sisa `dailyBudget`; 0 = tanpa batas |
| `noProgressLimit` | Berhenti bila N putaran berturut-turut tanpa perubahan file dan pesan terakhir sama | 2 |

Kriteria `doneWhen` (dapat digabung):
- `checklist`: selesai bila daftar dari tool `tasks` (bagian 16.1) berisi minimal satu item dan semuanya
  `done`. Prompt awal supervisor menginstruksikan agent memakai tool itu. Jika setelah putaran pertama belum
  ada item sama sekali, supervisor meminta agent membuatnya. Untuk tugas yang mudah "menipu diri sendiri"
  (mis. tes belum lulus tapi ditandai `done`), gabungkan dengan `command`.
- `command`: perintah di box (mis. `npm test`); selesai bila exit code 0.
- `manual`: tidak pernah dinyatakan selesai otomatis; hanya berhenti oleh batas atau pengguna.

Putaran: setelah `agent_settled`, evaluasi kriteria. Belum selesai dan batas belum tercapai → kirim
"Lanjutkan. Yang tersisa: …" (isi dari checklist atau keluaran perintah). Status akhir: `done`, `blocked`
(berhenti bertanya, atau ditolak berulang oleh `deny_risky`), `limit` (iterasi/waktu/biaya), `error`.
Setiap perubahan status mengirim ntfy. Selama berjalan, ntfy ringkas tiap 6 jam ("Tugas masih berjalan, jam ke-N").

Komponen yang diperlukan:
- **Ketahanan error model untuk run headless.** `tryFallback` hanya terpasang pada sesi chat interaktif
  (`onSessionEvent` di `openSession`); `backgroundSession` hanya mencatat error. Untuk 24 jam, rate limit
  hampir pasti terjadi. Tambahkan pada sesi background: retry dengan backoff (1, 2, 5, 10, 30 menit) dan
  rantai `fallbackModels` yang sudah ada di pengaturan.
- **Konteks panjang.** Mengandalkan kompaksi pi (event `compaction_start` sudah ditangani di
  `AgentController`). Belum diukur seberapa baik kompaksi menjaga tugas 24 jam tetap koheren.
- **Batas biaya.** `checkBudget` hanya membaca `dailyBudget` per hari; supervisor menambah batas per tugas
  dan berhenti dengan status `limit` ketika `checkBudget` melempar galat.
- **UI.** Di layar Tugas: sheet "Tugas panjang" (prompt, folder, kriteria, batas) dan kartu progres
  (iterasi, durasi, biaya, ringkasan checklist, tombol Hentikan dan Lanjutkan). Hasilnya tetap bisa dibuka
  sebagai chat biasa (sesi pi-nya sama).

**Hasil (4b).** `longtask.ts` + `runs.ts`: `run_enqueue` menerima `task` (`doneWhen`, `maxIterations`, `maxHours`,
`maxCostUsd`, `noProgressLimit`, `command`); nilai tak masuk akal ditolak langsung. Status akhir `done`, `blocked`,
`limit`, `error`, `cancelled`. "Tidak ada kemajuan" dihitung dari perubahan berkas (checkpoint), perubahan
checklist, dan pesan terakhir. Keluaran perintah kriteria diteruskan ke agent. Setiap putaran didahului
pemeriksaan disk dan anggaran harian (`preflight`). Run headless menunggu error sementara (rate limit, 5xx,
jaringan) dengan jeda 1, 2, 5, 10, 30 menit (`CODERRA_RETRY_BACKOFF_MS`, maksimal `CODERRA_RETRY_MAX`=12) dan
berpindah ke `fallbackModels` di antaranya. Bawaan batas biaya per tugas: tanpa batas.

### 15.4 Pengaman

- Sesi headless memakai mode `deny_risky` (bagian 5.2). Penolakan berulang untuk perintah yang sama dihitung
  sebagai `blocked`, bukan diulang terus.
- Kill switch di UI: "Hentikan semua" membatalkan run dan chat (`run_cancel`, `abort`) dan opsional mereset box.
- Proses yatim di box (dev server yang tertinggal): `--init` membersihkan zombie; layar kesehatan menampilkan
  jumlah proses dan pemakaian memori box (`podman stats --no-stream`).
- Log daemon lewat `journalctl --user -u coderra-hostd`, dengan batas ukuran journald.
- Karena token GitHub ada di box dan run berjalan tanpa pengawasan, gunakan token dengan scope minimum dan
  pantau di GitHub; VPS ini tidak menyimpan rahasia lain (bagian 12).

**Hasil (Fase 10).** Dari rencana 15.4: mode `deny_risky` untuk sesi headless, proses yatim dan memori box (lewat cgroup,
bukan `podman stats`) sudah ada; **belum ada** tombol "Hentikan semua", batas ukuran journald, dan pemakaian token
dengan cakupan minimum hanya berupa saran di `server/README.md`.

### 15.5 Pengujian

- **Soak test 24 jam** pada VPS sebenarnya dengan tugas sintetis (loop menulis kode dan menjalankan tes).
  Pantau: pemakaian memori daemon dari waktu ke waktu (kebocoran), pertumbuhan disk (sesi dan checkpoint),
  jumlah proses di box.
- Matikan daemon dengan `kill -9` di tengah run: run harus berstatus `interrupted` lalu lanjut otomatis.
- Putus-sambung jaringan dan kick antar-perangkat selama run panjang.
- Isi disk sampai batas: penjaga harus menolak prompt dan mengirim ntfy.
- Skenario rate limit: pastikan backoff dan fallback bekerja pada sesi headless.
- Test Node untuk supervisor dengan model palsu: kriteria selesai, batas iterasi, `noProgressLimit`, `blocked`.

### 15.6 Belum diverifikasi

- Pemakaian memori nyata host Node + pi pada sesi panjang (Android membatasi heap 1024 MB, tidak diukur).
- Pemulihan sesi yang terpotong terhadap penyedia model asli (dengan model tiruan sudah terbukti, lihat 15.2).
- Kualitas kompaksi konteks pada tugas berdurasi puluhan jam.
- Apakah 2 core cukup untuk satu run background + terminal + preview bersamaan; angka CPU di 15.1 awal saja.

## 16. Tool agent baru: `tasks` dan `subagent`

Di repo ini agent hanya punya tool: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `web_search`,
`web_fetch`, `web_screenshot`, ditambah tool MCP (daftar `TOOLS` di `host.ts`). Tidak ada tool todo atau
sub-agent; pi sendiri sengaja tidak menyertakan sub-agent dan plan mode. Menu "Tasks" di app adalah antrean
run background (`runs.ts`), bukan checklist agent. Keduanya ditambahkan sebagai tool kustom di host (pola yang
sama dengan `web.ts` dan MCP), tanpa mengubah pi.

### 16.1 Tool `tasks` (checklist terstruktur)

File baru: `agent/src/tasks.ts`. Didaftarkan di `customTools` pada `buildSession` dan namanya ditambahkan ke `TOOLS`.

Parameter (typebox, seperti `web.ts`):

| Field | Nilai |
| --- | --- |
| `action` | `set` \| `add` \| `update` \| `remove` \| `list` |
| `items` | untuk `set`: `[{title, note?}]` (mengganti seluruh daftar) |
| `id` / `title` | untuk `update`, `remove`; `add` memakai `title` |
| `status` | `todo` \| `in_progress` \| `done` \| `blocked` |
| `note` | catatan singkat (alasan blocked, hasil verifikasi) |

Aturan:
- `id` stabil (`t1`, `t2`, ...). Maksimal 100 item, judul ≤ 200 karakter, catatan ≤ 500 karakter.
- Idealnya satu `in_progress` pada satu waktu. Tool hanya memberi peringatan di keluarannya, tidak menolak.
- **Penyimpanan (berubah dari rencana awal): di dalam sesi, bukan di berkas.** Setiap hasil tool memuat seluruh daftar di
  `details.checklist`, dan daftar saat ini adalah hasil `tasks` terakhir yang berhasil pada cabang percakapan yang
  sedang aktif (`sessionManager.getBranch()`). Ini meniru contoh `todo.ts` bawaan pi dan memberi tiga hal gratis yang
  tidak didapat dari berkas: **edit-dan-kirim-ulang serta fork otomatis memutar balik daftar**, daftar ikut sesi saat
  dipulihkan setelah restart, dan tidak ada berkas lain yang harus dijaga sinkron. Panggilan yang gagal tidak punya
  `details`, jadi tidak mengubah apa pun.
- Beberapa panggilan `tasks` dalam satu giliran asisten (pi mengeksekusinya berurutan karena `executionMode:
  "sequential"`) belum tentu sudah tersimpan di cabang saat yang berikutnya mulai. Karena itu tool mengingat daftar
  terakhirnya per sesi dan memakainya selama ujung cabang (leaf) belum bergerak.
- Keluaran tool: checklist teks ringkas, mis. `[x] t1 …`, `[~] t2 …`, `[ ] t3 …`, `[!] t4 …` plus hitungan.
  Itu sudah tampil benar di kartu tool bawaan, jadi UI khusus bukan syarat.
- Record ke app: `{"type":"tasks","sessionId":"…","items":[…],"counts":{todo,in_progress,done,blocked}}`
  setiap kali daftar berubah (masuk daftar replay, bagian 4.2). Perintah `tasks_get {sessionId?}` memuat
  daftar saat chat dibuka atau setelah resume.
- Petunjuk di prompt (`promptSnippet`/`promptGuidelines`, seperti `web_fetch`): untuk tugas lebih dari dua
  langkah buat daftar dulu; tandai `in_progress` sebelum mulai dan `done` segera setelah selesai **dan
  diverifikasi**; jangan tandai `done` bila tes gagal; gunakan `blocked` dengan catatan, bukan diam.
- `guard.ts`: `tasks` ditambahkan ke `READ_ONLY` (bukan set `PLAN_SAFE` terpisah seperti rencana awal), karena yang
  dibutuhkan sama: tidak perlu approval (termasuk di `ask_all`), tidak memicu checkpoint, tetap jalan di plan mode, dan
  lolos di `deny_risky`. `plan_approve` kini berbunyi "The plan is approved. Write it down as a checklist with the tasks
  tool, then carry it out step by step."
- Supervisor (bagian 15.3): kriteria `checklist` terpenuhi bila ada ≥ 1 item dan semuanya `done`.
  `blocked` bila ada item `blocked` dan tidak ada `todo`/`in_progress` yang bisa dikerjakan.

UI (Dart), sudah dibangun:
- `ChecklistCard` (di `chat_extras.dart`, dipasang di `chat_screen.dart` setelah `PlanBar`): ikon, judul "Checklist",
  pil `selesai/total`, bilah progres, tugas yang sedang dikerjakan sebagai subjudul saat tertutup; dibuka menampilkan semua
  tugas dengan ikon status, coretan untuk yang selesai, catatan (kuning untuk `blocked`), dan spinner pada tugas
  `in_progress` hanya selama agent berjalan. Disembunyikan bila daftar kosong atau milik chat lain.
- `Features` menyimpan satu daftar per chat (maks. 20) dari record `tasks`; `AgentController` memanggil `tasks_get`
  setiap transkrip dimuat ulang (`loadHistory`, `newSession`), sehingga daftar mengikuti percakapan.
- Kartu tool menampilkan ringkasan (`set 4 tasks`, `t2 → done`) dan ikon `listChecks`.
- Di kartu run "Tugas panjang" (layar Tugas, Fase 4b) ringkasan hitungan yang sama masih perlu ditambahkan.

Pengujian yang ada: 39 test unit untuk `tasks.ts` dan `Guard`; **5 test ujung ke ujung dengan pi asli dan model
tiruan** (`agent/test/pi_e2e.test.ts`, server OpenAI-compatible kecil yang menjawab dari skrip di `host_helpers.ts`)
yang memeriksa: tool dan panduannya ada di prompt sistem dan daftar tool, dua panggilan dalam satu giliran saling melihat,
record `tasks` dan `tasks_get`, daftar bertahan setelah daemon dimulai ulang dan mundur saat pesan diedit, plan mode
(tulis diblokir, `tasks` lolos, `plan_approve` meminta checklist), `ask_all` (tasks tanpa approval, `write` minta
approval), panggilan salah gagal bersih, dan run tanpa pengawasan (perintah berbahaya ditolak, checklist run itu
milik sesinya sendiri). Dua mutasi sengaja (mengeluarkan `tasks` dari `READ_ONLY`, mencabut `unattendedGuard`)
terbukti membuat test gagal. Sisi Dart: 12 test (parser, batas daftar, ringkasan, ikon, dan widget kartu).

### 16.2 Tool `subagent`

File baru: `agent/src/subagent.ts`. Dasarnya adalah `backgroundSession(cwd)` di `host.ts` yang sudah membuat
sesi pi headless (`prompt`, `lastText`, `errorText`, `abort`, `dispose`).

Parameter:

| Field | Arti |
| --- | --- |
| `task` | Instruksi lengkap untuk anak (anak tidak melihat percakapan parent) |
| `role` | `explorer` (bawaan; hanya baca) \| `worker` (tool penuh) |
| `model` | Opsional `provider/model`, mis. model lebih murah; bawaan mengikuti parent |
| `title` | Nama pendek untuk UI dan nama sesi |
| `maxMinutes` | Batas waktu; bawaan 20 (`explorer`) dan 60 (`worker`) |

Perubahan pendukung: `buildSession` sekarang memakai daftar `TOOLS` tetap. Tambahkan opsi
`{interactive, tools?, exclude?}`:
- `explorer`: `read`, `grep`, `find`, `ls`, `web_search`, `web_fetch`.
- `worker`: seluruh `TOOLS` ditambah MCP, **tanpa** `subagent`.
- `subagent` tidak pernah disertakan di sesi anak (kedalaman 1, mencegah rekursi).

Eksekusi (v1, sinkron):
1. Parent memanggil tool dan menunggu. Anak dibuat dengan `buildSession(SessionManager.create(cwd), …)`.
2. `onUpdate` mengirim baris progres ringkas dari event anak (mis. "read src/x.ts", "bash npm test"),
   dibatasi satu baris per 500 ms. `AgentController` sudah menampilkan `tool_execution_update` di kartu tool,
   jadi tidak ada UI baru.
3. Hasil = `lastText()` anak dipotong 8.000 karakter, ditambah jalur file sesi anak, jumlah tool call, dan
   biaya. Transkrip lengkap tetap ada di sesi anak.
4. `signal` dari parent memanggil `abort()` anak lalu `dispose()`. Timeout `maxMinutes` melakukan hal yang sama
   dan mengembalikan hasil parsial dengan penanda "dihentikan karena batas waktu".

Batas dan pengaman:
- **Konkurensi/memori**: semua sesi berbagi satu heap Node 1024 MB di VPS 4 GB. Semaphore global: total sesi
  aktif (chat + run background + anak) maksimal 3, anak maksimal 2. Jika penuh, tool menunggu di antrean
  (dengan timeout) lalu gagal dengan pesan jelas.
- **Persetujuan**: sesi anak headless. Pakai mode `deny_risky` di semua mode (bukan hanya VPS), sehingga
  anak tidak pernah menjalankan `RISKY_BASH`. Di mode lokal Android `Runner` saat ini tidak memasang Guard
  sama sekali; perubahan `deny_risky` sebaiknya berlaku juga untuk `Runner`.
- **Plan mode**: `explorer` diizinkan, `worker` diblokir (hook `tool_call` di `guard.ts` memeriksa
  `input.role`). Perlu pengecekan sadar-role karena `READ_ONLY` sekarang berdasarkan nama tool saja.
- **Checkpoint**: `Guard` membuat checkpoint saat tool non-read-only pertama dalam satu run. `worker` dihitung
  non-read-only, `explorer` read-only.
- **Biaya**: `checkBudget()` dipanggil sebelum `prompt` anak. `usageSummary` membaca semua JSONL di
  `sessions/`; jika sesi anak tersimpan di sana, biayanya otomatis masuk `dailyBudget` **[BELUM DIVERIFIKASI]**.
  Selain itu supervisor (15.3) menghitung biaya anak ke tugas induknya.
- **Konflik file**: v1 sinkron, jadi parent dan anak tidak menulis bersamaan. Worker paralel ditunda sampai
  ada mekanisme kunci per direktori.

Sesi anak diberi nama "↳ `<title>`" lewat `appendSessionInfo` agar dapat dikenali di daftar chat dan dibuka
dari kartu tool ("Buka sesi anak").

Pengujian (`node:test` dengan sesi palsu): rekursi dicegah, `abort` dan timeout menghentikan anak, hasil
dipotong, semaphore menahan anak ketiga, plan mode memblokir `worker`, `deny_risky` menolak perintah berisiko.

**Hasil (4c).** Sesuai rencana kecuali yang dicatat di baris status 4c. Dua keputusan yang tidak ada di rencana
awal: `subagent` dengan `role: explorer` dianggap baca-saja oleh guard (lolos plan mode, tanpa persetujuan, tanpa
checkpoint) sedangkan `worker` dianggap mengubah (diblokir plan mode, minta persetujuan di `ask_all`, memicu
checkpoint); dan model anak mengikuti model parent yang sedang aktif, bukan model bawaan pengaturan. Sesi anak
disimpan di folder sesi yang sama sehingga muncul di daftar chat dengan nama "↳ judul".

### 16.3 Urutan dan ukuran

| Urutan | Isi | Ukuran (perkiraan dari bacaan kode) |
| --- | --- | --- |
| 1 | `tasks` (tool, penyimpanan, record, `PLAN_SAFE`) | ~0,5 hari |
| 2 | Kartu checklist di chat | ~0,5 hari |
| 3 | `buildSession` dengan opsi `tools`/`exclude`; `deny_risky` | ~0,5 hari |
| 4 | `subagent` v1 + test | ~1-2 hari |
| 5 | Worker paralel (setelah ada ukuran memori nyata di VPS) | ditunda |

`tasks` dan kartunya dapat dikerjakan dan diuji di mode lokal Android sebelum VPS siap.

Belum diverifikasi: bentuk API pi yang dipakai (`createAgentSession`, `onUpdate`, eksekusi paralel tool call)
dibaca dari pemakaian di `host.ts` dan `web.ts`, bukan dari tipe aslinya. Langkah pertama implementasi adalah
`npm install` di `agent/` untuk membaca tipenya, lalu menyesuaikan bagian ini.
