# Regression Comparator

Membandingkan pola request GMGN antara baseline Arjuna (`a0a8759`) dan HEAD, **berdasarkan eksekusi runtime nyata** dari fungsi produksi yang tidak dimodifikasi di masing-masing commit — bukan audit source code statis, bukan estimasi.

## Apa yang dijalankan

Untuk satu input fixture yang identik (`fixture.js`: 3 held position dengan status profit berbeda + 3 kandidat BUY), tool ini menjalankan subset BUY-cycle yang menyentuh GMGN secara langsung:

1. `tradingBotEngine.manageOpenPositions()` — logika refresh held-position, tidak dimodifikasi.
2. `tradeManager.openPosition()` → `usdToSolConverter.convertUsdPositionToLamports()` + `gmgnSwapTransactionBuilder.build()` — sampai persis sebelum `submit()`.

**Tidak pernah:** submit transaction, beli/jual token, menulis ke database asli, atau memanggil GMGN sungguhan (`spyGmgnClient.js` mencatat setiap panggilan dengan `Date.now()` presisi milidetik, lalu mengembalikan respons sintetis instan — jadi timing/urutan yang tercatat murni perilaku kode pemanggil, bukan latensi jaringan GMGN).

**Di luar cakupan (disengaja):** `entryGateService`/scoring/AI Decision Engine — dikonfirmasi lewat audit sumber sebelumnya nol panggilan GMGN, jadi tidak direplay di sini sama sekali; tool ini tidak pernah menyentuh AI logic.

## Cara menjalankan dari nol

```bash
# 1. Sisi HEAD (dari checkout ini)
cd server
node scripts/regressionCompare/runHead.js

# 2. Siapkan worktree baseline (sekali saja)
git worktree add /tmp/regression-baseline a0a8759
cd /tmp/regression-baseline/server
ln -s "<path-checkout-ini>/server/node_modules" node_modules
node -e "require('./src/database/migrate').runMigrations();"
# ^ membuat skema DB kosong TERISOLASI hanya di dalam worktree ini -
#   tidak pernah menyentuh data/crabsem.sqlite yang asli.

# 3. Salin harness ke worktree, jalankan sisi baseline
cp <checkout-ini>/server/scripts/regressionCompare/{spyGmgnClient,fixture,runBaseline}.js \
   /tmp/regression-baseline/server/scripts/regressionCompare/
cd /tmp/regression-baseline/server
node scripts/regressionCompare/runBaseline.js

# 4. Salin hasil balik, lalu bandingkan
cp /tmp/regression-baseline/server/scripts/regressionCompare/telemetry-baseline.json \
   <checkout-ini>/server/scripts/regressionCompare/
cd <checkout-ini>/server
node scripts/regressionCompare/compare.js
```

Untuk membandingkan HEAD dengan commit lain (bukan `a0a8759`): ganti commit di langkah 2, dan sesuaikan `runBaseline.js` bila signature fungsi produksi di commit itu berbeda dari yang saat ini diasumsikan (lihat komentar di kepala file tersebut).

## File

| File | Isi |
|---|---|
| `spyGmgnClient.js` | Client GMGN palsu — mencatat setiap panggilan (timestamp ms, endpoint, origin, candidate/token, status), tidak pernah request jaringan sungguhan |
| `fixture.js` | Input tetap, sama persis untuk kedua sisi |
| `runHead.js` | Runner untuk checkout ini (HEAD) |
| `runBaseline.js` | Runner untuk dijalankan di dalam worktree commit lama |
| `compare.js` | Membaca kedua telemetry JSON, menghitung metrik, mendeteksi first difference |
| `compare.test.js` | Test matematika comparator itu sendiri (QPS, burst, concurrency, first-difference) |
| `telemetry-head.json` / `telemetry-baseline.json` | Hasil run nyata terakhir (regenerated tiap dijalankan ulang) |
| `example-output.txt` | Contoh output `compare.js` dari run nyata di atas |

## Hasil run nyata terakhir (ringkasan)

Lihat `example-output.txt` untuk output lengkap. Ringkasan: HEAD menghasilkan 10 request vs Arjuna 8 (delta +2) untuk fixture ini — bertambah di jalur held-position refresh (2→6, karena HEAD me-refresh semua posisi bukan hanya yang untung), berkurang di jalur price-probe BUY (6→4, karena cache SOL/USD di HEAD). First difference terjadi di request ke-3: Arjuna langsung lanjut ke kandidat BUY pertama, HEAD masih memproses held-position kedua/ketiga lebih dulu.
