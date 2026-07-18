// services/predictionMetricsService.js - read-only aggregation over
// prediction_history/prediction_timeline (Part 4/5/7 of the engine-
// quality sprint 3 brief). Every number is computed from real,
// already-stored rows - nothing here tunes or touches the engine, and
// nothing is reported when the sample is empty (null/[] instead of a
// fabricated 0%/average).

const config = require("../config/predictionValidationConfig");
const predictionHistoryRepository = require("../repositories/predictionHistoryRepository");
const predictionTimelineRepository = require("../repositories/predictionTimelineRepository");

function mean(nums){ return nums.length ? nums.reduce((a,b)=>a+b,0) / nums.length : null; }

function median(nums){

    if(!nums.length) return null;

    const sorted = [...nums].sort((a,b)=>a-b);

    const mid = Math.floor(sorted.length/2);

    return sorted.length % 2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;

}

function parseRow(row){

    return {

        ...row,

        reasons: safeParse(row.reason_json),

        walletSummary: safeParse(row.wallet_summary_json),

        tradePlan: safeParse(row.trade_plan_json)

    };

}

function safeParse(json){

    if(!json) return null;

    try{ return JSON.parse(json); }
    catch(e){ return null; }

}

// =====================================
// SUMMARY (Part 4/5 - overall headline metrics, optionally filtered
// to one recommendation tier, e.g. STRONG BUY, AND/OR a real date
// range - Admin Date Filter, UX sprint Part 2. `from`/`to` are real
// "YYYY-MM-DD" strings compared against the immutable prediction_time
// column; omitting both means "All Time", exactly as before.)
// =====================================

function buildSummary({ recommendation, from, to } = {}){

    const statusCounts = predictionHistoryRepository.countsByStatus({ recommendation, from, to });

    const countByStatus = Object.fromEntries(statusCounts.map(r => [r.status, r.count]));

    const openCount = countByStatus.OPEN || 0;

    const tpCount = countByStatus.TP_HIT || 0;

    const slCount = countByStatus.SL_HIT || 0;

    const expiredCount = countByStatus.EXPIRED || 0;

    const totalCount = openCount + tpCount + slCount + expiredCount;

    const closedCount = tpCount + slCount + expiredCount;

    const closed = predictionHistoryRepository.findClosed({ recommendation, from, to });

    const rois = closed.map(p => p.current_roi_pct).filter(v => v != null);

    const tpRows = closed.filter(p => p.status === "TP_HIT");

    const slRows = closed.filter(p => p.status === "SL_HIT");

    const tpTimes = tpRows.map(p => p.time_alive_seconds).filter(v => v != null);

    const slTimes = slRows.map(p => p.time_alive_seconds).filter(v => v != null);

    const mfes = closed.map(p => p.mfe_pct).filter(v => v != null);

    const maes = closed.map(p => p.mae_pct).filter(v => v != null);

    return {

        predictionCount: totalCount,

        openCount,

        tpCount,

        slCount,

        expiredCount,

        winRate: closedCount > 0 ? tpCount / closedCount : null,

        averageRoiPct: mean(rois),

        medianRoiPct: median(rois),

        largestWinnerPct: rois.length ? Math.max(...rois) : null,

        largestLoserPct: rois.length ? Math.min(...rois) : null,

        averageTimeToTpSeconds: mean(tpTimes),

        medianTimeToTpSeconds: median(tpTimes),

        averageTimeToSlSeconds: mean(slTimes),

        medianTimeToSlSeconds: median(slTimes),

        averageMfePct: mean(mfes),

        averageMaePct: mean(maes)

    };

}

function getSummary({ from, to } = {}){

    return buildSummary({ from, to });

}

function getStrongBuySummary({ from, to } = {}){

    return buildSummary({ recommendation: "STRONG BUY", from, to });

}

// =====================================
// HISTORY (Part 5 - raw evidence list, date-filterable)
// =====================================

function getHistory({ status, recommendation, from, to, limit = 50, offset = 0 } = {}){

    const rows = predictionHistoryRepository.findMany({ status, recommendation, from, to, limit, offset });

    const total = predictionHistoryRepository.countMany({ status, recommendation, from, to });

    return {

        predictions: rows.map(parseRow),

        pagination: { limit, offset, total }

    };

}

// Real per-recommendation-tier accuracy (Part 2's "Accuracy") - win
// rate within each of the engine's 4 real action tiers. This engine
// has no "SELL" tier; AVOID's own "win" is inverted (closing anywhere
// but TP_HIT is the expected/correct outcome for a token the engine
// said to avoid), so AVOID is reported as a distinct row, not folded
// into the same TP-rate definition as the BUY-tier rows.

function accuracyByTier(closed){

    const tiers = ["STRONG BUY", "BUY", "HOLD", "AVOID"];

    return tiers.map(tier => {

        const rows = closed.filter(p => p.recommendation === tier);

        if(!rows.length) return { recommendation: tier, sampleSize: 0, accuracy: null };

        const correct = tier === "AVOID"

            ? rows.filter(p => p.status !== "TP_HIT").length

            : rows.filter(p => p.status === "TP_HIT").length;

        return { recommendation: tier, sampleSize: rows.length, accuracy: correct / rows.length };

    });

}

// Real False BUY / Missed BUY counts (Part 2) over the NEW
// prediction_history framework - distinct from Sprint 2's
// recommendation_log-based confusionCounts (a different table, a
// different definition of "prediction"). False BUY: engine said
// STRONG BUY/BUY and it closed anything but TP_HIT. Missed BUY: engine
// said HOLD/AVOID and the token would have hit its own real target
// anyway (a real recorded TP_HIT on a non-BUY-tier row - this only
// happens because HOLD-tier tokens still get a real trade plan/
// prediction when the readiness gate passes; AVOID tokens never do,
// so AVOID can never appear here).

function falseAndMissedBuy(closed){

    const falseBuy = closed.filter(p => (p.recommendation === "STRONG BUY" || p.recommendation === "BUY") && p.status !== "TP_HIT").length;

    const missedBuy = closed.filter(p => p.recommendation === "HOLD" && p.status === "TP_HIT").length;

    return { falseBuyCount: falseBuy, missedBuyCount: missedBuy };

}

// =====================================
// STATISTICS (Part 4 detail + Part 7 confidence calibration + Part 6
// failure-reason breakdown + Part 2's Accuracy/False BUY/Missed BUY -
// all date-filterable)
// =====================================

function getStatistics({ from, to } = {}){

    const closed = predictionHistoryRepository.findClosed({ from, to });

    const confidenceBuckets = config.confidenceBuckets.map(bucket => {

        const inBucket = closed.filter(p => p.confidence != null && p.confidence >= bucket.min && p.confidence < bucket.max);

        const tp = inBucket.filter(p => p.status === "TP_HIT").length;

        const rois = inBucket.map(p => p.current_roi_pct).filter(v => v != null);

        return {

            label: bucket.label,

            predictionCount: inBucket.length,

            winRate: inBucket.length ? tp / inBucket.length : null,

            averageRoiPct: mean(rois)

        };

    });

    const failureRows = closed.filter(p => p.status !== "TP_HIT" && p.close_reason);

    const failureCounts = {};

    failureRows.forEach(p => { failureCounts[p.close_reason] = (failureCounts[p.close_reason] || 0) + 1; });

    return {

        confidenceCalibration: confidenceBuckets,

        failureAnalysis: Object.entries(failureCounts).map(([reason, count]) => ({ reason, count })),

        accuracyByTier: accuracyByTier(closed),

        ...falseAndMissedBuy(closed),

        overall: buildSummary({ from, to })

    };

}

// Prediction Timeline for one prediction (Part 8) - exposed via
// /validation/predictions/history?includeTimeline or its own lookup;
// kept as a plain export so the controller can attach it per-row when
// asked.

function getTimeline(predictionId){

    return predictionTimelineRepository.findByPrediction(predictionId);

}

module.exports = { getSummary, getStrongBuySummary, getHistory, getStatistics, getTimeline };
