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

function pruneOlderThan(maxAgeHours){

    const info = db.prepare(`
        DELETE FROM token_price_history
        WHERE datetime(recorded_at) < datetime('now', '-' || ? || ' hours')
    `).run(maxAgeHours);

    return info.changes;

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
