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

test("pruneOlderThan keeps rows still within the real age bound", () => {

    const id = insertPrediction(`${PREFIX}A`);

    const deleted = predictionHistoryRepository.pruneOlderThan(1000);

    assert.equal(deleted, 0);
    assert.ok(predictionHistoryRepository.findById(id));

});

test("pruneOlderThan deletes a pure decision-log row (DECISION_ONLY) once it is past the real age bound", () => {

    const id = insertPrediction(`${PREFIX}B`);
    backdate(id, 400); // older than the 14-day (336h) production retention window

    const deleted = predictionHistoryRepository.pruneOlderThan(336);

    assert.ok(deleted >= 1);
    assert.equal(predictionHistoryRepository.findById(id), undefined);

});

test("pruneOlderThan NEVER deletes a decision row that opened a real trade_positions row, no matter how old", () => {

    const id = insertPrediction(`${PREFIX}C`, { initialStatus: "OPEN" });
    backdate(id, 100000); // absurdly old - the real point is this must still survive

    const opened = tradePositionRepository.openPosition({
        tokenAddress: `${PREFIX}C`, tokenSymbol: "TST", openedByPredictionId: id,
        entryPrice: 1, entryMarketCap: 1000, entryLiquidity: 100, entryVolume: 100, entryHolders: 10,
        targetPrice: 2, targetMarketCap: 2000, stopLossPrice: 0.5, stopLossMarketCap: 500,
        predictionHorizonSeconds: 86400
    });
    assert.ok(opened.opened !== false, "test setup: trade_positions row must open cleanly");

    const deleted = predictionHistoryRepository.pruneOlderThan(1);

    assert.ok(predictionHistoryRepository.findById(id), "a real trade's own decision-log row must survive pruning regardless of age");
    // deleted may be >0 from other unrelated old rows in this same run,
    // but must never include id above (asserted directly).

});
