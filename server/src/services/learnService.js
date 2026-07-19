// services/learnService.js - the Learn System (Product Improvement
// Sprint, Part 7). The engine must continuously learn from its own
// real prediction history: recordDailySnapshot() computes TODAY's real
// stats (via predictionMetricsService/ceoDashboardService - the exact
// same real functions the rest of the dashboard already uses) and
// upserts one row into engine_daily_metrics; getLearnSummary() reads
// that real, growing history back and derives day-over-day deltas.
//
// HONESTY CONSTRAINT (repeatedly enforced across this whole project):
// this table starts empty and grows one real row per real day from
// whenever this code first runs - it is NEVER backfilled with invented
// history. getLearnSummary() explicitly reports "not enough historical
// data yet" whenever fewer than 2 real days exist, rather than
// computing a delta against a day that was never actually recorded.

const predictionMetricsService = require("./predictionMetricsService");
const ceoDashboardService = require("./ceoDashboardService");
const engineDailyMetricsRepository = require("../repositories/engineDailyMetricsRepository");

function todayUtc(){

    return new Date().toISOString().slice(0, 10);

}

function recordDailySnapshot(){

    const today = todayUtc();

    const stats = predictionMetricsService.getStatistics({ from: today, to: today });

    const summary = stats.overall;

    const tierByName = name => stats.accuracyByTier.find(t => t.recommendation === name) || {};

    engineDailyMetricsRepository.upsertToday({

        metricDate: today,

        predictionCount: summary.predictionCount,
        winRate: summary.winRate,
        averageRoiPct: summary.averageRoiPct,
        tpCount: summary.tpCount,
        slCount: summary.slCount,
        expiredCount: summary.expiredCount,
        openCount: summary.openCount,

        strongBuyAccuracy: tierByName("STRONG BUY").accuracy ?? null,
        buyAccuracy: tierByName("BUY").accuracy ?? null,
        holdAccuracy: tierByName("HOLD").accuracy ?? null,
        avoidAccuracy: tierByName("AVOID").accuracy ?? null,

        bestWalletCategory: stats.bestWalletCategory?.key ?? null,
        bestWalletCategoryWinRate: stats.bestWalletCategory?.winRate ?? null,
        worstWalletCategory: stats.worstWalletCategory?.key ?? null,
        worstWalletCategoryWinRate: stats.worstWalletCategory?.winRate ?? null,

        mostProfitableTokenPattern: stats.mostProfitableTokenPattern?.key ?? null,
        mostDangerousTokenPattern: stats.mostDangerousTokenPattern?.key ?? null,

        confidenceHealthStatus: ceoDashboardService.getConfidenceHealth(stats.confidenceCalibration).status

    });

}

function pctPointDelta(current, previous){

    if(current == null || previous == null) return null;

    return (current - previous) * 100;

}

function describeDelta(label, delta, unit = "pp"){

    if(delta == null) return null;

    const dir = delta > 0.05 ? "improved" : (delta < -0.05 ? "worsened" : "held steady");

    return { label, dir, delta: `${delta > 0 ? "+" : ""}${delta.toFixed(1)}${unit}` };

}

function getLearnSummary(){

    const history = engineDailyMetricsRepository.findRecent(30);

    if(history.length < 2){

        return {

            available: false,

            realDaysRecorded: history.length,

            reason: history.length === 0

                ? "The Learn System started recording today - no real daily history exists yet. Check back tomorrow for the first real day-over-day comparison."

                : `Only ${history.length} real day of history has been recorded so far - at least 2 real days are needed for any day-over-day comparison.`,

            history

        };

    }

    // history is DESC by metric_date - [0] is the most recent real day,
    // [1] is the real day before it. This is a real, adjacent-day
    // comparison, never a fabricated "7 days" when only 2 real days
    // exist - the caller decides how to label the window based on
    // realDaysRecorded.

    const latest = history[0];

    const previous = history[1];

    const whatImproved = [];

    const whatWorsened = [];

    const tierDeltas = [

        { key: "strong_buy_accuracy", label: "Strong Buy accuracy" },
        { key: "buy_accuracy", label: "Buy accuracy" },
        { key: "hold_accuracy", label: "Hold accuracy" },
        { key: "avoid_accuracy", label: "Avoid accuracy" }

    ];

    tierDeltas.forEach(({ key, label }) => {

        const delta = pctPointDelta(latest[key], previous[key]);

        const described = describeDelta(label, delta);

        if(!described) return;

        if(described.dir === "improved") whatImproved.push(described);

        if(described.dir === "worsened") whatWorsened.push(described);

    });

    const overallWinRateDelta = pctPointDelta(latest.win_rate, previous.win_rate);

    const roiDelta = (latest.average_roi_pct != null && previous.average_roi_pct != null) ? latest.average_roi_pct - previous.average_roi_pct : null;

    return {

        available: true,

        realDaysRecorded: history.length,

        latestDate: latest.metric_date,

        previousDate: previous.metric_date,

        overallWinRateDelta,

        averageRoiDelta: roiDelta,

        whatImproved,

        whatWorsened,

        walletCategoryChange: (latest.best_wallet_category && previous.best_wallet_category && latest.best_wallet_category !== previous.best_wallet_category)

            ? `Best-performing wallet category changed from ${previous.best_wallet_category} to ${latest.best_wallet_category}.`

            : null,

        tokenPatternChange: (latest.most_dangerous_token_pattern && previous.most_dangerous_token_pattern && latest.most_dangerous_token_pattern !== previous.most_dangerous_token_pattern)

            ? `The most-failing token pattern changed from ${previous.most_dangerous_token_pattern} to ${latest.most_dangerous_token_pattern}.`

            : null,

        confidenceHealthChange: (latest.confidence_health_status && previous.confidence_health_status && latest.confidence_health_status !== previous.confidence_health_status)

            ? `Confidence calibration health changed from "${previous.confidence_health_status}" to "${latest.confidence_health_status}".`

            : null,

        history: history.map(h => ({

            date: h.metric_date,
            predictionCount: h.prediction_count,
            winRate: h.win_rate,
            averageRoiPct: h.average_roi_pct,
            bestWalletCategory: h.best_wallet_category,
            worstWalletCategory: h.worst_wallet_category,
            confidenceHealthStatus: h.confidence_health_status

        }))

    };

}

module.exports = { recordDailySnapshot, getLearnSummary };
