// repositories/dailyReviewRepository.js - the only place that reads/
// writes daily_trading_reviews (migration 068, Arjuna V4 Phase 2). Global
// (not user-scoped), same precedent engine_daily_metrics
// (engineDailyMetricsRepository.js) already establishes for an "engine
// health" table - one real row per real UTC calendar day, upserted.
//
// findTradesClosedOnDate queries trading_bot_trades DIRECTLY (rather than
// going through tradingBotRepository.js's heavily per-user/forUser(userId)
// surface) because the Daily Trading Review is deliberately global across
// every user's trades, the same scope engine_daily_metrics already uses -
// adding a global query here keeps tradingBotRepository.js itself
// completely untouched by this sprint.

const db = require("../database/connection");

// Every real trade CLOSED on the given UTC calendar day ("YYYY-MM-DD"),
// across every user - closed_at is the real moment the trade was decided
// (see tradingBotRepository.js's own insertTradeStmt), so this is "what
// finished today", not "what opened today".
function findTradesClosedOnDate(dateStr){

    return db.prepare(`
        SELECT * FROM trading_bot_trades
        WHERE date(closed_at) = date(?)
        ORDER BY closed_at ASC
    `).all(dateStr);

}

const upsertStmt = db.prepare(`
    INSERT INTO daily_trading_reviews (
        review_date, total_trades, win_count, loss_count, win_rate, net_profit_usd,
        average_roi_pct, average_mfe_pct, average_mae_pct, average_holding_seconds, report_json
    ) VALUES (
        @reviewDate, @totalTrades, @winCount, @lossCount, @winRate, @netProfitUsd,
        @averageRoiPct, @averageMfePct, @averageMaePct, @averageHoldingSeconds, @reportJson
    )
    ON CONFLICT(review_date) DO UPDATE SET
        total_trades = excluded.total_trades,
        win_count = excluded.win_count,
        loss_count = excluded.loss_count,
        win_rate = excluded.win_rate,
        net_profit_usd = excluded.net_profit_usd,
        average_roi_pct = excluded.average_roi_pct,
        average_mfe_pct = excluded.average_mfe_pct,
        average_mae_pct = excluded.average_mae_pct,
        average_holding_seconds = excluded.average_holding_seconds,
        report_json = excluded.report_json,
        computed_at = CURRENT_TIMESTAMP
`);

// Idempotent, safe to re-run for the same day (e.g. a delayed/retried
// scheduler tick) - same upsert-per-day convention engine_daily_metrics'
// own upsertToday() already uses.
function upsertReview(row){
    upsertStmt.run(row);
}

function findByDate(dateStr){
    return db.prepare("SELECT * FROM daily_trading_reviews WHERE review_date = date(?)").get(dateStr) ?? null;
}

function findRecent(limit = 30){
    return db.prepare("SELECT * FROM daily_trading_reviews ORDER BY review_date DESC LIMIT ?").all(limit);
}

function countAll(){
    return db.prepare("SELECT COUNT(*) as count FROM daily_trading_reviews").get().count;
}

module.exports = { findTradesClosedOnDate, upsertReview, findByDate, findRecent, countAll };
