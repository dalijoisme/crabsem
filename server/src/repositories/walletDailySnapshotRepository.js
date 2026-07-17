// repositories/walletDailySnapshotRepository.js - one row per wallet
// per UTC calendar day, upserted only for the CURRENT day (a closed-
// out past day is never rewritten, since the query used to build
// today's snapshot only looks at today's data).

const db = require("../database/connection");

const upsertStmt = db.prepare(`
    INSERT INTO wallet_daily_snapshot (wallet_address, snapshot_date, trades_count, realized_profit_usd, win_rate, score)
    VALUES (@walletAddress, @snapshotDate, @tradesCount, @realizedProfitUsd, @winRate, @score)
    ON CONFLICT(wallet_address, snapshot_date) DO UPDATE SET
        trades_count = excluded.trades_count,
        realized_profit_usd = excluded.realized_profit_usd,
        win_rate = excluded.win_rate,
        score = excluded.score
`);

function upsertMany(entries){

    const runMany = db.transaction((items) => { items.forEach(e => upsertStmt.run(e)); });

    runMany(entries);

    return entries.length;

}

function findByWallet(walletAddress, days = 30){

    return db.prepare(`
        SELECT * FROM wallet_daily_snapshot
        WHERE wallet_address = ?
        ORDER BY snapshot_date DESC
        LIMIT ?
    `).all(walletAddress, days);

}

module.exports = { upsertMany, findByWallet };
