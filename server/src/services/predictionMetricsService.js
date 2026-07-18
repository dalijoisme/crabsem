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
// to one recommendation tier, e.g. STRONG BUY)
// =====================================

function buildSummary({ recommendation } = {}){

    const statusCounts = predictionHistoryRepository.countsByStatus({ recommendation });

    const countByStatus = Object.fromEntries(statusCounts.map(r => [r.status, r.count]));

    const openCount = countByStatus.OPEN || 0;

    const tpCount = countByStatus.TP_HIT || 0;

    const slCount = countByStatus.SL_HIT || 0;

    const expiredCount = countByStatus.EXPIRED || 0;

    const totalCount = openCount + tpCount + slCount + expiredCount;

    const closedCount = tpCount + slCount + expiredCount;

    const closed = predictionHistoryRepository.findClosed({ recommendation });

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

function getSummary(){

    return buildSummary({});

}

function getStrongBuySummary(){

    return buildSummary({ recommendation: "STRONG BUY" });

}

// =====================================
// HISTORY (Part 5 - raw evidence list)
// =====================================

function getHistory({ status, recommendation, limit = 50, offset = 0 } = {}){

    const rows = predictionHistoryRepository.findMany({ status, recommendation, limit, offset });

    const total = predictionHistoryRepository.countMany({ status, recommendation });

    return {

        predictions: rows.map(parseRow),

        pagination: { limit, offset, total }

    };

}

// =====================================
// STATISTICS (Part 4 detail + Part 7 confidence calibration + Part 6
// failure-reason breakdown)
// =====================================

function getStatistics(){

    const closed = predictionHistoryRepository.findClosed({});

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

        overall: buildSummary({})

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
