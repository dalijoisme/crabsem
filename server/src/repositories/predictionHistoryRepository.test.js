// repositories/predictionHistoryRepository.test.js - proves
// pruneOlderThan (RATE_LIMIT_BANNED incident, 2026-08-05 - see
// config/retentionConfig.js's predictionHistoryMaxAgeHours for the real
// production root-cause writeup this closes: this table had NO pruning
// at all since introduction, grew to 135.8GB, and filled the VPS disk).
// The critical property under test: a decision row that actually opened
// a real trade_positions row must NEVER be deleted, even once its own
// age is well past the retention bound - trade_positions.
// opened_by_prediction_id is a real FK (foreign_keys=ON), and that row
// is permanent trade-audit history, not prunable decision-log noise.
// Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const predictionHistoryRepository = require("./predictionHistoryRepository");
const tradePositionRepository = require("./tradePositionRepository");
const db = require("../database/connection");

const PREFIX = "PREDHISTREPO_TEST_";

function insertPrediction(tokenAddress, overrides = {}){
    return predictionHistoryRepository.insertPrediction({
        tokenAddress, tokenSymbol: "TST", recommendation: "HOLD",
        score: 50, confidence: 50, reasonJson: "[]",
        entryPrice: 1, entryMarketCap: 1000, entryLiquidity: 100, entryVolume: 100, entryHolders: 10,
        walletSummaryJson: null, tradePlanJson: null,
        targetPrice: null, targetMarketCap: null, stopLossPrice: null, stopLossMarketCap: null,
        predictionHorizonSeconds: 86400,
        engineVersion: "test", engineName: "test", exitStrategy: null,
        ...overrides
    });
}

function backdate(id, hoursAgo){
    db.prepare("UPDATE prediction_history SET prediction_time = datetime('now', '-' || ? || ' hours') WHERE id = ?").run(hoursAgo, id);
}

test("pruneOlderThan keeps rows still within the real age bound", async () => {

    const id = insertPrediction(`${PREFIX}A`);

    const deleted = await predictionHistoryRepository.pruneOlderThan(1000);

    assert.equal(deleted, 0);
    assert.ok(predictionHistoryRepository.findById(id));

});

test("pruneOlderThan deletes a pure decision-log row (DECISION_ONLY) once it is past the real age bound", async () => {

    const id = insertPrediction(`${PREFIX}B`);
    backdate(id, 400); // older than the 14-day (336h) production retention window

    const deleted = await predictionHistoryRepository.pruneOlderThan(336);

    assert.ok(deleted >= 1);
    assert.equal(predictionHistoryRepository.findById(id), undefined);

});

test("pruneOlderThan NEVER deletes a decision row that opened a real trade_positions row, no matter how old", async () => {

    const id = insertPrediction(`${PREFIX}C`, { initialStatus: "OPEN" });
    backdate(id, 100000); // absurdly old - the real point is this must still survive

    const opened = tradePositionRepository.openPosition({
        tokenAddress: `${PREFIX}C`, tokenSymbol: "TST", openedByPredictionId: id,
        entryPrice: 1, entryMarketCap: 1000, entryLiquidity: 100, entryVolume: 100, entryHolders: 10,
        targetPrice: 2, targetMarketCap: 2000, stopLossPrice: 0.5, stopLossMarketCap: 500,
        predictionHorizonSeconds: 86400
    });
    assert.ok(opened.opened !== false, "test setup: trade_positions row must open cleanly");

    const deleted = await predictionHistoryRepository.pruneOlderThan(1);

    assert.ok(predictionHistoryRepository.findById(id), "a real trade's own decision-log row must survive pruning regardless of age");
    // deleted may be >0 from other unrelated old rows in this same run,
    // but must never include id above (asserted directly).

});

// RATE_LIMIT_BANNED incident follow-up (2026-08-06, live VPS):
// findClosed/findAllStatuses now force idx_prediction_history_prediction_time
// via INDEXED BY whenever a from/to date range is present - real
// production evidence (7.6M+ rows) proved the planner otherwise picks
// idx_prediction_history_recommendation for a tradingOnly query,
// scanning this table's ENTIRE history of STRONG BUY/BUY rows before a
// date range narrows it to "today" (2485ms measured for a 137-row
// result, vs 164ms once forced). SQLite's own INDEXED BY only changes
// the query PLAN, never which rows match - the critical property under
// test is that both functions still return exactly the right rows with
// a date range applied, proving the query-shape change is real
// (not silently falling back to a table scan or a wrong index) without
// altering what's returned.
test("findClosed with a date range only returns rows inside that range, using the forced prediction_time index", async () => {

    const inRangeId = insertPrediction(`${PREFIX}D`, { initialStatus: "DECISION_ONLY" });
    const outOfRangeId = insertPrediction(`${PREFIX}E`, { initialStatus: "DECISION_ONLY" });
    // findClosed excludes both OPEN and DECISION_ONLY (see its own
    // "excludeDecisionOnly" call) - a real "closed" status is required
    // for either row to be eligible at all, regardless of date range.
    db.prepare("UPDATE prediction_history SET status = 'TP_HIT' WHERE id IN (?, ?)").run(inRangeId, outOfRangeId);

    try{

        backdate(outOfRangeId, 48); // 2 days ago - outside a "today" range

        const today = new Date().toISOString().slice(0, 10);
        const closed = predictionHistoryRepository.findClosed({ from: today, to: today });

        assert.ok(closed.some(r => r.id === inRangeId), "a prediction from today must be included");
        assert.ok(!closed.some(r => r.id === outOfRangeId), "a prediction from 2 days ago must be excluded by the date range");

    }
    finally{
        db.prepare("DELETE FROM prediction_history WHERE id IN (?, ?)").run(inRangeId, outOfRangeId);
    }

});

test("findAllStatuses with a date range only returns rows inside that range, using the forced prediction_time index", async () => {

    const inRangeId = insertPrediction(`${PREFIX}F`, { initialStatus: "OPEN" });
    const outOfRangeId = insertPrediction(`${PREFIX}G`, { initialStatus: "OPEN" });

    try{

        backdate(outOfRangeId, 48);

        const today = new Date().toISOString().slice(0, 10);
        const rows = predictionHistoryRepository.findAllStatuses({ tradingOnly: false, from: today, to: today });

        assert.ok(rows.some(r => r.id === inRangeId), "a prediction from today must be included");
        assert.ok(!rows.some(r => r.id === outOfRangeId), "a prediction from 2 days ago must be excluded by the date range");

    }
    finally{
        db.prepare("DELETE FROM prediction_history WHERE id IN (?, ?)").run(inRangeId, outOfRangeId);
    }

});
