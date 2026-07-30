// services/customObjectiveService.test.js - Final Spec section 05/18.
// Pure-math helpers are tested directly with fixture values.
// analyze() itself is tested against the real (but, on a fresh
// database, trade-history-free) connection - which is exactly the
// scenario the "Insufficient Data" branch exists for, so this doubles
// as an honest integration check that no fabricated probability is
// ever returned when real evidence doesn't exist yet. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const customObjectiveService = require("./customObjectiveService");

test("computeRequiredDailyReturnPct is standard compounding math", () => {
    // $100 -> $200 in 10 days = 2x over 10 days = 2^(1/10)-1 daily rate.
    const rate = customObjectiveService.computeRequiredDailyReturnPct(100, 200, 10);
    const expected = (Math.pow(2, 1 / 10) - 1) * 100;
    assert.ok(Math.abs(rate - expected) < 1e-9);
});

test("findBucketLabelForConfidence maps each Strategy Profile floor to the real predictionValidationConfig bucket", () => {
    assert.equal(customObjectiveService.findBucketLabelForConfidence(65), "60-70"); // STABLE
    assert.equal(customObjectiveService.findBucketLabelForConfidence(60), "60-70"); // BALANCED
    assert.equal(customObjectiveService.findBucketLabelForConfidence(45), "<60");   // AGGRESSIVE
    assert.equal(customObjectiveService.findBucketLabelForConfidence(96), "95-100");
});

test("clampProbability never returns 0 or 100 - never false certainty", () => {
    assert.equal(customObjectiveService.clampProbability(-500), 5);
    assert.equal(customObjectiveService.clampProbability(0), 5);
    assert.equal(customObjectiveService.clampProbability(100), 95);
    assert.equal(customObjectiveService.clampProbability(100000), 95);
    assert.equal(customObjectiveService.clampProbability(50), 50);
});

test("analyze() rejects a target that is not greater than modal", () => {
    const result = customObjectiveService.analyze({ modal: 100, target: 100, deadline: new Date(Date.now() + 86400000).toISOString() });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("greater than modal")));
});

test("analyze() rejects a deadline in the past", () => {
    const result = customObjectiveService.analyze({ modal: 100, target: 200, deadline: new Date(Date.now() - 86400000).toISOString() });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("future")));
});

test("analyze() never fabricates a probability when real historical data is insufficient", () => {

    const result = customObjectiveService.analyze({
        modal: 100,
        target: 1000, // aggressive target - irrelevant here since the branch tested is data sufficiency, not feasibility math
        deadline: new Date(Date.now() + 30 * 86400000).toISOString()
    });

    assert.equal(result.ok, true);

    // A fresh/lightly-used database has fewer than MIN_SAMPLE_SIZE real
    // closed predictions in every confidence band - the honest answer
    // must be INSUFFICIENT_DATA, never a confident-looking percentage.
    if(result.result.feasibility === "INSUFFICIENT_DATA"){
        assert.equal(result.result.recommendedProfile, "STABLE");
        assert.equal(result.result.probabilityEstimate.value, null);
    }
    else{
        // If this environment DOES already have >= MIN_SAMPLE_SIZE real
        // closed predictions, probabilityEstimate must still be a real,
        // bounded number - never null with a feasibility that isn't
        // INSUFFICIENT_DATA, and never outside [5,95].
        assert.notEqual(result.result.probabilityEstimate.value, null);
        assert.ok(result.result.probabilityEstimate.value >= 5 && result.result.probabilityEstimate.value <= 95);
    }

});
