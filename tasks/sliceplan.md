# SLICEPLAN — natl audit & pengerasan

Setiap slice punya bukti yang bisa gagal. Catatan jujur soal rollback: slice
dikelompokkan ke dalam 6 commit, jadi rollback per-slice berarti membalik hunk
file tertentu di dalam commit itu — bukan satu commit per slice.

```
SLICEPLAN
SLICE 1: deadline pada setiap request keluar
  SCOPE: src/http.js (baru); src/llm.js 2 call site; src/drivers/mobile.js 1 call site
  PROOF: test/llm.test.js + test/drivers/mobile.test.js — provider/Appium yang stall
         harus menghasilkan NatlError "timed out after 80ms", bukan hang
  ROLLBACK: balik src/http.js + 3 hunk call-site di commit 91cbdd6; perilaku lama =
            fetch tanpa timeout (hang tanpa batas)

SLICE 2: init menolak selectors.mode yang driver tidak dukung
  SCOPE: src/init.js (SELECTOR_MODES + normalizeSelectorMode), prompt wizard
  PROOF: test/init.test.js — mode 'xpath' harus ditolak saat init, bukan saat run
  ROLLBACK: balik src/init.js di commit 91cbdd6

SLICE 3: close() menutup tiap handle secara independen
  SCOPE: src/drivers/web.js close()
  PROOF: test/drivers/web.test.js — page.close() yang melempar tidak boleh
         meninggalkan browser hidup (tanpa fix, proses test tidak bisa exit)
  ROLLBACK: balik hunk close() di commit 91cbdd6; leak browser kembali

SLICE 4: install hasil publish bisa menjalankan test web
  SCOPE: bin/natl.js (import web driver pindah ke cabang + guard ERR_MODULE_NOT_FOUND
         + PLAYWRIGHT_BROWSERS_PATH hanya bila ada), src/drivers/web.js (guard versi
         1.63.0), src/drivers/mobile.js (pesan "cannot reach the Appium server"),
         package.json (files, optional peer, lantai >=1.63.0), LICENSE
  PROOF: test/cli.test.js — proyek mobile-only tanpa node_modules harus gagal di
         koneksi Appium, tidak pernah menyebut playwright; test web.test.js — pesan
         menyebut 1.63.0
  ROLLBACK: balik bin/natl.js + package.json di 9771310; install terpasang kembali
            mencari browser di node_modules/natl/.browsers

SLICE 5: server contoh tidak bisa dimatikan satu GET dan tidak bocor lewat symlink
  SCOPE: examples/web/server.mjs (handler try/catch, semua kegagalan stat = 404,
         containment via realpathSync, param `root` untuk test)
  PROOF: test/example-server.test.js — 3 test; tanpa fix: crash (file hang 99s);
         tanpa cek realpath: symlink menyajikan file di luar root
  ROLLBACK: balik examples/web/server.mjs di 9771310

SLICE 6: loadSave tidak lagi kehilangan entri
  SCOPE: src/cache.js (acquireLock O_EXCL + loadSave tanpa retry mtime/CAS)
  PROOF: test/cache.test.js "parallel writers" diperkuat 3→12 penulis; tanpa lock
         3/3 run gagal, dengan lock 22 run bersih
  ROLLBACK: balik src/cache.js di 2b6f23d

SLICE 7: nama file cache unik per path
  SCOPE: src/cache.js (cacheFileName + digest), bin/natl.js memakainya
  PROOF: test/cache.test.js — a/b.test.js vs a_b.test.js harus beda file
  ROLLBACK: balik 2 hunk di 2b6f23d

SLICE 8: kontrak exit code
  SCOPE: bin/natl.js (fail() exit 1; klasifikasi import test; driver.open()),
         README exit-code list
  PROOF: test/cli.test.js — file test yang melempar → 1, path tidak ada → 2,
         tanpa test object → 1, assertion gagal → 1, usage → 2
  ROLLBACK: balik bin/natl.js di 75dc4dd; semua error run() kembali jadi 2

SLICE 9: cakupan verifikasi yang hilang
  SCOPE: test/drivers/web.test.js (URL di fingerprint, guard versi),
         test/runner.test.js (steps kosong), test/cli.test.js (exit code),
         test/cache.test.js (cacheFileName)
  PROOF: tiap test merah di kode pra-fix (dibuktikan dengan stash / revert blok)
  ROLLBACK: hapus test terkait; tidak mengubah perilaku
```

## EVIDENCE

FACTS
- HEAD `75dc4dd`; `node --test` → 126 test, 126 pass, 0 fail.
- 6 auditor independen: runner/planner, driver/cache/CLI, integritas test suite,
  packaging/hygiene, examples+permukaan CLI, docs-vs-code. 1 verifier dingin memeriksa
  17 klaim dengan verdict ternary: 13 PASS, 3 FAIL, 1 UNVERIFIABLE.
- 2 dari 3 FAIL verifier adalah koreksi atas klaim PRODUSEN (saya): (a) "0 failures"
  hanya benar ~90% run di revisi yang dipin — itu race loadSave; (b) perintah
  verifikasi path mesin saya repo-wide padahal propertinya test-scoped.
- Verifier juga mengoreksi catatan saya bahwa report.js tak terkonstrain:
  `renderReport` TERKONSTRAIN (mutasi selalu-PASS menggagalkan test/cli.test.js);
  yang tak terkonstrain hanya `toJson`/`summarize`, dan `summarize` nol caller.
- Setiap slice punya test yang merah tanpa fix-nya — dua di antaranya merah dengan
  cara hang/crash, yaitu bug-nya sendiri.

ASSUMPTIONS
- "Prioritas tinggi" = seluruh temuan severity HIGH dari 6 auditor.
- Perilaku yang didokumentasikan sebagai keterbatasan (mis. `expectUrl` di-skip di
  mobile) bukan cacat kode selama disebutkan di README.

PROOF
- `node --test` (126/126) dijalankan pada kondisi akhir; `npm pack --dry-run` →
  hanya bin/src/examples/README/LICENSE/package.json; `git ls-files | grep` path
  mesin → kosong; suite juga hijau dengan `PLAYWRIGHT_BROWSERS_PATH` unset.

UNKNOWN
- Driver mobile belum pernah diuji terhadap Appium/device nyata (tidak ada
  `appium`/`adb` di host ini). Seluruh verifikasi mobile = spec W3C + fake.
- CI (.github/workflows/test.yml) belum pernah dieksekusi di runner; repo juga tidak
  punya git remote. Inspeksi statis: tidak ada step yang pasti gagal.
- Perilaku runtime playwright 1.64.1 belum diuji (revisi browser tidak tersedia).

DECISION
- Menutup objective: seluruh slice severity HIGH selesai dan terverifikasi.
- Sisa temuan MEDIUM/LOW tetap terbuka dan tercatat di `tasks/todo.md`; dua batas
  lingkungan (Appium nyata, runner CI) tidak bisa diselesaikan dari host ini dan
  dinyatakan sebagai UNKNOWN, bukan diklaim selesai.
