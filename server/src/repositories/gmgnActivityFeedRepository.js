// repositories/gmgnActivityFeedRepository.js - the only place that
// reads/writes gmgn_activity_feed (real recent trades from
// KOL-tagged and smart-money-tagged wallets). Append-only: a real
// transaction never changes once it happened, so duplicates are
// ignored (not upserted) via INSERT OR IGNORE on the unique
// (feed_type, transaction_hash) key.

const db = require("../database/connection");

const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO gmgn_activity_feed (
        feed_type, transaction_hash, chain, maker_address, maker_tags,
        maker_twitter, side, token_address, token_symbol,
        amount_usd, price_usd, tx_timestamp, raw_json
    ) VALUES (
        @feedType, @transactionHash, @chain, @makerAddress, @makerTags,
        @makerTwitter, @side, @tokenAddress, @tokenSymbol,
        @amountUsd, @priceUsd, @txTimestamp, @rawJson
    )
`);

function insertEntries(entries){

    const runMany = db.transaction((items) => {

        let inserted = 0;

        items.forEach(e => {

            const info = insertStmt.run(e);

            if(info.changes > 0) inserted++;

        });

        return inserted;

    });

    return runMany(entries);

}

function findByType(feedType, limit = 50){

    return db.prepare(`
        SELECT id, feed_type, transaction_hash, chain, maker_address, maker_tags,
               maker_twitter, side, token_address, token_symbol, amount_usd,
               price_usd, tx_timestamp, collected_at
        FROM gmgn_activity_feed
        WHERE feed_type = ?
        ORDER BY tx_timestamp DESC
        LIMIT ?
    `).all(feedType, limit);

}

function countByType(feedType){

    return db.prepare("SELECT COUNT(*) as count FROM gmgn_activity_feed WHERE feed_type = ?").get(feedType).count;

}

// Used by the Intelligence Engine's Smart Money / KOL categories.
// The feed only holds the most recent ~50 trades per type
// system-wide (not exhaustive per-token history), so an empty result
// means "not in our recent sample", not "verified zero activity" -
// callers must present that honestly, not as a bearish signal.

function findByToken(tokenAddress, feedType, limit = 20){

    return db.prepare(`
        SELECT id, feed_type, transaction_hash, chain, maker_address, maker_tags,
               maker_twitter, side, token_address, token_symbol, amount_usd,
               price_usd, tx_timestamp, collected_at
        FROM gmgn_activity_feed
        WHERE token_address = ? AND feed_type = ?
        ORDER BY tx_timestamp DESC
        LIMIT ?
    `).all(tokenAddress, feedType, limit);

}

// Full-table read for one feed type, for the Intelligence Engine's
// list-mode analysis - one query to group in memory by token_address
// instead of one findByToken() call per token. Unlike findByType()
// (which serves the public /activity/kol and /activity/smart-money
// endpoints and is meant to be capped), this must return every row
// or a token whose real trades are older than the newest N
// system-wide would wrongly look like it has no smart-money/KOL
// activity at all. Safe only because retention pruning (see
// scheduler/pruneJob.js) keeps this table's total size bounded.

function findAllByType(feedType){

    return db.prepare(`
        SELECT id, feed_type, transaction_hash, chain, maker_address, maker_tags,
               maker_twitter, side, token_address, token_symbol, amount_usd,
               price_usd, tx_timestamp, collected_at
        FROM gmgn_activity_feed
        WHERE feed_type = ?
        ORDER BY tx_timestamp DESC
    `).all(feedType);

}

// Retention: the Intelligence Engine (via findAllByType) only ever
// needs recent activity - old trades stop influencing any live
// recommendation long before `maxAgeHours` (the smart-money/KOL
// participant modules only look at whether *recent* activity exists),
// so pruning older rows keeps this genuinely append-only table from
// growing forever without losing anything a current recommendation
// depends on.

function pruneOlderThan(maxAgeHours){

    const info = db.prepare(`
        DELETE FROM gmgn_activity_feed
        WHERE datetime(collected_at) < datetime('now', '-' || ? || ' hours')
    `).run(maxAgeHours);

    return info.changes;

}

module.exports = { insertEntries, findByType, countByType, findByToken, findAllByType, pruneOlderThan };
