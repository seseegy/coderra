# CoderRa di server

Agent berjalan di sebuah server (VPS) dan terus bekerja walau ponsel mati atau app ditutup. App di ponsel menjadi
klien: chat, file, editor, preview, terminal, backup dan pembaruan, semuanya lewat satu koneksi SSH. Mode ponsel
tetap ada; Anda memilih salah satunya di **Settings → Server agent**.

```
ponsel (app) ──ssh──> server: sshd ──> coderra-attach ──soket unix──> host (systemd, user coderra)
                                                                          └─ perintah bash agent ──> box (Podman rootless)
```

- Satu pengguna server bernama `coderra`, **tanpa sudo**. Semua yang dikerjakan agent terjadi sebagai dia.
- Perintah `bash` agent berjalan di dalam **box**, sebuah container Podman rootless (root di dalam = `coderra` di luar).
- Server menyimpan semuanya: sesi, berkas proyek, tugas yang berjalan. Tidak ada sinkronisasi git; yang Anda lihat di app
  adalah yang ada di server.

## Yang dibutuhkan

- Server Ubuntu atau Debian (diuji pada 24.04), x86_64 atau arm64, akses root. Untuk satu agent: 2 core, 4 GB RAM, 20 GB disk
  sudah cukup. Box dibatasi 2 GB RAM dan host 1,25 GB, jadi 4 GB adalah angka realistis.
- **Mesin yang boleh dikorbankan.** Box memakai jaringan server (`--network=host`) supaya server dev di dalamnya bisa dijangkau.
  Akibatnya agent di dalam box bisa menjangkau apa pun yang bisa dijangkau server itu. Jangan pasang di mesin yang
  menjalankan layanan lain yang tidak boleh disentuh agent.
- App CoderRa versi yang memuat fitur server (build terbaru dari CI).

## Memasang

1. **Di app:** Settings → Server agent. Isi alamat server (nama atau IP publik). App membuat kunci SSH miliknya dan
   menampilkan perintah siap-salin, kira-kira:
   ```
   sudo ./bootstrap.sh --pubkey 'ssh-ed25519 AAAA… coderra-app' --address 'vps.contoh.com'
   ```
2. **Salin folder `server/` ini ke server** (seluruh folder; skrip memeriksa bahwa semua berkas ada):
   ```
   scp -r server/ root@vps.contoh.com:~/coderra-server
   ```
3. **Di server**, lihat dulu rencananya (tidak mengubah apa pun):
   ```
   cd ~/coderra-server
   bash bootstrap.sh --dry-run --pubkey '…' --address 'vps.contoh.com'
   ```
   Yang harus tampak: **tidak ada** peringatan `this script is written for Ubuntu and Debian`, tidak ada `getent: command not found`, dan baris `host key:` berisi kunci `ssh-ed25519 AAAA…`.
4. **Jalankan sungguhan** (beberapa menit: paket, Node.js, membangun image box):
   ```
   sudo bash bootstrap.sh --pubkey '…' --address 'vps.contoh.com'
   ```
   Aman diulang: akun, kunci dan pengaturan yang ada dipertahankan, sisanya diperbarui.
5. Skrip mencetak **setup code** (`coderra1:…`). **Di app:** tempel di langkah 2, **Save server**, lalu:
   - **Test connection** → "belum dipasang" (wajar)
   - **Install / update agent** → app menyalin host ke server dan menjalankannya
   - **Test connection** → "agent berjalan"
   - nyalakan **Use the server agent**.

Opsi `bootstrap.sh`:

| Opsi | Arti |
| --- | --- |
| `--pubkey KEY` | kunci publik app (wajib) |
| `--address HOST` | nama/IP yang dipakai app; tanpa ini skrip menebak alamat pertama mesin |
| `--user NAMA` | akun yang dibuat (bawaan `coderra`) |
| `--no-box` | tanpa Podman: perintah agent berjalan **langsung di server**, tanpa pembatas |
| `--node-version X.Y.Z` | Node.js yang dipasang bila sistem belum punya yang cukup baru |
| `--harden-ssh --admin-user NAMA` | matikan login password dan root; `NAMA` harus sudah punya kunci SSH (supaya Anda tidak terkunci) |
| `--dry-run` | hanya tampilkan rencana |

## Apa yang dibuat skrip

| Di mana | Apa |
| --- | --- |
| akun `coderra` | tanpa sudo; skrip memperingatkan bila akun ada di grup `sudo`, `docker`, `lxd`, `adm` |
| `loginctl enable-linger coderra` | layanan jalan tanpa ada yang login |
| `~/.coderra/bin/` | `coderra-attach`, `box` |
| `~/.coderra/box/Containerfile` | resep image box (Ubuntu 24.04 + git, build-essential, python3, ripgrep, …) |
| `~/.coderra/env` | `ANDROPI_STORE_KEY`, kunci acak untuk token tersimpan (mode 600) |
| `~/.coderra/host/` | host Node; diisi app lewat **Install / update agent** |
| `~/.config/systemd/user/coderra-hostd.service` | layanan; `Restart=always`, batas memori 1280 MB, tidak jalan sebelum host dipasang |
| `~/.ssh/authorized_keys` | kunci app dengan batasan: `restrict,pty,port-forwarding,permitopen="127.0.0.1:*",permitlisten="127.0.0.1:1"` |
| `~/.pi/agent/`, `~/workspace/` | state agent dan folder proyek |
| `~/.coderra/box-home/` | home milik box (git/ssh yang disalin app, riwayat); dibuat saat box pertama dipakai |

Kunci app hanya boleh: membuka terminal, dan meneruskan port ke loopback server itu sendiri. Ia tidak bisa membuka
port di server (`-R`) atau menjangkau mesin lain lewat server.

## Yang aman, yang tidak

Dijaga:
- App memercayai **host key** yang ada di setup code (dipin; `StrictHostKeyChecking yes`), bukan "siapa pun yang menjawab".
- Agent tidak punya sudo; perintah berbahaya yang tidak sedang diawasi (`rm -rf`, `git push`, `ssh`, `curl | sh`, …)
  ditolak, bukan ditanyakan, pada tugas latar belakang dan sub-agent.
- Kunci SSH app dan `authorized_keys` tidak pernah disalin ke box.
- Preview halaman web dilindungi token acak di URL; berkas berawalan titik dan symlink keluar folder tidak disajikan.

Perlu Anda sadari:
- **Token GitHub/Vercel dapat dibaca agent** di dalam box. Itu disengaja (agent perlu `git push`). Pakai token dengan
  cakupan sekecil mungkin dan awasi di GitHub.
- Box berbagi jaringan server (lihat atas).
- Kunci privat app disimpan di penyimpanan privat app **tanpa passphrase**. Ponsel yang dibobol berarti akses ke server.
- Topik ntfy adalah rahasia: siapa pun yang tahu topiknya bisa membaca dan mengirim ke topik itu. Pesannya hanya judul
  generik ("Agent finished"), tanpa nama proyek atau isi.
- Dengan `--no-box`, atau bila box dimatikan di app, perintah agent berjalan **langsung** sebagai `coderra`.

## Sehari-hari

- **Memperbarui agent:** pasang APK baru, lalu **Install / update agent**. Hanya berkas yang berubah dikirim, dan daemon
  dijalankan ulang. Server tidak perlu disentuh.
- **Kesehatan:** Settings → Server agent menampilkan disk, memori, run yang berjalan dan uptime. Disk di bawah 10 GB
  memberi peringatan, di bawah 5 GB prompt dan tugas baru ditolak. Layar **The agent's box** menampilkan memori dan
  jumlah proses di dalam box.
- **Notifikasi saat app tertutup:** Server agent → Notifications. Buat topik, simpan, lalu pasang aplikasi ntfy di ponsel
  dan berlangganan topik itu. Server `ntfy.sh` bawaan; bisa diganti server sendiri.
- **Log:** sebagai root,
  ```
  journalctl _SYSTEMD_USER_UNIT=coderra-hostd.service -n 100 --no-pager
  ```
- **Memulai ulang / melihat status** sebagai `coderra`:
  ```
  runuser -u coderra -- env XDG_RUNTIME_DIR=/run/user/$(id -u coderra) systemctl --user restart coderra-hostd
  runuser -u coderra -- env XDG_RUNTIME_DIR=/run/user/$(id -u coderra) systemctl --user status coderra-hostd
  ```
- **Pengaturan lanjutan** (tambahkan baris `NAMA=nilai` ke `~/.coderra/env`, lalu restart layanan):

  | Variabel | Arti | Bawaan |
  | --- | --- | --- |
  | `NTFY_URL`, `NTFY_TOPIC` | tujuan notifikasi (bisa juga diatur di app) | — |
  | `CODERRA_DISK_WARN_BYTES`, `CODERRA_DISK_MIN_BYTES` | ambang disk | 10 GB, 5 GB |
  | `CODERRA_MEMORY_WARN_BYTES` | ambang memori host | 1100 MB |
  | `CODERRA_SUBAGENTS_MAX` | sub-agent bersamaan | 2 |
  | `CODERRA_RETRY_BACKOFF_MS`, `CODERRA_RETRY_MAX` | jeda dan jumlah coba ulang saat model membatasi/mati | 1,2,5,10,30 menit; 12 |
  | `CODERRA_HEARTBEAT_MS` | seberapa sering notifikasi "tugas masih berjalan" | 6 jam |

  Batas memori/CPU box ada di `~/.coderra/box.conf` (`BOX_MEMORY=2g`, `BOX_SWAP=3g`, `BOX_CPUS=1.5`) dan berlaku saat
  container dibuat lagi (**Reset the box**).

## Bila ada masalah

| Gejala | Kemungkinan penyebab | Coba |
| --- | --- | --- |
| Test connection: "tidak terjangkau" | alamat/port salah, firewall | `ssh -i kunci coderra@alamat` dari mesin lain; buka port SSH |
| "kunci ditolak" | skrip belum dijalankan dengan kunci app ini | jalankan ulang `bootstrap.sh` dengan perintah yang ditampilkan app |
| "host key tidak cocok" | server dipasang ulang, atau ada yang menyamar | **jangan lanjut** kecuali Anda memang memasang ulang; tempel setup code baru |
| "belum dipasang" | `bootstrap.sh` belum jalan | langkah 4 |
| "agent belum ada" / "tidak berjalan" | host belum disalin, atau layanan mati | **Install / update agent**; periksa log |
| `rootless podman does not work` saat bootstrap | Ubuntu 24.04+ membatasi user namespace lewat AppArmor | pastikan paket `apparmor` terpasang dan `/etc/apparmor.d/podman` ada dan dimuat (`aa-status`); jalankan ulang skrip |
| box: "Not built" / tes box gagal | image gagal dibangun | **The agent's box → Rebuild the image**; lihat pesan di layarnya |
| layanan tidak jalan setelah reboot | lingering mati | `loginctl enable-linger coderra` |
| disk penuh | sesi, backup, image | hapus backup lama di `~/workspace/backups`, `podman system prune` sebagai `coderra` |

## Menghapus

Ini menghapus semua milik agent (sesi, proyek di `~/workspace`, box). Ambil backup dulu (app → Backup).

```
runuser -u coderra -- env XDG_RUNTIME_DIR=/run/user/$(id -u coderra) systemctl --user disable --now coderra-hostd
loginctl disable-linger coderra
userdel -r coderra
rm -rf /opt/node-v* /opt/node /usr/local/bin/{node,npm,npx}   # hanya bila Node ini dipasang oleh skrip
```

Di app: **Server agent → Forget this server**.

## Batas yang diketahui

- Skrip ini diuji di dalam kontainer Debian, dan rantai SSH, soket serta layanan systemd user diuji dengan sshd dan systemd
  asli di loopback. **Podman selalu diganti tiruan** dan skrip belum pernah dijalankan di VPS sungguhan atau di Ubuntu 26.
  Format keluaran Podman asli (layar box), `--harden-ssh` dan AppArmor belum dibuktikan.
- Kode Kotlin dan perilaku app di perangkat (WebView, terminal, jaringan putus sungguhan) belum diuji di perangkat.
- Server dev yang hanya mendengarkan `::1` tidak terjangkau dari app (kunci hanya boleh meneruskan ke `127.0.0.1`);
  jalankan dengan `--host 127.0.0.1`.
- Backup dibatasi 60.000 berkas dan 3 GB (format zip biasa); berkas di atas 256 MB tidak ikut dan dilaporkan.
- Satu klien aktif pada satu waktu: menyambung dari perangkat lain memutus yang pertama.
