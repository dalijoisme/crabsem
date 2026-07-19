// repositories/walletTradePositionRepository.js - the only place
// that reads/writes wallet_trade_positions (real matched buy->sell
// round trips, derived from gmgn_activity_feed - see
// services/walletLedgerService.js). Never mutates a CLOSED position -
// only ever opens a new one or closes an open one exactly once.

const db = require("../database/connection");

const insertOpenStmt = db.prepare(`
    INSERT INTO wallet_trade_positions (
        wallet_address, token_address, token_symbol,
        entry_time, entry_price, entry_market_cap, entry_amount_usd,
        status, entry_activity_id
    ) VALUES (
        @walletAddress, @tokenAddress, @tokenSymbol,
        @entryTime, @entryPrice, @entryMarketCap, @entryAmountUsd,
        'open', @entryActivityId
    )
`);

function openPosition(p){

    const info = insertOpenStmt.run(p);

    return info.lastInsertRowid;

}

const closeStmt = db.prepare(`
    UPDATE wallet_trade_positions SET
        exit_time = @exitTime,
        exit_price = @exitPrice,
        exit_market_cap = @exitMarketCap,
        exit_amount_usd = @exitAmountUsd,
        holding_seconds = @holdingSeconds,
        roi_pct = @roiPct,
        profit_usd = @profitUsd,
        status = 'closed',
        exit_activity_id = @exitActivityId
    WHERE id = @id AND status = 'open'
`);

function closePosition(p){

    return closeStmt.run(p).changes;

}

// The oldest still-open position for a wallet+token (FIFO matching -
// a sell closes the earliest open buy first, the standard convention
// for position accounting when order size isn't split/tracked here).

function findOldestOpenPosition(walletAddress, tokenAddress){

    return db.prepare(`
        SELECT * FROM wallet_trade_positions
        WHERE wallet_address = ? AND token_address = ? AND status = 'open'
        ORDER BY entry_time ASC
        LIMIT 1
    `).get(walletAddress, tokenAddress);

}

function findClosedByWallet(walletAddress, limit = 200){

    return db.prepare(`
        SELECT * FROM wallet_trade_positions
        WHERE wallet_address = ? AND status = 'closed'
        ORDER BY exit_time DESC
        LIMIT ?
    `).all(walletAddress, limit);

}

function findByWallet(walletAddress, limit = 200){

    return db.prepare(`
        SELECT * FROM wallet_trade_positions
        WHERE wallet_address = ?
        ORDER BY entry_time DESC
        LIMIT ?
    `).all(walletAddress, limit);

}

function countByWallet(walletAddress){

    return db.prepare("SELECT COUNT(*) as count FROM wallet_trade_positions WHERE wallet_address = ?").get(walletAddress).count;

}

// Wallet Detail panel (Product Improvement Sprint, Part 4) - "Best
// Trade"/"Worst Trade" are real, individual closed positions (ranked
// by their own real roi_pct), not an invented summary stat.

function findBestTrade(walletAddress){

    return db.prepare(`
        SELECT * FROM wallet_trade_positions
        WHERE wallet_address = ? AND status = 'closed' AND roi_pct IS NOT NULL
        ORDER BY roi_pct DESC
        LIMIT 1
    `).get(walletAddress);

}

function findWorstTrade(walletAddress){

    return db.prepare(`
        SELECT * FROM wallet_trade_positions
        WHERE wallet_address = ? AND status = 'closed' AND roi_pct IS NOT NULL
        ORDER BY roi_pct ASC
        LIMIT 1
    `).get(walletAddress);

}

// Real still-open positions (Part 4's "Current Holdings") - this row
// itself carries no live price (see the schema doc comment at the top
// of this file); walletQueryService.getProfile() joins each one
// against gmgn_tokens' own last-scanned price to compute a real,
// last-known (not truly live) unrealized value.

function findOpenByWallet(walletAddress, limit = 50){

    return db.prepare(`
        SELECT * FROM wallet_trade_positions
        WHERE wallet_address = ? AND status = 'open'
        ORDER BY entry_time DESC
        LIMIT ?
    `).all(walletAddress, limit);

}

// The highest activity_feed row id already matched into a position -
// lets the ledger builder resume from where it left off instead of
// rescanning the whole activity feed every run.

function getMaxMatchedActivityId(){

    const row = db.prepare(`
        SELECT MAX(id) as maxId FROM (
            SELECT entry_activity_id as id FROM wallet_trade_positions WHERE entry_activity_id IS NOT NULL
            UNION ALL
            SELECT exit_activity_id as id FROM wallet_trade_positions WHERE exit_activity_id IS NOT NULL
        )
    `).get();

    return row?.maxId ?? 0;

}

module.exports = {
    openPosition,
    closePosition,
    findOldestOpenPosition,
    findClosedByWallet,
    findByWallet,
    findOpenByWallet,
    findBestTrade,
    findWorstTrade,
    countByWallet,
    getMaxMatchedActivityId
};
