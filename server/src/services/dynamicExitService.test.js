// services/dynamicExitService.test.js - Strategy Profile refactor:
// proves evaluateDynamicExit's new minTpPct/buyerDominanceRatio inputs
// are backward compatible (omitted = today's hardcoded MIN_TP_PCT=15 /
// 0.5 exactly) AND that a profile's overrides genuinely change the
// exit decision. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateDynamicExit, MIN_TP_PCT, computeMomentumHealth } = require("./dynamicExitService");

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

// Production Stabilization Final, Section B: marketContextStale must
// never let stale/absent momentum evidence justify continuing to hold a
// winning position - the Stop Loss floor itself is completely unaffected
// (never reads this flag at all), only the +minTpPct momentum-hold branch.
test("marketContextStale forces a close above minTpPct even when every individual momentum field looks fine", () => {
    // Every field here, read in isolation, would normally pass every
    // momentum check (positive change5m, buyer-dominant trenches, rising
    // volume, no reversal signs) - marketContextStale must override all
    // of that, since none of it was actually re-verified this cycle.
    const token = {
        price: 1.20, price_change_5m: 5, volume_1h: 5000, marketContextStale: true
    };
    const trenchesEntry = { buys_24h: 90, sells_24h: 10, net_buy_24h: 5000 };
    const result = evaluateDynamicExit({
        position: position({ last_volume_1h: 1000 }), token, trenchesEntry, engineAction: "BUY", stopLossPrice: 0.8
    });
    assert.equal(result.shouldClose, true);
    assert.equal(result.reason, "MOMENTUM_WEAKENING_STALE_CONTEXT");
});

test("marketContextStale has no effect below minTpPct - still just keeps holding, same as fresh data", () => {
    const token = { price: 1.10, price_change_5m: 5, volume_1h: 5000, marketContextStale: true }; // +10%, below the 15% floor
    const result = evaluateDynamicExit({
        position: position(), token, trenchesEntry: { buys_24h: 90, sells_24h: 10 }, engineAction: "BUY", stopLossPrice: 0.8
    });
    assert.equal(result.shouldClose, false);
});

test("marketContextStale has no effect on Stop Loss - a real price crash still closes immediately", () => {
    const token = { price: 0.5, price_change_5m: 5, volume_1h: 5000, marketContextStale: true }; // real, fresh, crashed price
    const result = evaluateDynamicExit({
        position: position(), token, trenchesEntry: null, engineAction: "BUY", stopLossPrice: 0.8
    });
    assert.equal(result.shouldClose, true);
    assert.equal(result.reason, "STOP_LOSS");
});

// Arjuna vNext sprint, Priority 2/3 (Exit Intelligence / Profit
// Protection) - momentumHealthConfig.js's hardBreakdownFloor=25,
// profitProtectionDecayFloor=45.

const badMomentumToken = {
    token_address: "TEST_MOMENTUM_HEALTH_BREAKDOWN",
    price: 1.05, price_change_5m: -5, price_change_1h: 10, // decelerating hard, reversing
    volume_1h: 100, liquidity: 100, market_cap: 100000, // volume collapsing, liquidity/mcap near nothing
    buys_5m: 1, sells_5m: 9 // seller-dominated
};
const badMomentumTrenches = {
    net_buy_24h: -500,
    raw_json: JSON.stringify({
        bot_degen_rate: 0.6, bundler_trader_amount_rate: 0.5, rat_trader_amount_rate: 0.08,
        entrapment_ratio: 0.32, fresh_wallet_rate: 0.6, suspected_insider_hold_rate: 0.08,
        is_wash_trading: false
    })
};

test("MOMENTUM_HEALTH_BREAKDOWN: real multi-signal deterioration closes even below minTpPct and above Stop Loss", () => {
    // The SUKI-shaped case: still technically above its Stop Loss and
    // nowhere near its +15% TP floor, but every real signal available
    // (decelerating price, seller-dominated 5m flow, collapsing volume,
    // thin liquidity/mcap, negative 24h net buy, bot-heavy orderflow) is
    // bad at once - "keluar sebelum rug pull, bukan sesudah."
    const result = evaluateDynamicExit({
        position: position({ last_volume_1h: 1000 }), token: badMomentumToken, trenchesEntry: badMomentumTrenches,
        engineAction: "BUY", stopLossPrice: 0.8
    });
    assert.equal(result.shouldClose, true);
    assert.equal(result.reason, "MOMENTUM_HEALTH_BREAKDOWN");
    assert.ok(result.momentumHealth.score <= 25);
});

test("MOMENTUM_HEALTH_BREAKDOWN never fires on stale context - the same real bad data just keeps holding below minTpPct", () => {
    const token = { ...badMomentumToken, marketContextStale: true };
    const result = evaluateDynamicExit({
        position: position({ last_volume_1h: 1000 }), token, trenchesEntry: badMomentumTrenches,
        engineAction: "BUY", stopLossPrice: 0.8
    });
    assert.equal(result.shouldClose, false); // never force-close below minTpPct on uncertain/stale data
});

test("PROFIT_PROTECTION_MOMENTUM_DECAY: moderate momentum decay above minTpPct sells without waiting for the full 4-condition check", () => {
    const token = {
        token_address: "TEST_PROFIT_PROTECTION_DECAY",
        price: 1.20, price_change_5m: 1, price_change_1h: 20, // decelerating but still nominally positive
        volume_1h: 800, liquidity: 2000, market_cap: 100000,
        buys_5m: 4, sells_5m: 6
    };
    const trenchesEntry = {
        net_buy_24h: -100,
        raw_json: JSON.stringify({
            bot_degen_rate: 0.3, bundler_trader_amount_rate: 0.25, rat_trader_amount_rate: 0.04,
            entrapment_ratio: 0.16, fresh_wallet_rate: 0.3, suspected_insider_hold_rate: 0.04
        })
    };
    const result = evaluateDynamicExit({
        position: position({ last_volume_1h: 1000 }), token, trenchesEntry, engineAction: "BUY", stopLossPrice: 0.8
    });
    assert.equal(result.shouldClose, true);
    assert.equal(result.reason, "PROFIT_PROTECTION_MOMENTUM_DECAY");
    assert.ok(result.momentumHealth.score > 25 && result.momentumHealth.score <= 45);
});

test("A genuinely healthy winner above minTpPct is NOT touched by the new momentum-health triggers - Arjuna's character is unchanged", () => {
    const token = {
        token_address: "TEST_HEALTHY_WINNER",
        price: 1.25, price_change_5m: 5, price_change_1h: 10,
        volume_1h: 1500, liquidity: 10000, market_cap: 100000,
        buys_5m: 8, sells_5m: 2
    };
    const trenchesEntry = {
        buys_24h: 80, sells_24h: 20, net_buy_24h: 500,
        raw_json: JSON.stringify({
            bot_degen_rate: 0, bundler_trader_amount_rate: 0, rat_trader_amount_rate: 0,
            entrapment_ratio: 0, fresh_wallet_rate: 0, suspected_insider_hold_rate: 0
        })
    };
    const result = evaluateDynamicExit({
        position: position({ last_volume_1h: 1000 }), token, trenchesEntry, engineAction: "BUY", stopLossPrice: 0.8
    });
    assert.equal(result.shouldClose, false);
    assert.ok(result.momentumHealth.score > 45);
});

test("computeMomentumHealth returns a neutral score, never a fabricated 0 or 100, when no real component data exists", () => {
    const health = computeMomentumHealth({ token_address: "TEST_NO_DATA" }, position(), null);
    assert.equal(health.score, 50);
});
