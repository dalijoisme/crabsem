// services/ceoDashboardService.js - Admin Dashboard V2 ("CEO
// Dashboard"). Business-facing aggregation, deliberately separate
// from adminService.js (the engineering-facing dashboard, still
// intact and reachable) - this file answers "is the engine
// improving, are predictions making money, which wallets perform
// best, what should I improve next", not "how many database rows
// exist". Every number is a real read from data the rest of the
// system already computes; nothing here tunes the engine.
//
// HONEST WALLET CATEGORY MAPPING (Section 5): the brief asks for
// Smart Money/Whale/Sniper/KOL/Accumulation/Developer/Fresh Wallet/
// Retail. This schema's real, computed wallet identity
// (walletIntelligenceService.computeLabel()) only produces: Smart
// Money, Whale, Sniper, KOL Trader, Developer, Scalper, Swing Trader,
// Long Holder, Trader, Unproven. "Accumulation" is a per-TOKEN
// participant-score sub-category, not a wallet identity - it has no
// real wallet-level equivalent, and is NOT offered as a selectable
// category (fabricating one would fail this sprint's own core rule).
// "Fresh Wallet" IS given a real, honest definition here: total_trades
// <= 2 (same threshold intelligenceEngine.js's toGmgnStatsShape()
// already uses for its own "fresh_wallet" tag), not a stored label.
// "Retail" is mapped to the real "Trader" label (the catch-all
// non-specialist category computeLabel() already assigns) rather than
// invented as a second, redundant bucket.

const config = require("../config/engineVersion");
const adminService = require("./adminService");
const engineVersionService = require("./engineVersionService");
const predictionMetricsService = require("./predictionMetricsService");
const walletQueryService = require("./walletQueryService");

const WALLET_CATEGORIES = {

    "Smart Money": { label: "Smart Money" },
    "Whale": { label: "Whale" },
    "Sniper": { label: "Sniper" },
    "KOL": { label: "KOL Trader" },
    "Developer": { label: "Developer" },
    "Retail": { label: "Trader" },
    "Fresh Wallet": { maxTrades: 2 }

};

// =====================================
// SECTION 1 - ENGINE STATUS
// =====================================

function getEngineStatus(){

    const system = adminService.getSystem();

    return {

        engineVersion: config.version,

        engineVersionNotes: config.notes,

        // No separate trained ML model exists in this project (see
        // config/engineVersion.js) - the "AI Model Version" the brief
        // asks for is honestly the same real version, not a second,
        // different number invented to fill the field.
        aiModelVersion: config.version,

        predictionEngineStatus: system.engineStatus,

        validationSchedulerStatus: system.scheduler.gmgn.status,

        databaseStatus: system.database.connected ? "Connected" : "Disconnected"

    };

}

// =====================================
// SECTION 3 - SIGNAL SUMMARY (thin re-export - the real logic lives
// in predictionMetricsService.js, shared with the /validation/
// predictions/* public endpoints)
// =====================================

function getSignalSummary(params){

    return predictionMetricsService.getSignalSummary(params);

}

// =====================================
// SECTION 5 - WALLET PERFORMANCE
// =====================================

function getWalletPerformance({ category, from, to, limit = 20 } = {}){

    const mapping = WALLET_CATEGORIES[category];

    if(category && !mapping){

        return { category, wallets: [], error: `"${category}" is not a real, distinguishable wallet category in this schema.` };

    }

    const result = walletQueryService.search({

        label: mapping?.label,

        maxTrades: mapping?.maxTrades,

        from,

        to,

        limit,

        sortColumn: "score",

        direction: "DESC"

    });

    return {

        category: category || "All",

        wallets: result.wallets.map((w, i) => ({

            rank: i + 1,

            walletAddress: w.wallet_address,

            category: w.primary_label || "Unlabeled",

            predictionCount: w.total_trades,

            winRate: w.win_rate,

            averageRoiPct: w.avg_roi_pct,

            totalRealizedProfitUsd: w.realized_profit_usd,

            tpCount: w.win_count,

            slCount: w.loss_count,

            openCount: w.open_position_count,

            score: w.score

        }))

    };

}

function getAvailableWalletCategories(){

    return Object.keys(WALLET_CATEGORIES);

}

// =====================================
// SECTION 8 - AI RECOMMENDATIONS (rule-based, deterministic - not an
// LLM call. Every recommendation below fires only when a real
// threshold is crossed in the real, already-computed statistics for
// the selected period; an empty period produces an empty list, never
// invented advice.)
// =====================================

const RULES = [

    {

        id: "strong-buy-confidence-low",

        estimatedImpact: "High",

        check(stats, summary, strongBuy){

            const lowBand = stats.confidenceCalibration.find(b => b.label === "<60");

            if(!lowBand || lowBand.predictionCount < 5) return null;

            if(strongBuy.predictionCount < 3) return null;

            if(lowBand.winRate != null && lowBand.winRate < 0.4){

                return `STRONG BUY confidence too low: predictions under 60% confidence won only ${(lowBand.winRate*100).toFixed(0)}% of the time (n=${lowBand.predictionCount}) - consider raising the STRONG BUY confidence floor.`;

            }

            return null;

        }

    },

    {

        id: "developer-losses",

        estimatedImpact: "Medium",

        check(stats){

            const totalLosses = stats.failureAnalysis.reduce((a,b) => a + b.count, 0);

            const devLosses = stats.walletCategoryLosses.find(w => w.category === "Developer");

            if(!devLosses || totalLosses < 5) return null;

            const pct = devLosses.count / totalLosses;

            if(pct >= 0.3){

                return `Developer-identified wallets are present in ${(pct*100).toFixed(0)}% of losing predictions - review whether developer-wallet involvement should be a stronger negative signal.`;

            }

            return null;

        }

    },

    {

        id: "whale-score-overweight",

        estimatedImpact: "Medium",

        check(stats){

            const whaleLosses = stats.walletCategoryLosses.find(w => w.category === "Smart Money");

            const totalLosses = stats.failureAnalysis.reduce((a,b) => a + b.count, 0);

            if(!whaleLosses || totalLosses < 5) return null;

            const pct = whaleLosses.count / totalLosses;

            if(pct >= 0.4){

                return `Smart-money-flagged wallets are present in ${(pct*100).toFixed(0)}% of losses this period - the whale/smart-money participant weight may be overweighted relative to its real recent accuracy.`;

            }

            return null;

        }

    },

    {

        id: "avg-tp-too-high",

        estimatedImpact: "Low",

        check(stats, summary){

            if(summary.tpCount < 5 || summary.averageTimeToTpSeconds == null) return null;

            if(summary.averageMfePct != null && summary.averageMfePct > 0 && summary.tpCount > 0){

                const overshoot = summary.averageMfePct - (summary.averageRoiPct || 0);

                if(overshoot > 15){

                    return `Average favorable excursion (${summary.averageMfePct.toFixed(0)}%) is well above the average realized ROI (${(summary.averageRoiPct||0).toFixed(0)}%) - the target band may be set too high, giving back real gains before TP is reached.`;

                }

            }

            return null;

        }

    },

    {

        id: "avg-sl-too-tight",

        estimatedImpact: "Medium",

        check(stats, summary){

            if(summary.slCount < 5) return null;

            const closedCount = summary.tpCount + summary.slCount + summary.expiredCount;

            const slRate = closedCount > 0 ? summary.slCount / closedCount : 0;

            if(slRate >= 0.5){

                return `${(slRate*100).toFixed(0)}% of closed predictions this period hit stop-loss - the stop distance may be too tight for this token population's real volatility.`;

            }

            return null;

        }

    },

    {

        id: "false-buy-rate",

        estimatedImpact: "High",

        check(stats){

            const buyTiers = stats.accuracyByTier.filter(t => t.recommendation === "STRONG BUY" || t.recommendation === "BUY");

            const buyClosedCount = buyTiers.reduce((a, t) => a + t.sampleSize, 0);

            if(buyClosedCount < 5 || stats.falseBuyCount == null) return null;

            const rate = stats.falseBuyCount / buyClosedCount;

            if(rate >= 0.5){

                return `False BUY rate is ${(rate*100).toFixed(0)}% (${stats.falseBuyCount}/${buyClosedCount} closed BUY-tier predictions didn't hit target) - BUY-tier evidence requirements may need tightening.`;

            }

            return null;

        }

    }

];

function getRecommendations({ from, to } = {}){

    const summary = predictionMetricsService.getSummary({ from, to });

    const strongBuy = predictionMetricsService.getStrongBuySummary({ from, to });

    const stats = predictionMetricsService.getStatistics({ from, to });

    const insights = [];

    for(const rule of RULES){

        try{

            const message = rule.check(stats, summary, strongBuy);

            if(message) insights.push({ id: rule.id, estimatedImpact: rule.estimatedImpact, message });

        }
        catch(e){ /* a rule failing to compute must never break the whole dashboard */ }

    }

    // Real, direct signal comparisons (Fresh Wallet vs KOL performance
    // this period) - computed here rather than as a fixed RULES entry
    // since it needs two extra wallet-performance queries.

    const freshWallets = getWalletPerformance({ category: "Fresh Wallet", from, to, limit: 50 }).wallets;

    const kolWallets = getWalletPerformance({ category: "KOL", from, to, limit: 50 }).wallets;

    const freshWinRates = freshWallets.map(w => w.winRate).filter(v => v != null);

    const kolWinRates = kolWallets.map(w => w.winRate).filter(v => v != null);

    if(freshWinRates.length >= 3 && kolWinRates.length >= 3){

        const freshAvg = freshWinRates.reduce((a,b)=>a+b,0) / freshWinRates.length;

        const kolAvg = kolWinRates.reduce((a,b)=>a+b,0) / kolWinRates.length;

        if(freshAvg > kolAvg + 0.1){

            insights.push({ id: "fresh-outperforms-kol", estimatedImpact: "Low", message: `Fresh wallets averaged ${(freshAvg*100).toFixed(0)}% win rate vs KOL wallets' ${(kolAvg*100).toFixed(0)}% this period.` });

        }
        else if(kolAvg > freshAvg + 0.1){

            insights.push({ id: "kol-outperforms-fresh", estimatedImpact: "Low", message: `KOL wallets averaged ${(kolAvg*100).toFixed(0)}% win rate vs fresh wallets' ${(freshAvg*100).toFixed(0)}% this period.` });

        }

    }

    return {

        generatedAt: new Date().toISOString(),

        insights: insights.slice(0, 5),

        sampleWarning: summary.predictionCount < 20 ? `Sample size (${summary.predictionCount} predictions) is small - treat these insights as directional, not conclusive.` : null

    };

}

// =====================================
// AI ENGINE ADVISOR (Admin V3) - structured version of the insights
// above: every entry carries a real current engine value (read
// straight from scoringConfig.js/tradePlanConfig.js via
// adminService.getEngineConfig() - never a second, hand-copied
// number), a recommended value (a real, disclosed HEURISTIC
// adjustment - never claimed as a proven optimum), an expected
// improvement computed as a real what-if over the actual closed
// predictions in the selected period (e.g. "if these losses became
// wins, win rate would rise from X% to Y%" - an optimistic upper
// bound, stated as such, not a guaranteed outcome), and a confidence
// level derived from the real sample size backing the rule. A rule
// with no real matching engine parameter (e.g. "fresh wallets
// outperform KOL" - "freshness" isn't a scored participant category)
// reports currentValue/recommendedValue as null rather than
// inventing a knob that doesn't exist.
// =====================================

function confidenceForSample(n){

    if(n >= 30) return "High";

    if(n >= 10) return "Medium";

    return "Low";

}

// Real what-if: if every loss in `lossCount` had instead been a TP,
// what would win rate become? An optimistic upper bound on the real
// closed-prediction counts, stated as such - never presented as a
// prediction of what will actually happen.

function hypotheticalWinRateIfFixed(tpCount, totalClosed, lossCount){

    if(totalClosed <= 0 || lossCount <= 0) return null;

    const fixedTp = Math.min(totalClosed, tpCount + lossCount);

    return fixedTp / totalClosed;

}

function getEngineAdvisor({ from, to } = {}){

    const stats = predictionMetricsService.getStatistics({ from, to });

    const summary = stats.overall;

    const engineConfig = adminService.getEngineConfig();

    const closedCount = summary.tpCount + summary.slCount + summary.expiredCount;

    const advisories = [];

    // 1. Developer wallet score too high
    const devLosses = stats.walletCategoryLosses.find(w => w.category === "Developer");

    if(devLosses && closedCount >= 10 && (devLosses.count / closedCount) >= 0.25){

        const currentValue = engineConfig.participantWeights.developer;

        const hypoWinRate = hypotheticalWinRateIfFixed(summary.tpCount, closedCount, devLosses.count);

        advisories.push({

            id: "developer-weight-too-high",

            reason: `Developer-identified wallets are present in ${devLosses.count}/${closedCount} (${((devLosses.count/closedCount)*100).toFixed(0)}%) of closed predictions that did NOT hit target.`,

            currentValue: `${currentValue} (participant score weight)`,

            recommendedValue: `${Math.round(currentValue * 0.7)}`,

            expectedImprovement: hypoWinRate != null ? `Win rate could rise from ${(summary.winRate*100).toFixed(0)}% to as much as ${(hypoWinRate*100).toFixed(0)}% if developer-linked losses were eliminated (optimistic upper bound, not a guarantee).` : null,

            confidence: confidenceForSample(devLosses.count)

        });

    }

    // 2. Fresh wallet vs KOL performance (no direct engine parameter -
    // disclosed honestly as a directional insight only).
    const freshWallets = getWalletPerformance({ category: "Fresh Wallet", from, to, limit: 50 }).wallets;

    const kolWallets = getWalletPerformance({ category: "KOL", from, to, limit: 50 }).wallets;

    const freshWinRates = freshWallets.map(w => w.winRate).filter(v => v != null);

    const kolWinRates = kolWallets.map(w => w.winRate).filter(v => v != null);

    if(freshWinRates.length >= 5 && kolWinRates.length >= 5){

        const freshAvg = freshWinRates.reduce((a,b)=>a+b,0) / freshWinRates.length;

        const kolAvg = kolWinRates.reduce((a,b)=>a+b,0) / kolWinRates.length;

        if(freshAvg > kolAvg + 0.1){

            advisories.push({

                id: "fresh-wallet-undervalued",

                reason: `Fresh wallets (≤2 real trades) averaged ${(freshAvg*100).toFixed(0)}% win rate vs KOL wallets' ${(kolAvg*100).toFixed(0)}% this period.`,

                currentValue: null,

                recommendedValue: null,

                expectedImprovement: "No direct engine parameter scores wallet freshness today - this is a directional signal, not a tunable value.",

                confidence: confidenceForSample(Math.min(freshWinRates.length, kolWinRates.length))

            });

        }

    }

    // 3. Liquidity score too low (worst token pattern is real and
    // liquidity-correlated - micro-cap tokens are structurally the
    // thinnest-liquidity band, see marketCapBandFor()).
    if(stats.mostDangerousTokenPattern && stats.mostDangerousTokenPattern.key.startsWith("Micro") && stats.mostDangerousTokenPattern.winRate < 0.4){

        const currentValue = engineConfig.marketWeights.liquidity;

        advisories.push({

            id: "liquidity-weight-too-low",

            reason: `The Micro-cap token pattern has the worst real win rate (${(stats.mostDangerousTokenPattern.winRate*100).toFixed(0)}%, n=${stats.mostDangerousTokenPattern.sampleSize}) of any ranked pattern this period.`,

            currentValue: `${currentValue} (market health weight)`,

            recommendedValue: `${Math.round(currentValue * 1.15)}`,

            expectedImprovement: null,

            confidence: confidenceForSample(stats.mostDangerousTokenPattern.sampleSize)

        });

    }

    // 4. Momentum/price-stability score overweight (real MFE overshoot
    // vs realized ROI - same real signal as the earlier "avg-tp-too-
    // high" insight, mapped to the closest real config parameter).
    if(summary.tpCount >= 5 && summary.averageMfePct != null && summary.averageRoiPct != null){

        const overshoot = summary.averageMfePct - summary.averageRoiPct;

        if(overshoot > 15){

            const currentValue = engineConfig.marketWeights.priceStability;

            advisories.push({

                id: "momentum-overweight",

                reason: `Average favorable excursion (${summary.averageMfePct.toFixed(0)}%) exceeds average realized ROI (${summary.averageRoiPct.toFixed(0)}%) by ${overshoot.toFixed(0)} points - real gains are being given back before close.`,

                currentValue: `${currentValue} (price stability weight)`,

                recommendedValue: `${Math.round(currentValue * 0.85)}`,

                expectedImprovement: null,

                confidence: confidenceForSample(summary.tpCount)

            });

        }

    }

    // 5. Confidence threshold too aggressive
    const lowBand = stats.confidenceCalibration.find(b => b.label === "<60");

    if(lowBand && lowBand.predictionCount >= 10 && lowBand.winRate != null && lowBand.winRate < 0.4){

        const currentValue = engineConfig.actionTiers.buy;

        advisories.push({

            id: "confidence-threshold-too-aggressive",

            reason: `Predictions under 60% confidence won only ${(lowBand.winRate*100).toFixed(0)}% of the time (n=${lowBand.predictionCount}) this period.`,

            currentValue: `${currentValue} (BUY action-tier score threshold)`,

            recommendedValue: `${currentValue + 5}`,

            expectedImprovement: null,

            confidence: confidenceForSample(lowBand.predictionCount)

        });

    }

    // 6. Take Profit too high
    if(summary.tpCount >= 5 && summary.averageMfePct != null && summary.averageRoiPct != null && (summary.averageMfePct - summary.averageRoiPct) > 15){

        const currentValue = engineConfig.tradePlan.target.maxTargetPct;

        advisories.push({

            id: "take-profit-too-high",

            reason: `Realized ROI (${summary.averageRoiPct.toFixed(0)}%) is well below the best price seen (MFE ${summary.averageMfePct.toFixed(0)}%) across ${summary.tpCount} TP-hit predictions - the target band may be letting real gains slip away.`,

            currentValue: `${currentValue}% (max target %)`,

            recommendedValue: `${Math.round(currentValue * 0.85)}%`,

            expectedImprovement: null,

            confidence: confidenceForSample(summary.tpCount)

        });

    }

    // 7. Stop Loss too tight
    if(summary.slCount >= 5 && closedCount > 0 && (summary.slCount / closedCount) >= 0.5){

        const currentValue = engineConfig.tradePlan.stopLoss.baseStopPct;

        advisories.push({

            id: "stop-loss-too-tight",

            reason: `${((summary.slCount/closedCount)*100).toFixed(0)}% of closed predictions this period hit stop-loss (n=${summary.slCount}/${closedCount}).`,

            currentValue: `${currentValue}% (base stop distance)`,

            recommendedValue: `${Math.round(currentValue * 1.2)}%`,

            expectedImprovement: null,

            confidence: confidenceForSample(summary.slCount)

        });

    }

    return {

        generatedAt: new Date().toISOString(),

        advisories: advisories.slice(0, 5),

        sampleWarning: summary.predictionCount < 20 ? `Sample size (${summary.predictionCount} predictions) is small - treat these as directional, not conclusive.` : null

    };

}

// =====================================
// SECTION 10 - EXPORT (CSV/XLSX). Every function below returns the
// exact { columns, rows } shape utils/exportBuilder.js needs -
// pulling from the SAME real functions above/in
// predictionMetricsService.js that the dashboard cards themselves
// use, never a second, separately-computed copy of the numbers.
// =====================================

function kvRows(obj, labels){

    return Object.entries(labels).map(([key, label]) => ({ metric: label, value: obj[key] }));

}

const EXPORT_TABLES = {

    "signal-summary": (params) => {

        const data = getSignalSummary(params);

        return {

            columns: [
                { key: "recommendation", label: "Recommendation" },
                { key: "count", label: "Count" },
                { key: "percentage", label: "Percentage" },
                { key: "previousCount", label: "Previous Period Count" },
                { key: "trendCount", label: "Trend (Count)" }
            ],

            rows: data.tiers.map(t => ({

                recommendation: t.recommendation,

                count: t.count,

                percentage: t.percentage != null ? `${(t.percentage*100).toFixed(1)}%` : "",

                previousCount: t.previousCount,

                trendCount: t.trendCount

            }))

        };

    },

    "result-summary": (params) => ({

        columns: [{ key: "metric", label: "Metric" }, { key: "value", label: "Value" }],

        rows: kvRows(predictionMetricsService.getSummary(params), {

            predictionCount: "Total Predictions", tpCount: "TP Hit", slCount: "SL Hit",
            expiredCount: "Expired", openCount: "Still Open", winRate: "Win Rate",
            averageRoiPct: "Average ROI %", medianRoiPct: "Median ROI %",
            largestWinnerPct: "Largest Winner %", largestLoserPct: "Largest Loser %",
            averageTimeToTpSeconds: "Avg Time to TP (s)", averageTimeToSlSeconds: "Avg Time to SL (s)"

        })

    }),

    "strong-buy": (params) => ({

        columns: [{ key: "metric", label: "Metric" }, { key: "value", label: "Value" }],

        rows: kvRows(predictionMetricsService.getStrongBuySummary(params), {

            predictionCount: "Issued", tpCount: "TP", slCount: "SL", expiredCount: "Expired",
            openCount: "Open", winRate: "Win Rate", averageRoiPct: "Average ROI %",
            averageTimeToTpSeconds: "Avg Time to TP (s)"

        })

    }),

    "wallet-performance": (params) => {

        const data = getWalletPerformance(params);

        return {

            columns: [
                { key: "rank", label: "Rank" }, { key: "walletAddress", label: "Wallet Address" },
                { key: "category", label: "Category" }, { key: "predictionCount", label: "Prediction Count" },
                { key: "winRate", label: "Win Rate" }, { key: "averageRoiPct", label: "Average ROI %" },
                { key: "totalRealizedProfitUsd", label: "Total Realized Profit (USD)" },
                { key: "tpCount", label: "TP" }, { key: "slCount", label: "SL" }, { key: "openCount", label: "Open" }
            ],

            rows: data.wallets

        };

    },

    "failure-reasons": (params) => ({

        columns: [{ key: "reason", label: "Losing Reason" }, { key: "count", label: "Count" }],

        rows: predictionMetricsService.getStatistics(params).failureAnalysis

    }),

    "winning-reasons": (params) => ({

        columns: [{ key: "reason", label: "Winning Reason" }, { key: "count", label: "Count" }],

        rows: predictionMetricsService.getStatistics(params).winAnalysis

    }),

    "wallet-category-losses": (params) => ({

        columns: [{ key: "category", label: "Wallet Category" }, { key: "count", label: "Losses" }],

        rows: predictionMetricsService.getStatistics(params).walletCategoryLosses

    }),

    "token-pattern-losses": (params) => ({

        columns: [{ key: "pattern", label: "Token Pattern (Market Cap Band)" }, { key: "count", label: "Losses" }],

        rows: predictionMetricsService.getStatistics(params).tokenPatternLosses

    }),

    "confidence-calibration": (params) => ({

        columns: [
            { key: "label", label: "Confidence Band" }, { key: "predictionCount", label: "Predictions" },
            { key: "winRate", label: "Win Rate" }, { key: "averageRoiPct", label: "Average ROI %" }
        ],

        rows: predictionMetricsService.getStatistics(params).confidenceCalibration

    }),

    "engine-history": () => ({

        columns: [
            { key: "version", label: "Engine Version" }, { key: "deployedAt", label: "Deployment Date" },
            { key: "winRate", label: "Win Rate" }, { key: "averageRoiPct", label: "Average ROI %" },
            { key: "predictionCount", label: "Prediction Count" }, { key: "winRateDelta", label: "Win Rate Δ vs Previous" }
        ],

        rows: engineVersionService.getHistory()

    }),

    "engine-advisor": (params) => ({

        columns: [
            { key: "reason", label: "Reason" }, { key: "currentValue", label: "Current Value" },
            { key: "recommendedValue", label: "Recommended Value" }, { key: "expectedImprovement", label: "Expected Improvement" },
            { key: "confidence", label: "Confidence" }
        ],

        rows: getEngineAdvisor(params).advisories

    })

};

function getExportTable(section, params){

    const builder = EXPORT_TABLES[section];

    if(!builder) return null;

    return builder(params);

}

function getExportableSections(){

    return Object.keys(EXPORT_TABLES);

}

module.exports = {

    getEngineStatus,
    getSignalSummary,
    getWalletPerformance,
    getAvailableWalletCategories,
    getRecommendations,
    getEngineAdvisor,
    getEngineHistory: engineVersionService.getHistory,
    getExportTable,
    getExportableSections

};
