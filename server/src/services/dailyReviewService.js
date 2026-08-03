// services/dailyReviewService.js - Arjuna V4 Phase 2, Daily Trading
// Review infrastructure (original sprint brief Part 3 / Phase 2's
// Section 11). Pure descriptive aggregation of ALREADY-CAPTURED real
// trade data (trading_bot_trades + the new realtime_pulse_at_entry_json
// column) - no formula, weight, threshold, or multiplier is computed or
// suggested here, only real counts/averages/frequency tables of what
// already happened. Per the original brief's own explicit requirement,
// this report is for research only and NEVER automatically modifies any
// production formula - "suggestedObservations" below are plain
// comparative FACTS (e.g. "winners averaged X, losers averaged Y"), not
// directives, and nothing reads them back into scoring.
//
// win/loss/profitUsd use the SAME official-ROI selection
// (realized_roi_pct ?? roi_pct) and profit formula
// (size_usd * roiPct/100 - fee_usd) services/tradingBotService.js's own
// KPI/self-audit code already established (Arjuna V4 Sprint 11's "one
// real ROI formula" rule) - reused verbatim, never a second
// implementation.

const dailyReviewRepository = require("../repositories/dailyReviewRepository");

function officialRoiPct(trade){
    const roiPct = trade.realized_roi_pct ?? trade.roi_pct;
    return roiPct != null ? Number(roiPct) : null;
}

function profitUsd(trade){
    const roiPct = officialRoiPct(trade);
    if(trade.size_usd == null || roiPct == null) return null;
    return (Number(trade.size_usd) * (roiPct / 100)) - (Number(trade.fee_usd) || 0);
}

function isWin(trade){
    const roiPct = officialRoiPct(trade);
    return roiPct != null && roiPct > 0;
}

function average(values){
    const real = values.filter(v => v != null && Number.isFinite(Number(v))).map(Number);
    if(!real.length) return null;
    return real.reduce((a, b) => a + b, 0) / real.length;
}

function round2(n){
    return n == null ? null : Math.round(n * 100) / 100;
}

// Frequency table over a real, already-persisted JSON array field
// (entry_reasons_json/risk_reasons_json) - counts each distinct real
// reason string across the given trades, most frequent first.
function frequencyOfJsonArrayField(trades, field, limit){
    const counts = new Map();
    for(const trade of trades){
        let list = [];
        try{ list = trade[field] ? JSON.parse(trade[field]) : []; }
        catch(e){ continue; } // malformed - never guessed, just skipped
        for(const reason of list){
            counts.set(reason, (counts.get(reason) || 0) + 1);
        }
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([reason, count]) => ({ reason, count }));
}

// Real per-reason (STOP_LOSS/TP1/TP2/TIME_EXIT/...) aggregate stats -
// the raw `reason` column values, not a re-bucketed classification (that
// coarser TP/SL/DYNAMIC_EXIT view already exists separately in
// tradingBotService.js's own self-audit/bottleneck reports - this stays
// at the real, specific reason level for the Daily Review).
function statsByReason(trades){
    const byReason = new Map();
    for(const trade of trades){
        const reason = trade.reason || "UNKNOWN";
        if(!byReason.has(reason)) byReason.set(reason, []);
        byReason.get(reason).push(trade);
    }
    const result = {};
    for(const [reason, group] of byReason){
        result[reason] = {
            count: group.length,
            averageRoiPct: round2(average(group.map(officialRoiPct))),
            averageConfidence: round2(average(group.map(t => t.confidence))),
            averageParticipantScore: round2(average(group.map(t => t.participant_score))),
            averageTokenAgeMinutesAtEntry: round2(average(group.map(t => t.token_age_minutes_at_entry))),
            averageLiquidityAtEntry: round2(average(group.map(t => t.liquidity_at_entry)))
        };
    }
    return result;
}

// Coverage/distribution over the new realtime_pulse_at_entry_json field -
// how many of today's trades actually had a real Realtime Pulse reading
// at entry (non-null buffer), and what its provisional flow direction
// looked like for winners vs losers - real validation data for the
// Solution Architect, not a decision input anywhere in this function.
function realtimeSignalStatistics(trades){

    let withPulseData = 0;
    const flowByOutcome = { win: {}, loss: {} };

    for(const trade of trades){

        let pulse = null;
        try{ pulse = trade.realtime_pulse_at_entry_json ? JSON.parse(trade.realtime_pulse_at_entry_json) : null; }
        catch(e){ continue; }

        if(!pulse || !pulse.bufferLength) continue;

        withPulseData++;

        const outcome = isWin(trade) ? "win" : "loss";
        const direction = pulse.flowDirectionVoteProvisional || "UNKNOWN";
        flowByOutcome[outcome][direction] = (flowByOutcome[outcome][direction] || 0) + 1;

    }

    return {
        tradesWithRealtimePulseData: withPulseData,
        totalTrades: trades.length,
        coverageFraction: trades.length ? round2(withPulseData / trades.length) : null,
        flowDirectionAtEntryByOutcome: flowByOutcome
    };

}

// Arjuna V4 FINAL DECISION ENGINE SPRINT - real effectiveness stats for
// each component of the confidence adjustment (Realtime Pulse/Token Age/
// Smart Money/KOL/Fake Pump), using the confidence_adjustment_at_entry_json
// column (migration 069) already persisted per trade by
// tradingBotRepository.js's buildTradeDatasetFields. Groups trades by
// each component's real, already-computed direction (positive/negative/
// neutral adjustment, or penalty-applied/not) and reports real win rate +
// average ROI per group - a genuine measurement of whether each
// component's adjustment actually correlated with a better outcome, not
// a guess. Malformed/missing data is honestly skipped, never fabricated.
function groupWinRateAndRoi(trades){
    const wins = trades.filter(isWin).length;
    return {
        count: trades.length,
        winRate: trades.length ? round2(wins / trades.length) : null,
        averageRoiPct: round2(average(trades.map(officialRoiPct)))
    };
}

function parseConfidenceAdjustment(trade){
    try{ return trade.confidence_adjustment_at_entry_json ? JSON.parse(trade.confidence_adjustment_at_entry_json) : null; }
    catch(e){ return null; }
}

function componentEffectiveness(trades, componentKey, pctExtractor){
    const withData = trades.map(t => ({ trade: t, adjustment: parseConfidenceAdjustment(t) })).filter(x => x.adjustment);
    const positive = withData.filter(x => pctExtractor(x.adjustment) > 0).map(x => x.trade);
    const negative = withData.filter(x => pctExtractor(x.adjustment) < 0).map(x => x.trade);
    const neutral = withData.filter(x => pctExtractor(x.adjustment) === 0).map(x => x.trade);
    return {
        sampleSize: withData.length,
        positiveAdjustment: groupWinRateAndRoi(positive),
        negativeAdjustment: groupWinRateAndRoi(negative),
        neutralAdjustment: groupWinRateAndRoi(neutral)
    };
}

function confidenceAdjustmentEffectiveness(trades){

    const withData = trades.map(parseConfidenceAdjustment).filter(Boolean);

    // Token Age's own bucket table (config/realtimeAdjustmentConfig.js)
    // has NO multiplier above 1.00x at all - 1.00x (10-60min) IS the top
    // bucket, with BOTH very-young (0.95x, 0-10min) and older (0.90x/
    // 0.75x/0.60x, 60min+) discounted below it. Grouping by ">1 vs <1"
    // would therefore never populate a "younger" group - this compares
    // against the exact 0.95x bucket value instead, matching the real
    // table rather than a naive greater-than-1 assumption.
    const tokenAgeVeryYoung = trades.filter(t => { const a = parseConfidenceAdjustment(t); return a && a.tokenAge?.multiplier === 0.95; });
    const tokenAgeAt = trades.filter(t => { const a = parseConfidenceAdjustment(t); return a && a.tokenAge?.multiplier === 1; });
    const tokenAgeOlder = trades.filter(t => { const a = parseConfidenceAdjustment(t); return a && a.tokenAge?.multiplier != null && a.tokenAge.multiplier < 1 && a.tokenAge.multiplier !== 0.95; });

    const fakePumpPenalized = trades.filter(t => { const a = parseConfidenceAdjustment(t); return a && a.fakePump?.pct < 0; });
    const fakePumpClean = trades.filter(t => { const a = parseConfidenceAdjustment(t); return a && a.fakePump?.pct === 0; });

    return {
        sampleSize: withData.length,
        // Realtime Pulse effectiveness.
        realtimePulse: componentEffectiveness(trades, "pulse", a => a.pulse?.pct ?? 0),
        // Smart Money effectiveness.
        smartMoney: componentEffectiveness(trades, "smartMoney", a => a.smartMoney?.pct ?? 0),
        // KOL effectiveness.
        kol: componentEffectiveness(trades, "kol", a => a.kol?.pct ?? 0),
        // Token Age effectiveness - grouped by the Architect's own real
        // bucket table (see the comment above on why this isn't a naive
        // >1/<1 split).
        tokenAge: {
            sampleSize: withData.length,
            veryYoung: groupWinRateAndRoi(tokenAgeVeryYoung), // 0.95x bucket (0-10min)
            neutral: groupWinRateAndRoi(tokenAgeAt), // 1.00x bucket (10-60min) - the sweet spot
            older: groupWinRateAndRoi(tokenAgeOlder) // 0.90x/0.75x/0.60x buckets (60min+)
        },
        // Fake Pump penalties - real count + how trades that were
        // penalized actually performed vs trades that weren't.
        fakePump: {
            sampleSize: withData.length,
            penalizedCount: fakePumpPenalized.length,
            penalized: groupWinRateAndRoi(fakePumpPenalized),
            clean: groupWinRateAndRoi(fakePumpClean)
        }
    };

}

// Best/worst INDIVIDUAL trades (not patterns) - real ROI-sorted, capped
// to a small real list. token identity + reason are the minimum needed
// to look the real trade up further if wanted.
function pickExtremeTrades(trades, count, direction){
    return [...trades]
        .filter(t => officialRoiPct(t) != null)
        .sort((a, b) => direction === "best" ? officialRoiPct(b) - officialRoiPct(a) : officialRoiPct(a) - officialRoiPct(b))
        .slice(0, count)
        .map(t => ({
            tokenAddress: t.token_address, tokenSymbol: t.token_symbol,
            roiPct: round2(officialRoiPct(t)), reason: t.reason,
            confidence: t.confidence, durationSeconds: t.duration_seconds
        }));
}

// Plain comparative FACTS only - no threshold, no directive, no implied
// magnitude of "how much" to change anything. Each entry states a real
// number for winners vs losers; the Solution Architect decides what (if
// anything) it means for scoring. See this file's own header.
function buildObservations({ winners, losers }){

    const observations = [];

    function addComparison(label, extractor){
        const winnerAvg = average(winners.map(extractor));
        const loserAvg = average(losers.map(extractor));
        if(winnerAvg == null || loserAvg == null) return;
        observations.push(`${label}: winners averaged ${round2(winnerAvg)}, losers averaged ${round2(loserAvg)}.`);
    }

    addComparison("Token age at entry (minutes)", t => t.token_age_minutes_at_entry);
    addComparison("Confidence at entry", t => t.confidence);
    addComparison("Participant score at entry", t => t.participant_score);
    addComparison("Market health at entry", t => t.market_health);
    addComparison("Liquidity at entry (USD)", t => t.liquidity_at_entry);
    addComparison("Holding duration (seconds)", t => t.duration_seconds);
    addComparison("MFE (%)", t => t.mfe_pct);
    addComparison("MAE (%)", t => t.mae_pct);

    return observations;

}

// dateStr: "YYYY-MM-DD" (UTC calendar day) - the day being reviewed, NOT
// necessarily "today" (the scheduler always calls this for the day that
// just closed - see dailyReviewScheduler.js).
function generateReview(dateStr){

    const trades = dailyReviewRepository.findTradesClosedOnDate(dateStr);

    const winners = trades.filter(isWin);
    const losers = trades.filter(t => !isWin(t));

    const netProfitUsd = trades.reduce((sum, t) => sum + (profitUsd(t) || 0), 0);
    const averageRoiPct = average(trades.map(officialRoiPct));
    const averageMfePct = average(trades.map(t => t.mfe_pct));
    const averageMaePct = average(trades.map(t => t.mae_pct));
    const averageHoldingSeconds = average(trades.map(t => t.duration_seconds));

    const reasonStats = statsByReason(trades);

    // Best/worst performing pattern - by real average ROI per reason,
    // requiring at least 2 real trades in the group so a single outlier
    // trade can never be crowned "best pattern" on its own (a sample-size
    // hygiene rule, not a trading threshold).
    const eligiblePatterns = Object.entries(reasonStats).filter(([, s]) => s.count >= 2 && s.averageRoiPct != null);
    const bestPerformingPattern = eligiblePatterns.length
        ? eligiblePatterns.reduce((best, cur) => cur[1].averageRoiPct > best[1].averageRoiPct ? cur : best)
        : null;
    const worstPerformingPattern = eligiblePatterns.length
        ? eligiblePatterns.reduce((worst, cur) => cur[1].averageRoiPct < worst[1].averageRoiPct ? cur : worst)
        : null;

    const report = {
        reviewDate: dateStr,
        tradingSummary: {
            totalTrades: trades.length,
            winCount: winners.length,
            lossCount: losers.length,
            winRate: trades.length ? round2(winners.length / trades.length) : null,
            netProfitUsd: round2(netProfitUsd),
            averageRoiPct: round2(averageRoiPct),
            averageMfePct: round2(averageMfePct),
            averageMaePct: round2(averageMaePct),
            averageHoldingSeconds: round2(averageHoldingSeconds)
        },
        exitReasonDistribution: Object.fromEntries(Object.entries(reasonStats).map(([reason, s]) => [reason, s.count])),
        // Arjuna V4 FINAL DECISION ENGINE SPRINT - full per-reason exit
        // statistics (not just counts) - average ROI/confidence/
        // participant-score/token-age/liquidity for each real exit
        // reason, including the two new momentum-aware rules
        // (MOMENTUM_WEAKENING_EARLY_EXIT/MAE_ACCELERATED_EXIT).
        exitStatistics: reasonStats,
        entryQuality: {
            confidenceAnalysis: { winnersAvg: round2(average(winners.map(t => t.confidence))), losersAvg: round2(average(losers.map(t => t.confidence))) },
            participantAnalysis: { winnersAvg: round2(average(winners.map(t => t.participant_score))), losersAvg: round2(average(losers.map(t => t.participant_score))) },
            marketHealthAnalysis: { winnersAvg: round2(average(winners.map(t => t.market_health))), losersAvg: round2(average(losers.map(t => t.market_health))) },
            liquidityAnalysis: { winnersAvg: round2(average(winners.map(t => t.liquidity_at_entry))), losersAvg: round2(average(losers.map(t => t.liquidity_at_entry))) },
            tokenAgeAnalysis: { winnersAvg: round2(average(winners.map(t => t.token_age_minutes_at_entry))), losersAvg: round2(average(losers.map(t => t.token_age_minutes_at_entry))) }
        },
        exitQuality: {
            holdingDurationAnalysis: { winnersAvg: round2(average(winners.map(t => t.duration_seconds))), losersAvg: round2(average(losers.map(t => t.duration_seconds))) },
            averageMfePct: round2(averageMfePct),
            averageMaePct: round2(averageMaePct)
        },
        bestPerformingPattern: bestPerformingPattern ? { reason: bestPerformingPattern[0], ...bestPerformingPattern[1] } : null,
        worstPerformingPattern: worstPerformingPattern ? { reason: worstPerformingPattern[0], ...worstPerformingPattern[1] } : null,
        mostFrequentStopLossCharacteristics: reasonStats.STOP_LOSS ?? null,
        mostFrequentTpCharacteristics: {
            tp1: reasonStats.TP1 ?? null,
            tp2: reasonStats.TP2 ?? null
        },
        mostCommonWinningConditions: frequencyOfJsonArrayField(winners, "entry_reasons_json", 10),
        mostCommonLosingConditions: frequencyOfJsonArrayField(losers, "risk_reasons_json", 10),
        top5LossReasons: frequencyOfJsonArrayField(losers, "risk_reasons_json", 5),
        top5ProfitReasons: frequencyOfJsonArrayField(winners, "entry_reasons_json", 5),
        realtimeSignalStatistics: realtimeSignalStatistics(trades),
        // Arjuna V4 FINAL DECISION ENGINE SPRINT - real effectiveness per
        // adjustment component (Realtime Pulse/Smart Money/KOL/Token Age/
        // Fake Pump) and the best/worst individual real trades.
        confidenceAdjustmentEffectiveness: confidenceAdjustmentEffectiveness(trades),
        bestTrades: pickExtremeTrades(trades, 5, "best"),
        worstTrades: pickExtremeTrades(trades, 5, "worst"),
        // Plain comparative facts, NOT directives - see buildObservations'
        // own header. Named "suggestedObservations", never
        // "suggestedParameterAdjustments", so nothing about this field's
        // own name could be mistaken for an auto-applied change.
        suggestedObservations: buildObservations({ winners, losers })
    };

    return report;

}

// Computes AND persists (idempotent upsert) - the scheduler's own entry
// point. Returns the same report generateReview() would.
function generateAndPersistReview(dateStr){

    const report = generateReview(dateStr);
    const summary = report.tradingSummary;

    dailyReviewRepository.upsertReview({
        reviewDate: dateStr,
        totalTrades: summary.totalTrades,
        winCount: summary.winCount,
        lossCount: summary.lossCount,
        winRate: summary.winRate,
        netProfitUsd: summary.netProfitUsd,
        averageRoiPct: summary.averageRoiPct,
        averageMfePct: summary.averageMfePct,
        averageMaePct: summary.averageMaePct,
        averageHoldingSeconds: summary.averageHoldingSeconds,
        reportJson: JSON.stringify(report)
    });

    return report;

}

module.exports = { generateReview, generateAndPersistReview, officialRoiPct, isWin, profitUsd };
