// repositories/walletScoreHistoryRepository.js - append-only log of
// every wallet score/label recomputation. Never overwritten - this is
// what makes wallet rankings/timelines/DNA-over-time real and
// queryable instead of only ever showing "now".

const db = require("../database/connection");

const insertStmt = db.prepare(`
    INSERT INTO wallet_score_history (
        wallet_address, score, win_rate, avg_roi_pct, primary_label, risk_profile, total_trades
    ) VALUES (
        @walletAddress, @score, @winRate, @avgRoiPct, @primaryLabel, @riskProfile, @totalTrades
    )
`);

function insertMany(entries){

    const runMany = db.transaction((items) => { items.forEach(e => insertStmt.run(e)); });

    runMany(entries);

    return entries.length;

}

function findByWallet(walletAddress, limit = 100){

    return db.prepare(`
        SELECT * FROM wallet_score_history
        WHERE wallet_address = ?
        ORDER BY computed_at DESC
        LIMIT ?
    `).all(walletAddress, limit);

}

module.exports = { insertMany, findByWallet };
