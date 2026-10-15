# Implementation Plan: natl — audit menyeluruh & pengerasan

## Overview

`natl` adalah CLI pengujian E2E berbahasa natural (web + mobile) yang tujuan
desainnya adalah menghapus model dari jalur panas: rekam sekali, replay tanpa
panggilan model. Dua commit terakhir (`039476b`, `91cbdd6`) menutup 15 cacat
hasil audit pertama. Rencana ini menutup sisa cacat yang muncul dari audit
menyeluruh permukaan yang belum pernah diaudit: integritas test suite, drift
dokumentasi, packaging/distribusi, dan contoh + permukaan CLI.

Prinsip: setiap slice punya satu bukti yang bisa gagal. Tidak ada slice yang
dianggap selesai karena "sudah terlihat benar".

## Architecture Decisions

- **Playwright tetap opsional saat runtime.** Spec (`docs/superpowers/specs/2026-10-05-natl-design.md`)
  menyatakan dependency dihitung dua dan `playwright` adalah "dev/example
  dependency, optional at runtime". Karena itu perbaikannya adalah memindahkan
  import driver web ke cabang `web` dan memberi pesan yang jelas — bukan
  memindahkan playwright ke `dependencies` (itu akan memaksa setiap pemakai
  mobile mengunduh ~10MB paket yang tidak dipakai).
- **Tidak ada dependensi baru** kecuali untuk pengujian. CI memakai runner
  bawaan GitHub Actions tanpa aksi pihak ketiga di luar `actions/*`.
- **Rencana ini hidup.** Temuan auditor yang belum masuk ditandai `[pending S1]`
  dan akan di-merge ke tabel prioritas, bukan ditulis ulang dari nol.

## Task List

### Phase 0: sudah selesai (konteks)

- [x] 15 cacat ditutup di `039476b` + `91cbdd6` (ordinal elemen, teks halaman di
      fingerprint, plan kosong, driver mobile W3C, loadSave, init, timeout fetch,
      close() parsial, dll). 113/113 pass, red-green terbukti.

### Phase 1: distribusi & portabilitas (temuan yang sudah dibuktikan parent)

- [x] Task 1: install hasil publish tidak butuh playwright untuk proyek mobile
- [x] Task 2: suite test portabel — buang 3 path absolut mesin

### Checkpoint: Phase 1

- [ ] `npm test` hijau
- [ ] Test CLI baru membuktikan proyek mobile jalan tanpa `playwright` terpasang
- [x] tidak ada path absolut mesin di file tracked (grep scoped ke `test/` kosong)

### Phase 2: temuan auditor

- [x] Task 4: server contoh mati oleh satu GET (ENOTDIR → proses abort)
- [x] Task 5: symlink menembus root server contoh
- [x] Task 6: install mencari browser di direktori yang tidak pernah dibuat
- [x] Task 7: playwright tak dideklarasikan + lantai versi salah (>=1.63.0)
- [x] Task 8: URL tak pernah diuji sebagai bagian fingerprint
- [x] Task 9: exit code CLI tak pernah di-assert
- [x] Task 10: test tanpa step melaporkan PASS
- [x] Task 11: path mesin + scaffolding ikut ter-publish
- [ ] Task 3: tabrakan nama file cache (`a/b.test.js` vs `a_b.test.js`)
- [ ] Task 13..N: sisa temuan + auditor docs-drift  [pending]

### Checkpoint: Phase 2

- [ ] Semua temuan severity high sudah ditutup atau punya alasan tertulis kenapa tidak

### Phase 3: pencegahan regresi

- [x] Task 12: CI minimal (node 20/22, install browser, `npm test`) — ditulis, belum pernah jalan di runner
- [x] Task 11b: `files` allow-list + LICENSE + `.superpowers/` keluar dari tracking

### Checkpoint: Phase 3

- [ ] CI hijau di mesin bersih (atau alasannya tertulis kalau tidak bisa dijalankan di sini)

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Fix packaging mengubah perilaku user yang sudah punya playwright | Low | Import tetap dijalankan untuk cabang web; hanya pesan errornya yang membaik |
| Auditor menemukan cacat yang membatalkan slice | Med | Rencana hidup: slice ditambah/diurutkan ulang, bukan ditulis ulang |
| CI tidak bisa dijalankan di mesin ini (sandbox menolak jaringan) | Med | Siapkan workflow + verifikasi langkah-langkahnya lokal; tandai "belum pernah jalan di runner" secara eksplisit |
| Perubahan fingerprint/elemen sudah menaikkan cache lama jadi tidak valid | Low | Cache hanya mempercepat; miss berarti plan ulang, bukan hasil salah |

## Open Questions

- Apakah `.superpowers/sdd/natl/progress.md` (scaffolding sesi, 16K, path absolut)
  sengaja di-commit? Kalau tidak, ia harus keluar dari repo.
- Apakah paket ini memang akan dipublikasikan ke npm? Menentukan seberapa jauh
  packaging perlu dipoles (Task N+2).
