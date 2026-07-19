// services/predictionMetricsService.js - read-only aggregation over
// prediction_history/prediction_timeline (Part 4/5/7 of the engine-
// quality sprint 3 brief). Every number is computed from real,
// already-stored rows - nothing here tunes or touches the engine, and
// nothing is reported when the sample is empty (null/[] instead of a
// fabricated 0%/average).

const config = require("../config/predictionValidationConfig");
const predictionHistoryRepository = require("../repositories/predictionHistoryRepository");
const predictionTimelineRepository = require("../repositories/predictionTimelineRepository");
const dateRange = require("../utils/dateRange");

// Real market-cap bands (CEO Dashboard Section 7 - "token patterns
// causing losses") - the same bucket boundaries walletIntelligence
// Config.js already uses for a wallet's favorite_market_cap_band, so
// "micro/small/mid/large" means the same real thing everywhere in
// this codebase, not a second, inconsistent definition.

const MARKET_CAP_BANDS = [
    { max: 100000, label: "Micro (<$100K)" },
    { max: 1000000, label: "Small ($100K-$1M)" },
    { max: 10000000, label: "Mid ($1M-$10M)" },
    { max: Infinity, label: "Large (>$10M)" }
];

function marketCapBandFor(marketCap){

    if(marketCap == null) return "Unknown";

    const band = MARKET_CAP_BANDS.find(b => marketCap <= b.max);

    return band ? band.label : "Unknown";

}

// Real, derived-from-stored-data wallet category for a prediction
// (CEO Dashboard Section 7 - "wallet category causing losses") - uses
// the same wallet_summary_json every prediction already carries
// (smartMoneyWalletCount/kolWalletCount/devWalletIdentified), never a
// second lookup.

function walletCategoryFor(prediction){

    const summary = safeParse(prediction.wallet_summary_json);

    if(!summary) return "No Wallet Data";

    if(summary.smartMoneyWalletCount > 0 && summary.smartMoneyWalletCount >= (summary.kolWalletCount || 0)) return "Smart Money";

    if(summary.kolWalletCount > 0) return "KOL";

    if(summary.devWalletIdentified) return "Developer";

    return "No Wallet Signal";

}

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

    // Admin V3.1 fix (Part 9): Confidence Calibration must show real
    // Expired/Open counts alongside TP/SL, which means bucketing over
    // EVERY status, not just closed ones - `closed` above stays the
    // real source for every other statistic in this function (failure/
    // win analysis, wallet/token pattern performance), none of which
    // make sense for a still-OPEN prediction.

    const allForCalibration = predictionHistoryRepository.findAllStatuses({ from, to });

    const confidenceBuckets = config.confidenceBuckets.map(bucket => {

        const inBucket = allForCalibration.filter(p => p.confidence != null && p.confidence >= bucket.min && p.confidence < bucket.max);

        const tp = inBucket.filter(p => p.status === "TP_HIT").length;

        const sl = inBucket.filter(p => p.status === "SL_HIT").length;

        const expired = inBucket.filter(p => p.status === "EXPIRED").length;

        const open = inBucket.filter(p => p.status === "OPEN").length;

        const closedInBucket = tp + sl + expired;

        const rois = inBucket.filter(p => p.status !== "OPEN").map(p => p.current_roi_pct).filter(v => v != null);

        return {

            label: bucket.label,

            predictionCount: inBucket.length,

            tpCount: tp,

            slCount: sl,

            expiredCount: expired,

            openCount: open,

            winRate: closedInBucket ? tp / closedInBucket : null,

            averageRoiPct: mean(rois)

        };

    });

    const losses = closed.filter(p => p.status !== "TP_HIT");

    const wins = closed.filter(p => p.status === "TP_HIT");

    const failureRows = losses.filter(p => p.close_reason);

    const failureCounts = {};

    failureRows.forEach(p => { failureCounts[p.close_reason] = (failureCounts[p.close_reason] || 0) + 1; });

    const winReasonRows = wins.filter(p => p.close_reason);

    const winReasonCounts = {};

    winReasonRows.forEach(p => { winReasonCounts[p.close_reason] = (winReasonCounts[p.close_reason] || 0) + 1; });

    const walletCategoryLossCounts = {};

    losses.forEach(p => { const c = walletCategoryFor(p); walletCategoryLossCounts[c] = (walletCategoryLossCounts[c] || 0) + 1; });

    const tokenPatternLossCounts = {};

    losses.forEach(p => { const band = marketCapBandFor(p.entry_market_cap); tokenPatternLossCounts[band] = (tokenPatternLossCounts[band] || 0) + 1; });

    const failureAnalysis = Object.entries(failureCounts).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);

    const winAnalysis = Object.entries(winReasonCounts).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);

    // Additive (Admin V3) - WIN RATE per wallet category / token
    // pattern across ALL closed predictions (not just losses), so
    // "best"/"worst" can be derived from a real rate, not just a raw
    // loss count. Requires a real minimum sample (5) before a category
    // is ranked at all - a 1-prediction "100% win rate" category is
    // noise, not a real best performer.

    const MIN_SAMPLE = 5;

    function performanceByGroup(rows, groupFn){

        const groups = {};

        rows.forEach(p => {

            const key = groupFn(p);

            if(!groups[key]) groups[key] = [];

            groups[key].push(p);

        });

        return Object.entries(groups).map(([key, groupRows]) => {

            const tp = groupRows.filter(p => p.status === "TP_HIT").length;

            const rois = groupRows.map(p => p.current_roi_pct).filter(v => v != null);

            return {

                key,

                sampleSize: groupRows.length,

                winRate: groupRows.length ? tp / groupRows.length : null,

                averageRoiPct: mean(rois)

            };

        });

    }

    const walletCategoryPerformance = performanceByGroup(closed, walletCategoryFor);

    const tokenPatternPerformance = performanceByGroup(closed, p => marketCapBandFor(p.entry_market_cap));

    const rankedWalletCategories = walletCategoryPerformance.filter(g => g.sampleSize >= MIN_SAMPLE && g.winRate != null).sort((a, b) => b.winRate - a.winRate);

    const rankedTokenPatterns = tokenPatternPerformance.filter(g => g.sampleSize >= MIN_SAMPLE && g.winRate != null).sort((a, b) => b.winRate - a.winRate);

    return {

        confidenceCalibration: confidenceBuckets,

        failureAnalysis,

        winAnalysis,

        mostCommonLosingReason: failureAnalysis[0] || null,

        mostCommonWinningReason: winAnalysis[0] || null,

        walletCategoryLosses: Object.entries(walletCategoryLossCounts).map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),

        tokenPatternLosses: Object.entries(tokenPatternLossCounts).map(([pattern, count]) => ({ pattern, count })).sort((a, b) => b.count - a.count),

        // Additive (Admin V3) - real win-rate-ranked performance, and
        // the best/worst derived from it. null when no group has the
        // minimum real sample size yet - never a guessed "best".
        walletCategoryPerformance,

        tokenPatternPerformance,

        bestWalletCategory: rankedWalletCategories[0] || null,

        worstWalletCategory: rankedWalletCategories[rankedWalletCategories.length - 1] || null,

        mostProfitableTokenPattern: rankedTokenPatterns[0] || null,

        mostDangerousTokenPattern: rankedTokenPatterns[rankedTokenPatterns.length - 1] || null,

        accuracyByTier: accuracyByTier(closed),

        ...falseAndMissedBuy(closed),

        overall: buildSummary({ from, to })

    };

}

// =====================================
// SIGNAL SUMMARY (CEO Dashboard Section 3) - count + percentage per
// recommendation tier for the selected period, plus a real trend
// against the immediately preceding period of the same length (see
// utils/dateRange.js). Trend is null (never a fabricated 0) whenever
// there's no comparable previous period (All Time, or an open-ended
// range with only one of from/to set).
// =====================================

function getSignalSummary({ from, to } = {}){

    const counts = predictionHistoryRepository.countsByRecommendation({ from, to });

    const countByTier = Object.fromEntries(counts.map(r => [r.recommendation, r.count]));

    const total = Object.values(countByTier).reduce((a, b) => a + b, 0);

    const previousRange = dateRange.computePreviousPeriod({ from, to });

    const prevCountByTier = previousRange

        ? Object.fromEntries(predictionHistoryRepository.countsByRecommendation(previousRange).map(r => [r.recommendation, r.count]))

        : null;

    const tiers = ["STRONG BUY", "BUY", "HOLD", "AVOID"];

    return {

        total,

        previousPeriod: previousRange,

        tiers: tiers.map(tier => {

            const count = countByTier[tier] || 0;

            const previousCount = prevCountByTier ? (prevCountByTier[tier] || 0) : null;

            return {

                recommendation: tier,

                count,

                percentage: total > 0 ? count / total : null,

                previousCount,

                trendCount: previousCount != null ? count - previousCount : null,

                trendPct: (previousCount != null && previousCount > 0) ? ((count - previousCount) / previousCount) : null

            };

        })

    };

}

// Prediction Timeline for one prediction (Part 8) - exposed via
// /validation/predictions/history?includeTimeline or its own lookup;
// kept as a plain export so the controller can attach it per-row when
// asked.

function getTimeline(predictionId){

    return predictionTimelineRepository.findByPrediction(predictionId);

}

module.exports = { getSummary, getStrongBuySummary, getHistory, getStatistics, getTimeline, getSignalSummary };
