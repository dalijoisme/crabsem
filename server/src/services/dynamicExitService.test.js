// services/dynamicExitService.test.js - Strategy Profile refactor:
// proves evaluateDynamicExit's new minTpPct/buyerDominanceRatio inputs
// are backward compatible (omitted = today's hardcoded MIN_TP_PCT=15 /
// 0.5 exactly) AND that a profile's overrides genuinely change the
// exit decision. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateDynamicExit, MIN_TP_PCT } = require("./dynamicExitService");

function position(overrides = {}){
    return { entry_price: 1, current_price: 1, mfe_pct: 0, mae_pct: 0, last_volume_1h: 1000, ...overrides };
}

test("MIN_TP_PCT default export is unchanged", () => {
    assert.equal(MIN_TP_PCT, 15);
});

test("omitted minTpPct: below 15% ROI keeps holding, exactly as before", () => {
    const result = evaluateDynamicExit({
        position: position(), token: { price: 1.10, price_change_5m: 1, volume_1h: 1000 }, // +10% ROI
        trenchesEntry: null, engineAction: "BUY", stopLossPrice: 0.8
    });
    assert.equal(result.shouldClose, false);
});

test("minTpPct override: a profile with fixedTpPct=12 evaluates momentum-hold logic at +12%, not +15%", () => {
    const token = { price: 1.13, price_change_5m: 1, volume_1h: 1000 }; // +13% ROI - below default 15, above override 12
    const withDefault = evaluateDynamicExit({ position: position(), token, trenchesEntry: null, engineAction: "BUY", stopLossPrice: 0.8 });
    const withOverride = evaluateDynamicExit({ position: position(), token, trenchesEntry: null, engineAction: "BUY", stopLossPrice: 0.8, minTpPct: 12 });
    assert.equal(withDefault.shouldClose, false); // still below default 15% floor, keep holding
    // above the 12% override floor - momentum evaluation now applies (buyerDominant returns null with no trenchesEntry -> buyersInControl false -> momentum not sustained -> closes)
    assert.equal(withOverride.shouldClose, true);
    assert.equal(withOverride.reason, "MOMENTUM_WEAKENING");
});

test("omitted buyerDominanceRatio: exactly 50% buy/sell split is NOT dominant (today's strict > 0.5)", () => {
    const result = evaluateDynamicExit({
        position: position(), token: { price: 1.20, price_change_5m: 1, volume_1h: 1000 },
        trenchesEntry: { buys_24h: 50, sells_24h: 50 }, engineAction: "BUY", stopLossPrice: 0.8
    });
    assert.equal(result.shouldClose, true);
    assert.equal(result.reason, "MOMENTUM_WEAKENING");
});

test("buyerDominanceRatio override: a looser profile ratio (0.45) accepts a 48% buy-side split as dominant", () => {
    const token = { price: 1.20, price_change_5m: 1, volume_1h: 1000 };
    const trenchesEntry = { buys_24h: 48, sells_24h: 52 }; // 0.48 buy fraction
    const withDefault = evaluateDynamicExit({ position: position(), token, trenchesEntry, engineAction: "BUY", stopLossPrice: 0.8 });
    const withOverride = evaluateDynamicExit({ position: position(), token, trenchesEntry, engineAction: "BUY", stopLossPrice: 0.8, buyerDominanceRatio: 0.45 });
    assert.equal(withDefault.shouldClose, true); // 0.48 <= 0.5 default -> not dominant -> closes
    assert.equal(withOverride.shouldClose, false); // 0.48 > 0.45 override -> dominant -> keeps holding
});
