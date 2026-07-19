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
const { computePreviousPeriod } = require("../utils/dateRange");

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

// Frontend-facing sort key -> real wallets column (Admin V3.1, Wallet
// Performance redesign, Part 5's "sort by every column"). Only real
// stored/computed columns are sortable - there is no column for the
// four requested "Strong BUY/BUY/HOLD/AVOID" tiers or "Expired" (see
// this file's Section 5 doc comment: prediction_history has no
// wallet-address linkage, so those tiers cannot be computed per
// wallet from this schema, sortable or not).

const WALLET_SORT_COLUMNS = {

    walletAddress: "wallet_address",
    predictionCount: "total_trades",
    tpCount: "win_count",
    slCount: "loss_count",
    openCount: "open_position_count",
    winRate: "win_rate",
    averageRoiPct: "avg_roi_pct",
    totalRealizedProfitUsd: "realized_profit_usd",
    averageHoldingSeconds: "avg_holding_seconds",
    score: "score",
    lastSeen: "last_seen"

};

// Hard cap on how many rows a single request can pull back, even for
// "Show All" (Part 12 - must stay fast at 100K/500K/1M scale). At
// today's real wallet count (~5.4K) this cap has no visible effect;
// it exists so this endpoint can never be asked to materialize an
// unbounded result set once the table grows.

const WALLET_PERFORMANCE_MAX_LIMIT = 5000;

function getWalletPerformance({ category, from, to, q, limit = 20, offset = 0, sortBy, direction = "DESC" } = {}){

    const mapping = WALLET_CATEGORIES[category];

    if(category && !mapping){

        return { category, wallets: [], total: 0, error: `"${category}" is not a real, distinguishable wallet category in this schema.` };

    }

    const sortColumn = WALLET_SORT_COLUMNS[sortBy] || "score";

    const safeLimit = Math.min(Math.max(1, Number(limit) || 20), WALLET_PERFORMANCE_MAX_LIMIT);

    const searchParams = {

        label: mapping?.label,

        maxTrades: mapping?.maxTrades,

        from,

        to,

        q,

        limit: safeLimit,

        offset: Math.max(0, Number(offset) || 0),

        sortColumn,

        direction: direction === "ASC" ? "ASC" : "DESC"

    };

    const result = walletQueryService.search(searchParams);

    const total = walletQueryService.countSearch({ label: mapping?.label, maxTrades: mapping?.maxTrades, from, to, q });

    return {

        category: category || "All",

        total,

        limit: safeLimit,

        offset: searchParams.offset,

        wallets: result.wallets.map((w, i) => ({

            rank: searchParams.offset + i + 1,

            walletAddress: w.wallet_address,

            category: w.primary_label || "Unlabeled",

            predictionCount: w.total_trades,

            winRate: w.win_rate,

            averageRoiPct: w.avg_roi_pct,

            totalRealizedProfitUsd: w.realized_profit_usd,

            tpCount: w.win_count,

            slCount: w.loss_count,

            openCount: w.open_position_count,

            averageHoldingSeconds: w.avg_holding_seconds,

            score: w.score,

            lastSeen: w.last_seen

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

            estimatedWinRateImprovementPct: hypoWinRate != null && summary.winRate != null ? (hypoWinRate - summary.winRate) * 100 : null,

            affectedParameter: "scoringConfig.js: participant.weights.developer",

            implementation: `Change participant.weights.developer from ${currentValue} to ${Math.round(currentValue * 0.7)} in server/src/config/scoringConfig.js, then redeploy.`,

            sampleSize: devLosses.count,

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

                estimatedWinRateImprovementPct: null,

                affectedParameter: null,

                implementation: "No direct engine parameter to change - this is a directional signal worth investigating manually (e.g. whether fresh-wallet activity deserves its own scored participant category), not an immediate config edit.",

                sampleSize: Math.min(freshWinRates.length, kolWinRates.length),

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

            estimatedWinRateImprovementPct: null,

            affectedParameter: "scoringConfig.js: market.weights.liquidity",

            implementation: `Change market.weights.liquidity from ${currentValue} to ${Math.round(currentValue * 1.15)} in server/src/config/scoringConfig.js, then redeploy.`,

            sampleSize: stats.mostDangerousTokenPattern.sampleSize,

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

                estimatedWinRateImprovementPct: null,

                affectedParameter: "scoringConfig.js: market.weights.priceStability",

                implementation: `Change market.weights.priceStability from ${currentValue} to ${Math.round(currentValue * 0.85)} in server/src/config/scoringConfig.js, then redeploy.`,

                sampleSize: summary.tpCount,

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

            estimatedWinRateImprovementPct: null,

            affectedParameter: "scoringConfig.js: actionTiers.buy",

            implementation: `Change actionTiers.buy from ${currentValue} to ${currentValue + 5} in server/src/config/scoringConfig.js, then redeploy. This raises the participant score a token needs to qualify for BUY at all.`,

            sampleSize: lowBand.predictionCount,

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

            estimatedWinRateImprovementPct: null,

            affectedParameter: "tradePlanConfig.js: target.maxTargetPct",

            implementation: `Change target.maxTargetPct from ${currentValue}% to ${Math.round(currentValue * 0.85)}% in server/src/config/tradePlanConfig.js, then redeploy. This lowers the take-profit target so real gains are locked in sooner.`,

            sampleSize: summary.tpCount,

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

            estimatedWinRateImprovementPct: null,

            affectedParameter: "tradePlanConfig.js: stopLoss.baseStopPct",

            implementation: `Change stopLoss.baseStopPct from ${currentValue}% to ${Math.round(currentValue * 1.2)}% in server/src/config/tradePlanConfig.js, then redeploy. This widens the stop distance to tolerate more real volatility before closing.`,

            sampleSize: summary.slCount,

            confidence: confidenceForSample(summary.slCount)

        });

    }

    // Product Refinement Sprint correctness fix: an earlier "AVOID
    // beats BUY on real average ROI" rule used to live here, comparing
    // accuracyByTier's AVOID row against BUY. It has been removed - per
    // this sprint's investigation, AVOID predictions structurally NEVER
    // get a trade plan or a prediction_history row at all (the
    // readiness gate unconditionally rejects the AVOID tier - see
    // tradePlanService.assessTradePlanReadiness), so avoidTier.sampleSize
    // is always 0 and that rule could never actually fire. It was dead
    // code based on a false premise about data availability, not a real
    // insight - removing it rather than leaving inert code in place.

    // 9. Smart Money category contributing negative real ROI (Product
    // Improvement Sprint's explicit example) - real per-wallet ROI
    // across every wallet this engine has labeled "Smart Money",
    // not a single anecdote.

    const smartMoneyWallets = getWalletPerformance({ category: "Smart Money", from, to, limit: 200 }).wallets;

    const smartMoneyRois = smartMoneyWallets.map(w => w.averageRoiPct).filter(v => v != null);

    if(smartMoneyRois.length >= 5){

        const smartMoneyAvgRoi = smartMoneyRois.reduce((a,b)=>a+b,0) / smartMoneyRois.length;

        if(smartMoneyAvgRoi < 0){

            const currentValue = engineConfig.participantWeights.smartMoney;

            advisories.push({

                id: "smart-money-negative-roi",

                reason: `Wallets labeled Smart Money averaged a negative real ROI (${smartMoneyAvgRoi.toFixed(1)}%, n=${smartMoneyRois.length} wallets) this period - this participant category is currently a drag, not a signal.`,

                currentValue: `${currentValue} (participant score weight)`,

                recommendedValue: `${Math.round(currentValue * 0.75)}`,

                expectedImprovement: "Reducing this weight would lower the participant score contribution of Smart-Money-flagged activity - real effect on win rate would need to be measured after the change, not assumed in advance.",

                estimatedWinRateImprovementPct: null,

                affectedParameter: "scoringConfig.js: participant.weights.smartMoney",

                implementation: `Change participant.weights.smartMoney from ${currentValue} to ${Math.round(currentValue * 0.75)} in server/src/config/scoringConfig.js, then redeploy.`,

                sampleSize: smartMoneyRois.length,

                confidence: confidenceForSample(smartMoneyRois.length)

            });

        }

    }

    // Priority/severity (Product Improvement Sprint, Part 6) - derived
    // from the same real confidence + evidence already computed above,
    // not a second, separately-guessed dimension. Priority is simply
    // rank order (advisories are already pushed roughly high-impact-
    // first); severity maps directly from the real sample-size-backed
    // confidence tier. `evidence` mirrors `reason` under the field name
    // the sprint asked for explicitly.

    const severityForConfidence = { High: "High", Medium: "Medium", Low: "Low" };

    advisories.forEach((a, i) => {

        a.priority = i + 1;

        a.severity = severityForConfidence[a.confidence] || "Low";

        a.evidence = a.reason;

    });

    // Admin V3.1 (Part 7) - a top-level summary so the advisor answers
    // "what should I improve today?" without reading every card: real
    // current-vs-previous-period win rate (null when there's no
    // comparable previous period - e.g. the All Time default, which by
    // definition has nothing before it, never a fabricated baseline),
    // plus the top 1-2 real advisories restated as
    // "Primary/Secondary Problem".

    const previousRange = computePreviousPeriod({ from, to });

    const previousWinRate = previousRange ? predictionMetricsService.getSummary(previousRange).winRate : null;

    const top = advisories.slice(0, 2);

    return {

        generatedAt: new Date().toISOString(),

        currentWinRate: summary.winRate,

        previousWinRate,

        winRateDelta: (summary.winRate != null && previousWinRate != null) ? (summary.winRate - previousWinRate) : null,

        previousPeriodAvailable: !!previousRange,

        primaryProblem: top[0] ? top[0].reason : null,

        secondaryProblem: top[1] ? top[1].reason : null,

        suggestedFix: top[0] && top[0].recommendedValue != null ? `Adjust ${top[0].id.replace(/-/g, " ")}: ${top[0].currentValue ?? "current value"} -> ${top[0].recommendedValue}` : (top[0] ? "Directional signal only - no direct engine parameter to adjust yet." : null),

        expectedImprovement: top[0] ? top[0].expectedImprovement : null,

        confidence: top[0] ? top[0].confidence : null,

        currentParameter: top[0] ? top[0].currentValue : null,

        recommendedParameter: top[0] ? top[0].recommendedValue : null,

        advisories: advisories.slice(0, 5),

        sampleWarning: summary.predictionCount < 20 ? `Sample size (${summary.predictionCount} predictions) is small - treat these as directional, not conclusive.` : null

    };

}

// =====================================
// AI DASHBOARD / AI HEALTH (Product Improvement Sprint, Part 5/8) -
// the top-of-page answer to "how healthy is my AI, is it improving,
// what should I improve today" within a few real numbers. Every field
// here is computed from the SAME real predictionMetricsService/
// ceoDashboardService functions the rest of the dashboard already
// uses - nothing new is invented, this only reframes existing real
// data plus two genuinely new-but-real checks (Confidence Health,
// 7-Day Trend) that are honest about not having enough real history
// yet when that's actually true (see the earliest-prediction-time
// check below - real prediction data currently spans well under 7
// days, so a "7-day trend" computed today would compare a real week
// against a mostly-empty "previous week" and call it a real trend;
// this reports that honestly instead).
// =====================================

function todayUtcRange(){

    const today = new Date().toISOString().slice(0, 10);

    return { from: today, to: today };

}

function daysAgoUtc(date, n){

    return new Date(date.getTime() - n*24*60*60*1000).toISOString().slice(0, 10);

}

function getConfidenceHealth(confidenceCalibration){

    const usableBands = confidenceCalibration.filter(b => b.predictionCount >= 10 && b.winRate != null);

    if(usableBands.length < 2){

        return { status: "Insufficient Data", orderedPairs: null, totalPairs: null, detail: "Fewer than two confidence bands have at least 10 real closed predictions yet - not enough data to judge calibration." };

    }

    // confidenceCalibration is already ordered highest-confidence-band
    // first (config.confidenceBuckets) - a well-calibrated engine
    // should show win rate falling (or holding) as confidence falls.

    let orderedPairs = 0;

    for(let i = 0; i < usableBands.length - 1; i++){

        if(usableBands[i].winRate >= usableBands[i+1].winRate) orderedPairs++;

    }

    const totalPairs = usableBands.length - 1;

    const ratio = orderedPairs / totalPairs;

    const status = ratio >= 0.75 ? "Well Calibrated" : (ratio >= 0.4 ? "Mixed" : "Poorly Calibrated");

    return { status, orderedPairs, totalPairs, detail: `${orderedPairs}/${totalPairs} adjacent confidence bands (≥10 real predictions each) show win rate falling as confidence falls, as a well-calibrated engine should.` };

}

function getAiHealth({ from, to } = {}){

    const stats = predictionMetricsService.getStatistics({ from, to });

    const summary = stats.overall;

    const todaySummary = predictionMetricsService.getSummary(todayUtcRange());

    const earliest = predictionMetricsService.getEarliestPredictionTime();

    const now = new Date();

    const realHistoryDays = earliest ? (now.getTime() - new Date(earliest.replace(" ", "T") + "Z").getTime()) / (24*60*60*1000) : 0;

    let sevenDayTrend = { available: false, reason: `Real prediction history currently spans ${realHistoryDays.toFixed(1)} day(s) - need at least 14 real days (7 to measure + 7 to compare against) before a real 7-day trend can be computed.` };

    if(realHistoryDays >= 14){

        const last7 = predictionMetricsService.getSummary({ from: daysAgoUtc(now, 7), to: daysAgoUtc(now, 0) });

        const prev7 = predictionMetricsService.getSummary({ from: daysAgoUtc(now, 14), to: daysAgoUtc(now, 8) });

        sevenDayTrend = {

            available: true,

            currentWinRate: last7.winRate,

            previousWinRate: prev7.winRate,

            delta: (last7.winRate != null && prev7.winRate != null) ? last7.winRate - prev7.winRate : null

        };

    }

    return {

        generatedAt: new Date().toISOString(),

        todaysAccuracy: todaySummary.winRate,

        todaysPredictionCount: todaySummary.predictionCount,

        sevenDayTrend,

        predictionCount: summary.predictionCount,

        winRate: summary.winRate,

        averageRoiPct: summary.averageRoiPct,

        openCount: summary.openCount,

        tpCount: summary.tpCount,

        slCount: summary.slCount,

        expiredCount: summary.expiredCount,

        averageTimeToTpSeconds: summary.averageTimeToTpSeconds,

        averageTimeToSlSeconds: summary.averageTimeToSlSeconds,

        confidenceHealth: getConfidenceHealth(stats.confidenceCalibration),

        bestPerformingCategory: stats.bestWalletCategory,

        worstPerformingCategory: stats.worstWalletCategory,

        // Product Refinement Sprint, Part 3 - HOLD/AVOID get their own
        // real evaluation here rather than being folded into the
        // trading numbers above.
        holdAvoidEvaluation: predictionMetricsService.getHoldAvoidEvaluation({ from, to })

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

        // Export always covers the FULL filtered set (every matching
        // wallet up to the real hard cap), never just whatever page
        // size the on-screen table happened to be showing - "Export"
        // means "give me the data", not "give me the current page".
        const data = getWalletPerformance({ ...params, limit: WALLET_PERFORMANCE_MAX_LIMIT, offset: 0 });

        return {

            columns: [
                { key: "rank", label: "Rank" }, { key: "walletAddress", label: "Wallet Address" },
                { key: "category", label: "Category" }, { key: "predictionCount", label: "Prediction Count" },
                { key: "winRate", label: "Win Rate" }, { key: "averageRoiPct", label: "Average ROI %" },
                { key: "totalRealizedProfitUsd", label: "Total Realized Profit (USD)" },
                { key: "tpCount", label: "TP" }, { key: "slCount", label: "SL" }, { key: "openCount", label: "Open" },
                { key: "averageHoldingSeconds", label: "Avg Holding Time (s)" }, { key: "score", label: "Score" },
                { key: "lastSeen", label: "Last Seen" }
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
            { key: "tpCount", label: "TP" }, { key: "slCount", label: "SL" },
            { key: "expiredCount", label: "Expired" }, { key: "openCount", label: "Open" },
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
    getAiHealth,
    getConfidenceHealth,
    getEngineHistory: engineVersionService.getHistory,
    getExportTable,
    getExportableSections

};
