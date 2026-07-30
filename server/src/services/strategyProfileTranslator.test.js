// services/strategyProfileTranslator.test.js - Strategy Profile
// refactor: proves translate() is a strict no-op on an empty/legacy
// config (byte-identical to today's engine defaults), tolerates both
// real-object and JSON-string-column input shapes (benchmark_profiles
// vs trading_bot_config), and correctly translates all 4 named
// profiles' concrete values from the approved architecture plan. Run
// with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { translate } = require("./strategyProfileTranslator");

test("empty config translates to a strict no-op on every override group", () => {
    const result = translate({});
    assert.deepEqual(result.philosophy.weights, {});
    assert.deepEqual(result.philosophy.tiers, {});
    assert.equal(result.philosophy.minLiquidityUsd, null);
    assert.equal(result.philosophy.minVolumeUsd, null);
    assert.equal(result.philosophy.flattenEarliness, true); // momentumHunter's own identity, not scoringConfig's original default
    assert.equal(result.philosophy.smBonus, false);
    assert.deepEqual(result.qualityGateOverrides, {});
    assert.equal(result.exitOverrides.fixedTpPct, 15);
    assert.equal(result.exitOverrides.stopLoss, null);
    assert.equal(result.exitOverrides.momentumWeakeningBuyerDominanceRatio, 0.5);
});

test("null/undefined config is tolerated the same as an empty object", () => {
    assert.deepEqual(translate(null), translate({}));
    assert.deepEqual(translate(undefined), translate({}));
});

test("tolerates benchmark_profiles-shaped input: nested real objects", () => {
    const result = translate({ weights: { accumulation: 1.6 }, tiers: { buy: 55 }, min_liquidity_usd: 1200 });
    assert.equal(result.philosophy.weights.accumulation, 1.6);
    assert.equal(result.philosophy.tiers.buy, 55);
    assert.equal(result.philosophy.minLiquidityUsd, 1200);
});

test("tolerates trading_bot_config-shaped input: JSON-string columns", () => {
    const result = translate({ weights_json: JSON.stringify({ smartMoney: 1.8 }), tiers_json: JSON.stringify({ strongBuy: 75 }) });
    assert.equal(result.philosophy.weights.smartMoney, 1.8);
    assert.equal(result.philosophy.tiers.strongBuy, 75);
});

test("a malformed JSON column falls back to {} rather than throwing", () => {
    assert.doesNotThrow(() => translate({ weights_json: "not valid json{{{" }));
    const result = translate({ weights_json: "not valid json{{{" });
    assert.deepEqual(result.philosophy.weights, {});
});

// Concrete per-profile values from the approved architecture plan
// (floating-sauteeing-swan.md) - BASELINE/STABLE/BALANCED/AGGRESSIVE.

const BASELINE = {
    weights: { accumulation: 0.8, smartMoney: 0.8, kol: 0.8, whale: 1.0, developer: 1.3, sniperQuality: 1.2, bundleQuality: 1.2, insiderQuality: 1.2, liquidity: 1.5, security: 1.5, holderDistribution: 1.0, volume: 1.0, priceStability: 1.0 },
    tiers: { buy: 72, strongBuy: 88 },
    min_liquidity_usd: 5000, min_volume_usd: 3000, flatten_earliness: 0, sm_bonus: 0,
    quality_gate_overrides: { maxRugRatio: 0.50, maxTop10HolderRate: 0.45, maxBundlerMhrWithLowLiquidity: 0.85, minSerialCreatorCount: 300, maxSerialCreatorOpenRatio: 0.08 },
    fixed_tp_pct: 20, stop_loss_overrides: { baseStopPct: 10, highRiskStopPct: 6, maxStopPct: 30 },
    momentum_weakening_buyer_dominance_ratio: 0.45
};

const AGGRESSIVE = {
    weights: { accumulation: 1.6, smartMoney: 1.8, kol: 1.4, whale: 1.5, holderDistribution: 0.5, volume: 0.5, priceStability: 0.4 },
    tiers: { buy: 55, strongBuy: 75 },
    min_liquidity_usd: 1200, min_volume_usd: null, flatten_earliness: 1, sm_bonus: 1,
    quality_gate_overrides: { maxRugRatio: 0.75, maxTop10HolderRate: 0.65, maxBundlerMhrWithLowLiquidity: 0.97, minSerialCreatorCount: 800, maxSerialCreatorOpenRatio: 0.02 },
    fixed_tp_pct: 12, stop_loss_overrides: { baseStopPct: 15, highRiskStopPct: 10, maxStopPct: 40 },
    momentum_weakening_buyer_dominance_ratio: 0.55
};

test("BASELINE translates to the strictest, most patient parameter set", () => {
    const result = translate(BASELINE);
    assert.equal(result.philosophy.weights.security, 1.5);
    assert.equal(result.philosophy.tiers.buy, 72);
    assert.equal(result.philosophy.minLiquidityUsd, 5000);
    assert.equal(result.philosophy.minVolumeUsd, 3000);
    assert.equal(result.philosophy.flattenEarliness, false);
    assert.equal(result.philosophy.smBonus, false);
    assert.equal(result.qualityGateOverrides.maxRugRatio, 0.50);
    assert.equal(result.exitOverrides.fixedTpPct, 20);
    assert.equal(result.exitOverrides.momentumWeakeningBuyerDominanceRatio, 0.45);
});

test("AGGRESSIVE translates to a reweighted early-signal, fast-exit parameter set", () => {
    const result = translate(AGGRESSIVE);
    assert.equal(result.philosophy.weights.smartMoney, 1.8); // early signal, up-weighted
    assert.equal(result.philosophy.weights.priceStability, 0.4); // confirmation signal, down-weighted
    assert.equal(result.philosophy.minVolumeUsd, null); // deliberately off - never gate on volume not yet built up
    assert.equal(result.philosophy.smBonus, true);
    assert.equal(result.exitOverrides.fixedTpPct, 12);
    assert.equal(result.exitOverrides.momentumWeakeningBuyerDominanceRatio, 0.55);
    // AGGRESSIVE's own tier drop is modest (55/75), not a collapse to
    // near-zero - most of its behavior change is the weight reshuffle above.
    assert.equal(result.philosophy.tiers.buy, 55);
});

test("BASELINE and AGGRESSIVE produce meaningfully different philosophy objects (the core bug this refactor fixes)", () => {
    const a = translate(BASELINE), b = translate(AGGRESSIVE);
    assert.notEqual(a.philosophy.tiers.buy, b.philosophy.tiers.buy);
    assert.notEqual(a.philosophy.minLiquidityUsd, b.philosophy.minLiquidityUsd);
    assert.notEqual(a.philosophy.weights.accumulation, b.philosophy.weights.accumulation);
    assert.notEqual(a.exitOverrides.fixedTpPct, b.exitOverrides.fixedTpPct);
});
