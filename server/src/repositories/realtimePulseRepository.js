// repositories/realtimePulseRepository.js - the only place that reads/
// writes realtime_pulse_snapshots (migration 068, Arjuna V4 Phase 2). This
// is the durable tier of the Realtime Pulse poll history - the in-memory
// rolling buffer (services/realtimePulseBufferService.js) is the hot path;
// this table is what survives a process restart, feeds the Daily Trading
// Review, and makes every Realtime Pulse reading debuggable after the
// fact. Same append-only shape as tokenPriceHistoryRepository.js - never
// updated in place, only inserted and eventually pruned.

const db = require("../database/connection");

const insertStmt = db.prepare(`
    INSERT INTO realtime_pulse_snapshots (
        token_address, price, liquidity, holders, volume_1h, buys_5m, sells_5m,
        price_change_5m, price_change_1h, net_buy_24h,
        smart_money_buy_usd, smart_money_sell_usd, smart_money_trade_count,
        kol_buy_usd, kol_sell_usd, kol_trade_count
    ) VALUES (
        @tokenAddress, @price, @liquidity, @holders, @volume1h, @buys5m, @sells5m,
        @priceChange5m, @priceChange1h, @netBuy24h,
        @smartMoneyBuyUsd, @smartMoneySellUsd, @smartMoneyTradeCount,
        @kolBuyUsd, @kolSellUsd, @kolTradeCount
    )
`);

// One row per fresh-universe token per Pulse tick - batched in a single
// transaction, same convention tokenPriceHistoryRepository.insertMany()
// already uses (far faster than one statement per row, and the whole
// batch either lands or none of it does).
function insertMany(entries){

    if(!entries.length) return 0;

    const runMany = db.transaction((items) => {
        items.forEach(e => insertStmt.run(e));
    });

    runMany(entries);

    return entries.length;

}

// The most recent `limit` real polls for one token, oldest first - what
// services/realtimePulseBufferService.js reads once at process boot to
// warm-start its in-memory buffer instead of starting fully cold (see
// PHASE2_ARCHITECTURE_REVIEW.md Section 1's "recovery after restart"
// recommendation).
function findRecentForToken(tokenAddress, limit){

    // Tie-broken by id (monotonic autoincrement), not just recorded_at -
    // SQLite's CURRENT_TIMESTAMP has only 1-second resolution, so two
    // polls written within the same real second would otherwise sort
    // non-deterministically among themselves.
    const rows = db.prepare(`
        SELECT * FROM realtime_pulse_snapshots
        WHERE token_address = ?
        ORDER BY recorded_at DESC, id DESC
        LIMIT ?
    `).all(tokenAddress, limit);

    return rows.reverse();

}

function countAll(){

    return db.prepare("SELECT COUNT(*) as count FROM realtime_pulse_snapshots").get().count;

}

// Retention - same pattern every other time-series table in this codebase
// already uses (tokenPriceHistoryRepository.pruneOlderThan, etc.), wired
// into services/retentionService.js's existing scheduled pass.
function pruneOlderThan(maxAgeHours){

    const info = db.prepare(`
        DELETE FROM realtime_pulse_snapshots
        WHERE datetime(recorded_at) < datetime('now', '-' || ? || ' hours')
    `).run(maxAgeHours);

    return info.changes;

}

module.exports = { insertMany, findRecentForToken, countAll, pruneOlderThan };
