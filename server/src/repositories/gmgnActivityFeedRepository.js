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
        SELECT id, feed_type, transaction_hash, maker_address, maker_tags,
               maker_twitter, side, amount_usd, price_usd, tx_timestamp
        FROM gmgn_activity_feed
        WHERE token_address = ? AND feed_type = ?
        ORDER BY tx_timestamp DESC
        LIMIT ?
    `).all(tokenAddress, feedType, limit);

}

module.exports = { insertEntries, findByType, countByType, findByToken };
