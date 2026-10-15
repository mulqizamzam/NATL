# Task list — natl audit & pengerasan

Rencana: [tasks/plan.md](plan.md). Status jujur: `[x]` berarti sudah diverifikasi
dengan bukti yang bisa gagal, bukan "sudah terlihat benar".

## Phase 1 — distribusi & portabilitas

### Task 1: install hasil publish tidak butuh playwright untuk proyek mobile

**Description:** `bin/natl.js:67` meng-import driver web tanpa syarat dan di luar
blok `try`. Karena `playwright` adalah devDependency, siapa pun yang memasang
`natl` lalu menjalankan `natl run` — bahkan untuk proyek mobile-only — gagal
dengan `ERR_MODULE_NOT_FOUND: Cannot find package 'playwright'`. Spec sudah
menyatakan playwright "optional at runtime"; kode harus sesuai spec.

**Acceptance criteria:**
- [x] Import driver web hanya terjadi di cabang `appType` web.
- [x] Proyek mobile-only bisa menjalankan `natl run` tanpa `playwright` terpasang.
- [x] Kalau playwright memang tidak ada di proyek web, pesannya menyebut cara
      memasangnya, bukan `ERR_MODULE_NOT_FOUND` mentah.

**Verification:**
- [x] Test CLI baru: salin `bin/` + `src/` ke direktori temp tanpa `node_modules`,
      jalankan dengan config mobile, dan buktikan error yang muncul adalah error
      koneksi Appium — bukan error modul `playwright`. (RED sebelum fix.)
- [x] `npm test` hijau.

**Dependencies:** None
**Files likely touched:** `bin/natl.js`, `test/cli.test.js` (baru)
**Estimated scope:** Small

### Task 2: suite test portabel

**Description:** Tiga file test yang di-track mematok path absolut mesin ini
(path absolut mesin penulis). Clone di mesin lain menjalankan suite
dengan direktori browser yang salah.

**Acceptance criteria:**
- [x] Tidak ada path absolut mesin di file yang di-track di bawah `test/`.
- [x] Path browser diturunkan dari lokasi file (atau dari env kalau sudah di-set).
- [x] `npm test` tetap hijau tanpa `PLAYWRIGHT_BROWSERS_PATH` di environment.
      CATATAN: percobaan pertama GAGAL audit-diri — helper men-set env di body modul,
      padahal Playwright membacanya saat modulnya dievaluasi. Komentar lama di test
      file ("read lazily at launch time") salah; helper sekarang men-set-nya saat
      evaluasi modul dan di-import paling awal.

**Verification:**
- [x] `env -u PLAYWRIGHT_BROWSERS_PATH node --test` hijau (116/116 saat itu).
- [x] tidak ada path absolut mesin di file tracked (grep scoped ke `test/` kosong)

**Dependencies:** None
**Files likely touched:** `test/drivers/web.test.js`, `test/example-web.test.js`,
`test/e2e-web.test.js`, `test/helpers/`
**Estimated scope:** Small

### Checkpoint: Phase 1
- [x] `npm test` hijau
- [x] Kedua bukti Task 1 dan Task 2 sudah dijalankan dan hasilnya dikutip

## Phase 2 — temuan auditor  [pending S1]

### Task 3: tabrakan nama file cache
**Description:** `bin/natl.js:119` memetakan `a/b.test.js` dan `a_b.test.js` ke
file cache yang sama, sehingga dua test berbeda berbagi state.
**Acceptance criteria:** dua path berbeda menghasilkan nama file cache berbeda.
**Verification:** test unit yang membandingkan dua path; `npm test` hijau.
**Dependencies:** None · **Scope:** XS

### Task 4: server contoh mati oleh satu GET (auditor examples, HIGH-1)
`examples/web/server.mjs` melempar keluar dari request handler saat `statSync`
gagal dengan selain ENOENT (ENOTDIR/ENAMETOOLONG) → proses abort.
**Acceptance:** setiap kegagalan stat = 404; server tetap hidup.
**Verification:** `test/example-server.test.js` — RED sebelum fix (test crash +
file hang 99s), hijau sesudah. **Status: [x] DONE**

### Task 5: symlink menembus root server contoh (auditor examples, HIGH-2)
**Acceptance:** symlink di dalam root tidak boleh menyajikan file di luarnya.
**Verification:** test symlink — RED saat blok realpath dilepas, hijau saat ada.
**Status: [x] DONE**

### Task 6: install terpasang mencari browser di direktori yang tidak ada (auditor packaging, H1)
`bin/natl.js` memaksa `PLAYWRIGHT_BROWSERS_PATH=<pkg>/.browsers` bahkan untuk paket
ter-install, sehingga saran `npx playwright install` di pesan errornya tidak menolong.
**Acceptance:** default hanya dipakai bila direktorinya ada.
**Verification:** guard `existsSync`; suite CLI tetap hijau. **Status: [x] DONE**

### Task 7: playwright tidak dideklarasikan & lantai versi salah (auditor packaging, H3+H4)
`page.ariaSnapshotJSON` baru ada di playwright 1.63.0, tapi rentangnya `^1.50.0`.
**Acceptance:** lantai >=1.63.0; deklarasi peer opsional; pesan jelas bila API absen.
**Verification:** test guard versi (merah tanpa guard). **Status: [x] DONE**

### Task 8: URL tidak pernah diuji di fingerprint (auditor test, HIGH-1)
15 pemanggilan `makeFingerprint` di test semuanya satu argumen.
**Verification:** test driver yang membandingkan `snap.fingerprint` dengan
`makeFingerprint(snap.elements, page.url())`. **Status: [x] DONE**

### Task 9: exit code CLI tak pernah di-assert (auditor test, HIGH-2)
**Verification:** test CLI: exit 0 (pass), 1 (assertion gagal + step ⊘), 2 (usage).
**Status: [x] DONE**

### Task 10: test tanpa step melaporkan PASS (auditor examples, M4)
**Verification:** test runner — merah tanpa aturan baru. **Status: [x] DONE**

### Task 11: path mesin + scaffolding ikut ter-publish (auditor packaging, H2/M4)
**Verification:** `npm pack --dry-run` → hanya bin/src/examples/README/LICENSE +
package.json; `.superpowers/` keluar dari tracking; `.gitignore` diperbarui; LICENSE
MIT ditambahkan. **Status: [x] DONE

### Task 12: tidak ada CI (auditor packaging, M1)
`.github/workflows/test.yml` — node 20/22, `npm ci`, install browser dengan
`PLAYWRIGHT_BROWSERS_PATH` yang sama, `npm test`.
**Status: [x] DITULIS, BELUM PERNAH JALAN DI RUNNER** (mesin ini tidak punya akses
runner; `--with-deps` butuh apt/root).

### Task 14: loadSave kehilangan entri di kontensi nyata (DITEMUKAN SAAT VERIFIKASI)
Test konkurensi yang sudah ada gagal **2 dari 5 run** dengan hanya 3 penulis — bukan
test flaky, tapi kehilangan data diam-diam: read-back CAS bersifat TOCTOU, dua penulis
yang sama-sama membaca sebelum salah satu menulis akan saling menimpa.
**Fix:** lock file eksklusif (`open(...,'wx')`, O_EXCL) membungkus read-modify-write;
lock basi (>10s) di-steal supaya penulis yang mati tidak memblokir cache selamanya.
**Verification:** test diperkuat 3→12 penulis; tanpa lock 3/3 run gagal, dengan lock
22 run bersih. **Status: [x] DONE**

### Task 13..N  [pending] — auditor docs-drift belum melapor
Juga belum dikerjakan dari laporan yang sudah masuk: `loadSave` di kontensi berat,
`report.js` + `renderReport` tanpa test, fake WebDriver non-W3C New Session,
duplikasi `expectCount` 0 pada session mati (sudah), `natl init` non-TTY exit 13,
`examples/mobile/README.md` menyebut file yang tidak ada, mode `capabilities.json`
mati, path cache bertabrakan, perilaku elemen hidden tak terdokumentasi.

## Phase 3 — pencegahan regresi  [pending S1]

### Task N+1: CI minimal
**Description:** Tidak ada CI sama sekali.
**Acceptance criteria:** workflow menjalankan install + test di mesin bersih.
**Verification:** langkah-langkahnya dijalankan lokal, atau ditandai eksplisit
"belum pernah jalan di runner".
**Scope:** Small

## Checkpoint akhir
- [x] Semua slice severity high ditutup atau punya alasan tertulis (6 auditor; 1 item
      sengaja tidak diubah dan alasannya tertulis)
- [x] `node --test` hijau di kondisi akhir: 136/136 pada HEAD d3b26c9

## Sisa pekerjaan (direkonsiliasi 2026-10-15, HEAD d3b26c9; init non-TTY ditutup)

Sudah tertutup setelah daftar lama ini ditulis: `report.js` (`summarize` dihapus +
`test/report.test.js`), fake WebDriver bentuk New Session W3C, mutasi fixture di
`test/e2e-web.test.js`, `init` tidak lagi menulis `capabilities.json`, elemen hidden
terdokumentasi di README, laporan auditor docs-drift diterima, verdict cold verification
diterima. Bukti: `b997523`, `ab941f4`, `d1fb3fb`.

**Masih terbuka di kode**

- [x] `natl init` tanpa TTY: sekarang exit 2 dengan pesan yang bisa ditindaklanjuti
      (`init needs an interactive terminal — no TTY is available. …`), nol file ditulis.
      Test CLI menutupnya (merah sebelum fix, exit 13 + "Detected unsettled top-level
      await"). SISA saudaranya, sengaja tidak disentuh: Ctrl-D di TTY nyata masih
      menghasilkan gejala yang sama karena `rl.question` tidak pernah settle — butuh
      penanganan 'close' pada readline, dan saya tidak mau menambah mesin itu tanpa
      cara memverifikasinya.
- [ ] Jalur "replay throws → replan + re-record" di mode auto tidak punya test; cabang
      re-snapshot setelah replay parsial di `runner.js` tak tersentuh.
- [ ] Invariant "tulis ke temp lalu rename" tak punya test yang bisa gagal.
- [ ] Sisa invariant spec tanpa test: group-size mismatch fallback, "fail fast tanpa API
      key", model unreachable di level runner, `click('#missing')` harus gagal, shape
      elemen D1, tool schema llm, skip `expectUrl` di mobile, entri cache lama tersisa.
- [ ] `loadCache` korup menggagalkan test yang tidak punya NL step sama sekali.
      Keputusan sadar: gagal keras dianggap lebih baik daripada diam-diam plan ulang.
- [ ] Pesan `SELECTOR_MODES` di init lebih luas dari kenyataan — driver memang
      mengimplementasikan strategi `xpath=` di dalam string selector.

**Sengaja tidak diubah**

- [ ] `src/drivers/mobile.js` tidak memasukkan URL ke fingerprint. Driver tidak punya URL
      native; menambah panggilan jaringan per snapshot tanpa device untuk memverifikasi
      lebih buruk daripada mendokumentasikannya (sudah ada di README "Known limitations"
      dan di catatan as-built spec).

**Menunggu keputusan atau infrastruktur operator**

- [ ] `git remote add` + push → CI pertama kali di mesin bersih. Ini menutup satu-satunya
      klaim besar yang masih UNVERIFIABLE: semua verifikasi sesi ini berjalan di host ini
      dengan `.browsers` yang sudah ada.
- [ ] Publish npm — ditunda operator; sampai itu README tetap "install dari source".
- [ ] `AGENTS.md` untracked di root repo natl. Bukan artefak repo ini, dan selama ada di
      sini isinya ikut tersuntik sebagai instruksi workspace setiap turn.

**Tidak bisa diverifikasi dari host ini**

- Driver mobile terhadap Appium nyata (`appium`/`adb` tidak terpasang).
- Runtime playwright 1.64 (revisi browser tidak tersedia di sini).
