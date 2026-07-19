// repositories/engineDailyMetricsRepository.js - the only place that
// reads/writes engine_daily_metrics (Learn System, migration 013).
// One real row per real UTC calendar day - upsertToday() overwrites
// TODAY's row every time it's called (same convention as
// walletDailySnapshotRepository.upsertMany()); a day once closed (any
// earlier metric_date) is never rewritten.

const db = require("../database/connection");

const upsertStmt = db.prepare(`
    INSERT INTO engine_daily_metrics (
        metric_date, prediction_count, win_rate, average_roi_pct,
        tp_count, sl_count, expired_count, open_count,
        strong_buy_accuracy, buy_accuracy, hold_accuracy, avoid_accuracy,
        best_wallet_category, best_wallet_category_win_rate,
        worst_wallet_category, worst_wallet_category_win_rate,
        most_profitable_token_pattern, most_dangerous_token_pattern,
        confidence_health_status, computed_at
    ) VALUES (
        @metricDate, @predictionCount, @winRate, @averageRoiPct,
        @tpCount, @slCount, @expiredCount, @openCount,
        @strongBuyAccuracy, @buyAccuracy, @holdAccuracy, @avoidAccuracy,
        @bestWalletCategory, @bestWalletCategoryWinRate,
        @worstWalletCategory, @worstWalletCategoryWinRate,
        @mostProfitableTokenPattern, @mostDangerousTokenPattern,
        @confidenceHealthStatus, CURRENT_TIMESTAMP
    )
    ON CONFLICT(metric_date) DO UPDATE SET
        prediction_count = excluded.prediction_count,
        win_rate = excluded.win_rate,
        average_roi_pct = excluded.average_roi_pct,
        tp_count = excluded.tp_count,
        sl_count = excluded.sl_count,
        expired_count = excluded.expired_count,
        open_count = excluded.open_count,
        strong_buy_accuracy = excluded.strong_buy_accuracy,
        buy_accuracy = excluded.buy_accuracy,
        hold_accuracy = excluded.hold_accuracy,
        avoid_accuracy = excluded.avoid_accuracy,
        best_wallet_category = excluded.best_wallet_category,
        best_wallet_category_win_rate = excluded.best_wallet_category_win_rate,
        worst_wallet_category = excluded.worst_wallet_category,
        worst_wallet_category_win_rate = excluded.worst_wallet_category_win_rate,
        most_profitable_token_pattern = excluded.most_profitable_token_pattern,
        most_dangerous_token_pattern = excluded.most_dangerous_token_pattern,
        confidence_health_status = excluded.confidence_health_status,
        computed_at = CURRENT_TIMESTAMP
`);

function upsertToday(row){

    upsertStmt.run(row);

}

function findRecent(limit = 30){

    return db.prepare(`
        SELECT * FROM engine_daily_metrics
        ORDER BY metric_date DESC
        LIMIT ?
    `).all(limit);

}

function countAll(){

    return db.prepare("SELECT COUNT(*) as count FROM engine_daily_metrics").get().count;

}

module.exports = { upsertToday, findRecent, countAll };
