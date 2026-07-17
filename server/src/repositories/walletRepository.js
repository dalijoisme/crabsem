// repositories/walletRepository.js - the only place that reads/
// writes the `wallets` table (current aggregate state per wallet).
// History of how these numbers changed over time lives in
// wallet_score_history / wallet_daily_snapshot, never overwritten.

const db = require("../database/connection");

function upsertWallet(w){

    db.prepare(`
        INSERT INTO wallets (
            wallet_address, chain, first_seen, last_seen,
            source_kol, source_smart_money, source_dev_wallet, source_top_trader,
            updated_at
        ) VALUES (
            @walletAddress, @chain, @firstSeen, @lastSeen,
            @sourceKol, @sourceSmartMoney, @sourceDevWallet, @sourceTopTrader,
            CURRENT_TIMESTAMP
        )
        ON CONFLICT(wallet_address) DO UPDATE SET
            -- Plain MIN()/MAX() here (SQLite's 2-arg scalar form, not
            -- the aggregate) returns NULL if EITHER side is NULL -
            -- would silently wipe a real first_seen/last_seen every
            -- time a dev-wallet registration (which has no real
            -- timestamp) touches an address that already has one.
            first_seen = CASE
                WHEN first_seen IS NULL THEN excluded.first_seen
                WHEN excluded.first_seen IS NULL THEN first_seen
                ELSE MIN(first_seen, excluded.first_seen)
            END,
            last_seen = CASE
                WHEN last_seen IS NULL THEN excluded.last_seen
                WHEN excluded.last_seen IS NULL THEN last_seen
                ELSE MAX(last_seen, excluded.last_seen)
            END,
            source_kol = MAX(source_kol, excluded.source_kol),
            source_smart_money = MAX(source_smart_money, excluded.source_smart_money),
            source_dev_wallet = MAX(source_dev_wallet, excluded.source_dev_wallet),
            source_top_trader = MAX(source_top_trader, excluded.source_top_trader),
            updated_at = CURRENT_TIMESTAMP
    `).run(w);

}

function upsertManyWallets(wallets){

    const runMany = db.transaction((items) => { items.forEach(upsertWallet); });

    runMany(wallets);

    return wallets.length;

}

const updateStatsStmt = db.prepare(`
    UPDATE wallets SET
        total_trades = @totalTrades,
        buy_count = @buyCount,
        sell_count = @sellCount,
        closed_position_count = @closedPositionCount,
        open_position_count = @openPositionCount,
        win_count = @winCount,
        loss_count = @lossCount,
        win_rate = @winRate,
        avg_roi_pct = @avgRoiPct,
        median_roi_pct = @medianRoiPct,
        best_roi_pct = @bestRoiPct,
        worst_roi_pct = @worstRoiPct,
        avg_holding_seconds = @avgHoldingSeconds,
        avg_position_usd = @avgPositionUsd,
        realized_profit_usd = @realizedProfitUsd,
        largest_winner_usd = @largestWinnerUsd,
        largest_loser_usd = @largestLoserUsd,
        favorite_market_cap_band = @favoriteMarketCapBand,
        score = @score,
        confidence = @confidence,
        primary_label = @primaryLabel,
        risk_profile = @riskProfile,
        updated_at = CURRENT_TIMESTAMP
    WHERE wallet_address = @walletAddress
`);

function updateStats(stats){

    updateStatsStmt.run(stats);

}

function updateManyStats(statsList){

    const runMany = db.transaction((items) => { items.forEach(s => updateStatsStmt.run(s)); });

    runMany(statsList);

    return statsList.length;

}

function setGmgnStats(walletAddress, statsJson){

    db.prepare(`
        UPDATE wallets SET gmgn_stats_json = ?, gmgn_stats_fetched_at = CURRENT_TIMESTAMP
        WHERE wallet_address = ?
    `).run(JSON.stringify(statsJson), walletAddress);

}

function findByAddress(address){

    return db.prepare("SELECT * FROM wallets WHERE wallet_address = ?").get(address);

}

function findManyByAddresses(addresses){

    const map = new Map();

    if(!addresses.length) return map;

    const CHUNK = 400;

    for(let i = 0; i < addresses.length; i += CHUNK){

        const chunk = addresses.slice(i, i + CHUNK);

        const placeholders = chunk.map(() => "?").join(",");

        const rows = db.prepare(`SELECT * FROM wallets WHERE wallet_address IN (${placeholders})`).all(...chunk);

        rows.forEach(r => map.set(r.wallet_address, r));

    }

    return map;

}

// All wallets that have at least one closed position - the
// candidate set for stat recomputation (open-only wallets have
// nothing to score yet).

function findActiveWalletAddresses(minTrades = 1){

    return db.prepare(`
        SELECT wallet_address FROM wallets WHERE total_trades >= ?
    `).all(minTrades).map(r => r.wallet_address);

}

const SORTABLE_COLUMNS = [
    "score", "win_rate", "avg_roi_pct", "realized_profit_usd",
    "total_trades", "last_seen", "best_roi_pct"
];

function search({ minWinRate, minRoi, minTrades, label, limit = 50, sortColumn = "score", direction = "DESC" }){

    if(!SORTABLE_COLUMNS.includes(sortColumn)) sortColumn = "score";

    const dir = direction === "ASC" ? "ASC" : "DESC";

    const clauses = ["total_trades > 0"];

    const params = {};

    if(minWinRate != null){ clauses.push("win_rate >= @minWinRate"); params.minWinRate = minWinRate; }

    if(minRoi != null){ clauses.push("avg_roi_pct >= @minRoi"); params.minRoi = minRoi; }

    if(minTrades != null){ clauses.push("total_trades >= @minTrades"); params.minTrades = minTrades; }

    if(label){ clauses.push("primary_label = @label"); params.label = label; }

    const sql = `
        SELECT * FROM wallets
        WHERE ${clauses.join(" AND ")}
        ORDER BY ${sortColumn} ${dir} NULLS LAST
        LIMIT @limit
    `;

    return db.prepare(sql).all({ ...params, limit });

}

function countAll(){

    return db.prepare("SELECT COUNT(*) as count FROM wallets").get().count;

}

// Feature vectors for similarity - only wallets with enough real
// trades to have a meaningful profile (see walletSimilarityService.js).

function findFeatureVectors(minTrades = 3, limit = 3000){

    return db.prepare(`
        SELECT wallet_address, win_rate, avg_roi_pct, avg_holding_seconds,
               avg_position_usd, favorite_market_cap_band, primary_label
        FROM wallets
        WHERE total_trades >= ? AND win_rate IS NOT NULL
        ORDER BY total_trades DESC
        LIMIT ?
    `).all(minTrades, limit);

}

module.exports = {
    upsertWallet,
    upsertManyWallets,
    updateStats,
    updateManyStats,
    setGmgnStats,
    findByAddress,
    findManyByAddresses,
    findActiveWalletAddresses,
    search,
    countAll,
    findFeatureVectors
};
