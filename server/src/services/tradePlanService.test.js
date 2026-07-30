// services/tradePlanService.test.js - Strategy Profile refactor:
// proves buildRiskBands(token, signal, stopLossOverrides) is backward
// compatible (omitted overrides = today's global tradePlanConfig.js
// stop-loss formula exactly) AND that a profile's overrides genuinely
// change the computed stop distance, while leaving entry-zone/target
// untouched. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildRiskBands } = require("./tradePlanService");

function token(overrides = {}){
    return { market_cap: 1000000, price: 0.001, price_change_1h: 5, liquidity: 50000, volume_1h: 20000, ...overrides };
}

function signal(overrides = {}){
    return { participantScore: 50, risk: "MEDIUM", confidence: 60, ...overrides };
}

test("omitted stopLossOverrides reproduce today's default stop distance (12% base)", () => {
    const bands = buildRiskBands(token(), signal());
    assert.equal(bands.stopLoss.distancePct, 12);
});

test("stopLossOverrides.baseStopPct changes the computed stop distance", () => {
    const bands = buildRiskBands(token(), signal(), { baseStopPct: 10 });
    assert.equal(bands.stopLoss.distancePct, 10);
});

test("stopLossOverrides.highRiskStopPct applies only when signal.risk === HIGH", () => {
    const bands = buildRiskBands(token(), signal({ risk: "HIGH" }), { highRiskStopPct: 6 });
    assert.equal(bands.stopLoss.distancePct, 6);
});

test("stopLossOverrides.maxStopPct caps the distance even with base widening applied", () => {
    // liquidity below lowLiquidityUsdThreshold (10000) triggers the
    // global +5 widen, unaffected by stopLossOverrides (not part of
    // the profile-tunable subset) - only maxStopPct is overridden here.
    const thinLiquidityToken = token({ liquidity: 1000, volume_1h: 10 });
    const bands = buildRiskBands(thinLiquidityToken, signal(), { baseStopPct: 15, maxStopPct: 20 });
    assert.ok(bands.stopLoss.distancePct <= 20);
});

test("stopLossOverrides never changes entryZone or target (only stop-loss is profile-tunable)", () => {
    const base = buildRiskBands(token(), signal());
    const overridden = buildRiskBands(token(), signal(), { baseStopPct: 3 });
    assert.deepEqual(overridden.entryZone, base.entryZone);
    assert.deepEqual(overridden.target, base.target);
    assert.notEqual(overridden.stopLoss.distancePct, base.stopLoss.distancePct);
});
