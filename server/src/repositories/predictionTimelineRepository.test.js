// repositories/predictionTimelineRepository.test.js - proves
// pruneForPredictionsOlderThan (RATE_LIMIT_BANNED incident, 2026-08-05 -
// see config/retentionConfig.js's predictionHistoryMaxAgeHours for the
// real production root-cause writeup this closes). The critical
// property under test: this must delete every prediction_timeline row
// for a prediction that predictionHistoryRepository.pruneOlderThan() is
// about to delete, keyed off the PARENT's own prediction_time - not
// this table's own recorded_at - since a 24h-horizon snapshot can be
// recorded up to a day after its parent. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const predictionHistoryRepository = require("./predictionHistoryRepository");
const predictionTimelineRepository = require("./predictionTimelineRepository");
const db = require("../database/connection");

const PREFIX = "PREDTIMELINEREPO_TEST_";

function insertPrediction(tokenAddress){
    return predictionHistoryRepository.insertPrediction({
        tokenAddress, tokenSymbol: "TST", recommendation: "HOLD",
        score: 50, confidence: 50, reasonJson: "[]",
        entryPrice: 1, entryMarketCap: 1000, entryLiquidity: 100, entryVolume: 100, entryHolders: 10,
        walletSummaryJson: null, tradePlanJson: null,
        targetPrice: null, targetMarketCap: null, stopLossPrice: null, stopLossMarketCap: null,
        predictionHorizonSeconds: 86400,
        engineVersion: "test", engineName: "test", exitStrategy: null
    });
}

function backdatePrediction(id, hoursAgo){
    db.prepare("UPDATE prediction_history SET prediction_time = datetime('now', '-' || ? || ' hours') WHERE id = ?").run(hoursAgo, id);
}

test("pruneForPredictionsOlderThan keeps timeline rows whose parent is still within the age bound", () => {

    const id = insertPrediction(`${PREFIX}A`);
    predictionTimelineRepository.insertSnapshot({ predictionId: id, horizon: "30m", roiPct: 1, marketCap: 1000, price: 1 });

    // Parent is only moments old - maxAgeHours=1000 must never touch it.
    const deleted = predictionTimelineRepository.pruneForPredictionsOlderThan(1000);

    assert.equal(deleted, 0);
    assert.equal(predictionTimelineRepository.findExistingHorizons(id).size, 1);

});

test("pruneForPredictionsOlderThan deletes timeline rows once their PARENT (not their own recorded_at) is past the age bound", () => {

    const id = insertPrediction(`${PREFIX}B`);

    // The snapshot itself is inserted "now" (recorded_at is fresh) -
    // exactly the real 24h-horizon case: the parent prediction is old,
    // but its timeline row was only just recorded. Pruning by this
    // table's own recorded_at would wrongly keep it; pruning by the
    // parent's prediction_time (what this function actually does)
    // correctly removes it.
    predictionTimelineRepository.insertSnapshot({ predictionId: id, horizon: "24h", roiPct: 5, marketCap: 1100, price: 1.1 });
    backdatePrediction(id, 400); // older than the 14-day (336h) production retention window

    const deleted = predictionTimelineRepository.pruneForPredictionsOlderThan(336);

    assert.equal(deleted, 1);
    assert.equal(predictionTimelineRepository.findExistingHorizons(id).size, 0);

});

test("pruneForPredictionsOlderThan never touches a different token's still-fresh timeline rows", () => {

    const oldId = insertPrediction(`${PREFIX}C_OLD`);
    backdatePrediction(oldId, 400);
    predictionTimelineRepository.insertSnapshot({ predictionId: oldId, horizon: "30m", roiPct: 1, marketCap: 1000, price: 1 });

    const freshId = insertPrediction(`${PREFIX}C_FRESH`);
    predictionTimelineRepository.insertSnapshot({ predictionId: freshId, horizon: "30m", roiPct: 1, marketCap: 1000, price: 1 });

    predictionTimelineRepository.pruneForPredictionsOlderThan(336);

    assert.equal(predictionTimelineRepository.findExistingHorizons(oldId).size, 0);
    assert.equal(predictionTimelineRepository.findExistingHorizons(freshId).size, 1);

});
