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
| `runHead.js` | Runner untuk checkout ini (HEAD) — menghormati env var `HELD_POSITION_REFRESH_MODE` dan `REGRESSION_OUTPUT_PATH` |
| `runBaseline.js` | Runner untuk dijalankan di dalam worktree commit lama |
| `runFlagCompare.js` | Menjalankan `runHead.js` dua kali (PROFIT_ONLY vs ALL_POSITIONS) sebagai child process terpisah, lalu membandingkan — **tidak butuh worktree**, keduanya HEAD, cuma beda flag |
| `compare.js` | Membaca dua telemetry JSON (default: baseline vs head; bisa override via `node compare.js <left> <right>`), menghitung metrik, mendeteksi first difference |
| `compare.test.js` | Test matematika comparator itu sendiri (QPS, burst, concurrency, first-difference) |
| `telemetry-head.json` / `telemetry-baseline.json` | Hasil run Arjuna-commit vs HEAD terakhir |
| `telemetry-modeA-profit-only.json` / `telemetry-modeB-all-positions.json` | Hasil run flag PROFIT_ONLY vs ALL_POSITIONS terakhir |
| `example-output.txt` | Contoh output perbandingan commit (Arjuna vs HEAD) |
| `example-output-flag-compare.txt` | Contoh output perbandingan flag (Mode A vs Mode B) |

## Feature flag: `HELD_POSITION_REFRESH_MODE`

Ditambahkan di `config/env.js`, dipakai `services/tradingBotEngine.js`'s `manageOpenPositions()`. Dua nilai nyata:

- **`ALL_POSITIONS`** (default — perilaku produksi saat ini, tidak berubah oleh keberadaan flag ini): setiap posisi terbuka di-refresh realtime tiap exit cycle, untung maupun rugi — perbaikan reliabilitas Stop Loss dari FINAL PRODUCTION SPRINT P0 (insiden nyata: SL -20% baru menutup di -43.8%/-81%).
- **`PROFIT_ONLY`** (cakupan asli Arjuna `a0a8759`): hanya posisi yang sudah di profit-protection territory yang direfresh realtime; posisi rugi/impas hanya lewat jalur `stale` (90s) yang lebih lambat.

Jalankan `node scripts/regressionCompare/runFlagCompare.js` untuk membandingkan keduanya langsung.

## Hasil run nyata terakhir (ringkasan)

**Commit Arjuna (a0a8759) vs HEAD** (`example-output.txt`): HEAD 10 request vs Arjuna 8 (delta +2) — naik di held-position refresh (2→6, semua posisi bukan cuma untung), turun di price-probe BUY (6→4, cache SOL/USD HEAD). First difference di request ke-3.

**Flag PROFIT_ONLY vs ALL_POSITIONS, keduanya HEAD** (`example-output-flag-compare.txt`): PROFIT_ONLY 6 request vs ALL_POSITIONS 10 (delta +4, murni dari held-position refresh — jalur BUY quote identik, 4 vs 4, karena cache SOL/USD tetap aktif di kedua mode, tidak terkait flag ini). **PROFIT_ONLY (6) bahkan lebih rendah dari total Arjuna baseline mentah (8)** — karena PROFIT_ONLY mewarisi cache SOL/USD yang tidak ada di Arjuna asli. Ini mengisolasi: cakupan held-position refresh adalah satu-satunya sumber kenaikan yang tersisa untuk fixture ini, dan bisa dimatikan/dinyalakan tanpa membuang perbaikan lain (cache, gateway, coalescing, maupun Stop Loss fix itu sendiri — yang tetap ada, hanya cakupannya yang dipersempit saat flag di-set PROFIT_ONLY).

**Pengujian nyata terhadap GMGN** (`npm run gmgn:verify-auth`, satu request `GET /v1/user/info`, endpoint verifikasi berbiaya-rendah yang sudah ada di codebase): **berhasil**, HTTP 200, 551ms, mengonfirmasi kredensial dan jalur autentikasi masih berfungsi normal saat ini.
