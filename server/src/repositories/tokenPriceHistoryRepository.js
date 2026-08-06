// repositories/tokenPriceHistoryRepository.js - the only place that
// reads/writes token_price_history. Filled going forward, one row
// per token per collector tick (see gmgnTrendingScheduler), as the
// real ground truth the recommendation validation framework
// evaluates outcomes against.

const db = require("../database/connection");

const insertStmt = db.prepare(`
    INSERT INTO token_price_history (token_address, price, market_cap, liquidity)
    VALUES (@tokenAddress, @price, @marketCap, @liquidity)
`);

function insertMany(entries){

    const runMany = db.transaction((items) => {

        items.forEach(e => insertStmt.run(e));

    });

    runMany(entries);

    return entries.length;

}

// The earliest recorded price at or after `timestamp` - i.e. "what
// was the price once this horizon had genuinely elapsed", not
// before. Falls back to null (never fabricated) if nothing was
// collected yet at/after that point.

function findPriceAtOrAfter(tokenAddress, timestamp){

    return db.prepare(`
        SELECT price, market_cap, liquidity, recorded_at
        FROM token_price_history
        WHERE token_address = ? AND datetime(recorded_at) >= datetime(?)
        ORDER BY recorded_at ASC
        LIMIT 1
    `).get(tokenAddress, timestamp) ?? null;

}

function countAll(){

    return db.prepare("SELECT COUNT(*) as count FROM token_price_history").get().count;

}

// Retention: only needed long enough to evaluate the longest
// recommendation_outcomes horizon (24h) plus slack for a delayed
// evaluator run - see config/retentionConfig.js.
//
// Batched + yielding, raw literal cutoff instead of
// datetime(recorded_at) < datetime('now', ...) - same fix, same
// evidence, as repositories/predictionHistoryRepository.js's own
// pruneOlderThan (see that function's own header for the full
// incident writeup this closes: "validation-scheduler 345 seconds as
// ONE unbatched DELETE"). Confirmed via EXPLAIN QUERY PLAN on the real
// production DB (2026-08-06): the datetime()-wrapped form produced a
// full SCAN of this table's 384k+ rows; this raw-literal form uses
// idx_token_price_history_token_time as a covering index SEARCH even
// without constraining token_address (SQLite's ANY() skip-scan). Real
// runtime evidence this closes: validation-scheduler logged
// priceHistoryPruned:2433 as part of a 145720ms run, immediately
// followed by 49528ms and 36232ms runs (a classic draining-backlog
// signature) - this table alone was never isolated as the sole cause,
// but shares the exact same query-shape defect already proven to cause
// multi-minute stalls in this same scheduler for a different table.
const PRUNE_BATCH_SIZE = 200;

function yieldToEventLoop(){
    return new Promise(resolve => setImmediate(resolve));
}

const pruneOlderThanBatchStmt = db.prepare(`
    DELETE FROM token_price_history WHERE id IN (
        SELECT id FROM token_price_history WHERE recorded_at < @cutoff LIMIT @batch
    )
`);

async function pruneOlderThan(maxAgeHours){

    const cutoff = new Date(Date.now() - maxAgeHours * 3600000).toISOString().slice(0, 19).replace("T", " ");

    let total = 0;

    while(true){

        const info = pruneOlderThanBatchStmt.run({ cutoff, batch: PRUNE_BATCH_SIZE });
        total += info.changes;

        if(info.changes < PRUNE_BATCH_SIZE) break;

        await yieldToEventLoop();

    }

    return total;

}

// Real historical peak price for this token, across whatever price
// history has been collected so far (bounded by retentionConfig's
// tokenPriceHistoryMaxAgeHours - see the token status service, which
// uses this to detect a real price collapse from a real observed
// high, not a guess).

function findPeakPrice(tokenAddress){

    const row = db.prepare(`
        SELECT MAX(price) as peak FROM token_price_history WHERE token_address = ?
    `).get(tokenAddress);

    return row?.peak ?? null;

}

// Real, ordered price/market-cap time series for one token since a
// given timestamp (chronological, oldest first) - used by
// predictionValidationService.js to determine which of TP/SL was
// touched FIRST (a token can pump then dump within the same check
// window; checking only the latest snapshot would silently miss
// whichever happened first) and to compute a real MFE/MAE across the
// full observed range, not just "whatever the price is right now".

function findRangeForToken(tokenAddress, fromTimestamp){

    return db.prepare(`
        SELECT price, market_cap, liquidity, recorded_at
        FROM token_price_history
        WHERE token_address = ? AND datetime(recorded_at) >= datetime(?)
        ORDER BY recorded_at ASC
    `).all(tokenAddress, fromTimestamp);

}

module.exports = { insertMany, findPriceAtOrAfter, countAll, pruneOlderThan, findPeakPrice, findRangeForToken };
