// services/dailyReviewService.test.js - Arjuna V4 Phase 2. Proves the
// Daily Trading Review's aggregation is a real, correct computation over
// real trade rows - win/loss classification, official ROI selection
// (realized_roi_pct falling back to roi_pct, same convention
// tradingBotService.js already established), profit/win-rate math,
// exit-reason distribution, best/worst pattern selection with its
// sample-size guard, and that persistence round-trips through
// dailyReviewRepository. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const dailyReviewService = require("./dailyReviewService");
const dailyReviewRepository = require("../repositories/dailyReviewRepository");
const db = require("../database/connection");

const PREFIX = "DAILYREVIEWSVC_TEST_";
const DATE = "2026-08-01";

const insertTradeStmt = db.prepare(`
    INSERT INTO trading_bot_trades (
        token_address, roi_pct, realized_roi_pct, size_usd, fee_usd, reason, closed_at,
        confidence, participant_score, market_health, token_age_minutes_at_entry,
        liquidity_at_entry, duration_seconds, mfe_pct, mae_pct,
        entry_reasons_json, risk_reasons_json, realtime_pulse_at_entry_json, confidence_adjustment_at_entry_json
    ) VALUES (
        @tokenAddress, @roiPct, @realizedRoiPct, @sizeUsd, @feeUsd, @reason, @closedAt,
        @confidence, @participantScore, @marketHealth, @tokenAgeMinutesAtEntry,
        @liquidityAtEntry, @durationSeconds, @mfePct, @maePct,
        @entryReasonsJson, @riskReasonsJson, @realtimePulseAtEntryJson, @confidenceAdjustmentAtEntryJson
    )
`);

function insertTrade(overrides = {}){
    insertTradeStmt.run({
        tokenAddress: `${PREFIX}A`, roiPct: 10, realizedRoiPct: null, sizeUsd: 100, feeUsd: 1, reason: "TP1", closedAt: `${DATE} 12:00:00`,
        confidence: 70, participantScore: 60, marketHealth: 50, tokenAgeMinutesAtEntry: 20,
        liquidityAtEntry: 5000, durationSeconds: 300, mfePct: 15, maePct: -3,
        entryReasonsJson: JSON.stringify(["Smart money accumulation"]),
        riskReasonsJson: JSON.stringify([]),
        realtimePulseAtEntryJson: null,
        confidenceAdjustmentAtEntryJson: null,
        ...overrides
    });
}

function adjustment(overrides = {}){
    return JSON.stringify({
        pulse: { pct: 0 }, tokenAge: { multiplier: 1 }, fakePump: { pct: 0 },
        kol: { pct: 0 }, smartMoney: { pct: 0 }, combinedMultiplier: 1,
        ...overrides
    });
}

test.afterEach(() => {
    db.prepare("DELETE FROM trading_bot_trades WHERE token_address LIKE ?").run(`${PREFIX}%`);
    db.prepare("DELETE FROM daily_trading_reviews WHERE review_date = ?").run(DATE);
});

test("generateReview reports zero/null honestly for a day with no real trades - never fabricated", () => {

    const report = dailyReviewService.generateReview(DATE);

    assert.equal(report.tradingSummary.totalTrades, 0);
    assert.equal(report.tradingSummary.winRate, null);
    assert.equal(report.tradingSummary.averageRoiPct, null);
    assert.deepEqual(report.exitReasonDistribution, {});
    assert.equal(report.bestPerformingPattern, null);

});

test("win/loss classification and win rate use the official ROI (realized_roi_pct falling back to roi_pct)", () => {

    insertTrade({ tokenAddress: `${PREFIX}A`, roiPct: 10, realizedRoiPct: null, closedAt: `${DATE} 01:00:00` }); // win via legacy roi_pct
    insertTrade({ tokenAddress: `${PREFIX}B`, roiPct: 999, realizedRoiPct: -5, closedAt: `${DATE} 02:00:00` }); // realized overrides legacy - real loss despite a fake-looking roi_pct
    insertTrade({ tokenAddress: `${PREFIX}C`, roiPct: -20, realizedRoiPct: null, closedAt: `${DATE} 03:00:00` }); // loss

    const report = dailyReviewService.generateReview(DATE);

    assert.equal(report.tradingSummary.totalTrades, 3);
    assert.equal(report.tradingSummary.winCount, 1);
    assert.equal(report.tradingSummary.lossCount, 2);
    assert.equal(report.tradingSummary.winRate, Math.round((1/3) * 100) / 100);

});

test("netProfitUsd uses size_usd * roiPct/100 - fee_usd per trade, summed - the same formula tradingBotService.js already uses", () => {

    insertTrade({ tokenAddress: `${PREFIX}A`, roiPct: 20, sizeUsd: 100, feeUsd: 1, closedAt: `${DATE} 01:00:00` }); // +19
    insertTrade({ tokenAddress: `${PREFIX}B`, roiPct: -10, sizeUsd: 200, feeUsd: 2, closedAt: `${DATE} 02:00:00` }); // -22

    const report = dailyReviewService.generateReview(DATE);

    assert.equal(report.tradingSummary.netProfitUsd, -3); // 19 - 22

});

test("exitReasonDistribution counts real reason strings, and bestPerformingPattern requires at least 2 real trades in a group", () => {

    insertTrade({ tokenAddress: `${PREFIX}A`, reason: "TP1", roiPct: 50, closedAt: `${DATE} 01:00:00` });
    insertTrade({ tokenAddress: `${PREFIX}B`, reason: "STOP_LOSS", roiPct: -20, closedAt: `${DATE} 02:00:00` });
    insertTrade({ tokenAddress: `${PREFIX}C`, reason: "STOP_LOSS", roiPct: -20, closedAt: `${DATE} 03:00:00` });

    const report = dailyReviewService.generateReview(DATE);

    assert.deepEqual(report.exitReasonDistribution, { TP1: 1, STOP_LOSS: 2 });

    // TP1 has only 1 real trade - must NOT be eligible as "best pattern"
    // despite its higher average ROI (the sample-size guard).
    assert.equal(report.bestPerformingPattern.reason, "STOP_LOSS", "a single-trade group must never be crowned best/worst pattern");
    assert.equal(report.worstPerformingPattern.reason, "STOP_LOSS");

});

test("entry quality analyses split winners vs losers by real per-trade fields", () => {

    insertTrade({ tokenAddress: `${PREFIX}A`, roiPct: 50, tokenAgeMinutesAtEntry: 15, closedAt: `${DATE} 01:00:00` }); // win, young
    insertTrade({ tokenAddress: `${PREFIX}B`, roiPct: -30, tokenAgeMinutesAtEntry: 500, closedAt: `${DATE} 02:00:00` }); // loss, old

    const report = dailyReviewService.generateReview(DATE);

    assert.equal(report.entryQuality.tokenAgeAnalysis.winnersAvg, 15);
    assert.equal(report.entryQuality.tokenAgeAnalysis.losersAvg, 500);

});

test("mostCommonWinningConditions/top5ProfitReasons build a real frequency table from entry_reasons_json, winners only", () => {

    insertTrade({ tokenAddress: `${PREFIX}A`, roiPct: 20, entryReasonsJson: JSON.stringify(["Smart money accumulation", "KOL activity"]), closedAt: `${DATE} 01:00:00` });
    insertTrade({ tokenAddress: `${PREFIX}B`, roiPct: 30, entryReasonsJson: JSON.stringify(["Smart money accumulation"]), closedAt: `${DATE} 02:00:00` });
    insertTrade({ tokenAddress: `${PREFIX}C`, roiPct: -10, entryReasonsJson: JSON.stringify(["Smart money accumulation"]), closedAt: `${DATE} 03:00:00` }); // loser - must NOT count toward winning conditions

    const report = dailyReviewService.generateReview(DATE);

    assert.deepEqual(report.mostCommonWinningConditions[0], { reason: "Smart money accumulation", count: 2 });
    assert.ok(!report.mostCommonWinningConditions.find(r => r.reason === "Smart money accumulation" && r.count === 3), "the losing trade's identical reason string must not be folded into the winners-only count");

});

test("realtimeSignalStatistics reports real coverage - only trades with an actual buffered reading count", () => {

    insertTrade({ tokenAddress: `${PREFIX}A`, realtimePulseAtEntryJson: JSON.stringify({ bufferLength: 2, flowDirectionVoteProvisional: "UP" }), closedAt: `${DATE} 01:00:00` });
    insertTrade({ tokenAddress: `${PREFIX}B`, realtimePulseAtEntryJson: null, closedAt: `${DATE} 02:00:00` }); // no Pulse data at all - must not count
    insertTrade({ tokenAddress: `${PREFIX}C`, realtimePulseAtEntryJson: JSON.stringify({ bufferLength: 0, flowDirectionVoteProvisional: null }), closedAt: `${DATE} 03:00:00` }); // present but empty buffer - must not count as real coverage

    const report = dailyReviewService.generateReview(DATE);

    assert.equal(report.realtimeSignalStatistics.tradesWithRealtimePulseData, 1);
    assert.equal(report.realtimeSignalStatistics.totalTrades, 3);

});

test("suggestedObservations are plain comparative facts, never a directive - and the field is never named as an auto-applied adjustment", () => {

    insertTrade({ tokenAddress: `${PREFIX}A`, roiPct: 50, tokenAgeMinutesAtEntry: 15, closedAt: `${DATE} 01:00:00` });
    insertTrade({ tokenAddress: `${PREFIX}B`, roiPct: -30, tokenAgeMinutesAtEntry: 500, closedAt: `${DATE} 02:00:00` });

    const report = dailyReviewService.generateReview(DATE);

    assert.ok(Array.isArray(report.suggestedObservations));
    assert.ok(report.suggestedObservations.some(o => o.includes("Token age at entry")));
    assert.ok(!("suggestedParameterAdjustments" in report), "must never be named as if it auto-applies a change - see this file's own FORMULA POLICY header");

});

test("generateAndPersistReview writes a real, re-loadable row via dailyReviewRepository", () => {

    insertTrade({ tokenAddress: `${PREFIX}A`, roiPct: 25, closedAt: `${DATE} 01:00:00` });

    const report = dailyReviewService.generateAndPersistReview(DATE);

    const persisted = dailyReviewRepository.findByDate(DATE);
    assert.equal(persisted.total_trades, 1);
    assert.equal(JSON.parse(persisted.report_json).reviewDate, DATE);
    assert.equal(persisted.total_trades, report.tradingSummary.totalTrades);

});

// Arjuna V4 FINAL DECISION ENGINE SPRINT - real effectiveness stats per
// confidence-adjustment component, measured from the real, persisted
// confidence_adjustment_at_entry_json column (migration 069).

test("confidenceAdjustmentEffectiveness.realtimePulse groups trades by real pulse.pct sign and reports real win rate per group", () => {

    insertTrade({ tokenAddress: `${PREFIX}A`, roiPct: 30, closedAt: `${DATE} 01:00:00`, confidenceAdjustmentAtEntryJson: adjustment({ pulse: { pct: 15 } }) }); // win, boosted
    insertTrade({ tokenAddress: `${PREFIX}B`, roiPct: -10, closedAt: `${DATE} 02:00:00`, confidenceAdjustmentAtEntryJson: adjustment({ pulse: { pct: -15 } }) }); // loss, penalized

    const report = dailyReviewService.generateReview(DATE);
    const eff = report.confidenceAdjustmentEffectiveness.realtimePulse;

    assert.equal(eff.positiveAdjustment.count, 1);
    assert.equal(eff.positiveAdjustment.winRate, 1);
    assert.equal(eff.negativeAdjustment.count, 1);
    assert.equal(eff.negativeAdjustment.winRate, 0);

});

test("confidenceAdjustmentEffectiveness.tokenAge groups by multiplier relative to the neutral 1.00x bucket", () => {

    insertTrade({ tokenAddress: `${PREFIX}A`, roiPct: 20, closedAt: `${DATE} 01:00:00`, confidenceAdjustmentAtEntryJson: adjustment({ tokenAge: { multiplier: 0.95 } }) });
    insertTrade({ tokenAddress: `${PREFIX}B`, roiPct: -20, closedAt: `${DATE} 02:00:00`, confidenceAdjustmentAtEntryJson: adjustment({ tokenAge: { multiplier: 0.60 } }) });
    insertTrade({ tokenAddress: `${PREFIX}C`, roiPct: 10, closedAt: `${DATE} 03:00:00`, confidenceAdjustmentAtEntryJson: adjustment({ tokenAge: { multiplier: 1 } }) });

    const report = dailyReviewService.generateReview(DATE);
    const eff = report.confidenceAdjustmentEffectiveness.tokenAge;

    assert.equal(eff.veryYoung.count, 1);
    assert.equal(eff.older.count, 1);
    assert.equal(eff.neutral.count, 1);

});

test("confidenceAdjustmentEffectiveness.fakePump reports real penalized-vs-clean win rates", () => {

    insertTrade({ tokenAddress: `${PREFIX}A`, roiPct: -30, closedAt: `${DATE} 01:00:00`, confidenceAdjustmentAtEntryJson: adjustment({ fakePump: { pct: -25 } }) });
    insertTrade({ tokenAddress: `${PREFIX}B`, roiPct: 25, closedAt: `${DATE} 02:00:00`, confidenceAdjustmentAtEntryJson: adjustment({ fakePump: { pct: 0 } }) });

    const report = dailyReviewService.generateReview(DATE);
    const eff = report.confidenceAdjustmentEffectiveness.fakePump;

    assert.equal(eff.penalizedCount, 1);
    assert.equal(eff.penalized.winRate, 0);
    assert.equal(eff.clean.winRate, 1);

});

test("confidenceAdjustmentEffectiveness honestly reports zero sample size when no trade has any real adjustment data", () => {
    insertTrade({ tokenAddress: `${PREFIX}A`, roiPct: 10, closedAt: `${DATE} 01:00:00`, confidenceAdjustmentAtEntryJson: null });
    const report = dailyReviewService.generateReview(DATE);
    assert.equal(report.confidenceAdjustmentEffectiveness.sampleSize, 0);
});

test("bestTrades/worstTrades return real, ROI-sorted individual trades, capped at 5", () => {

    for(let i = 0; i < 7; i++){
        insertTrade({ tokenAddress: `${PREFIX}T${i}`, roiPct: i * 10 - 30, closedAt: `${DATE} 0${(i % 9) + 1}:00:00` });
    }

    const report = dailyReviewService.generateReview(DATE);

    assert.equal(report.bestTrades.length, 5);
    assert.equal(report.worstTrades.length, 5);
    assert.ok(report.bestTrades[0].roiPct >= report.bestTrades[1].roiPct, "best trades must be sorted highest ROI first");
    assert.ok(report.worstTrades[0].roiPct <= report.worstTrades[1].roiPct, "worst trades must be sorted lowest ROI first");

});

test("exitStatistics exposes the full per-reason breakdown (not just counts), including the two new momentum-aware exit reasons", () => {

    insertTrade({ tokenAddress: `${PREFIX}A`, reason: "MOMENTUM_WEAKENING_EARLY_EXIT", roiPct: 18, closedAt: `${DATE} 01:00:00` });
    insertTrade({ tokenAddress: `${PREFIX}B`, reason: "MAE_ACCELERATED_EXIT", roiPct: -12, closedAt: `${DATE} 02:00:00` });

    const report = dailyReviewService.generateReview(DATE);

    assert.ok(report.exitStatistics.MOMENTUM_WEAKENING_EARLY_EXIT);
    assert.equal(report.exitStatistics.MOMENTUM_WEAKENING_EARLY_EXIT.averageRoiPct, 18);
    assert.ok(report.exitStatistics.MAE_ACCELERATED_EXIT);
    assert.equal(report.exitStatistics.MAE_ACCELERATED_EXIT.averageRoiPct, -12);

});
