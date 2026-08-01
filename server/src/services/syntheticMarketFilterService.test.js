// services/syntheticMarketFilterService.test.js - Arjuna vNext sprint,
// Priority 1. Proves the filter fails OPEN on missing/unparseable data
// (never reduces BUY frequency on its own account), passes a genuinely
// clean candidate, and rejects a real multi-signal bot/wash-trading
// pattern - never on a single elevated field alone. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateSyntheticMarketFilter, computeSyntheticBreakdown } = require("./syntheticMarketFilterService");

function trenches(overrides = {}){
    return {
        holders: 500, swaps_24h: 200, buys_24h: 140, sells_24h: 60,
        raw_json: JSON.stringify({
            bot_degen_rate: 0, bundler_trader_amount_rate: 0, rat_trader_amount_rate: 0,
            entrapment_ratio: 0, fresh_wallet_rate: 0, suspected_insider_hold_rate: 0,
            is_wash_trading: false, ...overrides
        })
    };
}

test("no trenches data at all: fails open, never fabricates a rejection", () => {
    const result = evaluateSyntheticMarketFilter({ token_address: "X" }, null);
    assert.equal(result.pass, true);
    assert.equal(result.syntheticScore, 0);
});

test("unparseable raw_json: fails open", () => {
    const result = evaluateSyntheticMarketFilter({ token_address: "X" }, { holders: 1, swaps_24h: 1, raw_json: "{not json" });
    assert.equal(result.pass, true);
});

test("a genuinely clean, organic-looking token passes with a near-zero score", () => {
    const result = evaluateSyntheticMarketFilter({ token_address: "CLEAN" }, trenches());
    assert.equal(result.pass, true);
    assert.ok(result.syntheticScore < 10);
});

test("a strong buy-side skew alone (genuine momentum) is never penalized - buySellClustering only flags a BALANCED split", () => {
    // 95% buy / 5% sell at real volume - exactly what a genuine momentum
    // candidate looks like. Must never be treated as synthetic on its own.
    const result = evaluateSyntheticMarketFilter({ token_address: "MOMENTUM" }, trenches());
    const skewed = trenches();
    skewed.buys_24h = 190; skewed.sells_24h = 10;
    const skewedResult = evaluateSyntheticMarketFilter({ token_address: "MOMENTUM" }, skewed);
    assert.equal(skewedResult.pass, true);
    assert.equal(skewedResult.breakdown.buySellClustering, 0);
});

test("GMGN's own is_wash_trading=true is a hard override, regardless of composite score", () => {
    const result = evaluateSyntheticMarketFilter({ token_address: "WASH" }, trenches({ is_wash_trading: true }));
    assert.equal(result.pass, false);
    assert.ok(result.reasons.some(r => r.includes("is_wash_trading")));
});

test("a single elevated field alone does not cross the reject threshold", () => {
    const result = evaluateSyntheticMarketFilter({ token_address: "ONEFIELD" }, trenches({ bot_degen_rate: 0.6 }));
    assert.equal(result.pass, true); // botDegenRate weight 0.20 * 100 = 20, well under rejectThreshold=55
});

test("a real multi-signal bot/bundle/wash pattern rejects - the SUKI-shaped case", () => {
    const suki = trenches({
        bot_degen_rate: 0.6, bundler_trader_amount_rate: 0.5, rat_trader_amount_rate: 0.08,
        entrapment_ratio: 0.32, fresh_wallet_rate: 0.6, suspected_insider_hold_rate: 0.08
    });
    suki.holders = 5; suki.swaps_24h = 500; // very low unique-holder diversity for the swap volume
    suki.buys_24h = 250; suki.sells_24h = 250; // suspiciously perfectly balanced round-trip

    const result = evaluateSyntheticMarketFilter({ token_address: "SUKI_LIKE" }, suki);
    assert.equal(result.pass, false);
    assert.ok(result.syntheticScore >= 55);
    assert.ok(result.reasons.length > 1); // combination of signals, never one indicator alone
});

test("computeSyntheticBreakdown is the exact same computation dynamicExitService.js reuses for orderflow integrity", () => {
    const t = trenches({ bot_degen_rate: 0.3 });
    const direct = computeSyntheticBreakdown(t);
    const viaFilter = evaluateSyntheticMarketFilter({ token_address: "X" }, t);
    assert.equal(direct.syntheticScore, viaFilter.syntheticScore);
});
