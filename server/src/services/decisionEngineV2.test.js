// services/decisionEngineV2.test.js - Decision Engine V2 sprint. Proves
// every layer (2-5) with hand-computed numbers, including the sample-
// size gating/fallback that keeps V2 safe on thin data. No real database
// used anywhere here - loadHistoricalTrades is exercised with a fake
// `db` double; every other function is pure and takes plain data. Run
// with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    loadHistoricalTrades,
    buildHistoricalStatsIndex,
    lookupBestHistoricalMatch,
    computeConfidenceV2,
    decide,
    evaluateV2,
    defaultConfig
} = require("./decisionEngineV2");

function trade(roiPct, reasons){
    return { roi_pct: roiPct, duration_seconds: 120, breakdown_json: JSON.stringify({ reasons }) };
}

// ---------------------------------------------------------------------
// Layer 3a - loadHistoricalTrades (fake db double, no real database)
// ---------------------------------------------------------------------

test("loadHistoricalTrades queries without a user filter when userId is omitted", () => {
    let capturedSql, capturedParams;
    const fakeDb = { prepare(sql){ capturedSql = sql; return { all: (params) => { capturedParams = params; return []; } }; } };
    loadHistoricalTrades(fakeDb, {});
    assert.match(capturedSql, /trading_bot_trades/);
    assert.match(capturedSql, /trading_bot_positions/);
    assert.doesNotMatch(capturedSql, /@userId/);
    assert.deepEqual(capturedParams, {});
});

test("loadHistoricalTrades adds the user filter and binds userId when provided", () => {
    let capturedSql, capturedParams;
    const fakeDb = { prepare(sql){ capturedSql = sql; return { all: (params) => { capturedParams = params; return []; } }; } };
    loadHistoricalTrades(fakeDb, { userId: 8 });
    assert.match(capturedSql, /@userId/);
    assert.deepEqual(capturedParams, { userId: 8 });
});

// ---------------------------------------------------------------------
// Layer 3b/3c - buildHistoricalStatsIndex / lookupBestHistoricalMatch
// ---------------------------------------------------------------------

const sampleTrades = [
    trade(20, ["Net accumulation detected ($100 net buys)", "Smart money detected ($50)"]),
    trade(-10, ["Net accumulation detected ($200 net buys)"]),
    trade(30, ["Net accumulation detected ($300 net buys)", "Smart money detected ($60)"])
];

test("buildHistoricalStatsIndex tallies a single feature across all trades that carry it, normalized", () => {
    const index = buildHistoricalStatsIndex(sampleTrades);
    const acc = index.get("Net accumulation detected");
    assert.equal(acc.n, 3);
    assert.equal(acc.wins, 2);
    assert.equal(acc.losses, 1);
    assert.equal(acc.winRatePct, 66.67);
    assert.equal(acc.avgRoiPct, 13.33);
    assert.equal(acc.medianRoiPct, 20);
});

test("buildHistoricalStatsIndex tallies a pair only across trades that carry BOTH features", () => {
    const index = buildHistoricalStatsIndex(sampleTrades);
    const pair = index.get("Net accumulation detected + Smart money detected");
    assert.equal(pair.n, 2);
    assert.equal(pair.winRatePct, 100);
    assert.equal(pair.avgRoiPct, 25);
});

test("lookupBestHistoricalMatch picks the combination with the LARGEST sample size, not the most specific one", () => {
    const index = buildHistoricalStatsIndex(sampleTrades);
    // Candidate has both features - the pair (n=2) exists, but the single
    // "Net accumulation detected" (n=3) has more real evidence and must win.
    const match = lookupBestHistoricalMatch(index, ["Net accumulation detected ($999)", "Smart money detected ($1)"]);
    assert.equal(match.comboKey, "Net accumulation detected");
    assert.equal(match.n, 3);
});

test("lookupBestHistoricalMatch returns null when the candidate's features have no historical record at all", () => {
    const index = buildHistoricalStatsIndex(sampleTrades);
    const match = lookupBestHistoricalMatch(index, ["Completely unseen feature"]);
    assert.equal(match, null);
});

// ---------------------------------------------------------------------
// Layer 4 - computeConfidenceV2 (hand-computed expected values against
// the default config: weights 0.5/0.3/0.2, hard floor 5, reliable 20)
// ---------------------------------------------------------------------

test("computeConfidenceV2 with no historical match returns the base score untouched", () => {
    const result = computeConfidenceV2(70, null);
    assert.equal(result.confidenceV2, 70);
    assert.equal(result.usedHistorical, false);
    assert.equal(result.sampleConfidenceFactor, 0);
});

test("computeConfidenceV2 below the hard sample floor (n<5) ignores historical entirely", () => {
    const result = computeConfidenceV2(70, { n: 3, winRatePct: 90, avgRoiPct: 50 });
    assert.equal(result.confidenceV2, 70);
    assert.equal(result.usedHistorical, false);
    assert.equal(result.sampleConfidenceFactor, 0);
});

test("computeConfidenceV2 at/above the reliable sample size applies the full configured blend", () => {
    // baseScore=60, historical winRatePct=70, avgRoiPct=15 -> roiScore=clamp(50+15,0,100)=65
    // confidenceV2 = 60*0.5 + 70*0.3 + 65*0.2 = 30 + 21 + 13 = 64
    const result = computeConfidenceV2(60, { n: 20, winRatePct: 70, avgRoiPct: 15 });
    assert.equal(result.sampleConfidenceFactor, 1);
    assert.equal(result.confidenceV2, 64);
    assert.equal(result.usedHistorical, true);
});

test("computeConfidenceV2 between the hard floor and reliable size ramps linearly", () => {
    // n=12 -> sampleConfidenceFactor = 12/20 = 0.6
    // effectiveBaseWeight = 0.5 + 0.5*0.4 = 0.7, winRateWeight=0.3*0.6=0.18, roiWeight=0.2*0.6=0.12
    // roiScore = clamp(50+15,0,100) = 65
    // confidenceV2 = 60*0.7 + 70*0.18 + 65*0.12 = 42 + 12.6 + 7.8 = 62.4
    const result = computeConfidenceV2(60, { n: 12, winRatePct: 70, avgRoiPct: 15 });
    assert.equal(result.sampleConfidenceFactor, 0.6);
    assert.equal(result.confidenceV2, 62.4);
});

test("computeConfidenceV2 throws a loud error if a custom config's weights don't sum to 1 - never silently renormalized", () => {
    const badConfig = { ...defaultConfig, weights: { baseScore: 0.6, historicalWinRate: 0.3, expectedRoi: 0.2 } };
    assert.throws(() => computeConfidenceV2(60, { n: 20, winRatePct: 70, avgRoiPct: 15 }, badConfig), /must sum to 1/);
});

// ---------------------------------------------------------------------
// Layer 5 - decide()
// ---------------------------------------------------------------------

test("decide falls back to base scoring untouched when historical wasn't used (thin sample)", () => {
    const confidenceResult = { confidenceV2: 70, usedHistorical: false };
    const result = decide({ action: "BUY", confidence: 70 }, { n: 3, winRatePct: 10, avgRoiPct: -50 }, confidenceResult);
    assert.equal(result.action, "BUY");
    assert.equal(result.fallbackToBaseScoring, true);
});

test("decide downgrades BUY to HOLD when historical win rate is below the floor", () => {
    const confidenceResult = { confidenceV2: 55, usedHistorical: true };
    const result = decide({ action: "BUY" }, { n: 20, winRatePct: 24, avgRoiPct: -11 }, confidenceResult);
    assert.equal(result.action, "HOLD");
    assert.ok(result.reasoning.some(r => r.includes("Downgraded to HOLD")));
});

test("decide downgrades STRONG BUY to HOLD when historical avg ROI is negative, even with a good win rate", () => {
    const confidenceResult = { confidenceV2: 55, usedHistorical: true };
    const result = decide({ action: "STRONG BUY" }, { n: 20, winRatePct: 80, avgRoiPct: -5 }, confidenceResult);
    assert.equal(result.action, "HOLD");
});

test("decide keeps BUY when historical evidence is genuinely good, and reports the 3 required reasoning lines", () => {
    const confidenceResult = { confidenceV2: 74, usedHistorical: true };
    const result = decide({ action: "BUY" }, { n: 41, winRatePct: 68, avgRoiPct: 12 }, confidenceResult);
    assert.equal(result.action, "BUY");
    assert.ok(result.reasoning.some(r => r.includes("win rate: 68%")));
    assert.ok(result.reasoning.some(r => r.includes("Sample: 41 trades")));
    assert.ok(result.reasoning.some(r => r.includes("Expected ROI: +12%")));
});

test("decide never upgrades a base HOLD/AVOID into a BUY, regardless of how good the historical stats are", () => {
    const confidenceResult = { confidenceV2: 90, usedHistorical: true };
    const result = decide({ action: "HOLD" }, { n: 50, winRatePct: 95, avgRoiPct: 40 }, confidenceResult);
    assert.equal(result.action, "HOLD");
});

// ---------------------------------------------------------------------
// Top-level orchestrator
// ---------------------------------------------------------------------

test("evaluateV2 end-to-end: good historical evidence keeps a BUY and reports full reasoning", () => {
    const richTrades = Array.from({ length: 25 }, (_, i) =>
        trade(i % 5 === 0 ? -5 : 20, ["Net accumulation detected ($1)", "Smart money detected ($1)"])
    ); // 5 losses, 20 wins out of 25 -> 80% win rate, positive avg ROI
    const index = buildHistoricalStatsIndex(richTrades);
    const baseSignal = { action: "BUY", confidence: 60, risk: "MEDIUM", reasons: ["Net accumulation detected ($5)", "Smart money detected ($5)"], riskReasons: [] };

    const result = evaluateV2(baseSignal, index);

    assert.equal(result.baseAction, "BUY");
    assert.equal(result.action, "BUY");
    assert.equal(result.fallbackToBaseScoring, false);
    assert.ok(result.historical.n >= 20);
    assert.ok(result.reasoning.length >= 3);
});

test("evaluateV2 end-to-end: no historical record at all falls back to base scoring untouched", () => {
    const index = buildHistoricalStatsIndex(sampleTrades);
    const baseSignal = { action: "BUY", confidence: 55, risk: "LOW", reasons: ["Totally novel feature never seen before"], riskReasons: [] };

    const result = evaluateV2(baseSignal, index);

    assert.equal(result.action, "BUY");
    assert.equal(result.confidence, 55);
    assert.equal(result.fallbackToBaseScoring, true);
});
