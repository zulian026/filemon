# 📋 FileMon Update & Changelog

Dokumentasi komprehensif seluruh pembaruan, fitur baru, perbaikan bug, dan peningkatan performa yang telah diimplementasikan pada **FileMon** (Linux File Manager berbasis Tauri v2 + Rust).

---

## 📑 Daftar Isi Pembaruan

1. [🎨 Penyesuaian Warna Folder & Tema Obsidian Pitch Black](#1--penyesuaian-warna-folder--tema-obsidian-pitch-black)
2. [💽 Deteksi & Manajemen Partisi / HDD / Removable Drives](#2--deteksi--manajemen-partisi--hdd--removable-drives)
3. [👁️ Quick Look Instant File Preview (Spacebar Preview)](#3-️-quick-look-instant-file-preview-spacebar-preview)
4. [🔍 Deep Content Search (Pencarian Teks dalam Berkas)](#4--deep-content-search-pencarian-teks-dalam-berkas)
5. [🏷️ Color Tagging System (Sistem Label Warna Finder-Style)](#5-️-color-tagging-system-sistem-label-warna-finder-style)
6. [⚡ Advanced Batch Renamer (Pengubah Nama File Massal)](#6--advanced-batch-renamer-pengubah-nama-file-massal)
7. [📊 Visual Disk Space Analyzer (Treemap & Folder Breakdown)](#7--visual-disk-space-analyzer-treemap--folder-breakdown)

---

## 1. 🎨 Penyesuaian Warna Folder & Tema Obsidian Pitch Black

### 📝 Deskripsi
Menyelaraskan kembali warna ikon folder dari oranye ke warna biru aksen obsidian khas FileMon, serta memperkuat sistem tema *Pitch Black* (`#000000`) dan kustomisasi warna aksen dinamis.

### 🚀 Fitur & Peningkatan
- **Koreksi Warna Folder**: Folder di Details view, Grid Icons view, dan Sidebar kini menggunakan warna biru aksen (`--color-file-folder` / `--color-accent`) yang konsisten.
- **Sistem Palet Warna Aksen Dinamis**: Pengguna dapat memilih aksen warna favorit (Blue, Purple, Emerald, Amber, Rose, Cyan) melalui dialog kustomisasi.
- **Persistensi State**: Pilihan tema dan warna aksen disimpan secara persisten di `localStorage` dan dieksekusi secara instan sebelum rendering DOM untuk mencegah *flicker* (*flash of unstyled content*).
- **Pitch Black Aesthetic**: Penyesuaian kontras latar belakang `#000000` dengan pembatas halus (`--color-rule`), memberikan pengalaman visual elegan dan hemat daya untuk layar OLED/AMOLED.

### 📂 File Terkait
- [`src/tokens.css`](file:///home/zyan/Projects/fileman/src/tokens.css)
- [`src/base.css`](file:///home/zyan/Projects/fileman/src/base.css)
- [`src/styles.css`](file:///home/zyan/Projects/fileman/src/styles.css)
- [`index.html`](file:///home/zyan/Projects/fileman/index.html)

---

## 2. 💽 Deteksi & Manajemen Partisi / HDD / Removable Drives

### 📝 Deskripsi
Menambahkan kemampuan mendeteksi, menampilkan, dan mengelola partisi penyimpanan lain di Linux (hard disk internal sekunder, partisi Windows/NTFS, SSD eksternal, flashdisk USB) baik yang sudah terpasang (*mounted*) maupun yang belum terpasang (*unmounted*).

### 🚀 Fitur & Peningkatan
- **Multi-Source Drive Scanner (Rust)**:
  - Menggabungkan parsing `/proc/mounts`, `sysfs`, dan `lsblk` / UDisks2 untuk mendeteksi seluruh blok perangkat penyimpanan yang tersedia di sistem Linux.
  - Menghitung kapasitas total (*total size*) dan ruang kosong (*free space*) secara realtime.
- **Visualisasi Sidebar Modern**:
  - **Drive Terpasang (*Mounted*)**: Menampilkan nama partisi, kapasitas kosong, path mount, dan *mini progress bar* persentase kapasitas terpakai. Indikator bar otomatis berubah warna saat kapasitas hampir penuh (≥ 90%).
  - **Drive Belum Terpasang (*Unmounted*)**: Ditampilkan secara rapi dengan badge **"Mount"**. Mengklik drive unmounted akan memicu proses mount otomatis dan langsung menavigasi ke foldernya.
- **Menu Konteks Klik Kanan Drive**:
  - `Open`: Membuka partisi di panel aktif.
  - `Open in new tab`: Membuka partisi di tab baru.
  - `Copy mount path`: Menyalin path direktori mount ke clipboard.
  - `Copy device path`: Menyalin path perangkat blok (misal `/dev/sdb1`).
  - `Unmount`: Melepas kaitan partisi dengan aman (diproteksi agar tidak dapat meng-unmount partisi sistem vital seperti `/`, `/boot`, `/home`).
  - `Analyze Disk Space`: Menganalisis penggunaan ruang disk partisi tersebut secara visual.

### 📂 File Terkait
- [`src-tauri/src/fsops.rs`](file:///home/zyan/Projects/fileman/src-tauri/src/fsops.rs)
- [`src-tauri/src/lib.rs`](file:///home/zyan/Projects/fileman/src-tauri/src/lib.rs)
- [`src/main.ts`](file:///home/zyan/Projects/fileman/src/main.ts)
- [`src/styles.css`](file:///home/zyan/Projects/fileman/src/styles.css)

---

## 3. 👁️ Quick Look Instant File Preview (Spacebar Preview)

### 📝 Deskripsi
Fitur pratinjau instan berkas bergaya macOS Quick Look yang memungkinkan pengguna memeriksa isi file dalam dialog modal beresolusi tinggi tanpa harus membuka aplikasi pihak ketiga.

### 🚀 Fitur & Peningkatan
- **Pemicu Cepat Tombol Spacebar**: Cukup tekan tombol `Space` saat file dipilih untuk membuka atau menutup pratinjau instan.
- **Dukungan Format Luas**:
  - **Gambar**: PNG, JPG, JPEG, GIF, WebP, SVG, BMP dengan penskalaan halus.
  - **Video**: MP4, MKV, WebM, MOV, AVI menampilkan frame pertama (thumbnail via ffmpeg) dengan tombol buka di aplikasi default — tanpa pemutar inline, karena elemen `<video>` membuat WebKitGTK di sistem ini crash (GStreamer `autoaudiosink` tidak tersedia).
  - **Audio**: MP3, FLAC, WAV, OGG, M4A dengan player audio dan durasi.
  - **Dokumen Teks & Source Code**: Rust, Python, TypeScript, JavaScript, HTML, CSS, JSON, TOML, YAML, Markdown, Bash script dengan pemformatan sintaks bersih.
  - **PDF & File Lainnya**: Tampilan ringkasan berkas, ukuran, waktu modifikasi, dan izin akses.
- **Navigasi Keyboard Berkelanjutan**:
  - Tekan `←` (Panah Kiri) atau `→` (Panah Kanan) untuk berpindah langsung ke file sebelumnya/berikutnya dalam folder yang sama tanpa keluar dari Quick Look.
  - Tekan `Esc` atau `Space` untuk menutup pratinjau.

### 📂 File Terkait
- [`index.html`](file:///home/zyan/Projects/fileman/index.html)
- [`src/main.ts`](file:///home/zyan/Projects/fileman/src/main.ts)
- [`src/styles.css`](file:///home/zyan/Projects/fileman/src/styles.css)

---

## 4. 🔍 Deep Content Search (Pencarian Teks dalam Berkas)

### 📝 Deskripsi
Pencarian teks mendalam (*full-text content search*) yang memindai isi di dalam berkas teks di seluruh struktur direktori, bukan hanya mencocokkan nama file.

### 🚀 Fitur & Peningkatan
- **Worker Thread Berkecepatan Tinggi di Rust**:
  - Melakukan traversal pohon direktori secara rekursif dan paralel.
  - Mengabaikan berkas biner besar (*binary detection heuristics*) untuk menjaga kestabilan memori dan kecepatan pemindaian.
- **UI & Integrasi Bilah Pencarian**:
  - Tombol mode sakelar di sisi kanan kotak pencarian topbar (`search-content`).
  - Menampilkan cuplikan baris kode/teks (*line preview snippets*) yang cocok dengan penandaan kata kunci (*highlighting*).
  - Klik pada hasil pencarian langsung membuka dan menyorot lokasi berkas tersebut.

### 📂 File Terkait
- [`src-tauri/src/fsops.rs`](file:///home/zyan/Projects/fileman/src-tauri/src/fsops.rs)
- [`src-tauri/src/lib.rs`](file:///home/zyan/Projects/fileman/src-tauri/src/lib.rs)
- [`index.html`](file:///home/zyan/Projects/fileman/index.html)
- [`src/main.ts`](file:///home/zyan/Projects/fileman/src/main.ts)
- [`src/styles.css`](file:///home/zyan/Projects/fileman/src/styles.css)

---

## 5. 🏷️ Color Tagging System (Sistem Label Warna Finder-Style)

### 📝 Deskripsi
Sistem penandaan dan pengorganisasian berkas menggunakan label warna (Finder-style tags) dengan 6 pilihan warna cerah yang terintegrasi di seluruh aplikasi.

### 🚀 Fitur & Peningkatan
- **6 Palet Warna Tag Standar**:
  - 🔴 **Red**: Urgent / Kritis
  - 🟠 **Orange**: Penting / In Progress
  - 🟡 **Yellow**: Review / Referensi
  - 🟢 **Green**: Selesai / Approved
  - 🔵 **Blue**: Pekerjaan / Dokumen Utama
  - 🟣 **Purple**: Arsip / Pribadi
- **Antarmuka Penandaan Intuitif**:
  - Baris lingkaran warna langsung muncul di bagian teratas Menu Konteks klik kanan saat satu atau banyak file dipilih.
  - Opsi *Clear all tags* untuk menghapus seluruh penandaan dari file terpilih.
- **Indikator Visual**:
  - Titik warna muncul di samping nama file pada *Details View*.
  - Titik warna muncul di sudut kanan atas kartu pada *Grid Icons View*.
- **Kategori "Tags" di Sidebar**:
  - Daftar label warna di sidebar lengkap dengan jumlah file yang terpasang tag (*realtime count*).
  - Mengklik tag membuka **Tag View**: filter instan yang menampilkan semua file berlabel tersebut dari berbagai lokasi direktori.
- **Sinkronisasi Pemindahan & Rename**:
  - Tag tetap melekat meskipun file diubah namanya (*rename*) atau dipindahkan (*move*).

### 📂 File Terkait
- [`index.html`](file:///home/zyan/Projects/fileman/index.html)
- [`src/main.ts`](file:///home/zyan/Projects/fileman/src/main.ts)
- [`src/styles.css`](file:///home/zyan/Projects/fileman/src/styles.css)

---

## 6. ⚡ Advanced Batch Renamer (Pengubah Nama File Massal)

### 📝 Deskripsi
Alat penggantian nama banyak berkas sekaligus (*batch renamer*) yang tangguh, aman, dan kaya fitur dengan pratinjau perubahan langsung (*live preview*) dan pencegahan tabrakan nama (*conflict detector*).

### 🚀 Fitur & Peningkatan
- **Pintasan Akses Cepat**:
  - Tekan `F2` saat lebih dari 1 file dipilih untuk membuka dialog Batch Rename secara instan.
  - Tersedia di Menu Konteks klik kanan (`Batch Rename (N files, F2)…`) dan Command Palette (`Ctrl+K`).
- **5 Mode Operasi Lengkap**:
  1. **Find & Replace**:
     - Pencarian teks biasa atau ekspresi reguler (Regex).
     - Pengaturan *Match Case* (sensitif huruf besar/kecil) dan *Replace All*.
     - Sakelar opsional untuk menyertakan atau mengecualikan ekstensi file.
  2. **Add Prefix & Suffix**:
     - Menambahkan teks di awal nama file (*prefix*).
     - Menambahkan teks di akhir nama file sebelum ekstensi (*suffix*).
  3. **Numbering Sequence**:
     - Penomoran urut otomatis (posisi: di awal nama, di akhir nama, atau mengganti seluruh nama).
     - Pemisah kustom (misal `-`, `_`, atau spasi).
     - Angka awal (*start number*), kelipatan (*step*), dan *zero-padding* otomatis (misal `001`, `002`, `010`).
  4. **Change Case**:
     - Konversi gaya huruf: `lowercase`, `UPPERCASE`, `Title Case`, `kebab-case`, dan `snake_case`.
     - Pilihan cakupan: hanya nama dasar (*basename only*) atau nama lengkap beserta ekstensi.
  5. **Clean Formatting**:
     - *Clean duplicate spaces*: Menghapus spasi ganda berlebih.
     - *Remove symbols*: Membuang karakter khusus dan tanda baca.
     - *Remove numbers*: Membuang seluruh angka dari nama file.
     - *Trim ends*: Menghapus spasi di awal dan akhir nama.
- **Fitur Keamanan (*Safety First*)**:
  - **Live Preview Table**: Membandingkan nama asli vs nama baru secara berdampingan sebelum dieksekusi.
  - **Collision Detection**: Otomatis mendeteksi jika ada nama hasil konversi yang bentrok atau duplikat, dan mengunci tombol konfirmasi hingga parameter diperbaiki.
  - **Sync Tags**: Otomatis memperbarui database label warna (*file tags*) saat nama file berubah.

### 📂 File Terkait
- [`index.html`](file:///home/zyan/Projects/fileman/index.html#L397-L560)
- [`src/main.ts`](file:///home/zyan/Projects/fileman/src/main.ts#L2540-L2980)
- [`src/styles.css`](file:///home/zyan/Projects/fileman/src/styles.css#L2205-L2510)

---

## 7. 📊 Visual Disk Space Analyzer (Treemap & Folder Breakdown)

### 📝 Deskripsi
Fitur visualisasi penggunaan ruang penyimpanan direktori dan drive secara mendalam ala Baobab / WinDirStat / DaisyDisk, terintegrasi langsung di dalam FileMon tanpa memerlukan perkakas eksternal.

### 🚀 Fitur & Peningkatan
- **Backend Rust Cepat dengan Instant Cancellation**:
  - Perintah `analyze_space` melakukan pemindaian rekursif multi-threaded pada subdirektori, menghitung ukuran riil, jumlah file, dan jumlah folder tanpa memblokir antarmuka GUI.
  - Perintah `cancel_analyze_space` dengan penanda atomik `AtomicU64` untuk menghentikan pemindaian di latar belakang secara instan begitu modal ditutup atau pengguna berpindah folder.
- **Squarified Treemap Interaktif**:
  - Mengimplementasikan algoritma *Squarified Treemap* (Bruls, Huizing, van Wijk) dengan rasio aspek optimal menyerupai bujur sangkar.
  - Rendering SVG dinamis dengan palet warna modern per kategori file/folder.
  - **Hover Tooltip**: Menampilkan nama berkas, ukuran, persentase terhadap folder induk, rincian file/subfolder, serta path absolut.
  - **Klik untuk Drill Down**: Mengklik blok folder langsung memperbesar dan menganalisis folder tersebut (*zoom in*).
- **Ranked Breakdown List**:
  - Tabel rincian berurutan dari item paling memakan tempat hingga terkecil.
  - Dilengkapi *usage progress bar*, persentase penggunaan, ukuran terformat (`B`, `KB`, `MB`, `GB`, `TB`), dan jumlah item.
  - Tombol aksi per baris: *Reveal in FileMon*, *Open in Terminal*, dan *Move to Trash*.
- **Navigasi & Kemudahan Kontrol**:
  - **Breadcrumbs Interaktif**: Jalur navigasi folder di header dialog dapat diklik untuk melompat kembali ke folder induk mana pun.
  - **Mode Tampilan**: Beralih antara mode **Split** (Treemap + List berdampingan), **Treemap Only**, atau **List Only**.
  - **Multi-titik Akses**:
    - Tombol toolbar baru di header atas.
    - Menu konteks klik kanan folder & canvas kosong (`Analyze Disk Space`).
    - Menu konteks klik kanan drive di sidebar (`Analyze Disk Space`).
    - Command Palette (`Ctrl+K` → *"Analyze Disk Space"*).
    - Pintasan keyboard: **`Ctrl+Shift+U`**.
    - Di dalam modal: `Backspace` / `Alt+Up` untuk naik level, `Ctrl+R` untuk rescan, dan `Esc` untuk menutup dialog.

### 📂 File Terkait
- [`src-tauri/src/fsops.rs`](file:///home/zyan/Projects/fileman/src-tauri/src/fsops.rs#L1698-L1825)
- [`src-tauri/src/lib.rs`](file:///home/zyan/Projects/fileman/src-tauri/src/lib.rs#L259-L278)
- [`index.html`](file:///home/zyan/Projects/fileman/index.html#L562-L685)
- [`src/main.ts`](file:///home/zyan/Projects/fileman/src/main.ts#L2982-L3650)
- [`src/styles.css`](file:///home/zyan/Projects/fileman/src/styles.css#L2748-L3200)

---

## ⌨️ Rangkuman Pintasan Keyboard (Shortcuts)

| Pintasan Keyboard | Aksi / Fitur |
| :--- | :--- |
| `Space` | **Quick Look Preview**: Pratinjau instan gambar, video, audio, kode, atau teks |
| `Ctrl + K` / `Ctrl + P` | **Command Palette**: Mencari perintah, navigasi lokasi, tag, dan partisi |
| `F2` | **Rename / Batch Rename**: Ganti nama 1 file atau buka Batch Renamer untuk banyak file |
| `Ctrl + Shift + U` | **Visual Disk Space Analyzer**: Menganalisis kapasitas folder saat ini |
| `Ctrl + Shift + D` | **Dual Pane**: Beralih antara mode 1 kolom atau split 2 kolom berdampingan |
| `Ctrl + T` | **New Tab**: Membuka folder saat ini di tab baru |
| `Ctrl + W` | **Close Tab**: Menutup tab aktif |
| `Ctrl + Shift + T` | **Reopen Tab**: Membuka kembali tab terakhir yang tertutup |
| `Ctrl + L` | **Address Bar**: Mengaktifkan input lokasi folder manual |
| `Ctrl + H` | **Hidden Files**: Menampilkan / menyembunyikan berkas dotfiles |
| `F5` | **Copy to Other Pane**: Salin berkas ke panel sisi lain (Dual Pane) |
| `F6` | **Move to Other Pane**: Pindahkan berkas ke panel sisi lain (Dual Pane) |
| `Alt + 1` / `Alt + 2` | **Focus Pane**: Berpindah fokus antara panel kiri dan panel kanan |
| `Alt + Up` / `Backspace` | **Up Folder**: Naik ke direktori induk di atasnya |
| `Alt + Left` / `Alt + Right` | **History**: Navigasi mundur atau maju dalam riwayat folder |
| `Esc` | Menutup dialog modal aktif (Quick Look, Batch Renamer, Analyzer, Palette) |

---

## 🧪 Status Pengujian & Kualitas Kode
- **Frontend Build (`npm run build`)**: 
  - Kompilasi TypeScript strict mode (`tsc`) dan bundling Vite sukses 100% tanpa error maupun warning.
- **Backend Test Suite (`cargo test`)**: 
  - Lulus seluruh **27 unit test** tanpa kegagalan (`27 passed; 0 failed; 0 ignored`).
- **Gaya Desain UI**: 
  - Konsisten mengusung *Pitch Black Obsidian* (`#000000`), transisi mikro halus, dan tipografi monospaced untuk path dan ukuran file.
