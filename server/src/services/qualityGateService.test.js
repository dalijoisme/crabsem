// services/qualityGateService.test.js - Strategy Profile refactor:
// proves passesQualityGate(token, overrides) is backward compatible
// (omitted overrides = today's global QUALITY_GATE thresholds exactly)
// AND that a profile's overrides genuinely change the verdict.
// gmgnTrenchesRepository is monkey-patched (same pattern used
// elsewhere in this codebase for instrumented/isolated testing) rather
// than hitting the real dev DB. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const gmgnTrenchesRepository = require("../repositories/gmgnTrenchesRepository");
const { passesQualityGate, QUALITY_GATE } = require("./qualityGateService");

function withFakeTrenches(row, fn){
    const original = gmgnTrenchesRepository.findByTokenAddress;
    gmgnTrenchesRepository.findByTokenAddress = () => row;
    try{ fn(); }
    finally{ gmgnTrenchesRepository.findByTokenAddress = original; }
}

test("QUALITY_GATE default export is unchanged (today's global thresholds)", () => {
    assert.equal(QUALITY_GATE.maxRugRatio, 0.70);
    assert.equal(QUALITY_GATE.maxTop10HolderRate, 0.60);
    assert.equal(QUALITY_GATE.maxBundlerMhrWithLowLiquidity, 0.95);
    assert.equal(QUALITY_GATE.minSerialCreatorCount, 500);
    assert.equal(QUALITY_GATE.maxSerialCreatorOpenRatio, 0.05);
});

test("passesQualityGate with no trenches row passes regardless of overrides (never fabricates a rejection)", () => {
    const token = { token_address: "X" };
    assert.equal(passesQualityGate(token).pass, true);
    assert.equal(passesQualityGate(token, { maxRugRatio: 0.01 }).pass, true);
});

test("omitted overrides reproduce today's global verdict exactly (rug ratio 0.65 passes at the 0.70 default)", () => {
    withFakeTrenches({ rug_ratio: 0.65, top_10_holder_rate: 0.1, raw_json: "{}" }, () => {
        const token = { token_address: "X" };
        const result = passesQualityGate(token);
        assert.equal(result.pass, true);
    });
});

test("a stricter profile override (BASELINE-style maxRugRatio:0.50) rejects the same token the default would pass", () => {
    withFakeTrenches({ rug_ratio: 0.65, top_10_holder_rate: 0.1, raw_json: "{}" }, () => {
        const token = { token_address: "X" };
        assert.equal(passesQualityGate(token).pass, true);
        const stricter = passesQualityGate(token, { maxRugRatio: 0.50 });
        assert.equal(stricter.pass, false);
        assert.equal(stricter.reason, "REJECTED_RUG_RATIO_EXTREME");
    });
});

test("a looser profile override (AGGRESSIVE-style maxRugRatio:0.75) passes a token the default would reject", () => {
    withFakeTrenches({ rug_ratio: 0.72, top_10_holder_rate: 0.1, raw_json: "{}" }, () => {
        const token = { token_address: "X" };
        assert.equal(passesQualityGate(token).pass, false);
        const looser = passesQualityGate(token, { maxRugRatio: 0.75 });
        assert.equal(looser.pass, true);
    });
});
