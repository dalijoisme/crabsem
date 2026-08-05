// collectors/gmgn/gmgnTrafficAccounting.js - TEMPORARY instrumentation
// (GMGN RATE_LIMIT_BANNED investigation, round 2). After Held-Position
// Refresh Architecture (commit acc00e5) and the SOL/USD price cache
// (commit 7d7e96d), RATE_LIMIT_BANNED still occurred roughly 10 minutes
// after boot. A full source-code call-chain audit re-traced every one of
// authClient.js's 21 exported methods to its real caller(s) and found
// every reachable live-request path already accounted for or already
// fixed - which means the next step can only be settled by REAL runtime
// measurement, not another source-code guess. This module IS that
// measurement: every GMGN request (via authClient.js's one shared
// fetchWithTimeout choke point - see requestDiagnostics.js, which this
// hooks into) is recorded with WHERE it actually came from, not just
// method+subPath.
//
// Origin attribution uses AsyncLocalStorage instead of threading an
// `origin` parameter through every intermediate function
// (authClient.js's ~20 exported methods, services/marketDataGateway.js,
// services/gmgnOndemandService.js). This keeps every one of those call
// signatures byte-identical - zero behavior-affecting change anywhere in
// the actual request/response path - while still tagging every request
// accurately: Node propagates AsyncLocalStorage context across every
// await/Promise/timer descended from the withOrigin() call automatically.
//
// A request captured with NO origin context set (getCurrentOrigin()
// falls through to "unattributed") is never swallowed or guessed - it is
// counted and surfaced as its own real row, with a short stack sample
// captured (cheap: only for this rare/unexpected case, never on every
// request), so a call chain nobody has tagged yet is a visible, honest
// gap instead of vanishing into someone else's bucket.
//
// REMOVE once the investigation is closed - same convention
// requestDiagnostics.js's own header already established.

const { AsyncLocalStorage } = require("async_hooks");

const originStorage = new AsyncLocalStorage();

// Wraps an async call chain so every GMGN request made anywhere inside
// it - however many awaits/Promise.all/loops deep - is attributed to
// `origin`. Call this at the OUTERMOST point that knows WHY the request
// is happening (a scheduler's own collector call, a price probe, a real
// BUY/SELL execution step), never deep inside a shared layer like
// marketDataGateway.js that serves many different callers.
function withOrigin(origin, fn){
    return originStorage.run(origin, fn);
}

function getCurrentOrigin(){
    return originStorage.getStore() ?? "unattributed";
}

// Static provenance for every origin this investigation has tagged so
// far - merged with LIVE counts (see getTrafficAccounting below) to
// produce the full accounting table. Kept here, not derived, because
// "why is this call made" and "can it be cached/coalesced/reduced" are
// engineering judgments, not something a request log can measure.
const ORIGIN_METADATA = {

    "scheduler:trending": {
        callChain: "gmgnTrendingScheduler.runOnce -> trendingCollector.collectTrending",
        sourceFile: "collectors/gmgn/trendingCollector.js",
        fungsi: "collectTrending()",
        alasan: "Refresh token universe trending (4 interval) setiap tick 30s",
        wajib: "Wajib", cache: "Tidak - harus real-time per tick",
        coalesce: "Tidak relevan - parameter interval berbeda tiap call",
        reducible: "Sudah minimal (4 interval sengaja untuk cakupan)"
    },

    "scheduler:trenches": {
        callChain: "gmgnTrendingScheduler.runOnce -> trenchesCollector.collectTrenches",
        sourceFile: "collectors/gmgn/trenchesCollector.js",
        fungsi: "collectTrenches()",
        alasan: "Refresh token baru / near-completion setiap tick 30s",
        wajib: "Wajib", cache: "Tidak", coalesce: "Tidak relevan", reducible: "Sudah minimal"
    },

    "scheduler:hot_searches": {
        callChain: "gmgnTrendingScheduler.runOnce -> hotSearchesCollector.collectHotSearches",
        sourceFile: "collectors/gmgn/hotSearchesCollector.js",
        fungsi: "collectHotSearches()",
        alasan: "Refresh token paling banyak dicari setiap tick 30s",
        wajib: "Wajib", cache: "Tidak", coalesce: "Tidak relevan", reducible: "Sudah minimal"
    },

    "scheduler:kol_activity": {
        callChain: "gmgnTrendingScheduler.runOnce -> activityFeedCollector.collectKolActivity",
        sourceFile: "collectors/gmgn/activityFeedCollector.js",
        fungsi: "collectKolActivity()",
        alasan: "Refresh feed aktivitas wallet KOL setiap tick 30s",
        wajib: "Wajib", cache: "Tidak", coalesce: "Tidak relevan", reducible: "Sudah minimal"
    },

    "scheduler:smart_money_activity": {
        callChain: "gmgnTrendingScheduler.runOnce -> activityFeedCollector.collectSmartMoneyActivity",
        sourceFile: "collectors/gmgn/activityFeedCollector.js",
        fungsi: "collectSmartMoneyActivity()",
        alasan: "Refresh feed aktivitas smart money setiap tick 30s",
        wajib: "Wajib", cache: "Tidak", coalesce: "Tidak relevan", reducible: "Sudah minimal"
    },

    "scheduler:gas_price": {
        callChain: "gmgnTrendingScheduler.runOnce -> gasPriceCollector.collectGasPrice",
        sourceFile: "collectors/gmgn/gasPriceCollector.js",
        fungsi: "collectGasPrice()",
        alasan: "Refresh snapshot gas fee jaringan setiap tick 30s",
        wajib: "Wajib", cache: "Tidak", coalesce: "Tidak relevan", reducible: "Sudah minimal"
    },

    "scheduler:launchpad_stats": {
        callChain: "gmgnTrendingScheduler.runOnce -> launchpadStatsCollector.collectLaunchpadStats",
        sourceFile: "collectors/gmgn/launchpadStatsCollector.js",
        fungsi: "collectLaunchpadStats()",
        alasan: "Refresh statistik launchpad setiap tick 30s",
        wajib: "Wajib", cache: "Tidak", coalesce: "Tidak relevan", reducible: "Sudah minimal"
    },

    "held-position-refresh-scheduler": {
        callChain: "heldPositionRefreshScheduler.runOnce -> refreshOneToken",
        sourceFile: "scheduler/heldPositionRefreshScheduler.js",
        fungsi: "refreshOneToken()",
        alasan: "Refresh harga/liquidity tiap token held-position UNIK, tiap 5s",
        wajib: "Wajib", cache: "Sudah - 1x per token unik per tick 5s",
        coalesce: "Ya (natural - union token lintas user)", reducible: "Sudah dioptimalkan sprint lalu"
    },

    "held-position-fallback-direct-fetch": {
        callChain: "runCycle/runExitCycle -> manageOpenPositions -> tradingBotEngine.refreshStaleHeldToken (store MISS)",
        sourceFile: "services/tradingBotEngine.js",
        fungsi: "refreshStaleHeldToken() - cabang fallback",
        alasan: "Fallback saat heldPositionMarketStore belum punya data cukup fresh (restart baru / race / posisi baru dibuka)",
        wajib: "Wajib sebagai fallback", cache: "Tidak - ini JALUR fallback saat cache kosong/basi",
        coalesce: "Tidak", reducible: "SEHARUSNYA jarang muncul - frekuensi tinggi di baris ini berarti sentralisasi tidak bekerja seperti didesain, bukan traffic yang direncanakan"
    },

    "usd-to-sol-price-probe": {
        callChain: "walletService.getRealWalletBalance -> usdToSolConverter.getSolUsdPrice",
        sourceFile: "services/execution/usdToSolConverter.js",
        fungsi: "getSolUsdPrice()",
        alasan: "Harga SOL/USD untuk wallet balance & konversi ukuran posisi",
        wajib: "Wajib", cache: "Sudah - TTL 10 detik, global (bukan per-user)",
        coalesce: "Sudah - in-flight coalescing", reducible: "Sudah dioptimalkan sprint lalu"
    },

    "execution:buy-quote": {
        callChain: "tradeManager (BUY) -> executionService -> gmgnSwapTransactionBuilder.build() cabang BUY",
        sourceFile: "services/execution/gmgnSwapTransactionBuilder.js",
        fungsi: "build() - cabang BUY",
        alasan: "Quote wajib sebelum submit swap BUY nyata (cek slippage/price-impact)",
        wajib: "Wajib", cache: "Tidak - harus real-time saat eksekusi", coalesce: "Tidak",
        reducible: "Tidak bisa - keselamatan eksekusi"
    },

    "execution:sell-quote": {
        callChain: "tradeManager (SELL) -> executionService -> gmgnSwapTransactionBuilder.build() cabang SELL (1-2 tier eskalasi)",
        sourceFile: "services/execution/gmgnSwapTransactionBuilder.js",
        fungsi: "build() - cabang SELL",
        alasan: "Quote wajib sebelum submit swap SELL nyata, dengan eskalasi toleransi bertingkat",
        wajib: "Wajib", cache: "Tidak", coalesce: "Tidak", reducible: "Tidak bisa - keselamatan eksekusi"
    },

    "execution:submit-swap": {
        callChain: "gmgnSwapTransactionBuilder.build().submit() -> executionService (state SUBMITTING)",
        sourceFile: "services/execution/gmgnSwapTransactionBuilder.js",
        fungsi: "submit()",
        alasan: "Submit transaksi swap nyata ke GMGN",
        wajib: "Wajib", cache: "Tidak", coalesce: "Tidak", reducible: "Tidak bisa"
    },

    "unattributed": {
        callChain: "BELUM DIKETAHUI - request ini lolos tanpa origin context",
        sourceFile: "-", fungsi: "-",
        alasan: "Perlu investigasi manual - lihat stackSample yang direkam untuk baris ini",
        wajib: "-", cache: "-", coalesce: "-", reducible: "-"
    }

};

// Generous relative to the ~10-minute ban window this investigation
// cares about, bounded so memory can never grow unbounded across a
// long-running process.
const MAX_RETENTION_MS = 30 * 60 * 1000;

const records = []; // { endpoint, origin, ts, stackSample? } - oldest first

function pruneOld(){
    const cutoff = Date.now() - MAX_RETENTION_MS;
    while(records.length && records[0].ts < cutoff) records.shift();
}

// Called from requestDiagnostics.js's logRequest() - the same single
// choke point every GMGN HTTP request already passes through
// (authClient.js's fetchWithTimeout), for every client instance
// (marketDataGateway's, execution's). Purely additive: records the real
// request that already happened, never affects it.
function record({ method, subPath }){

    const origin = getCurrentOrigin();
    const entry = { endpoint: `${method} ${subPath}`, origin, ts: Date.now() };

    if(origin === "unattributed"){
        // Cheap only because this is the rare/unexpected path - never
        // captured on every request, only on the ones this investigation
        // most needs to explain.
        entry.stackSample = (new Error().stack || "").split("\n").slice(2, 6).map(l => l.trim()).join(" | ");
    }

    records.push(entry);
    pruneOld();

}

// Real, measured accounting for the last `windowMs` (default: the full
// retention window). elapsedMs is the REAL observed span between the
// oldest record in the window and now - never the nominal windowMs -
// so calls/min is accurate even moments after boot, when far less than
// windowMs of real history exists yet.
function getTrafficAccounting(windowMs = MAX_RETENTION_MS){

    pruneOld();

    const cutoff = Date.now() - windowMs;
    const inWindow = records.filter(r => r.ts >= cutoff);

    if(!inWindow.length){
        return { windowMs, elapsedMs: 0, totalCalls: 0, generatedAt: new Date().toISOString(), rows: [] };
    }

    const oldestTs = Math.min(...inWindow.map(r => r.ts));
    const elapsedMs = Math.max(1000, Date.now() - oldestTs);
    const totalCalls = inWindow.length;

    const byKey = new Map();
    for(const r of inWindow){
        const key = `${r.endpoint}::${r.origin}`;
        if(!byKey.has(key)) byKey.set(key, { count: 0, sampleStack: r.stackSample });
        byKey.get(key).count++;
    }

    const rows = [...byKey.entries()].map(([key, { count, sampleStack }]) => {

        const [endpoint, origin] = key.split("::");
        const meta = ORIGIN_METADATA[origin] || ORIGIN_METADATA.unattributed;

        return {
            endpoint,
            origin,
            callsPerMinute: Math.round((count / elapsedMs) * 60000 * 100) / 100,
            callCount: count,
            percentageOfTotal: Math.round((count / totalCalls) * 10000) / 100,
            ...meta,
            ...(sampleStack ? { stackSample: sampleStack } : {})
        };

    }).sort((a, b) => b.callCount - a.callCount);

    return { windowMs, elapsedMs, totalCalls, generatedAt: new Date().toISOString(), rows };

}

// Plain-text table, the exact column shape requested for this
// investigation - safe to console.log() directly (shows up in
// pm2/systemd logs with zero extra tooling) or return from an admin
// endpoint.
function formatAccountingTable(accounting){

    if(!accounting.totalCalls){
        return "[gmgn-traffic-accounting] Belum ada request GMGN tercatat dalam window ini.";
    }

    const lines = [];
    lines.push(`[gmgn-traffic-accounting] window=${Math.round(accounting.elapsedMs / 1000)}s totalCalls=${accounting.totalCalls} generatedAt=${accounting.generatedAt}`);
    lines.push("Endpoint | Calls/min | %Total | Origin | Call Chain | Source File | Fungsi | Wajib | Cache? | Coalesce? | Bisa dikurangi?");

    for(const r of accounting.rows){
        lines.push([
            r.endpoint, r.callsPerMinute, `${r.percentageOfTotal}%`, r.origin, r.callChain,
            r.sourceFile, r.fungsi, r.wajib, r.cache, r.coalesce, r.reducible
        ].join(" | "));
        if(r.stackSample) lines.push(`    stackSample: ${r.stackSample}`);
    }

    const totalPct = Math.round(accounting.rows.reduce((s, r) => s + r.percentageOfTotal, 0) * 100) / 100;
    lines.push(`TOTAL: ${accounting.totalCalls} calls, ${totalPct}% (harus 100%, boleh meleset tipis karena pembulatan per baris)`);

    return lines.join("\n");

}

let periodicTimer = null;

// Logs the full accounting table to console every intervalMs - the
// most direct way to see real numbers on the VPS: just watch the
// existing process log (pm2 logs / journalctl), no separate tooling or
// endpoint call needed. unref()'d so it can never keep the process
// alive on its own, same convention every other timer in this codebase
// already follows (see services/schedulerLockGuard.js).
function startPeriodicLogging(intervalMs = 60000){

    if(periodicTimer) return periodicTimer;

    periodicTimer = setInterval(() => {
        console.log(formatAccountingTable(getTrafficAccounting()));
    }, intervalMs);

    if(typeof periodicTimer.unref === "function") periodicTimer.unref();

    return periodicTimer;

}

function stopPeriodicLogging(){
    if(periodicTimer){ clearInterval(periodicTimer); periodicTimer = null; }
}

// Test-only reset.
function _resetForTest(){
    records.length = 0;
}

module.exports = {
    withOrigin, getCurrentOrigin, record, getTrafficAccounting, formatAccountingTable,
    startPeriodicLogging, stopPeriodicLogging, ORIGIN_METADATA, _resetForTest
};
