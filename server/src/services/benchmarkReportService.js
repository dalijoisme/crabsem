// services/benchmarkReportService.js - Benchmark Harness Architecture
// Design Document section 7 (Report Generation). Computes every metric
// from real, already-collected data - benchmark_trades/positions/
// statistics (this participant's own isolated state) plus
// prediction_history/token_price_history (the SHARED, single-source-of-
// truth tables every participant's gate already reads) for the
// hindsight metrics. Never re-scores a token, never re-runs Production
// V2 - purely arithmetic over rows that already exist.

const benchmarkRunRepository = require("../repositories/benchmarkRunRepository");
const benchmarkPositionRepository = require("../repositories/benchmarkPositionRepository");
const benchmarkStatisticsRepository = require("../repositories/benchmarkStatisticsRepository");
const benchmarkReportRepository = require("../repositories/benchmarkReportRepository");
const benchmarkFunnelRepository = require("../repositories/benchmarkFunnelRepository");
const benchmarkCandidateSightingsRepository = require("../repositories/benchmarkCandidateSightingsRepository");
const tokenPriceHistoryRepository = require("../repositories/tokenPriceHistoryRepository");

// "Moved significantly" bar for Opportunity Capture / False Negative -
// an unvalidated starting point (same honest framing as
// qualityGateService.js's own thresholds), not a tuned/backtested
// number. A candidate whose real peak price (token_price_history,
// already collected) rose at least this much from the price recorded
// at the moment it first became a BUY-tier candidate counts as a real
// missed/captured opportunity.
const OPPORTUNITY_MOVE_THRESHOLD = 0.5; // +50%

function mean(values){
    const real = values.filter(v => v != null && Number.isFinite(v));
    if(!real.length) return null;
    return real.reduce((s, v) => s + v, 0) / real.length;
}

function parseSqliteTimestamp(ts){
    return new Date(`${String(ts).replace(" ", "T")}Z`).getTime();
}

function computeCoreMetrics(participant){

    const closedSums = benchmarkPositionRepository.sumClosedTrades(participant.id);
    const openSums = benchmarkPositionRepository.sumOpenPositions(participant.id);
    const trades = benchmarkPositionRepository.findTrades(participant.id);
    const openPositions = benchmarkPositionRepository.findOpenPositions(participant.id);

    const availableCash = participant.initial_capital + closedSums.realizedPnl - openSums.openValueAtEntry;
    const finalBalance = availableCash + openSums.openMarketValue;
    const netProfit = finalBalance - participant.initial_capital;
    const grossProfit = closedSums.grossWin - closedSums.grossLoss;

    const winRatePct = closedSums.closedCount ? (closedSums.winCount / closedSums.closedCount) * 100 : null;
    const profitFactor = closedSums.grossLoss > 0
        ? closedSums.grossWin / closedSums.grossLoss
        : (closedSums.grossWin > 0 ? null : null); // undefined/infinite ratio reported as null, never fabricated as a number

    const wins = trades.filter(t => t.roi_pct > 0);
    const losses = trades.filter(t => t.roi_pct <= 0);

    const curve = benchmarkStatisticsRepository.findEquityCurve(participant.id);
    const capitalUtilisationPct = curve.length
        ? mean(curve.map(s => s.equity > 0 ? ((s.equity - s.available_cash) / s.equity) * 100 : 0))
        : null;

    // Signal Latency (report section 7): from decision_at (written once,
    // at open, by services/benchmarkRunner.js) vs opened_at - both real
    // timestamps on the same row, never reconstructed from logs.
    const latencySamples = [...trades, ...openPositions]
        .filter(p => p.decision_at)
        .map(p => (parseSqliteTimestamp(p.opened_at) - parseSqliteTimestamp(p.decision_at)) / 1000);

    return {
        finalBalance, netProfit, grossProfit,
        netReturnPct: (netProfit / participant.initial_capital) * 100,
        totalTrades: trades.length,
        winningTrades: closedSums.winCount,
        losingTrades: closedSums.lossCount,
        winRatePct, profitFactor,
        maxDrawdownPct: benchmarkStatisticsRepository.computeMaxDrawdownPct(participant.id),
        averageWinPct: mean(wins.map(t => t.roi_pct)),
        averageLossPct: mean(losses.map(t => t.roi_pct)),
        averageHoldTimeSeconds: mean(trades.map(t => t.duration_seconds)),
        capitalUtilisationPct,
        openPositionCount: openPositions.length,
        closedPositionCount: trades.length,
        falsePositiveCount: losses.length,
        averageSignalLatencySeconds: mean(latencySamples),
        signalLatencySampleSize: latencySamples.length
    };

}

// Hindsight metrics (report section 7). UPDATED (Profile-Aware
// Production V2 refactor): candidates now come from
// benchmark_candidate_sightings - THIS participant's own profile-scored
// BUY-tier history - instead of the single shared, profile-blind
// prediction_history table. That table is written on the live bot's
// own cadence by whatever profile IT happens to be running, which has
// nothing to do with what a benchmark participant's own profile
// actually saw as a candidate - reusing it here would have silently
// made every participant's hindsight metrics identical again, defeating
// the entire point of this refactor. token_price_history is still the
// same real, already-collected data (no new scoring, no new collection).
function computeHindsightMetrics(run, participant){

    const candidates = benchmarkCandidateSightingsRepository.findByParticipant(participant.id);

    const tradedAddresses = new Set([
        ...benchmarkPositionRepository.findOpenPositions(participant.id),
        ...benchmarkPositionRepository.findTrades(participant.id)
    ].map(p => p.token_address));

    const distinctCandidateAddresses = new Set(candidates.map(c => c.token_address));
    const recommendationAcceptanceRatePct = distinctCandidateAddresses.size
        ? ([...distinctCandidateAddresses].filter(a => tradedAddresses.has(a)).length / distinctCandidateAddresses.size) * 100
        : null;

    let opportunitiesCaptured = 0, missedOpportunities = 0;

    for(const candidate of candidates){
        const entryPrice = candidate.entry_price_at_first_sight;
        if(entryPrice == null || entryPrice <= 0) continue;
        const peak = tokenPriceHistoryRepository.findPeakPrice(candidate.token_address);
        if(peak == null) continue;
        const movedSignificantly = (peak - entryPrice) / entryPrice >= OPPORTUNITY_MOVE_THRESHOLD;
        if(!movedSignificantly) continue;
        if(tradedAddresses.has(candidate.token_address)) opportunitiesCaptured++;
        else missedOpportunities++;
    }

    const totalBigMovers = opportunitiesCaptured + missedOpportunities;

    return {
        buyTierCandidatesInWindow: distinctCandidateAddresses.size,
        recommendationAcceptanceRatePct,
        opportunityCapturePct: totalBigMovers ? (opportunitiesCaptured / totalBigMovers) * 100 : null,
        opportunitiesCaptured,
        falseNegativeCount: missedOpportunities,
        opportunityMoveThresholdPct: OPPORTUNITY_MOVE_THRESHOLD * 100
    };

}

// Funnel visibility (architecture requirement): cumulative, across the
// whole run, of exactly where this participant's own profile lost
// candidates at each stage - written per-tick by benchmarkRunner.js.
function computeFunnelMetrics(participant){
    const sum = benchmarkFunnelRepository.sumForParticipant(participant.id);
    if(!sum || sum.tickCount === 0) return null;
    return {
        tokensScanned: sum.tokensScanned,
        hardRejectCount: sum.hardRejectCount,
        aiCandidatesCount: sum.aiCandidatesCount,
        aiTierPassedCount: sum.aiTierPassedCount,
        entryGateOpenedCount: sum.entryGateOpenedCount,
        entryGateSkippedCount: sum.entryGateSkippedCount,
        profileAware: Boolean(sum.profileAware),
        ticksRecorded: sum.tickCount
    };
}

function computeParticipantReport(run, participant){
    return {
        runParticipantId: participant.id,
        profileName: participant.profile_name,
        initialCapital: participant.initial_capital,
        ...computeCoreMetrics(participant),
        ...computeHindsightMetrics(run, participant),
        funnel: computeFunnelMetrics(participant)
    };
}

// Generates (or regenerates) the report for every participant in a run.
// isFinal mirrors the run's own status - a still-RUNNING run can be
// previewed ("standings so far") without being marked final; a
// COMPLETED/STOPPED run's report is final and should not silently
// change if called again later (metrics are recomputed from the same
// immutable trade history either way, so re-running is safe, just
// redundant).
function generateReport(runId){

    const run = benchmarkRunRepository.findRunById(runId);
    if(!run) return { ok: false, error: "Run not found." };

    const participants = benchmarkRunRepository.findParticipantsByRun(runId);
    const isFinal = ["COMPLETED", "STOPPED"].includes(run.status);

    const reports = participants.map(p => computeParticipantReport(run, p));

    // Ranked by Net Return % - the primary, most comparable metric
    // across participants with potentially different initial capital.
    const ranked = [...reports].sort((a, b) => (b.netReturnPct ?? -Infinity) - (a.netReturnPct ?? -Infinity));

    ranked.forEach((report, index) => {
        benchmarkReportRepository.upsertReport({
            runId,
            runParticipantId: report.runParticipantId,
            rank: index + 1,
            metricsJson: JSON.stringify(report),
            isFinal
        });
    });

    return { ok: true, reports: benchmarkReportRepository.findReportsByRun(runId) };

}

module.exports = { generateReport, OPPORTUNITY_MOVE_THRESHOLD };
