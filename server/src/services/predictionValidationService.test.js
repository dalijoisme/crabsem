// services/predictionValidationService.test.js - proves
// recordTimelineSnapshots' rewritten, per-horizon-windowed scan
// (RATE_LIMIT_BANNED incident follow-up, 2026-08-06 - see that
// function's own header for the real production numbers this closes:
// 491,317 rows re-scanned every ~60s cycle, 60-85s per run). The
// critical property under test: restructuring the scan from
// per-prediction/all-horizons to per-horizon/windowed-predictions must
// produce the SAME real result (every eligible prediction still gets
// every eligible horizon recorded, exactly once, never a stale/missing
// one) - this is a query-shape optimization, not a behavior change.
// Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const predictionHistoryRepository = require("../repositories/predictionHistoryRepository");
const predictionTimelineRepository = require("../repositories/predictionTimelineRepository");
const tokenPriceHistoryRepository = require("../repositories/tokenPriceHistoryRepository");
const db = require("../database/connection");

const { recordTimelineSnapshots } = require("./predictionValidationService");

const PREFIX = "PREDVALSVC_TEST_";

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

function backdatePrediction(id, secondsAgo){
    db.prepare("UPDATE prediction_history SET prediction_time = datetime('now', '-' || ? || ' seconds') WHERE id = ?").run(secondsAgo, id);
}

function insertPriceAt(tokenAddress, price, marketCap, secondsAgo){
    tokenPriceHistoryRepository.insertMany([{ tokenAddress, price, marketCap, liquidity: 100 }]);
    db.prepare(`
        UPDATE token_price_history SET recorded_at = datetime('now', '-' || ? || ' seconds')
        WHERE token_address = ? AND price = ? AND recorded_at = (SELECT MAX(recorded_at) FROM token_price_history WHERE token_address = ?)
    `).run(secondsAgo, tokenAddress, price, tokenAddress);
}

function cleanup(ids){
    for(const id of ids){
        db.prepare("DELETE FROM prediction_timeline WHERE prediction_id = ?").run(id);
    }
    db.prepare("DELETE FROM prediction_history WHERE id IN (" + ids.map(() => "?").join(",") + ")").run(...ids);
}

test("a prediction whose 30m horizon just became due gets a real snapshot recorded from real price history", async () => {

    const tokenAddress = `${PREFIX}A`;
    const id = insertPrediction(tokenAddress, { entryMarketCap: 1000 });

    try{

        // 31 minutes ago - the 30m horizon boundary (prediction_time + 30m)
        // is therefore ~1 minute in the past: due, and inside the
        // narrow per-horizon window (well within the 1h slack).
        backdatePrediction(id, 31 * 60);

        // A real price point recorded AFTER the 30m boundary - this is
        // exactly what findPriceAtOrAfter is meant to find.
        insertPriceAt(tokenAddress, 2.0, 2000, 60);

        const result = await recordTimelineSnapshots();

        assert.ok(result.recorded >= 1, "at least this one real snapshot must have been recorded");

        const rows = predictionTimelineRepository.findByPrediction(id);
        const thirtyMin = rows.find(r => r.horizon === "30m");

        assert.ok(thirtyMin, "the 30m snapshot must exist");
        assert.equal(thirtyMin.market_cap, 2000);
        assert.equal(thirtyMin.roi_pct, 100, "(2000-1000)/1000*100 = 100% real ROI");

    }
    finally{
        cleanup([id]);
        db.prepare("DELETE FROM token_price_history WHERE token_address = ?").run(tokenAddress);
    }

});

test("a prediction outside every horizon's window this cycle is left untouched - never scanned, never recorded", async () => {

    const tokenAddress = `${PREFIX}B`;
    // 3 hours ago - past the 30m horizon's own window entirely (30m +
    // 1h slack = 90m wide, ends 90 minutes ago) - this row must not be
    // picked up by the 30m pass at all.
    const id = insertPrediction(tokenAddress, { entryMarketCap: 1000 });

    try{

        backdatePrediction(id, 3 * 60 * 60);
        insertPriceAt(tokenAddress, 5.0, 5000, 60);

        await recordTimelineSnapshots();

        const rows = predictionTimelineRepository.findByPrediction(id);
        assert.equal(rows.find(r => r.horizon === "30m"), undefined, "too old for the 30m window this cycle - must not have been recorded by it");

    }
    finally{
        cleanup([id]);
        db.prepare("DELETE FROM token_price_history WHERE token_address = ?").run(tokenAddress);
    }

});

test("a prediction whose horizon already has a recorded snapshot is never re-recorded (no duplicate, existingHorizons still respected)", async () => {

    const tokenAddress = `${PREFIX}C`;
    const id = insertPrediction(tokenAddress, { entryMarketCap: 1000 });

    try{

        backdatePrediction(id, 31 * 60);
        insertPriceAt(tokenAddress, 3.0, 3000, 60);

        predictionTimelineRepository.insertSnapshot({ predictionId: id, horizon: "30m", roiPct: 50, marketCap: 1500, price: 1.5 });

        await recordTimelineSnapshots();

        const rows = predictionTimelineRepository.findByPrediction(id).filter(r => r.horizon === "30m");
        assert.equal(rows.length, 1, "must never duplicate an already-recorded horizon");
        assert.equal(rows[0].market_cap, 1500, "the ORIGINAL row must be untouched - never overwritten");

    }
    finally{
        cleanup([id]);
        db.prepare("DELETE FROM token_price_history WHERE token_address = ?").run(tokenAddress);
    }

});

test("two different horizons for the SAME prediction are each checked independently against their own window", async () => {

    const tokenAddress = `${PREFIX}D`;
    const id = insertPrediction(tokenAddress, { entryMarketCap: 1000 });

    try{

        // 61 minutes ago: both the 30m boundary (31 min past due) AND
        // the 1h boundary (1 min past due) are inside their own
        // respective windows this same cycle.
        backdatePrediction(id, 61 * 60);
        insertPriceAt(tokenAddress, 4.0, 4000, 30);

        const result = await recordTimelineSnapshots();

        assert.ok(result.recorded >= 2, "both the 30m and 1h horizons must be recorded in the same run");

        const rows = predictionTimelineRepository.findByPrediction(id);
        assert.ok(rows.find(r => r.horizon === "30m"));
        assert.ok(rows.find(r => r.horizon === "1h"));

    }
    finally{
        cleanup([id]);
        db.prepare("DELETE FROM token_price_history WHERE token_address = ?").run(tokenAddress);
    }

});
